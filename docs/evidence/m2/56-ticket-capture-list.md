# Title-only Backlog capture and the persisted Ticket list

## Purpose

Add ticketIt's first domain record: the Ticket. A title alone captures
a Ticket in Backlog through Galley's own API, and the signed-in Owner
sees a persisted, ordered list in Swiftlet. Everything before this
slice was plumbing (status, PostgreSQL, sign-in) — this is the first
slice that puts a real domain record on screen. Touches `contracts/`,
`apps/galley`, `apps/swiftlet`, and `e2e/`. Tracking issue:
[#56 — M2.8 — Title-only Backlog capture and the persisted Ticket
list](https://github.com/cristoforows/ticketIt/issues/56), under
[M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3). Blocked
by [#55](https://github.com/cristoforows/ticketIt/issues/55), merged
before this slice began.

## What already existed

- `apps/galley`: `GET /api/status` (with a live database-health field),
  `GET`/`POST /api/dev/diagnostic-notes`, the whole OAuth/session
  surface (`start`/`callback`/`GET`/`DELETE /api/session`), and
  `requireSession` as the established per-handler authentication gate.
  Two migrations (`diagnostic_notes`; `owners`/`owner_identities`/
  `sessions`/`oauth_states`). No domain/Ticket table, and no table with
  an `owner_id` foreign key yet — every prior table was either
  development-only (`diagnostic_notes`) or identity/session
  infrastructure itself.
- `apps/swiftlet`: `App.tsx` renders exactly one of loading / sign-in
  page / authenticated shell / error, based on `GET /api/session`.
  `AppShell` shows the signed-in Owner, a sign-out button, and the
  pre-existing `StatusView`. No Ticket concept, no list view, no form.
- `e2e/`: `run.sh` (reset DB, migrate, build+start Galley and the
  substitute GitHub provider, build+serve Swiftlet, run specs, tear
  down), `tests/status.spec.ts`, `tests/auth.spec.ts`,
  `tests/session-restart-before/after.spec.ts` (the Galley-restart
  pattern this slice's own persistence specs reuse), and
  `tests/backend-failure.spec.ts`. No spec had ever needed real domain
  test data before this slice — `e2e/support/` held only `sign-in.ts`.
- `contracts/openapi.yaml` described five operations and no Ticket
  schema. `CONTEXT.md`'s `Status` vocabulary (`Backlog`, `Ready`, `In
  Progress`, `In Review`, `Done`, `Blocked`) existed only as prose, not
  as a persisted value anywhere.
- No sibling slice was landing in parallel that this slice depended on.

## What this slice added

### Contract (`contracts/openapi.yaml`)

- `Ticket` schema: `id`, `title`, `status` (inline enum — see "Status
  enum" below), `createdAt`, `updatedAt`. `additionalProperties: false`
  and no `ownerId`/work-type/category field, matching
  `docs/ticket-creation.md`'s "Flexible ticket structure."
- `TicketList` (`{ tickets: Ticket[] }`) and `CreateTicketRequest`
  (`{ title: string }`, `minLength: 1`, `maxLength: 200` — documentation
  for generated-client consumers; the actual enforcement is in Galley's
  handler, see below).
- `GET`/`POST /api/tickets`, both tagged `tickets`, both documented as
  requiring a valid session (`401 unauthenticated` otherwise) and both
  described in full detail in their `description` fields (ordering,
  validation, Backlog-only, no work-type).

**Status enum, engineering choice:** `Ticket.status` is an *inline*
enum on the `Ticket` schema (`enum: [Backlog]`), not a top-level shared
schema listing every `CONTEXT.md` Status name. This slice's Galley code
is the only writer of this table (ADR 0001) and only ever writes
`Backlog` — listing `Ready`/`In Progress`/etc. now, before any code
path can produce them, would be exactly the kind of forward placeholder
the issue explicitly forbids ("Do not add placeholders that imply
[transitions, Assignee, etc.]"). Extending the enum is an ordinary,
small, additive contract change `#60` makes when it adds transitions —
consistent with how `StatusResponse.status`/`DatabaseStatus.status`
already only enumerate values this codebase currently produces.

### Galley (`apps/galley`)

- **Migration** `internal/migrations/000003_create_tickets.up.sql`:
  `tickets(id, owner_id REFERENCES owners(id), title, status, created_at,
  updated_at)` plus `tickets_owner_id_created_at_id_idx (owner_id,
  created_at DESC, id DESC)` backing the documented list order.
  `status` is plain `TEXT`, not `CHECK`-constrained — see "Status
  column, engineering choice" below.
- **`internal/httpapi/ticket.go`** (new): `ListTickets`/`CreateTicket`,
  hand-rolled against `*pgxpool.Pool` like `diagnostic.go` — one new
  table does not yet justify a repository layer (same reasoning
  `apps/galley/README.md` already gives for `diagnostic.go`). Both call
  `requireSession` first, matching the established authenticated-route
  convention.
- **Validation**: title is decoded from JSON, trimmed
  (`strings.TrimSpace`), and must be non-empty and ≤200 characters
  after trimming; every violation is `400 invalid_request` in the
  shared error shape. Malformed JSON is also `invalid_request`,
  matching `diagnostic.go`'s existing convention for the same failure
  mode.
- **Ownership**: `CreateTicket` inserts with `owner_id` set to the
  resolved session's Owner id; `ListTickets` scopes its query to
  `WHERE owner_id = $1`. A request with no valid session cookie never
  reaches either query (`requireSession` writes `401` and returns
  first).
- **Ordering**: `created_at DESC, id DESC`. `id` (monotonic via
  `GENERATED ALWAYS AS IDENTITY`) is the tiebreak because `created_at`
  alone is not a safe sort key — nothing prevents two rows sharing a
  timestamp at whatever resolution the database clock offers.
- Route registration: `mux.HandleFunc("/api/tickets",
  methodNotAllowedHandler("GET", "POST"))` added to
  `internal/httpapi/handler.go`, matching every other route's
  method-mismatch handling.
- Regenerated `internal/httpapi/api.gen.go` via `go generate ./...`
  (oapi-codegen v2.8.0, unchanged pin) — `Ticket`, `TicketStatus`
  (with generated const `Backlog`), `TicketList`, `CreateTicketRequest`,
  and the `ListTickets`/`CreateTicket` `ServerInterface` methods.
- **Tests** (`internal/httpapi/ticket_test.go`, all against real
  PostgreSQL): title-only capture produces Backlog; trimming; blank
  title rejected (empty, all-whitespace, tab/newline-whitespace);
  title over 200 chars rejected; title at exactly 200 chars accepted;
  malformed JSON rejected; both operations require a session (`401`
  with no cookie); newest-first ordering proven end-to-end through two
  real sequential HTTP creates; the `id DESC` tiebreak proven directly
  against `listTicketsForOwner` with two rows inserted with an
  identical `created_at` (real sequential HTTP requests essentially
  never collide on their own); database-unavailable returns
  `503 database_unavailable` for both operations; unknown method is
  `405 method_not_allowed`. `contract_test.go` gained
  `TestTickets_ResponseMatchesContract`, validating both operations'
  real responses against the contract the same way the pre-existing
  operations are validated.
- **Ownership-scoping test, engineering choice
  (`TestListTicketsForOwner_ScopedToOwner`):** `owners` is a true
  one-row-per-deployment singleton (`owners_singleton_uq`), and
  `auth_test.go`'s pre-existing `TestOAuthSignIn_HappyPath` asserts
  `select count(*) from owners` is exactly `1` against this same
  shared, persistent `ticketit_test` database. A first attempt at this
  test constructed a second, synthetic `owners` row directly (bypassing
  `auth.ResolveOwner`, which enforces that same singleton and would
  reject a second identity outright) to exercise cross-owner scoping —
  this broke `TestOAuthSignIn_HappyPath` on the very next `go test`
  run, and, because `ticketit_test` is never reset between runs, left a
  second permanent row that had to be cleaned up by hand (`DELETE FROM
  tickets/sessions/owner_identities/owners WHERE owner_id = 2`) before
  the suite was green again. The test was redesigned instead to query
  `listTicketsForOwner` with a synthetic owner id that can never belong
  to any real Owner (small, sequential integers; the test id is offset
  `+1_000_000_000`) and assert a real Owner's Ticket is never returned
  for it — this proves the `WHERE owner_id = $1` filter is real (a
  regression to an unscoped `SELECT * FROM tickets` would fail it
  immediately) without ever touching the `owners` table. This
  incident and its fix are recorded here rather than silently
  corrected, per `AGENTS.md`'s honesty expectation.

### Swiftlet (`apps/swiftlet`)

- **`src/api/tickets.ts`** (new): `fetchTickets()`
  (`GET /api/tickets`) and `createTicket(title)` (`POST /api/tickets`),
  both typed against the generated `Ticket` schema. Reuses
  `src/api/session.ts`'s `UnauthenticatedError` exactly — a `401` from
  either call is the same "return to the sign-in page" signal every
  other authenticated call in this app already uses; this slice does
  not invent a second convention. `createTicket` surfaces Galley's own
  `error.message` on a non-2xx response (e.g. a blank or over-length
  title) rather than a generic status line, since the caller is an
  inline capture form the Owner is actively filling in.
- **`src/components/TicketList.tsx`** (new): fetches the list on mount
  and renders exactly one of loading / an explicit error state / an
  empty state / the list, in whatever order Galley returned (this
  component never re-sorts). A one-field form above it is the whole of
  quick capture — a title input (disabled while submitting,
  `maxLength` mirroring Galley's 200) and a submit button disabled
  until the trimmed title is non-empty. **No manual reload after
  capture:** a successful `POST` clears the input and re-fetches the
  list; Galley alone decides where the new Ticket sorts. A rejected
  capture shows Galley's message inline and leaves the list exactly as
  it was (no re-fetch, since nothing changed).
- Mounted in `AppShell.tsx`, above the pre-existing `StatusView`.
- Regenerated `src/api/generated/schema.d.ts` via `contracts`' own
  toolchain (`openapi-typescript` 7.13.0, unchanged pin).
- **Tests**: `src/components/TicketList.test.tsx` (new) — loading,
  empty state, rendering every Ticket in the order returned, an
  explicit error state on fetch failure, the submit button disabled
  until a non-blank title is entered, a successful capture clearing the
  input and showing the refreshed list, and a rejected capture showing
  Galley's own message while leaving the list unchanged. `App.test.tsx`
  and `AppShell.test.tsx` were retrofitted to also stub `GET
  /api/tickets` (an empty list), since `AppShell` now mounts
  `TicketList` unconditionally alongside `StatusView` — the same kind
  of necessary retrofit `#55`'s own evidence record made to
  `status.spec.ts`/`backend-failure.spec.ts` when `App.tsx` grew a
  session gate.

### The browser suite's Ticket data-setup convention (`e2e/`)

This is the slice acceptance criterion 6 calls out specifically: the
first spec needing real domain test data establishes the convention
rather than improvising one.

- **`e2e/support/tickets.ts`** (new): `createTicket(page, title)` posts
  through `page.request` (which shares cookie storage and `baseURL`
  with the signed-in `page`'s own browser context), reaching Galley's
  real API exactly as the signed-in browser would — never writing to
  PostgreSQL directly (ADR 0001). Documented as the tool for a spec
  that needs Tickets to exist as *background* data, not as the
  behavior under test.
- **`tests/ticket-persistence-before.spec.ts`** / **`...-after.spec.ts`**
  (new): the required browser spec. Reuses
  `session-restart-before.spec.ts`'s saved storage state and the one
  Galley restart `run.sh` already performs in that phase (`e2e/README.md`,
  "Adding a spec": "the spec cannot restart a process it did not
  start") rather than requesting a second restart. The "before" half
  calls `createTicket` once for an unrelated pre-existing Ticket (so
  the ordering assertion proves "newest first" against a non-empty
  list, exercising the new helper), then drives the real quick-capture
  form twice — filling and submitting `ticket-title-input` /
  `ticket-capture-submit` — for the two Tickets under test, and asserts
  the newest-first order via `[data-testid="ticket-title"]`. The
  "after" half, running against the freshly restarted Galley, asserts
  the exact same two Tickets are still listed in the same order. The
  two fixed Ticket titles are duplicated as local constants in each
  file rather than imported (each half is a separate `playwright test`
  process invocation), matching the existing session-restart pair's own
  convention of hardcoding the fixture owner's login independently in
  each half.
- **`e2e/run.sh`**: extended the existing restart phase (10) with the
  two invocations above, one on each side of the restart, and extended
  the final exit-code check accordingly. No second restart was added.
- **`e2e/README.md`**: "Adding a spec" gained a new "Creating test
  data" subsection with the worked example above, so the next slice
  (`#59`/`#60`/`#61`) copies it instead of re-deriving the convention
  from prose.

### Documentation

- `apps/galley/README.md`: new "Tickets (issue #56)" section (table
  shape, Backlog-only/no-CHECK-constraint reasoning, title validation
  and the 200-character limit's reasoning, ordering/tiebreak reasoning,
  ownership and the scoping-test redesign), updated intro paragraph
  chain and layout diagram.
- `apps/swiftlet/README.md`: new "The Ticket list and quick capture
  (issue #56)" section, updated intro paragraph and "Browser-to-backend
  suite" section.
- `e2e/README.md`: "Adding a spec" gained "Creating test data" (above).

## Status column and enum: engineering choices, in full

**Database (`tickets.status TEXT`, no `CHECK` constraint):** this
slice's Galley code is the only writer of this table (ADR 0001) and
only ever writes `'Backlog'`. A `CHECK` enumerating every `CONTEXT.md`
Status name today would duplicate that enforcement now and need its
own forward-only migration the moment `#60` adds real transitions,
for no correctness benefit in the meantime (nothing else can write to
this table). Plain `TEXT` costs nothing today and is a strict subset of
what `#60`'s migration will need to add regardless (either a `CHECK`
listing every real status, or none at all if transitions are validated
purely in application code — an open engineering choice for that
slice, not this one).

**Contract (`Ticket.status` inline enum, `enum: [Backlog]`):** mirrors
the database choice for the same reason, and matches this codebase's
existing convention of enumerating only values a schema's producer
currently emits (`StatusResponse.status`, `DatabaseStatus.status`,
`StatusResponse.environment` are all fully "used" enums, never
speculative). Extending an enum is an ordinary additive contract change
(`contracts/README.md`'s "contract first" convention already covers
it) — not a barrier `#60` will need to work around.

**Title maximum length (200 characters, after trimming):** chosen as a
round number comfortably longer than a real one-line title (the
"Fix login bug on Safari" example in `docs/ticket-creation.md` is 24
characters) while staying under the limits GitHub (256) and Jira (255)
use for the same kind of field. Enforced only in Galley's handler
(`ticketTitleMaxLength`, `internal/httpapi/ticket.go`) — the contract's
`maxLength: 200` is documentation for generated-client consumers, not
runtime validation, consistent with how `CreateDiagnosticNoteRequest`'s
`minLength: 1` was already documentation only (`diagnostic.go`'s own
`if req.Note == ""` check is the actual enforcement).

## Exact versions and toolchain

- Go `go1.27.1 darwin/arm64` — unchanged.
- Node `v26.9.0`, npm `11.19.1` — unchanged.
- `apps/galley`: no new runtime dependency. `ticket.go` uses only the
  standard library (`context`, `encoding/json`, `fmt`, `net/http`,
  `strings`, `time`) plus `pgx/v5`, already present. `oapi-codegen`
  `v2.8.0` (unchanged pin) regenerated `api.gen.go`;
  `github.com/getkin/kin-openapi` `v0.149.0` (unchanged) validates the
  new contract test.
- `apps/swiftlet`: no new dependency. `tickets.ts`/`TicketList.tsx`/
  `TicketList.test.tsx` use only React, `@testing-library/react`, and
  Vitest, all already present. `openapi-typescript` `7.13.0` (unchanged
  pin, `contracts/package.json`) regenerated `schema.d.ts`.
- `e2e`: `@playwright/test` `1.63.0` — unchanged. Chromium's headless
  shell only (`--only-shell`), same as `#53`/`#55`.
- PostgreSQL server: `17.11` (Homebrew), `localhost:5432`. This
  record's Go-side verification used `ticketit_test` (real, shared,
  never reset — see "Ownership-scoping test" above for the one
  incident this caused and its fix); the browser-suite runs used
  `ticketit_e2e`, reset from empty by `run.sh` itself each time, as
  always. `ticketit_dev` and `ticketit_m1_native` were untouched
  throughout.

## Reproducible commands

**Galley** (from `apps/galley/`, real PostgreSQL):

```sh
gofmt -l .
go vet ./...
go build ./...
go test ./... -v -count=1
./scripts/check-contract-drift.sh
```

**Swiftlet** (from `apps/swiftlet/`):

```sh
npm ci
npm run test -- --run
npm run build
```

**Contract drift, Swiftlet side** (from `contracts/`):

```sh
npm ci
./check-swiftlet-drift.sh
```

**Browser suite** (from `e2e/`):

```sh
./run.sh
```

## Observed results

### `gofmt` / `go vet` / `go build`

```
$ gofmt -l .
(no output — clean)
$ go vet ./...
(no output — clean)
$ go build ./...
(no output — success)
```

### `go test ./... -v -count=1` — 100 subtests, 0 failures

```
=== RUN   TestRun_ConfigurationFailure
--- PASS: TestRun_ConfigurationFailure (0.00s)
=== RUN   TestRun_ServesStatusThenShutsDownCleanly
--- PASS: TestRun_ServesStatusThenShutsDownCleanly (0.02s)
=== RUN   TestRestartDurability_DiagnosticNoteSurvivesFreshProcess
--- PASS: TestRestartDurability_DiagnosticNoteSurvivesFreshProcess (0.63s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	0.995s
=== RUN   TestRun_ServesFakeProviderUntilContextCanceled
--- PASS: TestRun_ServesFakeProviderUntilContextCanceled (0.00s)
=== RUN   TestRun_WritesAddrFileWhenConfigured
--- PASS: TestRun_WritesAddrFileWhenConfigured (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	0.476s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/auth	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/authtest	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.169s	(21 subtests, all PASS, unchanged by this slice)
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	0.606s	(2 subtests, all PASS, unchanged)
=== RUN   TestOAuthSignIn_HappyPath
--- PASS: TestOAuthSignIn_HappyPath (0.03s)
(... every other pre-existing #52/#54 auth/contract/diagnostic/routing subtest, all PASS, unchanged by this slice ...)
=== RUN   TestTickets_ResponseMatchesContract
--- PASS: TestTickets_ResponseMatchesContract (0.01s)
=== RUN   TestCreateTicket_TitleOnlyCapturesBacklog
--- PASS: TestCreateTicket_TitleOnlyCapturesBacklog (0.01s)
=== RUN   TestCreateTicket_TrimsTitle
--- PASS: TestCreateTicket_TrimsTitle (0.01s)
=== RUN   TestCreateTicket_RejectsBlankTitle
=== RUN   TestCreateTicket_RejectsBlankTitle/blank_
=== RUN   TestCreateTicket_RejectsBlankTitle/blank_#01
=== RUN   TestCreateTicket_RejectsBlankTitle/blank_#02
--- PASS: TestCreateTicket_RejectsBlankTitle (0.01s)
    --- PASS: TestCreateTicket_RejectsBlankTitle/blank_ (0.00s)
    --- PASS: TestCreateTicket_RejectsBlankTitle/blank_#01 (0.00s)
    --- PASS: TestCreateTicket_RejectsBlankTitle/blank_#02 (0.00s)
=== RUN   TestCreateTicket_RejectsTitleOverMaxLength
--- PASS: TestCreateTicket_RejectsTitleOverMaxLength (0.01s)
=== RUN   TestCreateTicket_AcceptsTitleAtMaxLength
--- PASS: TestCreateTicket_AcceptsTitleAtMaxLength (0.01s)
=== RUN   TestCreateTicket_RejectsMalformedJSON
--- PASS: TestCreateTicket_RejectsMalformedJSON (0.01s)
=== RUN   TestCreateTicket_RequiresSession
--- PASS: TestCreateTicket_RequiresSession (0.00s)
=== RUN   TestListTickets_RequiresSession
--- PASS: TestListTickets_RequiresSession (0.00s)
=== RUN   TestListTickets_NewestFirstWithIdTiebreak
--- PASS: TestListTickets_NewestFirstWithIdTiebreak (0.01s)
=== RUN   TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies
--- PASS: TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies (0.01s)
=== RUN   TestListTicketsForOwner_ScopedToOwner
--- PASS: TestListTicketsForOwner_ScopedToOwner (0.01s)
=== RUN   TestTickets_DatabaseUnavailable
=== RUN   TestTickets_DatabaseUnavailable/list
=== RUN   TestTickets_DatabaseUnavailable/create
--- PASS: TestTickets_DatabaseUnavailable (0.00s)
=== RUN   TestTickets_MethodNotAllowed
--- PASS: TestTickets_MethodNotAllowed (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	1.042s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	[no test files]
```

57 top-level `--- PASS` lines plus 43 subtest `--- PASS` lines = 100
total, 0 `FAIL`. Full untrimmed transcript is reproducible with the
command above.

### Contract-response validation and both drift checks

```
$ cd apps/galley && go test ./internal/httpapi/... -run Contract -v
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.03s)
=== RUN   TestGetStatus_DatabaseUnreachableResponseMatchesContract
--- PASS: TestGetStatus_DatabaseUnreachableResponseMatchesContract (0.00s)
=== RUN   TestDiagnosticNotes_ResponseMatchesContract
--- PASS: TestDiagnosticNotes_ResponseMatchesContract (0.02s)
=== RUN   TestTickets_ResponseMatchesContract
--- PASS: TestTickets_ResponseMatchesContract (0.02s)
=== RUN   TestGetSession_ResponseMatchesContract
--- PASS: TestGetSession_ResponseMatchesContract (0.02s)
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
🚀 openapi.yaml → ../apps/swiftlet/src/api/generated/schema.d.ts [16ms]
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

### Swiftlet: install, test, build

```
$ npm ci
added 108 packages, and audited 109 packages in 749ms
found 0 vulnerabilities

$ npm run test -- --run
 Test Files  5 passed (5)
      Tests  21 passed (21)

$ npm run build
✓ 22 modules transformed.
dist/index.html                  0.31 kB │ gzip:  0.22 kB
dist/assets/index-eWF_dGu2.js  227.63 kB │ gzip: 70.65 kB
✓ built in 51ms
```

108 packages — identical to `#55`'s baseline; no new dependency. 21
tests across 5 files: `App.test.tsx` (4), `AppShell.test.tsx` (4),
`SignInPage.test.tsx` (1), `StatusView.test.tsx` (5),
`TicketList.test.tsx` (7, new).

### Browser suite — `SUITE PASSED`, 9 specs across 7 files

```
$ cd e2e && ./run.sh
...
[run.sh] running tests/status.spec.ts against a live galley
  ✓  1 [chromium] › tests/status.spec.ts:20:1 › status page displays the values Galley actually returns (864ms)
[run.sh] running tests/auth.spec.ts against a live galley and the substitute GitHub provider
  ✓  1 [chromium] › tests/auth.spec.ts:11:3 › sign-in › the Owner can sign in with GitHub and sees the authenticated shell (161ms)
  ✓  2 [chromium] › tests/auth.spec.ts:19:3 › sign-in › the session survives a page reload (129ms)
  ✓  3 [chromium] › tests/auth.spec.ts:29:3 › sign-in › sign-out revokes the session through Galley and returns to the sign-in page (168ms)
  ✓  4 [chromium] › tests/auth.spec.ts:45:3 › sign-in › a non-owner identity is rejected with Galley's own reason, and no authenticated shell renders (113ms)
[run.sh] running tests/session-restart-before.spec.ts (signs in, saves storage state)
  ✓  1 [chromium] › tests/session-restart-before.spec.ts:20:1 › the Owner signs in before Galley restarts (157ms)
[run.sh] running tests/ticket-persistence-before.spec.ts (captures two Tickets, newest first)
  ✓  1 [chromium] › tests/ticket-persistence-before.spec.ts:29:1 › the Owner captures two Tickets, newest first, before Galley restarts (237ms)
[run.sh] restarting galley (same database, same origin, new process) to prove the session and Tickets survive
[run.sh] galley ready (pid 53637)
[run.sh] running tests/session-restart-after.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/session-restart-after.spec.ts:21:1 › the session survives a Galley restart (86ms)
[run.sh] running tests/ticket-persistence-after.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/ticket-persistence-after.spec.ts:25:1 › the two captured Tickets are still listed, in the same order, after a Galley restart (92ms)
[run.sh] stopping galley to exercise the failure-mode spec (pid 53637)
[run.sh] running tests/backend-failure.spec.ts against a stopped galley
  ✓  1 [chromium] › tests/backend-failure.spec.ts:28:1 › the app shows its error state when Galley is stopped, instead of a blank or fabricated page (108ms)
[run.sh] status.spec.ts exit code: 0
[run.sh] auth.spec.ts exit code: 0
[run.sh] session-restart-before.spec.ts exit code: 0
[run.sh] ticket-persistence-before.spec.ts exit code: 0
[run.sh] session-restart-after.spec.ts exit code: 0
[run.sh] ticket-persistence-after.spec.ts exit code: 0
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE PASSED
[run.sh] stopping swiftlet preview server (pid 53386)
[run.sh] stopping the substitute GitHub provider (pid 53351)
```

`lsof -i -P` immediately after exit showed no `galley`/`githubfake`/
`vite`/`node` listener left behind, both after this run and after every
deliberately-broken run below.

## Proof the suite can fail

Three separate, targeted, reverted breaks against real code — two at
the Go level (one validation, one ownership, both against the real,
shared `ticketit_test` database), one at the browser level — each
capturing the actual red output, each reverted (confirmed via `git
diff --stat` showing no diff against the committed file), followed by
a confirming green run.

**1. Ownership check removed** (`ListTickets` temporarily changed to
skip `requireSession` entirely, using a hardcoded `ownerID` of `0`
instead of the resolved session's Owner):

```
$ go test ./internal/httpapi/... -run 'TestListTickets|TestTickets_ResponseMatchesContract' -v
=== RUN   TestTickets_ResponseMatchesContract
--- PASS: TestTickets_ResponseMatchesContract (0.04s)
=== RUN   TestListTickets_RequiresSession
    ticket_test.go:274: status = 200, want 401; body={"tickets":[]}
--- FAIL: TestListTickets_RequiresSession (0.01s)
=== RUN   TestListTickets_NewestFirstWithIdTiebreak
    ticket_test.go:310: expected both tickets (older id=59, newer id=60) in the list of 0 tickets
--- FAIL: TestListTickets_NewestFirstWithIdTiebreak (0.02s)
=== RUN   TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies
--- PASS: TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies (0.01s)
=== RUN   TestListTicketsForOwner_ScopedToOwner
--- PASS: TestListTicketsForOwner_ScopedToOwner (0.01s)
FAIL
```

Exactly the two tests that depend on `ListTickets` actually enforcing a
session/owner failed; the two tests that call `listTicketsForOwner`
directly (bypassing the broken handler) correctly stayed green, showing
the break was isolated to the handler, not the query.

**2. Title validation removed** (`CreateTicket` temporarily accepted
`req.Title` untrimmed and unchecked — no non-empty check, no length
limit):

```
$ go test ./internal/httpapi/... -run 'TestCreateTicket' -v
=== RUN   TestCreateTicket_TitleOnlyCapturesBacklog
--- PASS: TestCreateTicket_TitleOnlyCapturesBacklog (0.03s)
=== RUN   TestCreateTicket_TrimsTitle
    ticket_test.go:123: Title = "  ticket_test-TestCreateTicket_TrimsTitle-32e923eeef52c919  \t", want trimmed "ticket_test-TestCreateTicket_TrimsTitle-32e923eeef52c919"
--- FAIL: TestCreateTicket_TrimsTitle (0.02s)
=== RUN   TestCreateTicket_RejectsBlankTitle
=== RUN   TestCreateTicket_RejectsBlankTitle/blank_
    ticket_test.go:150: status = 201, want 400; body={"createdAt":"2026-09-21T18:10:02Z","id":66,"status":"Backlog","title":"","updatedAt":"2026-09-21T18:10:02Z"}
=== RUN   TestCreateTicket_RejectsBlankTitle/blank_#01
    ticket_test.go:150: status = 201, want 400; body={"createdAt":"2026-09-21T18:10:02Z","id":67,"status":"Backlog","title":"   ","updatedAt":"2026-09-21T18:10:02Z"}
=== RUN   TestCreateTicket_RejectsBlankTitle/blank_#02
    ticket_test.go:150: status = 201, want 400; body={"createdAt":"2026-09-21T18:10:02Z","id":68,"status":"Backlog","title":"\t\n ","updatedAt":"2026-09-21T18:10:02Z"}
--- FAIL: TestCreateTicket_RejectsBlankTitle (0.02s)
=== RUN   TestCreateTicket_RejectsTitleOverMaxLength
    ticket_test.go:184: status = 201, want 400; body={...199 chars omitted...}
--- FAIL: TestCreateTicket_RejectsTitleOverMaxLength (0.01s)
=== RUN   TestCreateTicket_AcceptsTitleAtMaxLength
--- PASS: TestCreateTicket_AcceptsTitleAtMaxLength (0.01s)
=== RUN   TestCreateTicket_RejectsMalformedJSON
--- PASS: TestCreateTicket_RejectsMalformedJSON (0.01s)
=== RUN   TestCreateTicket_RequiresSession
--- PASS: TestCreateTicket_RequiresSession (0.01s)
FAIL
```

Exactly the tests exercising trimming/blank/over-length titles failed;
malformed-JSON and session-requirement (unrelated validations) stayed
green, showing the break was isolated to the specific validation rule
removed. (Leftover invalid rows this run created in `ticketit_test`
were deleted by hand afterward — see "Exact versions" above.)

**3. Ticket ordering reversed** (`listTicketsForOwner`'s `ORDER BY
created_at DESC, id DESC` temporarily changed to `ASC, ASC`):

```
$ go test ./internal/httpapi/... -run 'TestListTickets' -v
=== RUN   TestListTickets_RequiresSession
--- PASS: TestListTickets_RequiresSession (0.02s)
=== RUN   TestListTickets_NewestFirstWithIdTiebreak
    ticket_test.go:313: newer ticket (id=81) at index 74 did not come before older ticket (id=80) at index 73 -- want newest first
--- FAIL: TestListTickets_NewestFirstWithIdTiebreak (0.02s)
=== RUN   TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies
    ticket_test.go:353: with tied created_at, higher id 83 at index 76 did not come before lower id 82 at index 75 -- want id DESC to break the tie
--- FAIL: TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies (0.02s)
=== RUN   TestListTicketsForOwner_ScopedToOwner
--- PASS: TestListTicketsForOwner_ScopedToOwner (0.01s)
FAIL
```

Then the full browser suite, with the same break still in place:

```
$ cd e2e && ./run.sh
...
[run.sh] running tests/ticket-persistence-before.spec.ts (captures two Tickets, newest first)
  ✘  1 [chromium] › tests/ticket-persistence-before.spec.ts:29:1 › the Owner captures two Tickets, newest first, before Galley restarts (5.3s)

    Error: expect(locator).toHaveText(expected) failed
    Locator:  locator('[data-testid="ticket-title"]').first()
    Expected: "ticket-persistence: second Ticket"
    Received: "ticket-persistence: pre-existing older Ticket"

[run.sh] restarting galley (same database, same origin, new process) to prove the session and Tickets survive
[run.sh] running tests/session-restart-after.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/session-restart-after.spec.ts:21:1 › the session survives a Galley restart (93ms)
[run.sh] running tests/ticket-persistence-after.spec.ts against the restarted galley
  ✘  1 [chromium] › tests/ticket-persistence-after.spec.ts:25:1 › the two captured Tickets are still listed, in the same order, after a Galley restart (5.1s)

    Error: expect(locator).toHaveText(expected) failed
    Locator:  locator('[data-testid="ticket-title"]').first()
    Expected: "ticket-persistence: second Ticket"
    Received: "ticket-persistence: pre-existing older Ticket"

[run.sh] status.spec.ts exit code: 0
[run.sh] auth.spec.ts exit code: 0
[run.sh] session-restart-before.spec.ts exit code: 0
[run.sh] ticket-persistence-before.spec.ts exit code: 1
[run.sh] session-restart-after.spec.ts exit code: 0
[run.sh] ticket-persistence-after.spec.ts exit code: 1
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE FAILED
```

Exactly the two new Ticket specs failed (both, since both depend on the
same documented order); every other spec — including
`session-restart-after.spec.ts`, which shares the same restart phase —
stayed green, and `lsof -i -P` showed no orphaned process after this
run either.

All three breaks were reverted (`git diff --stat
apps/galley/internal/httpapi/ticket.go` showed no output after each
revert, confirming an exact return to the committed version) and the
suite returns to fully green — the "Observed results" transcripts above
are the confirming runs after the last revert.

## Implementation limitations and follow-ups

- **`Ticket.status`'s enum lists only `Backlog`, not every `CONTEXT.md`
  Status name.** This is a deliberate engineering choice (see "Status
  column and enum" above), not a gap: extending it is an ordinary
  additive contract change, owned by **#60** ("Status controls") when
  it adds real transitions.
- **No `CHECK` constraint on `tickets.status`.** Same reasoning — see
  above. **#60** is the natural point to add one if that slice's design
  wants the database itself to reject an invalid Status string, rather
  than relying solely on Galley being the only writer.
- **`updated_at` has no trigger and no code path ever changes it after
  creation in this slice.** It is set once (equal to `created_at`) and
  exists now so `#60`'s transition endpoint does not need its own
  migration to add it. Not a follow-up in the "missed requirement"
  sense — issue #56 explicitly scopes transitions out — but recorded so
  the next slice knows the column is already there.
- No other required behavior in issue #56 was left unimplemented; every
  acceptance criterion is satisfied and verified above.

## Outstanding checks and owning milestone

- **CI automation** of the commands recorded here — no owning issue
  yet, unchanged from every prior M2 slice's own recorded limitation.
- **Board, modal, Badges, archive** — all explicitly **M3**, per the
  issue's own scope statement; no code here anticipates their shape.
- **Assignee, Template, and Status controls** — **#59**, **#60**,
  **#61** respectively; this slice added no placeholder for any of
  them.
- **Real-provider (github.com) OAuth verification** — unrelated to this
  slice's own changes, still **M10** per `#54`'s original record; this
  slice's tests all sign in against the local substitute provider,
  same as every prior M2 slice.

## Decision impacts (open-decision IDs)

None of D1, D2, D4–D9 are resolved or touched by this slice. D3 is
unrelated — this slice has no Agent, Round, or execution concept, per
M2's scope rule. This record's decision-relevant content is entirely
the engineering choices this slice made and records: the inline
(rather than shared top-level) `TicketStatus` enum listing only
`Backlog`; leaving `tickets.status` as unconstrained `TEXT` rather than
a `CHECK`; the 200-character title maximum and its reasoning;
`created_at DESC, id DESC` as the documented list order; the
API-direct (`page.request`) vs. real-UI-form split for the browser
suite's new Ticket data-setup convention; and reusing the existing
Galley-restart phase for Ticket persistence rather than adding a second
restart. None of these are open product decisions requiring D-series
resolution. This slice provisions no paid resource and creates no
provider account, per `AGENTS.md`'s "Paid resources" rule.
