# Reject unknown request properties, as every contract schema declares

## Purpose

Fixes `apps/galley` so an unknown property in a request body is
rejected with the shared `invalid_request` error shape, matching
`contracts/openapi.yaml`'s `additionalProperties: false` on every
request schema. Tracking issue:
[#75 — Reject unknown request properties, as every contract schema
declares](https://github.com/cristoforows/ticketIt/issues/75). Not a
milestone slice -- a follow-up fix found while reviewing #58 (PR #74)
by probing a live server, pre-existing since #52 and #56.

## What already existed

Four routes had a request body, and all four decoded it with a plain
`json.NewDecoder(r.Body).Decode(&req)`, which silently ignores any
JSON property the destination struct does not declare:

- `POST /api/tickets` (`CreateTicket`, `apps/galley/internal/httpapi/ticket.go`)
- `PATCH /api/tickets/{id}` (`UpdateTicket`, same file)
- `POST /api/tickets/{id}/status` (`ChangeTicketStatus`, `apps/galley/internal/httpapi/ticket_lifecycle.go`)
- `POST /api/dev/diagnostic-notes` (`CreateDiagnosticNote`, `apps/galley/internal/httpapi/diagnostic.go`)

Confirmed exhaustive against `contracts/openapi.yaml` directly: every
`requestBody:` in the file belongs to one of these four operations (a
plain-text search for `requestBody:` finds exactly four occurrences,
at the `createDiagnosticNote`, `createTicket`, `updateTicket`, and
`changeTicketStatus` operations). No other operation in the contract
has a request body --
`POST /api/tickets/{id}/accept`, `PUT`/`DELETE /api/tickets/{id}/assignee`,
`GET`/`DELETE /api/session`, and the two `/api/auth/github/*` routes
all take none (the auth routes take query parameters instead), which
`apps/galley/internal/httpapi/ticket_lifecycle.go`'s `AcceptTicket`,
`AssignTicketOwner`, and `UnassignTicket` already reflect -- they never
call `json.Decode` at all. This matches the issue's own list of three
probed endpoints plus `ticket.go`'s second site (`UpdateTicket`), and
confirms no fifth site was missed.

`apps/galley/internal/httpapi/json.go` held only `writeJSON` and
`writeError` -- no shared request-decoding helper existed before this
fix; each of the four sites wrote its own `json.NewDecoder(...).Decode(...)`
call and its own malformed-body message.

## What this slice added

### Decision -- one shared decode helper, not four inline `DisallowUnknownFields()` calls

**Chosen:** `decodeStrictJSON(w, r, dst, shapeMessage)`
(`apps/galley/internal/httpapi/json.go`), called from all four sites in
place of the bare `json.NewDecoder(r.Body).Decode(&req)`. It sets
`DisallowUnknownFields()` once, decodes into `dst`, and on any error
writes the existing `invalid_request` shape via the existing
`writeError` helper -- the same status code, the same shape, the same
helper the malformed-JSON case already used, per the issue's own
instruction.

**Why a shared helper over four inline calls:** the four sites already
shared nothing but a copy-pasted decode-and-reject pattern with a
per-endpoint message; a shared helper collapses that duplication and,
more importantly, makes the *next* request-body endpoint correct by
default -- a future handler that calls `decodeStrictJSON` gets
`additionalProperties: false` enforcement for free, whereas a future
handler that copies the old `json.NewDecoder(...).Decode(...)` pattern
would reintroduce exactly this issue. Four independent
`dec.DisallowUnknownFields()` calls would have fixed today's four sites
identically but left that inline pattern as the thing to copy.

### Decision -- what the client sees for an unknown property

`encoding/json`'s `DisallowUnknownFields()` produces a plain, untyped
error whose text is exactly `json: unknown field "name"` (`encoding/json/decode.go`,
stable since Go 1.10; there is no `*json.UnknownFieldError` to
`errors.As` against, so `decodeStrictJSON` matches the literal prefix
`json: unknown field "` via `strings.CutPrefix`).

**Chosen:** name the offending property in the response, but never
forward the underlying `json: ...` string. `decodeStrictJSON` extracts
only the quoted field name from that error and composes a fresh
message: `unknown request property "bogus" -- ` followed by the
endpoint's own existing malformed-body shape message (e.g.
`unknown request property "bogus" -- request body must be JSON
matching {"title": "..."}`). This satisfies both halves of the issue's
instruction: the caller learns which property was rejected (useful
for a misspelled field like `sucessCriteria`), while the response never
leaks `encoding/json`'s internal wording, which is a Go implementation
detail, not a documented part of this contract, and is not
`contracts/openapi.yaml`-described text. Every other decode failure
(malformed JSON, wrong type, and so on) keeps exactly its previous
message and status -- this fix changes zero bytes of any response for
any input that isn't an added, unknown property.

