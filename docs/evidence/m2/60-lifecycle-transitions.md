# Human-assigned lifecycle transitions enforced by Galley

## Purpose

Adds, in Galley only, the Assignee concept for human work and the
authoritative Status state machine implementing the accepted [D3
decision](../../decisions/d3-agent-template-compatibility.md) §2's
human-assigned workflow table and §4's rejections. Touches
`contracts/`, `apps/galley`, and `apps/swiftlet` (only the generated
client and the minimal parsing/fixture changes needed to keep its
build and tests green -- no UI). Tracking issue: [#60 — M2.12 —
Human-assigned lifecycle transitions enforced by
Galley](https://github.com/cristoforows/ticketIt/issues/60), under
[M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3). Blocked
by [#59](https://github.com/cristoforows/ticketIt/issues/59), merged
before this slice began
(`docs/evidence/m2/59-ticket-templates.md`). Swiftlet's own controls
for these commands are [#61](https://github.com/cristoforows/ticketIt/issues/61)
-- explicitly out of scope here.

## What already existed

- **Galley**: `tickets` table with `id` (internal), `owner_id`,
  `title`, `status` (`TEXT`, only ever `'Backlog'`), `public_id`,
  `goal`, `context`, `success_criteria`, `constraints`, `template`,
  `completion_condition`, `repository`, `created_at`/`updated_at`
  (`internal/migrations/000001`–`000006`). `GET`/`POST /api/tickets`,
  `GET`/`PATCH /api/tickets/{id}` (`internal/httpapi/ticket.go`), all
  Owner-scoped via `requireSession`. No Assignee concept, no Status
  transition endpoint of any kind, no Accept command -- `status` was
  produced only as the literal string `'Backlog'` at creation and
  never changed again. No Round, work request, or queue concept
  anywhere in the codebase.
- **Contract**: `Ticket.status` was `enum: [Backlog]` -- a closed
  one-value enum, since nothing ever produced another value.
- **Swiftlet**: `TicketDetail.tsx`/`TicketList.tsx` render `status` as
  plain text with no branching logic; `parseTicket` in
  `src/api/tickets.ts` validates every Ticket field is present and
  correctly typed before returning it.
- **e2e**: existing specs cover capture, refinement, Templates, and
  restart durability; none exercise a Status transition.
- No sibling slice was landing in parallel that this slice depended
  on.

## What this slice added

### Decision 1 — the D3 §2 table encoded as a literal reverse map, not inferred

**Chosen:** `internal/httpapi/ticket_lifecycle.go`'s
`allowedSourceStatusesForTarget` maps each requested **target** Status
to the closed set of **source** Statuses D3 §2 permits moving from --
the table inverted, transcribed cell-by-cell, not generalised:

```go
var allowedSourceStatusesForTarget = map[TicketStatus][]TicketStatus{
	Backlog:    {Ready},
	Ready:      {Backlog, InProgress, Done},
	InProgress: {Ready, Blocked, InReview},
	Blocked:    {InProgress},
	InReview:   {InProgress},
}
```

`Done` has no entry at all -- it is reachable only through explicit
Accept (`decideAccept`), never this map, which is what makes a plain
`POST /api/tickets/{id}/status` targeting `Done` **always** rejected,
regardless of the current Status. `Ready`'s sources deliberately
**exclude** `Blocked` -- D3 permits only `Blocked -> InProgress`, never
a shortcut straight back to `Ready`, which is the one negative property
the issue calls out by name. This is the literal table, not an
inferred generalisation: nine cells, matching the ten D3 S2 rows minus
the one Accept-only row (`InReview -> Done`).

The test suite's own expectation (`ticket_lifecycle_test.go`'s
`d3S2AllowedPlainTransitions`) is a **second, independent**
transcription of the same nine cells, written without reference to
`allowedSourceStatusesForTarget` -- so a bug that miscoded the
production map the same wrong way would not silently agree with itself
the way importing the production var into the test would.

### Decision 2 — Accept is its own command, never a Status write

**Chosen:** `POST /api/tickets/{id}/accept` (`AcceptTicket`) is a
separate generated operation from `POST /api/tickets/{id}/status`
(`ChangeTicketStatus`), per
[docs/contracts/execution-interface.md](../../contracts/execution-interface.md)'s
Swiftlet → Galley owner-command boundary ("accept a Ticket" is listed
as its own representative owner command, distinct from any Status
write). `decidePlainStatusChange` never returns `Done` as a value it
accepts, structurally: `ChangeTicketStatus`'s handler rejects `Done`
before ever consulting `allowedSourceStatusesForTarget`, so no future
edit to that map could accidentally reopen a plain-status path to
completion. `decideAccept` is the only function in this codebase that
can produce `Done`.

### Decision 3 — Accept's two checks are ordered and separately coded: state first, then completion condition

**Chosen:** `decideAccept(current, condition)` checks `current !=
InReview` **first**, returning the generic `invalid_transition` code
regardless of `condition` -- an Accept attempt on a Ticket that isn't
In Review is a state problem, not a completion-condition problem, even
if that Ticket's retained condition happens to be `reviewedPrMerge`.
Only when the Ticket **is** In Review does the completion-condition
check run, rejecting `reviewedPrMerge` with the distinct
`reviewed_pr_merge_not_implemented` code, whose message names **D2**
and **M8** explicitly (docs/decisions/d3-agent-template-compatibility.md,
"Completing human work that requires a reviewed PR merge"). This keeps
"wrong state" and "right state, but this condition can't complete in
M2 yet" distinguishable by a caller matching on `code` alone, and never
silently downgrades `completionCondition` -- there is no write path to
that column anywhere in this file (see `apps/galley/README.md`'s
already-established guarantee from #59, extended by the guardrail
allowlist below).

### Decision 4 — concurrency: one transaction, one row lock, re-evaluated against the fresh row

**Chosen:** `applyTicketTransition` (shared by both `ChangeTicketStatus`
and `AcceptTicket`) opens one transaction, issues `SELECT status,
completion_condition FROM tickets WHERE ... FOR UPDATE`, evaluates the
caller's `decide` closure against exactly that row, and only then
issues the `UPDATE` and commits -- all inside the same transaction.
`FOR UPDATE` holds a row lock for the transaction's whole lifetime: a
second, concurrent call against the same Ticket blocks on its own
`SELECT ... FOR UPDATE` until the first transaction commits or rolls
back, and only then reads the row -- which by then reflects whatever
the first call actually did. This is what makes "two concurrent
conflicting requests cannot both apply" true: whichever call's
transaction commits first is the only one that can ever observe the
Ticket's Status as it was before either call started; the second
necessarily re-evaluates its own requested transition against the
already-changed row. See
`TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies`
and "Proof the suite can fail" below for a captured red run against a
deliberately un-locked, read-then-write version of this same function.

A read-then-write across two separate statements (`pool.QueryRow` then
a later `pool.Exec`/`pool.QueryRow`, no `BEGIN`, no lock) was
considered and rejected -- it is exactly the shape the issue names as
wrong, and "Proof the suite can fail" below demonstrates concretely why
it fails: two concurrent calls can both read the same pre-write status
and both then blindly apply their own update, since nothing in that
shape re-checks the row's status at write time.

### Decision 5 — Assignee: one nullable discriminator column, additive by design, no Round/queue precondition

**Chosen:** `internal/migrations/000007_add_ticket_assignee.up.sql`
adds one nullable `assignee_type TEXT` column -- `NULL` at storage
means "never assigned," backfilled correctly by the column's implicit
`NULL` default (the Assignee concept did not exist before this
migration, so every pre-existing Ticket really was unassigned; no data
migration was needed, matching `goal`/`context`'s own precedent from
#58). No `CHECK` constraint, matching every other enum-like column in
this table (`status`, `template`, `completion_condition`): Galley's own
code is the only writer (ADR 0001) and validates the value set itself.

This is deliberately a **plain, unenumerated string** in the contract
(`Ticket.assigneeType: {type: string}`, not a closed `enum`) -- unlike
`status`/`template`/`completionCondition`. Nothing in this contract
ever *accepts* an assignee-type value from a client: `PUT
/api/tickets/{id}/assignee` and `POST /api/tickets/{id}/accept` etc.
take no body naming it, so there is no request-side enum to validate
against, and the wire value is purely Galley's own read-only report of
internal state. Go code defines the one non-empty value M2 ever writes
(`assigneeTypeOwnerValue = "owner"`) as a private constant, not a
generated enum. A future milestone can introduce an Agent Assignee kind
by adding a new value this same column already accepts syntactically,
plus its own reference column (e.g. `assignee_agent_id`), as a purely
additive migration -- no rewrite of this column, its callers, or the
contract's required-field list.

**No Status precondition on assignment.** D3 §1 states assignment is
permitted "when no Round is open," and M2 never has an open Round at
all (no such concept exists), so `AssignTicketOwner`/`UnassignTicket`
apply unconditionally via a plain `UPDATE`, with no transaction of
their own -- there is no persisted precondition for them to race
against, unlike Status transitions. `TestAssignTicketOwner_AllowedRegardlessOfStatus`
proves this directly against every one of the six Statuses, including
`Done`.

**`Done -> Ready`'s D4 caveat is not enforced.** D3 §2's own table
notes `Done -> Ready` is "Yes, subject to D4 for an already-merged PR."
D4 is explicitly out of scope for this slice (issue #60: "Do not
resolve D2 or D4") and unresolved, so `Done -> Ready` is permitted
unconditionally here, with no PR-merge-aware restriction of any kind.
See "Implementation limitations and follow-ups" below.

### Decision 6 — command shapes: POST for the two non-idempotent workflow commands, PUT/DELETE for the idempotent Assignee sub-resource

**Chosen:** `POST /api/tickets/{id}/status` and `POST
/api/tickets/{id}/accept` are workflow commands whose repeated
application is **not** idempotent in the HTTP sense (a second,
identical call after a first success now targets an already-changed
current Status and is rejected) -- POST matches that shape and the
"commands" framing `docs/contracts/execution-interface.md` and the
issue itself use throughout. `PUT`/`DELETE /api/tickets/{id}/assignee`
are genuinely idempotent (assigning an already-assigned Ticket, or
unassigning an already-unassigned one, is a true no-op that still
returns 200), matching this contract's existing `GET`/`DELETE
/api/session` sub-resource precedent.

### Decision 7 — the guardrail test's allowlist is deliberately extended, not routed around

`internal/httpapi/template_capability_guardrail_test.go`'s AST scan
(issue #59) flagged this slice's new code on the first run: `AcceptTicket`,
`decideAccept`, and `applyTicketTransition` all reference
`TicketCompletionCondition` (Accept must read a Ticket's own retained
condition to decide whether it can complete at all), and
`ChangeTicketStatus`'s shared `decide` closure signature names the same
type even though its own logic never branches on it. This is exactly
the "legitimately need to touch Template-aware code" case the issue
anticipates: none of these four functions map a Template to an Agent,
engine, or capability -- the one thing D3 forbids -- so all four were
added to `allowedTemplateAwareFunctions` deliberately, with a comment
at the point of addition explaining why. See "Proof the suite can
fail" below: this was caught on the very first run, not merely
described afterward.

### Decision 8 — the no-execution-artifact guardrail: a real database-level trip wire, not a vacuous negative

Issue #60 names exactly the risk #59 found: "a test asserting a
negative is easy to make vacuous." A bare assertion like "no Round was
created" is true today for the wrong reason -- M2 has no Round table
at all, so nothing could ever make it fail.

**Chosen instead:**
`internal/httpapi/no_execution_side_effects_test.go`'s
`TestManualLifecycleActionsCreateNoExecutionRecords` drives every
manual command this slice adds (assign, the full forward/back Status
chain including `Blocked`, Accept to `Done`, `Done -> Ready`, unassign)
against one Ticket through the real API, then makes two falsifiable
assertions against real PostgreSQL:

1. The complete set of tables in the `public` schema, both before and
   after, is exactly `knownPublicTables` -- the seven tables confirmed
   directly against a freshly migrated database (`diagnostic_notes`,
   `oauth_states`, `owner_identities`, `owners`, `schema_migrations`,
   `sessions`, `tickets`).
2. Every one of those tables **other than** `tickets` has the exact
   same row count after as before; `tickets` itself grows by exactly
   one row (the single Ticket this test creates).

**What would make this fail if a future slice wired up execution,**
stated explicitly per the issue's own instruction: a migration adding
any table beyond `knownPublicTables` (a `rounds` table, a
`work_claims`/`work_queue` table -- assertion 1), or any of this file's
four handlers inserting a row into an existing table beyond `tickets`
(assertion 2) -- for example, if a future change made
`ChangeTicketStatus` also write a bookkeeping row when transitioning to
`InProgress`. A change that adds Round/queue creation in a genuinely
separate execution module, gated behind an Agent Assignee that cannot
exist in M2, would need no change to this test at all -- intentionally:
this guards the manual-transition commands themselves, not the schema
in general. See "Proof the suite can fail" below for a captured red
run.

### Contract (`contracts/openapi.yaml`)

- `TicketStatus` extracted into its own reusable named schema (matching
  `TicketTemplate`/`TicketCompletionCondition`'s existing pattern,
  rather than staying inline on `Ticket` alone) and widened from
  `enum: [Backlog]` to `enum: [Backlog, Ready, InProgress, Blocked,
  InReview, Done]` -- referenced from both `Ticket.status` and the new
  `ChangeTicketStatusRequest.status`.
- New `TicketAssigneeType` schema (`type: string`, no enum -- see
  Decision 5) and `Ticket.assigneeType` (required, always present, `""`
  meaning unassigned, matching `goal`'s own convention).
- New `ChangeTicketStatusRequest` (`{status: TicketStatus}`, required).
- Four new operations, all tagged `tickets`:
  - `POST /api/tickets/{id}/status` (`changeTicketStatus`)
  - `POST /api/tickets/{id}/accept` (`acceptTicket`)
  - `PUT /api/tickets/{id}/assignee` (`assignTicketOwner`)
  - `DELETE /api/tickets/{id}/assignee` (`unassignTicket`)

  Every one requires a valid session, folds a malformed/unknown/
  cross-owner identifier into the same `404 not_found` every existing
  `/api/tickets/{id}` operation already uses, and documents the
  concurrency/no-Round/no-queue guarantees directly in its operation
  description.

### Galley (`apps/galley`)

- `internal/migrations/000007_add_ticket_assignee.up.sql` (forward-only,
  no down): Decision 5.
- `internal/httpapi/ticket.go`: `ticketSelectColumns`/`scanTicketRow`
  extended to `assignee_type` (nullable, scanned like
  `goal`/`context`/etc via `sql.NullString`, `NULL` -> `""`).
  `insertTicket`'s `INSERT` list is unchanged -- `assignee_type` is left
  out entirely, exactly like the four refinement columns, so it starts
  `NULL` on every new Ticket.
- `internal/httpapi/ticket_lifecycle.go` (new): the transition table,
  `decidePlainStatusChange`, `decideAccept`, the shared
  `applyTicketTransition` (Decision 4), `setTicketAssigneeForOwner`,
  and the four handlers (`ChangeTicketStatus`, `AcceptTicket`,
  `AssignTicketOwner`, `UnassignTicket`).
- `internal/httpapi/handler.go`: registered `405` handlers for the
  three new exact paths (`/api/tickets/{id}/status`,
  `/api/tickets/{id}/accept`, `/api/tickets/{id}/assignee`), matching
  every existing route's own convention.
- `internal/httpapi/template_capability_guardrail_test.go`:
  `allowedTemplateAwareFunctions` extended per Decision 7.
- **Tests**:
  - `ticket_lifecycle_test.go` (new): `TestChangeTicketStatus_D3S2Table`
    (the exhaustive 6×6 = 36-cell grid, Decision 1),
    `TestChangeTicketStatus_RejectsUnknownStatusValue`,
    `TestChangeTicketStatus_UnknownAndMalformedIdentifiers404`,
    `TestAcceptTicket_HumanAcceptanceCompletesFromInReview`,
    `TestAcceptTicket_ReviewedPrMergeRejected` (Decision 3, D2/M8
    naming asserted directly),
    `TestAcceptTicket_RejectsWhenNotInReview` (five current-status
    subtests), `TestAcceptTicket_UnknownAndMalformedIdentifiers404`,
    `TestAssignTicketOwner_SetsAssigneeTypeAndIsIdempotent`,
    `TestAssignTicketOwner_AllowedRegardlessOfStatus` (six subtests),
    `TestAssignTicketOwner_UnknownAndMalformedIdentifiers404`,
    `TestApplyTicketTransition_ScopedToOwner`,
    `TestSetTicketAssigneeForOwner_ScopedToOwner`,
    `TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies`
    (15 trials, Decision 4).
  - `no_execution_side_effects_test.go` (new):
    `TestManualLifecycleActionsCreateNoExecutionRecords` (Decision 8).
- **Owner-scoping.** `TestApplyTicketTransition_ScopedToOwner` and
  `TestSetTicketAssigneeForOwner_ScopedToOwner` follow the established
  bogus-owner-id technique (`owners` is a true singleton -- see #56–#59's
  own evidence for why a second real Owner cannot be constructed).

### Swiftlet (`apps/swiftlet`)

Galley-only slice; Swiftlet's own controls for these commands are #61.
The only Swiftlet changes here are the mechanical minimum needed to
keep its build and existing tests green against the widened contract:

- `src/api/tickets.ts`: `parseTicket` now also requires/passes through
  `assigneeType` as a string, matching every other required Ticket
  field's existing validation.
- `src/components/{TicketDetail,TicketList,TicketDetailPage,AppShell}.test.tsx`:
  existing Ticket fixtures gained `assigneeType: ""` -- required both
  for the ones explicitly typed `Ticket` (TypeScript) and, for the
  untyped `jsonResponse` fixtures, because `parseTicket` now requires
  it at runtime. No new UI, no new test asserting new behavior.
- Regenerated `src/api/generated/schema.d.ts` (openapi-typescript
  7.13.0, unchanged pin) -- confirmed idempotent (a second consecutive
  regeneration produced zero further diff) rather than run through
  `check-swiftlet-drift.sh` directly, since that script requires a
  clean working tree for the generated file and this slice's own
  changes to it are still uncommitted at verification time; re-run
  against the committed tree immediately before opening the PR (see
  "Observed results").

## Exact versions and toolchain

- Go `1.27.1` (darwin/arm64) -- unchanged.
- Node `v26.9.0` -- unchanged.
- `apps/galley`: no new runtime dependency. `ticket_lifecycle.go` uses
  only the standard library plus the existing `pgx/v5`/`pgxpool`
  pattern (`pool.Begin`, matching `internal/auth/owner.go`'s
  `bootstrapOwner` transaction precedent).
  `oapi-codegen/oapi-codegen/v2` `v2.8.0` (unchanged pin) regenerated
  `api.gen.go`; `github.com/getkin/kin-openapi` `v0.149.0` (unchanged)
  backs the contract-response validation tests.
- `apps/swiftlet`: no new dependency. `openapi-typescript` `7.13.0`
  (unchanged pin, `contracts/package.json`) regenerated `schema.d.ts`.
  `vite` `8.3.0`, `vitest` `5.0.1` -- unchanged.
- `e2e`: `@playwright/test` `1.63.0` -- unchanged. Chromium's headless
  shell only (`--only-shell`), same as every prior slice. No new spec
  added (Galley-only slice; direct-API proof lives in
  `apps/galley`'s own test suite, per ADR 0001 and this issue's own
  "proven through direct API requests" requirement).
- PostgreSQL server: `17.11` (Homebrew), `localhost:5432`. Go-side
  verification used `ticketit_test` (real, shared, never reset).
  Browser-suite run used `ticketit_e2e`, reset from empty by `run.sh`.
  `ticketit_dev` and `ticketit_m1_native` were untouched throughout.

## Reproducible commands

**Contract regeneration** (from `contracts/`):

```sh
npm ci
npm run generate:swiftlet
```

**Galley** (from `apps/galley/`, real PostgreSQL, `ticketit_test`
already created):

```sh
cd apps/galley
go generate ./...
gofmt -l .
go vet ./...
go build ./...
go test ./... -count=1
./scripts/check-contract-drift.sh
```

**Contract drift, Swiftlet side** (from `contracts/`):

```sh
cd contracts
npm ci
./check-swiftlet-drift.sh
```

**Swiftlet** (from `apps/swiftlet/`):

```sh
npm ci
npx tsc -p tsconfig.json --noEmit
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

### `go test ./... -count=1` -- all packages pass

```
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	1.602s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	0.186s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/auth	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/authtest	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.445s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	0.596s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	2.673s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	[no test files]
```

103 top-level and subtest `--- PASS` lines across the module in the
full verbose run, 0 `--- FAIL`.

New lifecycle tests in isolation (`-run` filter), all passing, 67
`--- PASS` lines including subtests:

```
$ go test ./internal/httpapi/... -run "TestChangeTicketStatus|TestAcceptTicket|TestAssignTicketOwner|TestUnassignTicket|TestApplyTicketTransition|TestSetTicketAssigneeForOwner|TestManualLifecycleActionsCreateNoExecutionRecords" -v
=== RUN   TestChangeTicketStatus_D3S2Table
    (36 subtests: every (from, to) pair across Backlog/Ready/InProgress/Blocked/InReview/Done)
--- PASS: TestChangeTicketStatus_D3S2Table (0.06s)
=== RUN   TestChangeTicketStatus_RejectsUnknownStatusValue
--- PASS: TestChangeTicketStatus_RejectsUnknownStatusValue (0.01s)
=== RUN   TestChangeTicketStatus_UnknownAndMalformedIdentifiers404
--- PASS: TestChangeTicketStatus_UnknownAndMalformedIdentifiers404 (0.01s)
=== RUN   TestAcceptTicket_HumanAcceptanceCompletesFromInReview
--- PASS: TestAcceptTicket_HumanAcceptanceCompletesFromInReview (0.01s)
=== RUN   TestAcceptTicket_ReviewedPrMergeRejected
--- PASS: TestAcceptTicket_ReviewedPrMergeRejected (0.01s)
=== RUN   TestAcceptTicket_RejectsWhenNotInReview
    (5 subtests: Backlog, Ready, InProgress, Blocked, Done)
--- PASS: TestAcceptTicket_RejectsWhenNotInReview (0.01s)
=== RUN   TestAcceptTicket_UnknownAndMalformedIdentifiers404
--- PASS: TestAcceptTicket_UnknownAndMalformedIdentifiers404 (0.01s)
=== RUN   TestAssignTicketOwner_SetsAssigneeTypeAndIsIdempotent
--- PASS: TestAssignTicketOwner_SetsAssigneeTypeAndIsIdempotent (0.01s)
=== RUN   TestAssignTicketOwner_AllowedRegardlessOfStatus
    (6 subtests: Backlog, Ready, InProgress, Blocked, InReview, Done)
--- PASS: TestAssignTicketOwner_AllowedRegardlessOfStatus (0.01s)
=== RUN   TestAssignTicketOwner_UnknownAndMalformedIdentifiers404
--- PASS: TestAssignTicketOwner_UnknownAndMalformedIdentifiers404 (0.01s)
=== RUN   TestApplyTicketTransition_ScopedToOwner
--- PASS: TestApplyTicketTransition_ScopedToOwner (0.01s)
=== RUN   TestSetTicketAssigneeForOwner_ScopedToOwner
--- PASS: TestSetTicketAssigneeForOwner_ScopedToOwner (0.01s)
=== RUN   TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies
--- PASS: TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies (0.08s)
=== RUN   TestManualLifecycleActionsCreateNoExecutionRecords
--- PASS: TestManualLifecycleActionsCreateNoExecutionRecords (0.05s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.7s
```

Concurrency test re-run three additional times with `-race`, all
green (see "Proof the suite can fail" for the same test's captured red
run):

```
$ go test ./internal/httpapi/... -run TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies -race -v
--- PASS: TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies (0.14s)
PASS
```

### Contract-response validation and both drift checks

```
$ go generate ./...
(regenerated api.gen.go; a second consecutive run produced zero further diff -- confirmed idempotent)
$ ./scripts/check-contract-drift.sh
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).

$ cd ../../contracts && npm ci && ./check-swiftlet-drift.sh
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

(Both checks run against this slice's own committed tree immediately
before opening its pull request, per every prior M2 slice's own
convention -- they refuse to run against an uncommitted generated
file.)

### Swiftlet: install, typecheck, test, build

```
$ npm ci
added 108 packages, and audited 109 packages in 724ms
found 0 vulnerabilities

$ npx tsc -p tsconfig.json --noEmit
(no output -- clean)

$ npm run test -- --run
 Test Files  8 passed (8)
      Tests  49 passed (49)

$ npm run build
✓ 26 modules transformed.
dist/index.html                  0.31 kB │ gzip:  0.23 kB
dist/assets/index-GvlOFBzQ.js  235.98 kB │ gzip: 72.58 kB
✓ built in 49ms
```

Test count unchanged from #59's record (49) -- this slice adds no new
Swiftlet test, since it adds no new Swiftlet behavior.

### Browser suite -- `SUITE PASSED`, 12 files (unchanged from #59; no new spec)

```
$ cd e2e && ./run.sh
...
migrations applied: schema version 7
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
[run.sh] running tests/session-restart-after.spec.ts against the restarted galley
  ✓ the session survives a Galley restart
[run.sh] running tests/ticket-persistence-after.spec.ts against the restarted galley
  ✓ the two captured Tickets are still listed, in the same order, after a Galley restart
[run.sh] running tests/ticket-refinement-after.spec.ts against the restarted galley
  ✓ the edited title and manual refinement fields are still there after a Galley restart
[run.sh] running tests/ticket-detail.spec.ts against the restarted galley
  ✓ 5 passed
[run.sh] running tests/ticket-refinement.spec.ts against the restarted galley
  ✓ 4 passed
[run.sh] running tests/ticket-templates.spec.ts against the restarted galley
  ✓ 4 passed
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
[run.sh] ticket-templates.spec.ts exit code: 0
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE PASSED
[run.sh] stopping swiftlet preview server
[run.sh] stopping the substitute GitHub provider
```

`migrations applied: schema version 7` confirms `000007_add_ticket_assignee.up.sql`
applied cleanly to a genuinely empty database as part of this same
run. `lsof -i -P` immediately after exit showed no
`galley`/`githubfake`/`vite`/`node` listener left behind.

## Proof the suite can fail

Four separate, targeted, reverted breaks, each capturing the actual red
output, each reverted (confirmed via `grep`/rebuild showing no residual
change), followed by a confirming green run. Required by this slice's
own instructions: at least one allowed transition, one rejection, and
the transactional concurrency guard specifically -- plus a fourth,
optional break of the no-execution-artifact guardrail (Decision 8),
since the issue separately demands stating explicitly what would make
that check fail and proving it is not worse advice than none.

**1. One allowed transition, broken** (`allowedSourceStatusesForTarget`'s
`InProgress` entry changed from `{Ready, Blocked, InReview}` to
`{Ready, InReview}` -- silently dropping `Blocked -> InProgress`, an
allowed D3 S2 transition):

```
$ go test ./internal/httpapi/... -run "TestChangeTicketStatus_D3S2Table/Blocked_to_InProgress" -v
=== RUN   TestChangeTicketStatus_D3S2Table
=== RUN   TestChangeTicketStatus_D3S2Table/Blocked_to_InProgress
    ticket_lifecycle_test.go:193: status = 400, want 200 (allowed transition Blocked -> InProgress); error={Error:{Code:invalid_transition Message:the transition Blocked -> InProgress is not permitted}}
--- FAIL: TestChangeTicketStatus_D3S2Table (0.03s)
    --- FAIL: TestChangeTicketStatus_D3S2Table/Blocked_to_InProgress (0.00s)
FAIL
```

Reverted; re-run of the full 36-cell grid confirmed `--- PASS`.

**2. One rejection, broken** (`allowedSourceStatusesForTarget`'s
`Ready` entry changed from `{Backlog, InProgress, Done}` to `{Backlog,
InProgress, Done, Blocked}` -- over-permitting `Blocked -> Ready`, the
exact negative property the issue calls out by name: "Blocked → Ready
is not allowed, only Blocked → In Progress"):

```
$ go test ./internal/httpapi/... -run "TestChangeTicketStatus_D3S2Table/Blocked_to_Ready" -v
=== RUN   TestChangeTicketStatus_D3S2Table
=== RUN   TestChangeTicketStatus_D3S2Table/Blocked_to_Ready
    ticket_lifecycle_test.go:206: status = 200, want 400 (disallowed transition Blocked -> Ready); body={... Status:Ready ...}
--- FAIL: TestChangeTicketStatus_D3S2Table (0.04s)
    --- FAIL: TestChangeTicketStatus_D3S2Table/Blocked_to_Ready (0.00s)
FAIL
```

Reverted; re-run confirmed `--- PASS`.

**3. The transactional concurrency guard, broken exactly as this
slice's own instructions describe** (`applyTicketTransition` rewritten
to a naive read-then-write: `pool.QueryRow` for the `SELECT` with no
`FOR UPDATE`, immediately followed by a separate `pool.QueryRow` for
the `UPDATE`, no `Begin`/`Commit` at all -- the exact "read-then-write
across two statements" shape the issue names as wrong):

```
$ go test ./internal/httpapi/... -run TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies -count=1 -v
=== RUN   TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies
    ticket_lifecycle_test.go:572: trial 1: 2 of 2 concurrent conflicting transitions succeeded, want exactly 1 (results=[{status:200 ticket:{... Status:Blocked ...}} {status:200 ticket:{... Status:InReview ...}}])
--- FAIL: TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies (0.04s)
FAIL
```

Both concurrent requests succeeded and both applied -- exactly the bug
the transactional row lock exists to prevent. This reproduced on the
**first trial, every one of five separate re-runs** of the broken
version (never needed to wait for a rare interleaving), and after
reverting, three additional runs (one with `-race`) were all green
(see "Observed results" above). Reverted; confirmed via `grep` showing
the transaction/lock code restored exactly, and `go test ./...`
green.

**4. The no-execution-artifact guardrail (Decision 8), broken** (a
nonexistent `"rounds"` entry added to `knownPublicTables`, standing in
for what a future migration's real execution table would look like to
this check -- the live schema itself was left completely untouched):

```
$ go test ./internal/httpapi/... -run TestManualLifecycleActionsCreateNoExecutionRecords -v
=== RUN   TestManualLifecycleActionsCreateNoExecutionRecords
    no_execution_side_effects_test.go:120: failed to count rows in rounds: ERROR: relation "rounds" does not exist (SQLSTATE 42P01)
--- FAIL: TestManualLifecycleActionsCreateNoExecutionRecords (0.04s)
FAIL
```

The check does not merely mismatch quietly -- it fails loudly and
immediately the moment `knownPublicTables` diverges from the live
schema in either direction (a table the list expects but the schema
lacks, exactly as tested here; or, symmetrically, a table the schema
gained that the list does not yet know about, which a future
Round/queue migration would produce), which is what "state explicitly
what would make your check fail" (issue #60) required proving, not
merely asserting. Reverted; confirmed via `grep` showing the original
seven-table list restored, and a green re-run.

**5. The guardrail's own allowlist, caught on the first real run (not
a deliberate break -- a genuine finding during implementation):** the
first `go test ./...` run against this slice's actual new code failed
`TestNoTemplateToCapabilityMapping` immediately, before any test file
existed for the new endpoints, because `AcceptTicket`, `decideAccept`,
`applyTicketTransition`, and `ChangeTicketStatus` all reference
`TicketCompletionCondition` (Accept must read a Ticket's own retained
condition):

```
--- FAIL: TestNoTemplateToCapabilityMapping (0.00s)
    template_capability_guardrail_test.go:185: found code outside the reviewed allowlist referencing a Template/completion-condition identifier (...):
          internal/httpapi/ticket_lifecycle.go: func AcceptTicket
          internal/httpapi/ticket_lifecycle.go: func ChangeTicketStatus
          internal/httpapi/ticket_lifecycle.go: func applyTicketTransition
          internal/httpapi/ticket_lifecycle.go: func decideAccept
FAIL
```

This is the guardrail working exactly as #59 designed it: a real,
unplanned finding, resolved by deliberately extending
`allowedTemplateAwareFunctions` with a comment explaining why each
addition is legitimate (Decision 7) -- not by working around the
check. Confirmed green immediately after that edit (see "Observed
results").

## Implementation limitations and follow-ups

- **`Done -> Ready`'s D4 caveat ("subject to D4 for an already-merged
  PR") is not enforced.** D3 §2's table notes this caveat but D4
  (closed-unmerged PRs, reopening after merge, merge during a Round,
  repository/template changes after delivery) is explicitly out of
  scope for this slice ("Do not resolve D2 or D4") and unresolved.
  `Done -> Ready` is permitted here with no PR-merge-aware condition of
  any kind -- an explicit recorded limitation, not a silent
  narrowing: D4 is still owned by **M8**
  (`docs/decisions/d3-agent-template-compatibility.md`'s own routing
  section).
- **`reviewedPrMerge` Tickets cannot reach `Done` in M2 at all** --
  by design, per D3 and this issue's own instruction, not an oversight.
  `AcceptTicket` rejects with `reviewed_pr_merge_not_implemented`,
  naming **D2** (review/merge evidence, unresolved) and **M8** (the
  shared mechanism's owning milestone) explicitly in the message. The
  condition is never downgraded to `humanAcceptance` -- there is no
  code path anywhere in this module that writes `completion_condition`
  outside `insertTicket` (unchanged guarantee from #59, now also
  covered by this slice's extended guardrail allowlist).
- **No Status precondition is enforced on Assignee changes.** D3 §1's
  "no open Round" precondition is vacuously true throughout M2 (no
  Round concept exists), so `AssignTicketOwner`/`UnassignTicket` apply
  unconditionally from every Status. This is not a limitation relative
  to D3 -- M4's actual open-Round field lock is explicitly out of scope
  for this issue ("open-Round field locks (M4)").
- **Agent Assignee, agent-assignment endpoint, and Agent-readiness
  validation** are explicitly out of scope (M4, per this issue) and not
  built here in any form, including as a placeholder: `assigneeType`'s
  contract schema is a plain, unenumerated string specifically so no
  closed set of "assignee kinds" is declared prematurely (Decision 5).
- **Archive and Badges** (M3) and **reviewed-merge evidence transport**
  (M8, D2) are untouched, per this issue's own scope statement.
- No other required behavior in issue #60 was left unimplemented; every
  acceptance criterion is satisfied and verified above:
  - Every allowed D3 S2 transition succeeds and persists; every
    rejection fails with the stable `invalid_transition` code
    (`TestChangeTicketStatus_D3S2Table`'s 36-cell grid).
  - Explicit Accept completes a `humanAcceptance` Ticket
    (`TestAcceptTicket_HumanAcceptanceCompletesFromInReview`); a plain
    Status set to `Done` never does, from any state
    (`TestChangeTicketStatus_D3S2Table`'s six `*_to_Done` subtests, all
    rejected).
  - A `reviewedPrMerge` Ticket cannot reach `Done` in M2, and its
    rejection names D2 and M8
    (`TestAcceptTicket_ReviewedPrMergeRejected`).
  - No manual action creates a Round, work request, or queue entry
    (`TestManualLifecycleActionsCreateNoExecutionRecords`, Decision 8).
  - Two concurrent conflicting transitions cannot both apply, proven
    against real PostgreSQL
    (`TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies`,
    15 trials, plus a captured red run against a deliberately un-locked
    implementation).
  - All rules are proven through the API, independently of any UI --
    every test in this slice drives the real HTTP handlers against real
    PostgreSQL; no browser spec was needed or added, consistent with
    this being a Galley-only slice.

## Outstanding checks and owning milestone

- **CI automation** of the commands recorded here -- no owning issue
  yet, unchanged from every prior M2 slice's own recorded limitation.
- **Swiftlet controls for these four commands** (Status transition
  buttons, Accept, Assign/Unassign UI) -- explicitly **#61**, per this
  issue's own scope statement ("Swiftlet controls are #61").
- **D4's `Done -> Ready` caveat, Agent Assignee, Agent-readiness
  validation, open-Round field locks** -- **M4**, per D3's own
  "Implementation rules and verification examples" table.
- **D2** (review/merge evidence) and the shared completion mechanism it
  selects -- still open, still **M8**; this slice stores and enforces
  the retained condition but implements no completion path for
  `reviewedPrMerge` at all.

## Decision impacts (open-decision IDs)

D3 is the decision this slice implements, per its own routing table:
"Title-only human Ready; manual Blocked/resume; explicit Accept;
rejected status skips" is named as M2's own row. This slice is the
first to build the concrete Status state machine, Accept command, and
Assignee column D3's acceptance made possible -- it does not resolve D3
further (already accepted before this slice began).

D1, D2, D4–D9 are not resolved or touched by this slice's own
decisions. D2 and D4 are explicitly named (not resolved) in
"Implementation limitations and follow-ups" above, exactly as this
issue instructs. This slice provisions no paid resource and creates no
provider account, per `AGENTS.md`'s "Paid resources" rule.
