# Manual refinement fields and writing guidance

## Purpose

Adds manual refinement to Swiftlet's full-page Ticket detail view: an
Owner can edit a Ticket's title, goal, context, Success Criteria, and
constraints by hand, guided by the exact prompts in
[docs/ticket-creation.md](../../ticket-creation.md), "Manual guidance".
No AI of any kind is involved and refinement triggers nothing else.
Touches `contracts/`, `apps/galley`, `apps/swiftlet`, and `e2e/`.
Tracking issue: [#58 — M2.10 — Manual refinement fields and writing
guidance](https://github.com/cristoforows/ticketIt/issues/58), under
[M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3). Blocked
by [#57](https://github.com/cristoforows/ticketIt/issues/57), merged
before this slice began
(`docs/evidence/m2/57-ticket-detail-page.md`).

## What already existed

- **Galley**: `tickets` table with `id` (internal), `owner_id`,
  `title`, `status`, `public_id`, `created_at`, `updated_at`
  (`internal/migrations/000001`–`000004`). `GET`/`POST /api/tickets`
  and `GET /api/tickets/{id}` (`internal/httpapi/ticket.go`), all
  Owner-scoped via `requireSession`, all returning `Ticket.id` as the
  opaque public UUID. No column or endpoint for goal, context, Success
  Criteria, or constraints existed; no update/PATCH operation of any
  kind existed on `/api/tickets/{id}`.
- **Swiftlet**: `src/router.ts`, `src/components/Link.tsx`,
  `TicketList.tsx` (list + quick capture),
  `TicketDetail.tsx` (pure presentation: title, Status, timestamps
  only — no fetching, no routing, deliberately so a later container
  could reuse it) and `TicketDetailPage.tsx` (the fetch/route
  container). No editing of any field existed anywhere in the app.
- **e2e**: `e2e/support/tickets.ts`'s API-direct `createTicket`
  helper, `e2e/support/sign-in.ts`, and every spec through
  `tests/ticket-detail.spec.ts`. `run.sh`'s phase 10 already restarts
  Galley once, shared by `tests/session-restart-*` and
  `tests/ticket-persistence-*`.
- No sibling slice was landing in parallel that this slice depended
  on.

## What this slice added

### Decision 1 — partial-update representation: `*string`, not `string`

**Chosen: every field on `UpdateTicketRequest` is optional at the
schema level (absent from `required`), which oapi-codegen generates
as a Go pointer (`*string` with `json:"...,omitempty"`) — the same
pattern this contract already uses for `DatabaseStatus.Error`.** This
is what makes the three required cases genuinely distinguishable:

1. **Field absent** from the JSON body → `encoding/json` leaves the
   Go pointer `nil` → `validateRefinementField`/`validateOptionalTitle`
   return `nil` → `updateTicketForOwner`'s
   `COALESCE($n, existing_column)` sees a SQL `NULL` parameter and
   keeps the existing value untouched.
2. **Field present, set to `""`** → the pointer is non-nil, pointing
   at `""` → trimmed (see Decision 2) → passed to `COALESCE` as a
   genuine (non-NULL) empty-string parameter, which **wins** over the
   existing value, clearing it.
3. **Field present with text** → pointer non-nil, trimmed, validated
   against its documented maximum length, and stored.

A bare (non-pointer) `string` field cannot distinguish case 1 from
case 2 — this is exactly the trap the issue itself names, and
precisely why `apps/galley/internal/httpapi/ticket.go`'s
`ticketUpdate` struct and `updateTicketForOwner`'s SQL are built
around pointers end to end, not just at the JSON-binding boundary.
Verified with a deliberate break (see "Proof the suite can fail"
below): making the "absent" branch return a pointer to `""` instead of
`nil` immediately fails `TestUpdateTicket_OnlyProvidedFieldsChange`
while every unrelated test — including other `UpdateTicket` tests —
stays green.

**Title is the one documented exception**: it can be set (case 3) or
left absent (case 1), but never cleared (case 2) — a value that trims
to `""` is rejected with `invalid_request`
(`validateOptionalTitle`), since every Ticket must keep a title. This
is a deliberate asymmetry with the four refinement fields, not an
oversight, and is documented in `contracts/openapi.yaml`'s
`UpdateTicketRequest.title` and `apps/galley/internal/httpapi/ticket.go`'s
comments.

**Whitespace-only refinement fields are treated as an explicit `""`.**
Every field is trimmed of leading/trailing whitespace before
validation (matching `CreateTicketRequest.title`'s existing rule), so
a value that trims to empty — including one that was only whitespace —
clears the field exactly like an explicit `""`. This conflation is
deliberate (documented in the contract and in `ticket.go`'s
`validateRefinementField`): "the Owner submitted only whitespace"
and "the Owner submitted nothing at all" are not meaningfully
different intents for a free-text field, and treating them
identically avoids a fourth, unnecessary case.

### Decision 2 — the concurrent-edit rule: last-write-wins, no optimistic concurrency

**Chosen, as issue #58 explicitly permits: last-write-wins, with no
version token, ETag, or `If-Match` check of any kind.**
`updateTicketForOwner`'s `UPDATE ... WHERE owner_id = $1 AND public_id
= $2::uuid` always applies unconditionally to whatever row currently
matches — there is no `WHERE updated_at = $expected` guard and no
response header carrying a version the client is expected to echo
back. Two PATCH requests naming disjoint fields both apply cleanly
(each only ever touches the columns it names, via `COALESCE`); two
PATCH requests naming the *same* field apply in whichever order
Galley's database serializes them, and the later one's value silently
overwrites the earlier one's with no error, warning, or merge. This
is recorded here and in `contracts/openapi.yaml`'s `updateTicket`
description as the deliberate, accepted rule — a future milestone
that needs conflict detection (e.g. for Grill Mode's interaction with
manual edits, M7) would need to add a version column and an
`If-Match`-style precondition explicitly; nothing here anticipates
that shape.

**Every PATCH bumps `updated_at`, even one whose body names no field
at all.** `updateTicketForOwner` always sets `updated_at = now()`
unconditionally — there is no "did anything actually change" check.
This was chosen for simplicity (one SQL statement, one code path) and
because a PATCH request is itself an explicit Owner action worth
recording as "last touched now," even a no-op one. Verified directly
by `TestUpdateTicket_BumpsUpdatedAtButNotCreatedAt`, which PATCHes
with an empty body (`{}`) and asserts `updatedAt` still advances while
`createdAt` and every stored value stay the same.

### Decision 3 — length limits, and why `context` gets a larger one

All four documented, in characters (`utf8.RuneCountInString`, not
bytes — see "Decision 4" below), applied after trimming:

| Field | Max length | Reasoning |
| --- | --- | --- |
| `title` | 200 | Unchanged from issue #56. |
| `goal` | 2000 | A one-to-few-sentence outcome statement; comfortably longer than the example in docs/ticket-creation.md while still bounding pathological input. |
| `context` | 10000 | Explicitly meant to hold "relevant background, links, repositories, or examples" (docs/ticket-creation.md) — reproduction steps, pasted logs, and multiple links need more room than a short statement. |
| `successCriteria` | 2000 | Same reasoning as `goal` — observable conditions, not a document. |
| `constraints` | 2000 | Same reasoning as `goal`. |

These are engineering choices inside the issue's own instruction
("documented maximum lengths"), not an open product decision — no
D-series ID governs free-text field limits. If real usage shows any of
these too tight or too loose, adjusting them is a plain constant
change in `apps/galley/internal/httpapi/ticket.go` (`ticketGoalMaxLength`
etc.) and the corresponding `maxLength` in `contracts/openapi.yaml`,
with no migration needed (the columns themselves carry no `CHECK`
constraint — see the migration file's own comment for why, mirroring
`tickets.status`'s existing rationale).

### Decision 4 — counting characters, not bytes (again)

Issue #56 shipped `ticketTitleMaxLength` enforced with `len()` (byte
count) against a `maxLength` that JSON Schema defines in code points —
a bug caught in review, not by any test, because every existing test
used ASCII. This slice's four new limits are enforced with
`utf8.RuneCountInString`, exactly like `ticketTitleMaxLength`'s own
existing (already-fixed) pattern, and
`TestUpdateTicket_CountsFieldLengthInCharactersNotBytes` proves it
directly: a `goal` built from `ticketGoalMaxLength` repetitions of a
3-byte CJK character (`日`) is accepted at exactly the documented
character limit, even though its byte length is roughly three times
that — the same technique
`TestCreateTicket_CountsTitleLengthInCharactersNotBytes` already uses
for `title`.

### Contract (`contracts/openapi.yaml`)

- `Ticket` gained `goal`, `context`, `successCriteria`, `constraints`
  — all `type: string`, all listed in `required` (a Ticket's response
  always includes them; `""` means "never set" or "cleared" — reading
  a Ticket never distinguishes those two, only a PATCH request body
  does).
- New schema `UpdateTicketRequest`: `title`, `goal`, `context`,
  `successCriteria`, `constraints`, all optional (none in `required`),
  each with its own `maxLength`. `additionalProperties: false`,
  matching every other request schema in this contract.
- New operation `PATCH /api/tickets/{id}` (`updateTicket`), on the
  same path item as the existing `GET` — the `id` path parameter was
  hoisted to the path-item level (shared by both operations) rather
  than duplicated.
- `Ticket.updatedAt`'s description now also mentions a refinement edit
  as a reason it can differ from `createdAt`, alongside #60's future
  transitions.

### Galley

- `internal/migrations/000005_add_ticket_refinement_fields.up.sql`
  (forward-only, no down): adds `tickets.goal`, `.context`,
  `.success_criteria`, `.constraints`, all nullable `TEXT`, no
  `CHECK` constraint (see Decision 3).
- `internal/httpapi/ticket.go`:
  - `ticketGoalMaxLength`, `ticketContextMaxLength`,
    `ticketSuccessCriteriaMaxLength`, `ticketConstraintsMaxLength`
    constants.
  - `ticketSelectColumns` / `scanTicketRow` / `ticketRowScanner`: a
    shared column list and scan helper used by `insertTicket`,
    `getTicketForOwner`, `listTicketsForOwner`, and the new
    `updateTicketForOwner`, so the SELECT/RETURNING column list and
    the scan destinations can never drift against each other now that
    there are four query functions instead of three, each returning
    nine columns instead of five. `sql.NullString`'s zero value being
    `""` on a NULL column is what implements "unset reads as empty
    string" for free.
  - `UpdateTicket` (new `ServerInterface` method): `requireSession` →
    `uuid.Parse` (malformed folds into the same `404` as `GetTicket`,
    unchanged privacy property) → decode → validate every field
    (`validateOptionalTitle`, `validateRefinementField` ×4) → build a
    `ticketUpdate` → `updateTicketForOwner` → `200` with the updated
    Ticket, or the same `404 not_found` `GetTicket` uses for an
    unknown/cross-owner identifier.
  - `updateTicketForOwner`: the `COALESCE`-based `UPDATE`, scoped by
    `owner_id` exactly like `getTicketForOwner` (see "Owner-scoping
    proof, singleton limitation" below).
  - `handler.go`: `/api/tickets/{id}`'s method-not-allowed handler now
    lists `GET, PATCH` instead of just `GET`.
- **Tests** (`internal/httpapi/ticket_test.go`, `contract_test.go`, all
  against real PostgreSQL): 17 new top-level tests plus 3 subtests —
  see "Observed results" for the full list and output. Cover, at
  minimum, every behavior issue #58 names explicitly: a title-only
  PATCH leaving the four refinement fields untouched
  (`TestUpdateTicket_OnlyProvidedFieldsChange`), an absent field
  leaving the title untouched
  (`TestUpdateTicket_AbsentFieldLeavesValueUnchanged`), an explicit
  `""` clearing a field
  (`TestUpdateTicket_EmptyStringClearsField`), trimming
  (`TestUpdateTicket_TrimsRefinementFields`), the
  whitespace-only-clears conflation
  (`TestUpdateTicket_WhitespaceOnlyRefinementFieldClears`), title's
  clear-rejection
  (`TestUpdateTicket_RejectsClearingTitle`), every field's own maximum
  length both rejected-over and accepted-at
  (`TestUpdateTicket_RejectsOverLengthFields`,
  `TestUpdateTicket_AcceptsFieldsAtMaxLength`), the non-ASCII
  character-count proof
  (`TestUpdateTicket_CountsFieldLengthInCharactersNotBytes`),
  malformed JSON, missing session, the 404-parity property
  (`TestUpdateTicket_UnknownAndMalformedIdentifiersAreIndistinguishable`),
  Owner scoping
  (`TestUpdateTicket_ScopedToOwner`), the `updatedAt`/`createdAt`
  concurrent-edit side effect
  (`TestUpdateTicket_BumpsUpdatedAtButNotCreatedAt`), the `Allow`
  header, database-unavailability, and the contract-schema-validation
  test for the `200`/`400`/`404` shapes
  (`TestUpdateTicket_ResponseMatchesContract`).
- **Owner-scoping and 404-parity proof, singleton limitation.**
  Exactly the same inherited limitation `#56` and `#57` already
  recorded: `owners` is a true one-row-per-deployment singleton
  (`owners_singleton_uq`), so a second real Owner cannot be
  constructed to prove "another Owner's PATCH returns 404" by actually
  creating one. `TestUpdateTicket_ScopedToOwner` follows the
  established technique — calling `updateTicketForOwner` directly with
  a bogus owner id that can never belong to any real Owner — the same
  way `TestGetTicket_ScopedToOwner` and
  `TestListTicketsForOwner_ScopedToOwner` do.

### Swiftlet

- `src/api/tickets.ts`: `Ticket`'s runtime shape check
  (`parseTicket`) now requires `goal`/`context`/`successCriteria`/`constraints`
  as strings. New `TicketUpdate` type (`components["schemas"]["UpdateTicketRequest"]`)
  and `updateTicket(id, update)` — `PATCH /api/tickets/{id}`, sending
  exactly the object the caller built (no trimming, no defaulting: only
  Galley owns those rules, per ADR 0001), throwing `TicketNotFoundError`
  on `404` and surfacing Galley's own `error.message` on any other
  rejection, mirroring `createTicket`'s existing convention exactly.
- `src/components/TicketDetail.tsx`: gained an edit mode. **Still pure
  presentation** — it neither fetches nor routes; saving delegates to
  a new `onSave: (update: TicketUpdate) => Promise<Ticket>` prop
  supplied by the container. View mode now also shows each refinement
  field's stored value (or an explicit "Not set." placeholder); edit
  mode offers `title` plus the four refinement fields as plain
  `<input>`/`<textarea>` elements — **stored and rendered as plain
  text, never Markdown** (M7 owns report rendering) — each refinement
  field's `<textarea>` paired with its docs/ticket-creation.md
  guidance prompt shown verbatim just above it, plus Save and Cancel.
  Save calls `onSave` with all five fields as currently typed (this
  app's own edit form always shows every field at once, so it always
  submits all of them — the endpoint's partial-update capability is
  exercised directly by Galley's own tests per ADR 0001, not
  specifically by this form); on rejection, Galley's exact
  `error.message` is shown inline (`data-testid="ticket-detail-save-error"`)
  and the form stays open with the Owner's in-progress edits intact.
  Cancel discards local edits and returns to view mode without ever
  calling `onSave`.
- `src/components/TicketDetailPage.tsx`: passes `onSave={(update) =>
  updateTicket(ticketId, update)}` to `TicketDetail` — the only place
  in this app that calls `updateTicket`, keeping the container/
  presentation split issue #57 established intact (a future M3 modal
  container can supply its own `onSave` and reuse `TicketDetail`
  unchanged, exactly as issue #57's own reuse note already
  anticipated for the read-only fields).
- Regenerated `src/api/generated/schema.d.ts` (openapi-typescript
  7.13.0, unchanged pin).
- **Tests** (Vitest + Testing Library): `TicketDetail.test.tsx` grew
  from 2 to 9 tests — placeholders for unset fields, stored values
  shown, no edit form before "Edit" is clicked, the guidance prompts
  rendered verbatim, the edit form pre-filled from the current Ticket,
  a successful save returning to view mode with the saved values (and
  asserting exactly what was sent to `onSave`), Cancel discarding
  edits without calling `onSave`, and Galley's own rejection message
  surfaced verbatim while staying in edit mode.
  `TicketDetailPage.test.tsx` gained a test driving a full
  fetch-then-PATCH round trip through the real component tree,
  asserting the exact `PATCH` request body. `TicketList.test.tsx` and
  `AppShell.test.tsx`'s existing Ticket fixtures were extended with
  the four new (empty-string) fields — required now that `Ticket`'s
  generated type lists them under `required`.

### e2e

- `e2e/support/tickets.ts`: `Ticket` interface gained `goal`,
  `context`, `successCriteria`, `constraints`.
- `e2e/tests/ticket-refinement.spec.ts` (new, 4 specs, fresh sign-in,
  no restart needed): capturing a title-only Ticket then filling in
  the title and all four fields persists across reload (also asserts
  the guidance prompts verbatim, and the "Not set." placeholders
  before editing); Cancel discards unsaved edits; clearing the title
  is rejected with Galley's exact message; an over-length field is
  rejected with Galley's exact message, and clearing a previously-set
  field persists as cleared after reload.
- `e2e/tests/ticket-refinement-before.spec.ts` /
  `ticket-refinement-after.spec.ts` (new): the acceptance criterion
  that refinement fields (and the title) persist across a genuine
  backend restart, not just a page reload — following the exact
  `session-restart-before/after.spec.ts` /
  `ticket-persistence-before/after.spec.ts` two-process, shared-restart
  pattern (storage state carried via `E2E_STORAGE_STATE_PATH`). The
  "after" half locates the Ticket by its edited title (rather than its
  id, which cannot be shared across the two separate `playwright test`
  process invocations) on the Backlog list.
- `e2e/run.sh`: runs `ticket-refinement-before.spec.ts` **before**
  `ticket-persistence-before.spec.ts` in the shared restart phase —
  deliberately, not incidentally: `ticket-persistence-after.spec.ts`
  asserts the exact identity of the two newest list entries, and list
  order is by `created_at` (not `updated_at`), so refinement's own
  Ticket capture needed to sort *older* than persistence's two,
  otherwise it would silently become the new "newest" entry and break
  that unrelated assertion (caught by actually running the suite — see
  "Observed results"). Runs `ticket-refinement.spec.ts` in phase 10b
  alongside `ticket-detail.spec.ts`. Exit-code aggregation and the
  final summary log extended accordingly.

## Exact versions and toolchain

- Go `1.27.1` (darwin/arm64) — unchanged.
- Node `v26.9.0` — unchanged.
- `apps/galley`: no new runtime dependency. `database/sql` is standard
  library (used only for `sql.NullString`, alongside the existing
  `pgx/v5` driver, which supports it directly). `oapi-codegen/oapi-codegen/v2`
  `v2.8.0` (unchanged pin) regenerated `api.gen.go`;
  `github.com/getkin/kin-openapi` `v0.149.0` (unchanged) validates the
  new contract test.
- `apps/swiftlet`: no new dependency. `openapi-typescript` `7.13.0`
  (unchanged pin, `contracts/package.json`) regenerated `schema.d.ts`.
  `vite` `8.3.0`, `vitest` `5.0.1`, `@testing-library/react` —
  unchanged.
- `e2e`: `@playwright/test` `1.63.0` — unchanged. Chromium's headless
  shell only (`--only-shell`), same as every prior slice.
- PostgreSQL server: `17.11` (Homebrew), `localhost:5432`. Go-side
  verification used `ticketit_test` (real, shared, never reset — see
  "Owner-scoping proof" above). Browser-suite runs used `ticketit_e2e`,
  reset from empty by `run.sh` each time. `ticketit_dev` and
  `ticketit_m1_native` were untouched throughout.

## Reproducible commands

**Galley** (from `apps/galley/`, real PostgreSQL, `ticketit_test`
already created per `apps/galley/README.md`, "Local PostgreSQL
setup"):

```sh
gofmt -l .
go vet ./...
go build ./...
go test ./... -count=1
go test ./internal/httpapi/... -run Contract -v
./scripts/check-contract-drift.sh
```

**Contract drift, Swiftlet side** (from `contracts/`):

```sh
npm ci
npm run generate:swiftlet
./check-swiftlet-drift.sh
```

**Swiftlet** (from `apps/swiftlet/`):

```sh
npm ci
npm run test -- --run
npm run build
```

**Browser suite** (from `e2e/`):

```sh
./run.sh
```

## Observed results

### `gofmt` / `go vet` / `go build`

```
$ gofmt -l .
(no output -- clean)
$ go vet ./...
(no output -- clean)
$ go build ./...
(no output -- success)
```

### `go test ./... -count=1` — all packages pass

```
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	1.185s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	0.423s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/auth	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/authtest	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.152s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	0.293s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	2.308s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	[no test files]
```

`internal/httpapi -run TestUpdateTicket -v` (18 new tests, 3 subtests
of `TestUpdateTicket_RejectsClearingTitle`, 5 subtests of
`TestUpdateTicket_RejectsOverLengthFields`, all passing):

```
=== RUN   TestUpdateTicket_ResponseMatchesContract
--- PASS: TestUpdateTicket_ResponseMatchesContract (0.04s)
=== RUN   TestUpdateTicket_OnlyProvidedFieldsChange
--- PASS: TestUpdateTicket_OnlyProvidedFieldsChange (0.02s)
=== RUN   TestUpdateTicket_EmptyStringClearsField
--- PASS: TestUpdateTicket_EmptyStringClearsField (0.02s)
=== RUN   TestUpdateTicket_AbsentFieldLeavesValueUnchanged
--- PASS: TestUpdateTicket_AbsentFieldLeavesValueUnchanged (0.02s)
=== RUN   TestUpdateTicket_TrimsRefinementFields
--- PASS: TestUpdateTicket_TrimsRefinementFields (0.01s)
=== RUN   TestUpdateTicket_WhitespaceOnlyRefinementFieldClears
--- PASS: TestUpdateTicket_WhitespaceOnlyRefinementFieldClears (0.01s)
=== RUN   TestUpdateTicket_RejectsClearingTitle
--- PASS: TestUpdateTicket_RejectsClearingTitle (0.01s)
    --- PASS: TestUpdateTicket_RejectsClearingTitle/blank_ (0.00s)
    --- PASS: TestUpdateTicket_RejectsClearingTitle/blank_#01 (0.00s)
    --- PASS: TestUpdateTicket_RejectsClearingTitle/blank_#02 (0.00s)
=== RUN   TestUpdateTicket_RejectsOverLengthFields
--- PASS: TestUpdateTicket_RejectsOverLengthFields (0.01s)
    --- PASS: TestUpdateTicket_RejectsOverLengthFields/title (0.00s)
    --- PASS: TestUpdateTicket_RejectsOverLengthFields/goal (0.00s)
    --- PASS: TestUpdateTicket_RejectsOverLengthFields/context (0.00s)
    --- PASS: TestUpdateTicket_RejectsOverLengthFields/successCriteria (0.00s)
    --- PASS: TestUpdateTicket_RejectsOverLengthFields/constraints (0.00s)
=== RUN   TestUpdateTicket_AcceptsFieldsAtMaxLength
--- PASS: TestUpdateTicket_AcceptsFieldsAtMaxLength (0.01s)
=== RUN   TestUpdateTicket_CountsFieldLengthInCharactersNotBytes
--- PASS: TestUpdateTicket_CountsFieldLengthInCharactersNotBytes (0.01s)
=== RUN   TestUpdateTicket_RejectsMalformedJSON
--- PASS: TestUpdateTicket_RejectsMalformedJSON (0.01s)
=== RUN   TestUpdateTicket_RequiresSession
--- PASS: TestUpdateTicket_RequiresSession (0.01s)
=== RUN   TestUpdateTicket_UnknownAndMalformedIdentifiersAreIndistinguishable
--- PASS: TestUpdateTicket_UnknownAndMalformedIdentifiersAreIndistinguishable (0.01s)
=== RUN   TestUpdateTicket_ScopedToOwner
--- PASS: TestUpdateTicket_ScopedToOwner (0.01s)
=== RUN   TestUpdateTicket_BumpsUpdatedAtButNotCreatedAt
--- PASS: TestUpdateTicket_BumpsUpdatedAtButNotCreatedAt (1.12s)
=== RUN   TestUpdateTicket_MethodAllowedOnTicketPath
--- PASS: TestUpdateTicket_MethodAllowedOnTicketPath (0.01s)
PASS
```

### Contract-response validation and both drift checks

```
$ go test ./internal/httpapi/... -run Contract -v
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.03s)
=== RUN   TestGetStatus_DatabaseUnreachableResponseMatchesContract
--- PASS: TestGetStatus_DatabaseUnreachableResponseMatchesContract (0.00s)
=== RUN   TestDiagnosticNotes_ResponseMatchesContract
--- PASS: TestDiagnosticNotes_ResponseMatchesContract (0.03s)
=== RUN   TestTickets_ResponseMatchesContract
--- PASS: TestTickets_ResponseMatchesContract (0.02s)
=== RUN   TestGetTicket_ResponseMatchesContract
--- PASS: TestGetTicket_ResponseMatchesContract (0.02s)
=== RUN   TestUpdateTicket_ResponseMatchesContract
--- PASS: TestUpdateTicket_ResponseMatchesContract (0.02s)
=== RUN   TestGetSession_ResponseMatchesContract
--- PASS: TestGetSession_ResponseMatchesContract (0.01s)
=== RUN   TestErrorResponses_MatchContract
--- PASS: TestErrorResponses_MatchContract (0.01s)
=== RUN   TestAuthErrorResponses_MatchContract
--- PASS: TestAuthErrorResponses_MatchContract (0.01s)
PASS

$ ./scripts/check-contract-drift.sh
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).

$ cd ../../contracts && npm ci && ./check-swiftlet-drift.sh
> ticketit-contracts@0.0.0 generate:swiftlet
> openapi-typescript openapi.yaml -o ../apps/swiftlet/src/api/generated/schema.d.ts
✨ openapi-typescript 7.13.0
🚀 openapi.yaml → ../apps/swiftlet/src/api/generated/schema.d.ts [17.7ms]
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

### Swiftlet: install, test, build

```
$ npm ci
added 108 packages, and audited 109 packages in 804ms
found 0 vulnerabilities

$ npm run test -- --run
 Test Files  8 passed (8)
      Tests  45 passed (45)

$ npm run build
✓ 26 modules transformed.
dist/index.html                  0.31 kB │ gzip:  0.23 kB
dist/assets/index-D7M0HrFB.js  234.28 kB │ gzip: 72.20 kB
✓ built in 48ms
```

45 tests across 8 files (up from 36 in #57's record): `App.test.tsx`
(4), `AppShell.test.tsx` (5), `SignInPage.test.tsx` (1),
`StatusView.test.tsx` (5), `TicketList.test.tsx` (8),
`TicketDetail.test.tsx` (9, up from 2 — edit/save/cancel/guidance),
`TicketDetailPage.test.tsx` (7, up from 6 — the PATCH round trip),
`router.test.tsx` (5).

### Browser suite — `SUITE PASSED`, 26 specs across 11 files

```
$ cd e2e && ./run.sh
...
[run.sh] running tests/status.spec.ts against a live galley
  ✓ status page displays the values Galley actually returns
[run.sh] running tests/auth.spec.ts against a live galley and the substitute GitHub provider
  ✓ 4 passed
[run.sh] running tests/session-restart-before.spec.ts (signs in, saves storage state)
  ✓ the Owner signs in before Galley restarts
[run.sh] running tests/ticket-refinement-before.spec.ts (edits title and manual refinement fields)
  ✓ the title and manual refinement fields, edited from the full page, survive a Galley restart
[run.sh] running tests/ticket-persistence-before.spec.ts (captures two Tickets, newest first)
  ✓ the Owner captures two Tickets, newest first, before Galley restarts
[run.sh] restarting galley (same database, same origin, new process) to prove the session and Tickets survive
[run.sh] galley ready
[run.sh] running tests/session-restart-after.spec.ts against the restarted galley
  ✓ the session survives a Galley restart
[run.sh] running tests/ticket-persistence-after.spec.ts against the restarted galley
  ✓ the two captured Tickets are still listed, in the same order, after a Galley restart
[run.sh] running tests/ticket-refinement-after.spec.ts against the restarted galley
  ✓ the edited title and manual refinement fields are still there after a Galley restart
[run.sh] running tests/ticket-detail.spec.ts against the restarted galley
  ✓ 5 passed
[run.sh] running tests/ticket-refinement.spec.ts against the restarted galley
  ✓ capturing a title-only Ticket, then filling in the title and all four refinement fields, persists across reload
  ✓ Cancel discards unsaved edits without persisting them
  ✓ clearing the title is rejected with Galley's own message, shown verbatim
  ✓ an over-length field is rejected with Galley's own message, and clearing a set field persists after reload
[run.sh] stopping galley to exercise the failure-mode spec
[run.sh] running tests/backend-failure.spec.ts against a stopped galley
  ✓ the app shows its error state when Galley is stopped, instead of a blank or fabricated page
[run.sh] status.spec.ts exit code: 0
[run.sh] auth.spec.ts exit code: 0
[run.sh] session-restart-before.spec.ts exit code: 0
[run.sh] ticket-persistence-before.spec.ts exit code: 0
[run.sh] ticket-refinement-before.spec.ts exit code: 0
[run.sh] session-restart-after.spec.ts exit code: 0
[run.sh] ticket-persistence-after.spec.ts exit code: 0
[run.sh] ticket-refinement-after.spec.ts exit code: 0
[run.sh] ticket-detail.spec.ts exit code: 0
[run.sh] ticket-refinement.spec.ts exit code: 0
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE PASSED
[run.sh] stopping swiftlet preview server
[run.sh] stopping the substitute GitHub provider
```

`lsof -i -P` immediately after exit showed no `galley`/`githubfake`/
`vite`/`node` listener left behind, both after this run and after
every deliberately-broken run below.

## Proof the suite can fail

Three separate, targeted, reverted breaks, each capturing the actual
red output, each reverted (confirmed via `diff` against a saved copy
of the pre-break file, showing no difference), followed by a
confirming green run. Two are required by this slice's own
instructions: at least one break in Galley's partial-update or
validation logic (not harness plumbing), and proof each new spec can
fail.

**1. Galley partial-update logic broken** (`validateRefinementField`'s
"absent" branch changed from `return nil, true` to returning a pointer
to `""`, i.e. deliberately reintroducing the exact bug this slice's
own instructions warn about: conflating "the property was absent" with
"the property was sent as an empty string"):

```
$ go test ./internal/httpapi/... -run TestUpdateTicket -v
...
=== RUN   TestUpdateTicket_OnlyProvidedFieldsChange
    ticket_test.go:647: Goal = "", want unchanged "Ship the feature" -- a title-only PATCH must not touch it
    ticket_test.go:650: Context = "", want unchanged "See the linked issue" -- a title-only PATCH must not touch it
    ticket_test.go:653: SuccessCriteria = "", want unchanged "Tests pass" -- a title-only PATCH must not touch it
    ticket_test.go:656: Constraints = "", want unchanged "Do not change the API" -- a title-only PATCH must not touch it
--- FAIL: TestUpdateTicket_OnlyProvidedFieldsChange (0.02s)
...
FAIL
```

Exactly the central partial-update test failed; every other
`TestUpdateTicket_*` test — including
`TestUpdateTicket_AbsentFieldLeavesValueUnchanged` (which only
exercises title's own absence, unaffected by this specific break) and
`TestUpdateTicket_BumpsUpdatedAtButNotCreatedAt` (also title-only) —
stayed green, isolating the break precisely to the four refinement
fields' own "absent" handling. Reverted (`diff` against the saved
pre-break copy showed no difference); the confirming green run is
"Observed results" above.

**2. Swiftlet's save handler broken** (`TicketDetail.tsx`'s
`handleSave` changed to call `onSave({})` — an empty patch — instead
of the actual edited field values, simulating a real regression where
Save silently discards the Owner's edits):

Unit level:

```
$ npm run test -- --run
 FAIL  src/components/TicketDetail.test.tsx > TicketDetail > saves the edited fields and returns to view mode showing the saved values
 FAIL  src/components/TicketDetailPage.test.tsx > TicketDetailPage > saves an edit through PATCH /api/tickets/:id and shows the updated Ticket
 Test Files  2 failed | 6 passed (8)
      Tests  2 failed | 43 passed (45)
```

Browser level, same break, full suite:

```
$ cd e2e && ./run.sh
...
[run.sh] running tests/ticket-refinement-before.spec.ts (edits title and manual refinement fields)
  ✘ the title and manual refinement fields, edited from the full page, survive a Galley restart
...
[run.sh] running tests/ticket-refinement-after.spec.ts against the restarted galley
  ✘ the edited title and manual refinement fields are still there after a Galley restart
...
[run.sh] running tests/ticket-refinement.spec.ts against the restarted galley
  ✘ capturing a title-only Ticket, then filling in the title and all four refinement fields, persists across reload
  ✘ clearing the title is rejected with Galley's own message, shown verbatim
  ✘ an over-length field is rejected with Galley's own message, and clearing a set field persists after reload
  1 passed (Cancel discards unsaved edits -- unaffected, since it never calls onSave)
[run.sh] ticket-refinement-before.spec.ts exit code: 1
[run.sh] ticket-refinement-after.spec.ts exit code: 1
[run.sh] ticket-detail.spec.ts exit code: 0
[run.sh] ticket-refinement.spec.ts exit code: 1
[run.sh] SUITE FAILED
```

Exactly the new specs failed — every unrelated spec (`status`, `auth`,
`session-restart-*`, `ticket-persistence-*`, `ticket-detail.spec.ts`,
`backend-failure.spec.ts`) stayed green, and within
`ticket-refinement.spec.ts` itself, the one spec that never calls
`onSave` (Cancel) stayed green while the other three failed. `lsof -i
-P` showed no orphaned process after this failed run either. Both
breaks were reverted (`diff` against saved pre-break copies showed no
difference in either file) and the confirming green runs are the
"Observed results" sections above (Swiftlet's 45/45 and the full
`SUITE PASSED` browser run).

**3. Ordering hazard caught during development, not a deliberate
proof-of-failure break, but recorded because it is exactly the kind of
mistake "prove the suite can fail" is meant to catch:** the first
version of `run.sh` ran `ticket-refinement-before.spec.ts` *after*
`ticket-persistence-before.spec.ts`. Because list order is by
`created_at` (`apps/galley/README.md`, "Ticket ordering"), refinement's
own newly-captured Ticket became the list's newest entry, which broke
`ticket-persistence-after.spec.ts`'s unrelated assertion about which
two Tickets are newest:

```
Error: expect(locator).toHaveText(expected) failed
Locator:  locator('[data-testid="ticket-title"]').first()
Expected: "ticket-persistence: second Ticket"
Received: "ticket-refinement: before restart (edited)"
```

This was fixed by reordering the two "before" specs (refinement now
runs first, so its Ticket sorts older than persistence's two) rather
than by weakening either assertion — see `e2e/run.sh`'s comment at
that phase for the reasoning. Re-running the full suite afterward
confirmed both specs green together (see "Observed results").

## Implementation limitations and follow-ups

- **`UpdateTicket`'s Owner-scoping and 404-parity tests exercise the
  singleton Owner's own scoping query with a synthetic bogus owner id**
  — the same limitation `#56` and `#57`'s evidence records already
  accepted for `ListTickets`/`GetTicket`, applied consistently to this
  new operation, not a new gap. A true second-Owner end-to-end proof
  needs multi-Owner support, out of M2's scope.
- **The Swiftlet edit form always submits all five fields together**,
  rather than only the ones the Owner actually changed. This is a UI
  choice, not a contract limitation: the endpoint's genuine
  partial-update behavior (absent vs. empty vs. text) is fully
  implemented and is proven directly by Galley's own tests per ADR
  0001, which is what the issue's acceptance criteria actually
  require ("direct API requests obey them"). A future slice could make
  the form itself send a true diff if there is a concrete reason to
  (e.g. reducing payload size), but nothing here requires that -- and
  every field is trimmed before comparison in the same way it always
  was.
- No other required behavior in issue #58 was left unimplemented;
  every acceptance criterion is satisfied and verified above:
  - All four fields plus the title are editable by hand and persist
    across reload (`ticket-refinement.spec.ts`) and a backend restart
    (`ticket-refinement-before/after.spec.ts`).
  - The guidance prompts match `docs/ticket-creation.md` verbatim,
    asserted at the unit level (`TicketDetail.test.tsx`) and the
    browser level (`ticket-refinement.spec.ts`).
  - No AI, no external calls, and no automation is involved in
    refinement — Save performs exactly one `PATCH` request with
    exactly what the Owner typed; nothing else is triggered anywhere
    in this diff.
  - Galley validates and owns every rule; direct API requests obey
    them, proven by 18 new Go tests against the real HTTP handler and
    real PostgreSQL, none of which go through Swiftlet.
  - Field limits (Decision 3) and the concurrent-edit rule (Decision
    2) are documented here, in `contracts/openapi.yaml`, and in
    `apps/galley/internal/httpapi/ticket.go`'s comments.

## Outstanding checks and owning milestone

- **CI automation** of the commands recorded here — no owning issue
  yet, unchanged from every prior M2 slice's own recorded limitation.
- **Agent-readiness validation** of `goal`/`successCriteria` (whether
  they are populated enough to authorize agent execution) —
  explicitly **M4**'s, per issue #58's own scope statement; this slice
  stores and validates length only, never readiness.
- **Grill Mode** and any AI-assisted refinement — **M7**, per issue
  #58's own scope statement; no placeholder for it exists anywhere in
  this diff.
- **Templates** (`#59`), **Status transitions** (`#60`), **status
  controls** (`#61`) — this slice added no column, endpoint, or UI
  affordance anticipating any of them.
- **Report rendering of these fields as Markdown** — explicitly out of
  scope for M2 (this slice renders and stores plain text only,
  verbatim, with no Markdown parsing anywhere); **M7** owns report
  rendering, per issue #58's own instruction.

## Decision impacts (open-decision IDs)

None of D1, D2, D4–D9 are resolved or touched by this slice. D3 is
unrelated — this slice has no Agent, Round, or execution concept, per
M2's scope rule. This record's decision-relevant content is entirely
the four engineering choices this slice made and records above
(pointer-based partial-update representation, last-write-wins
concurrency with no optimistic check, the four fields' length limits,
and counting length in characters rather than bytes) — none of them is
an open product decision requiring D-series resolution. This slice
provisions no paid resource and creates no provider account, per
`AGENTS.md`'s "Paid resources" rule.