Every one of the four `TestX_RejectsUnknownProperty` tests below
asserts both halves directly: the message contains the quoted field
name, and (where checked, `TestCreateDiagnosticNote_RejectsUnknownProperty`)
does not contain the substring `"json:"`.

### Galley (`apps/galley`)

- `internal/httpapi/json.go`: added `unknownFieldPrefix` and
  `decodeStrictJSON` (Decisions above).
- `internal/httpapi/ticket.go`: `CreateTicket` and `UpdateTicket` now
  call `decodeStrictJSON`; dropped the now-unused `encoding/json`
  import.
- `internal/httpapi/diagnostic.go`: `CreateDiagnosticNote` now calls
  `decodeStrictJSON`; dropped the now-unused `encoding/json` import.
- `internal/httpapi/ticket_lifecycle.go`: `ChangeTicketStatus` now
  calls `decodeStrictJSON`; dropped the now-unused `encoding/json`
  import.
- **Explicitly not touched**, per this issue's own scope: `internal/auth/github.go`
  and `internal/githubfake/` decode GitHub's own API *responses*, not
  our request bodies -- GitHub is free to add fields to those responses,
  and rejecting unknown ones there would break sign-in the next time it
  does. Confirmed unchanged (`git diff` against `main` touches only
  `internal/httpapi`).
- **Tests** (`internal/httpapi/ticket_test.go`, `ticket_lifecycle_test.go`,
  `diagnostic_test.go`; real PostgreSQL, same convention as every prior
  M2 slice):
  - `TestCreateTicket_RejectsUnknownProperty`, `TestUpdateTicket_RejectsUnknownProperty`,
    `TestChangeTicketStatus_RejectsUnknownProperty`, `TestCreateDiagnosticNote_RejectsUnknownProperty`
    (new): a well-formed body naming one extra property is rejected
    `400 invalid_request`, naming the property in the message.
    `TestUpdateTicket_RejectsUnknownProperty` uses the issue's own
    example (`sucessCriteria`, the misspelling of `successCriteria`)
    and additionally re-fetches the Ticket to prove nothing was
    written -- the exact defect the issue calls out as the one that
    bites. `TestChangeTicketStatus_RejectsUnknownProperty` similarly
    re-fetches to prove the Status did not move.
  - **A valid body still succeeds, per endpoint** -- not a new test in
    every case, since each already existed and continues to pass
    unmodified: `TestCreateTicket_TitleOnlyCapturesBacklog` (POST
    `/api/tickets`), `TestUpdateTicket_OnlyProvidedFieldsChange` (PATCH
    `/api/tickets/{id}`), `TestChangeTicketStatus_D3S2Table` (POST
    `/api/tickets/{id}/status`), `TestDiagnosticNotes_WriteThenRead`
    (POST `/api/dev/diagnostic-notes`). Each sends a body containing
    only contract-declared properties and asserts `200`/`201` plus the
    expected persisted effect -- proof this fix cannot pass by
    rejecting everything.
  - No new test needed for the four **not**-touched, bodyless
    operations (`accept`, `assignee` PUT/DELETE) -- `decodeStrictJSON`
    is never called from them, and their existing tests
    (`TestAcceptTicket_*`, `TestAssignTicketOwner_*`, `TestUnassignTicket_*`)
    already pass unmodified, proving this fix touched nothing there.

### Swiftlet caller audit (no code change)

`apps/swiftlet/src` was grepped for every `JSON.stringify` call
constructing a request body (`apps/swiftlet/src/api/tickets.ts`,
grep for `JSON.stringify`) and checked against the contract:

- `createTicket`: `JSON.stringify({ title, template })` -- both
  declared on `CreateTicketRequest`; `template` is always a string
  (`"Basic"` default), never `undefined`, so it is always present and
  always valid.
- `updateTicket`: `JSON.stringify(update)` where `update`'s only
  caller, `TicketDetail.tsx`'s `handleSave`, builds it as an object
  *literal* with exactly `title, goal, context, successCriteria,
  constraints, repository` -- TypeScript's excess-property check on an
  object literal assigned to the `TicketUpdate` (generated
  `UpdateTicketRequest`) parameter type means an extra property here
  would already be a compile error, not just a contract mismatch.
- `changeTicketStatus`: `JSON.stringify({ status })` -- matches
  `ChangeTicketStatusRequest` exactly.
- `acceptTicket`/`assignTicketOwner`/`unassignTicket`: no body sent at
  all, matching the contract's bodyless operations.
- `/api/dev/diagnostic-notes` is not called anywhere in
  `apps/swiftlet/src` or `e2e/` (grep for `diagnostic-notes`/`diagnosticNote`
  finds only the generated schema file) -- no caller to check.

No caller anywhere in Swiftlet depends on the previously lenient
behavior. Confirmed further by running the full existing Swiftlet unit
suite and the full e2e browser suite unmodified against the fixed
Galley (see "Observed results" below) -- both passed with no
`invalid_request` regression on any real form submission.

## Exact versions and toolchain

- Go `1.27.1` (darwin/arm64) -- unchanged.
- Node `v26.9.0` -- unchanged.
- PostgreSQL `17.11` (Homebrew), `localhost:5432`. Go-side verification
  used `ticketit_test` (real, shared, never reset). Browser-suite run
  used `ticketit_e2e`, reset from empty by `e2e/run.sh`. `ticketit_dev`
  and `ticketit_m1_native` were untouched throughout.
- No new dependency anywhere: `decodeStrictJSON` uses only
  `encoding/json` and `strings` (standard library, already imported
  elsewhere in this package). `go.mod`/`go.sum`, `contracts/openapi.yaml`,
  and both generated files (`api.gen.go`, `schema.d.ts`) are unchanged
  by this fix -- confirmed by both drift checks passing with zero diff
  (below).
- `apps/galley`: `github.com/getkin/kin-openapi` `v0.149.0`,
  `oapi-codegen/oapi-codegen/v2` `v2.8.0` -- unchanged pins.
- `apps/swiftlet`: `vite` `8.3.0`, `vitest` `5.0.1` -- unchanged.
- `e2e`: `@playwright/test` `1.63.0`, Chromium headless shell only
  (`--only-shell`) -- unchanged.

## Reproducible commands

```sh
cd apps/galley
gofmt -l .
go vet ./...
go build ./...
go test ./... -count=1
go test ./internal/httpapi/... -run Contract -v
./scripts/check-contract-drift.sh

cd ../../contracts
npm ci
./check-swiftlet-drift.sh

cd ../apps/swiftlet
npm ci
npm test
npm run build

cd ../../e2e
./run.sh
```

## Observed results

### `gofmt` / `go vet` / `go build` (from `apps/galley`)

```
$ gofmt -l .
$ go vet ./...
$ go build ./...
```

(No output from any of the three -- clean.)

### `go test ./...` (from `apps/galley`, real `ticketit_test`)

```
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	1.786s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	0.673s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/auth	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/authtest	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.157s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	0.309s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	2.769s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	[no test files]
```

### The four new tests, in isolation

```
$ go test ./internal/httpapi/... -run "RejectsUnknownProperty" -v
=== RUN   TestCreateDiagnosticNote_RejectsUnknownProperty
--- PASS: TestCreateDiagnosticNote_RejectsUnknownProperty (0.04s)
=== RUN   TestChangeTicketStatus_RejectsUnknownProperty
--- PASS: TestChangeTicketStatus_RejectsUnknownProperty (0.02s)
=== RUN   TestCreateTicket_RejectsUnknownProperty
--- PASS: TestCreateTicket_RejectsUnknownProperty (0.02s)
=== RUN   TestUpdateTicket_RejectsUnknownProperty
--- PASS: TestUpdateTicket_RejectsUnknownProperty (0.02s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.672s
```

### `go test ./internal/httpapi/... -run Contract -v`

```
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.03s)
=== RUN   TestGetStatus_DatabaseUnreachableResponseMatchesContract
--- PASS: TestGetStatus_DatabaseUnreachableResponseMatchesContract (0.01s)
=== RUN   TestDiagnosticNotes_ResponseMatchesContract
--- PASS: TestDiagnosticNotes_ResponseMatchesContract (0.03s)
=== RUN   TestTickets_ResponseMatchesContract
--- PASS: TestTickets_ResponseMatchesContract (0.04s)
=== RUN   TestGetTicket_ResponseMatchesContract
--- PASS: TestGetTicket_ResponseMatchesContract (0.02s)
=== RUN   TestUpdateTicket_ResponseMatchesContract
--- PASS: TestUpdateTicket_ResponseMatchesContract (0.02s)
=== RUN   TestGetSession_ResponseMatchesContract
--- PASS: TestGetSession_ResponseMatchesContract (0.02s)
=== RUN   TestErrorResponses_MatchContract
=== RUN   TestErrorResponses_MatchContract/not_found
=== RUN   TestErrorResponses_MatchContract/method_not_allowed
--- PASS: TestErrorResponses_MatchContract (0.01s)
    --- PASS: TestErrorResponses_MatchContract/not_found (0.00s)
    --- PASS: TestErrorResponses_MatchContract/method_not_allowed (0.00s)
=== RUN   TestAuthErrorResponses_MatchContract
=== RUN   TestAuthErrorResponses_MatchContract/unauthenticated
=== RUN   TestAuthErrorResponses_MatchContract/invalid_oauth_state
--- PASS: TestAuthErrorResponses_MatchContract (0.01s)
    --- PASS: TestAuthErrorResponses_MatchContract/unauthenticated (0.00s)
    --- PASS: TestAuthErrorResponses_MatchContract/invalid_oauth_state (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.418s
```

### `./scripts/check-contract-drift.sh` (from `apps/galley`)

```
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
```

Exit code 0.

### `./check-swiftlet-drift.sh` (from `contracts`, after `npm ci`)

```
> ticketit-contracts@0.0.0 generate:swiftlet
> openapi-typescript openapi.yaml -o ../apps/swiftlet/src/api/generated/schema.d.ts

✨ openapi-typescript 7.13.0
🚀 openapi.yaml → ../apps/swiftlet/src/api/generated/schema.d.ts [20.3ms]
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

Exit code 0. `git status` after this run shows no diff in
`schema.d.ts` -- the contract was not touched by this fix, so
regeneration reproduces exactly what is already committed.

### Swiftlet (`apps/swiftlet`, `npm ci && npm test && npm run build`)

```
 Test Files  8 passed (8)
      Tests  64 passed (64)
```

```
> swiftlet@0.1.0 build
> tsc -p tsconfig.json --noEmit && vite build

vite v8.3.0 building client environment for production...
transforming...
✓ 26 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                  0.31 kB │ gzip:  0.22 kB
dist/assets/index-B7l_SNq-.js  238.71 kB │ gzip: 73.27 kB

✓ built in 50ms
```

### `e2e/run.sh`

Every phase passed (`status.spec.ts`, `auth.spec.ts`, both restart
halves for session/ticket-persistence/ticket-refinement/ticket-lifecycle,
`ticket-detail.spec.ts`, `ticket-refinement.spec.ts`,
`ticket-templates.spec.ts`, `ticket-lifecycle.spec.ts`,
`backend-failure.spec.ts` -- 30 specs total across all files):

```
[run.sh] status.spec.ts exit code: 0
[run.sh] auth.spec.ts exit code: 0
[run.sh] session-restart-before.spec.ts exit code: 0
[run.sh] ticket-lifecycle-before.spec.ts exit code: 0
[run.sh] ticket-persistence-before.spec.ts exit code: 0
[run.sh] ticket-refinement-before.spec.ts exit code: 0
[run.sh] session-restart-after.spec.ts exit code: 0
[run.sh] ticket-persistence-after.spec.ts exit code: 0
[run.sh] ticket-refinement-after.spec.ts exit code: 0
[run.sh] ticket-lifecycle-after.spec.ts exit code: 0
[run.sh] ticket-detail.spec.ts exit code: 0
[run.sh] ticket-refinement.spec.ts exit code: 0
[run.sh] ticket-templates.spec.ts exit code: 0
[run.sh] ticket-lifecycle.spec.ts exit code: 0
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

This is the "confirm no existing caller depends on the lenient
behaviour" check running for real: every browser-driven form
submission in this suite (Ticket capture with a Template, manual
refinement PATCH, Status changes, Accept, Assign/Unassign) now goes
through `decodeStrictJSON` and still succeeds end to end.

### Falsification: the four new tests, run against the pre-fix code

The production change
(`internal/httpapi/json.go`, `ticket.go`, `diagnostic.go`,
`ticket_lifecycle.go`) was reverted to `main`'s version with the new
tests left in place, confirmed to still build, then run:

```
$ git checkout HEAD -- internal/httpapi/json.go internal/httpapi/ticket.go \
    internal/httpapi/diagnostic.go internal/httpapi/ticket_lifecycle.go
$ go build ./...
$ go test ./internal/httpapi/... -run "RejectsUnknownProperty" -v
=== RUN   TestCreateDiagnosticNote_RejectsUnknownProperty
    diagnostic_test.go:195: status = 201, want 400; body={"createdAt":"2026-09-22T18:22:42Z","id":34,"note":"diagnostic_test-TestCreateDiagnosticNote_RejectsUnknownProperty-60007eba2971ca92"}
--- FAIL: TestCreateDiagnosticNote_RejectsUnknownProperty (0.03s)
=== RUN   TestChangeTicketStatus_RejectsUnknownProperty
    ticket_lifecycle_test.go:233: status = 200, want 400
--- FAIL: TestChangeTicketStatus_RejectsUnknownProperty (0.02s)
=== RUN   TestCreateTicket_RejectsUnknownProperty
    ticket_test.go:319: status = 201, want 400; body={"assigneeType":"","completionCondition":"humanAcceptance","constraints":"","context":"","createdAt":"2026-09-22T18:22:42Z","goal":"","id":"8e6b4ac5-f43b-4cd4-ae61-d0bc141bf636","repository":"","status":"Backlog","successCriteria":"","template":"Basic","title":"ticket_test-TestCreateTicket_RejectsUnknownProperty-59827fef462104d2","updatedAt":"2026-09-22T18:22:42Z"}
--- FAIL: TestCreateTicket_RejectsUnknownProperty (0.02s)
=== RUN   TestUpdateTicket_RejectsUnknownProperty
    ticket_test.go:1066: status = 200, want 400; body={"assigneeType":"","completionCondition":"humanAcceptance","constraints":"","context":"","createdAt":"2026-09-22T18:22:42Z","goal":"","id":"45b77130-a776-4469-9c14-ed43015decbc","repository":"","status":"Backlog","successCriteria":"","template":"Basic","title":"ticket_test-TestUpdateTicket_RejectsUnknownProperty-4c6ff3d10c26a43b","updatedAt":"2026-09-22T18:22:42Z"}
--- FAIL: TestUpdateTicket_RejectsUnknownProperty (0.02s)
FAIL
```

All four fail red against the pre-fix code, reproducing the issue's
exact reported behavior byte for byte (`201`/`200` instead of `400`,
the bogus property silently dropped, `UpdateTicket` in particular
returning `200` with the Ticket unchanged -- the specific case the
issue calls out as the one that bites). The production change was then
restored:

```
$ git apply <the four-file diff captured above>
$ gofmt -l . && go vet ./... && go build ./... && go test ./... -count=1
```

All green again (output identical to the "go test ./..." section
above) -- confirming the tests genuinely exercise this fix rather than
passing regardless of it.

## Implementation limitations and follow-ups

None. All four request-body operations in `contracts/openapi.yaml` are
covered; no endpoint was found that the issue's own list missed, and
none was left with the old lenient decoding.

## Outstanding checks and owning milestone

None specific to this fix. `internal/auth/github.go` and
`internal/githubfake/` were confirmed out of scope (they decode
GitHub's own responses, not this application's request bodies) and
left untouched, per the issue's explicit instruction -- see "What this
slice added," "Galley," above for the citation and reasoning.

## Decision impacts (open-decision IDs)

None. This fix does not touch any Ticket/Template/completion-condition
behavior or any other tracked open decision -- it corrects request
decoding to match an already-approved contract.
