# Basic and Coding Templates with retained completion conditions

## Purpose

Adds ticketIt's two built-in Ticket Templates (`Basic`, `Coding`), a
Ticket's own retained `completionCondition` (derived from the chosen
Template's default exactly once, at creation, per the accepted [D3
decision](../../decisions/d3-agent-template-compatibility.md)), and the
one Ticket repository reference available on either Template. Touches
`contracts/`, `apps/galley`, `apps/swiftlet`, and `e2e/`. Tracking
issue: [#59 — M2.11 — Basic and Coding Templates with retained
completion
conditions](https://github.com/cristoforows/ticketIt/issues/59), under
[M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3). Blocked
by [#58](https://github.com/cristoforows/ticketIt/issues/58), merged
before this slice began
(`docs/evidence/m2/58-refinement-fields.md`).

## What already existed

- **Galley**: `tickets` table with `id` (internal), `owner_id`,
  `title`, `status`, `public_id`, `goal`, `context`,
  `success_criteria`, `constraints`, `created_at`, `updated_at`
  (`internal/migrations/000001`–`000005`). `GET`/`POST /api/tickets`,
  `GET`/`PATCH /api/tickets/{id}` (`internal/httpapi/ticket.go`), all
  Owner-scoped via `requireSession`. No `template`, `completion_condition`,
  or `repository` column or field existed anywhere; `CreateTicketRequest`
  accepted only `title`; `UpdateTicketRequest` accepted only `title`
  and the four refinement fields.
- **Swiftlet**: `TicketList.tsx` (list + quick capture, title only),
  `TicketDetail.tsx` (pure presentation: title, Status, timestamps,
  four refinement fields — no fetching, no routing) and
  `TicketDetailPage.tsx` (the fetch/route container). No Template,
  completion-condition, repository, or PR concept existed anywhere in
  the app.
- **e2e**: `e2e/support/tickets.ts`'s API-direct `createTicket(page,
  title)` helper (title only), `e2e/support/sign-in.ts`, and every spec
  through `tests/ticket-refinement*.spec.ts`. `run.sh`'s phase 10
  already restarts Galley once, shared by `tests/session-restart-*` and
  `tests/ticket-persistence-*`/`ticket-refinement-*`.
- No sibling slice was landing in parallel that this slice depended on.

## What this slice added

### Decision 1 — separate `template`/`completion_condition` columns, and exactly one call site that maps between them

**Chosen:** two independent `NOT NULL` columns with their own
`DEFAULT` (`template TEXT DEFAULT 'Basic'`, `completion_condition TEXT
DEFAULT 'humanAcceptance'`), added by
`internal/migrations/000006_add_ticket_template_and_completion_condition.up.sql`.
Backfilled correctly *by their own DEFAULT*, not a data migration step
— every Ticket captured before this migration went through the
Basic-only `CreateTicket` path with human acceptance as its completion
condition, so `'Basic'`/`'humanAcceptance'` are the historically
correct values for existing rows, matching this issue's own instruction
("every existing one is `basic` with the human-acceptance condition").

`insertTicket` is the **one and only** call site anywhere in this
codebase of a new function, `defaultCompletionCondition(template)`,
which derives `Coding` → `reviewedPrMerge`, everything else →
`humanAcceptance`. No other function ever calls it or otherwise writes
to `completion_condition` — `updateTicketForOwner`'s `SET` clause does
not name that column *at all*, not merely leave it at a `COALESCE`
default. This is what makes "retained independently of later edits"
true by construction: there is no parameter path through this function
that could touch the column, so no future caller can accidentally (or
deliberately) make it recompute.

### Decision 2 — explicit rejection of a Template change, not silent omission

**Chosen:** `UpdateTicketRequest.template` exists in the contract
specifically so a client naming it can be told apart from one that does
not — `UpdateTicket` rejects any PATCH naming `template` at all (even
the Ticket's own current value) with `invalid_request`, before
validating any other field or touching the database. This directly
satisfies the issue's own instruction: "Reject it explicitly if the API
can express it, and record the limitation with its follow-up" — by
making the API able to express the attempt and then explicitly
rejecting it, rather than omitting the field and leaving an unnamed
gap that issue #75's known `additionalProperties` bug would otherwise
swallow silently. `completionCondition` has no corresponding request
field anywhere in this contract; there is no path, rejected or
otherwise, that could set it directly. See "Implementation limitations
and follow-ups" below for the D4/M8 citation this criterion requires.

### Decision 3 — the guardrail test: an AST scan with a closed allowlist, not an assertion that proves nothing

The issue is explicit that "a test that passes whether or not the
property holds is worse than no test." A plain assertion like "no
`Agent` field exists on `Ticket`" would pass today for the wrong
reason (M2 has no `Agent` concept at all) and would keep passing
silently even after a future slice added exactly the mapping D3
forbids, as long as that slice didn't touch `Ticket`'s own schema.

**Chosen instead:** `internal/httpapi/template_capability_guardrail_test.go`'s
`TestNoTemplateToCapabilityMapping` parses every non-generated,
non-test `.go` file in `apps/galley` with the standard library's
`go/parser` (not `go/types` — no type resolution is needed, since this
only needs *identifier occurrence*, not type-checked usage), finds
every syntactic reference to a Template/completion-condition identifier
(`TicketTemplate`, `Basic`, `Coding`, `TicketCompletionCondition`,
`HumanAcceptance`, `ReviewedPrMerge` — the six identifiers
`contracts/openapi.yaml`'s two new enum schemas generate), attributes
each occurrence to its enclosing top-level function (or to package
scope, for a reference outside any function, e.g. a package-level
variable), and fails unless that attribution set is *exactly* the
closed, reviewed allowlist: `CreateTicket`, `UpdateTicket`,
`insertTicket`, `scanTicketRow`, `updateTicketForOwner`,
`defaultCompletionCondition`.

**Why this would fail if someone added a real mapping.** Any future
code — anywhere in this module, in any package, new or existing — that
makes an Agent, Assignee, or engine decision depend on a Ticket's
Template necessarily *references* `TicketTemplate` or one of its values
to make that decision (there is no way to branch on a Template without
naming it). That reference is either inside a brand-new function (a
new attribution key this map does not contain) or inside one of the
six already-whitelisted functions (a diff to an existing, narrowly-scoped
function that a reviewer would see directly in the pull request). Since
the allowlist is kept exactly as large as today's real, legitimate set
of Template-aware code — not padded with hypothetical future
exceptions — *any* addition to it is a deliberate, visible change to
`template_capability_guardrail_test.go` itself, which is the point:
the test's own doc comment asks "why does this new code care about
Template?" of whoever extends it. See "Proof the suite can fail" below
for two captured red runs (a mapping function, and separately a
mapping variable), both caught and reverted.

**What this test does *not* catch**, stated in its own doc comment: a
mapping smuggled entirely inside one of the six already-whitelisted
functions (e.g. into `defaultCompletionCondition` itself). That
residual gap is inherent to any allowlist-based static check and is
exactly why the allowlist is kept minimal — the six functions are
individually small, single-purpose, and reviewable by inspection, so
this is a acceptable, explicit trade-off rather than an unstated one.

### Decision 4 — the retained-completion-condition proof needs two levels, not one

The issue calls the "does not change when other fields change"
criterion "straightforwardly testable," and it is — but a naive version
of that test has a blind spot this slice found and fixed:

- `TestUpdateTicket_CompletionConditionNeverChanges` creates a Basic
  and a Coding Ticket through the real `CreateTicket` path (so
  `template` and `completion_condition` are already in agreement, the
  only pairing `CreateTicket` can ever produce), PATCHes every other
  field individually and in combination, and asserts
  `completionCondition` never moves.
- **This test alone cannot distinguish "genuinely untouched" from
  "recomputed from `template`, but happened to produce the same value
  because `template` itself never changes in this API."** Since
  Template-change is rejected (Decision 2), a hypothetical
  recompute-from-template bug would read the Ticket's own,
  never-changing `template` and write back the exact same
  `completion_condition` it already had — silently passing this test
  by coincidence.
- **`TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate`**
  closes that gap: it inserts a row directly (bypassing `CreateTicket`,
  the same technique `ticket_test.go`'s `insertTicketAt` already uses)
  whose stored `completion_condition` deliberately *disagrees* with
  what `defaultCompletionCondition(template)` would produce for that
  row's `template` — a state no legitimate call through this API can
  ever create. PATCHing an unrelated field and finding the mismatched
  value unchanged proves the code path never looked at `template` to
  decide it; a recompute would "correct" the mismatch back to the
  template's real default, which is now observably different from the
  stored value. See "Proof the suite can fail" below: this is the exact
  test that caught the deliberate `updateTicketForOwner` recompute
  regression while the simpler test above stayed green throughout.

**Restart coverage**: `cmd/galley/ticket_template_restart_test.go`'s
`TestRestartDurability_CompletionConditionSurvivesFreshProcess` follows
`restart_durability_test.go`'s established two-real-OS-process
technique exactly (not two in-process `run()` calls, which the sibling
test's own doc comment already rules out as insufficient): creates a
Coding Ticket (`completionCondition = reviewedPrMerge` — the
non-default branch, so a regression that silently fell back to the
column's own `DEFAULT` would be caught), edits every other field
against the first process, restarts as a genuinely new process sharing
only the database, edits again (including a rejected Template-change
attempt) against the second process, and asserts the condition never
moved. This satisfies the issue's own "including across a Galley
restart" clause at the Go level, so the browser suite's own
`ticket-templates.spec.ts` needs no restart phase of its own.

### Contract (`contracts/openapi.yaml`)

- New reusable schemas `TicketTemplate` (`enum: [Basic, Coding]`) and
  `TicketCompletionCondition` (`enum: [humanAcceptance,
  reviewedPrMerge]`), `$ref`'d from `Ticket`, `CreateTicketRequest`,
  and `UpdateTicketRequest` rather than duplicated inline — one
  generated Go type/TS union per concept, not three.
- `Ticket` gained `template`, `completionCondition` (both required,
  read-only — no request schema anywhere sets `completionCondition`
  directly) and `repository` (required, `""` meaning "never set or
  cleared," exactly like `goal`'s existing convention).
- `CreateTicketRequest` gained optional `template` (absent defaults to
  `Basic`, per the operation description).
- `UpdateTicketRequest` gained optional `repository` (same
  absent/empty/text rule as the four refinement fields, `maxLength:
  500`) and optional `template` (present at all, any value, is
  rejected — see Decision 2).
- Wire enum values: `Basic`/`Coding` capitalized to match
  `TicketStatus`'s existing "proper term" convention (`Backlog`) and
  `docs/ticket-creation.md`'s own headers ("**Basic:**", "**Coding:**");
  `humanAcceptance`/`reviewedPrMerge` lower-camelCase since "completion
  condition" is not itself a CONTEXT.md proper-noun term, matching the
  existing property-name casing convention (`successCriteria`, etc.).

### Galley (`apps/galley`)

- `internal/migrations/000006_add_ticket_template_and_completion_condition.up.sql`
  (forward-only, no down): see Decision 1.
- `internal/httpapi/ticket.go`:
  - `ticketRepositoryMaxLength = 500`.
  - `ticketSelectColumns`/`scanTicketRow` extended to the three new
    columns (`template`, `completion_condition` — both `NOT NULL`, so
    scanned as plain `string`, not `sql.NullString`; `repository` —
    nullable, scanned like the four refinement fields).
  - `insertTicket` takes a validated `TicketTemplate`; `CreateTicket`
    validates it (`.Valid()`, defaulting to `Basic` when absent) before
    calling in.
  - `defaultCompletionCondition` (Decision 1).
  - `UpdateTicket`: rejects `req.Template != nil` outright (Decision
    2); validates `repository` through the same
    `validateRefinementField` the four refinement fields already use
    (no new validation function needed — the absent/empty/text rule is
    identical).
  - `ticketUpdate`/`updateTicketForOwner`: gained a `repository` field
    and `SET` clause entry; deliberately gained **no** `template` or
    `completion_condition` field or `SET` entry (Decision 1).
  - `handler.go`: no change — `/api/tickets{,/{id}}`'s method sets were
    already `GET,POST`/`GET,PATCH`.
- **Tests** (`internal/httpapi/ticket_test.go`,
  `ticket_template_test.go`, `template_capability_guardrail_test.go`,
  `cmd/galley/ticket_template_restart_test.go` — all against real
  PostgreSQL except the guardrail test, which reads source files):
  - `ticket_test.go`: added `createTicketWithTemplate` helper; extended
    `TestUpdateTicket_RejectsOverLengthFields` with a `repository` case;
    added `TestUpdateTicket_RepositoryFollowsRefinementFieldRules`
    (absent/empty/text/trim, available on both Templates, persists
    independently of unrelated edits).
  - `ticket_template_test.go` (new): `TestCreateTicket_DefaultsTemplateToBasicWithHumanAcceptance`,
    `TestCreateTicket_CodingTemplateDefaultsToReviewedPrMerge`,
    `TestCreateTicket_RejectsInvalidTemplate`,
    `TestUpdateTicket_RejectsTemplateChange` (two subtests: a different
    value, and the Ticket's own current value), `TestUpdateTicket_CompletionConditionNeverChanges`
    (Decision 4), `TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate`
    (Decision 4).
  - `template_capability_guardrail_test.go` (new):
    `TestNoTemplateToCapabilityMapping` (Decision 3).
  - `cmd/galley/ticket_template_restart_test.go` (new):
    `TestRestartDurability_CompletionConditionSurvivesFreshProcess`
    (Decision 4, restart half).
  - `contract_test.go`: unchanged — `TestTickets_ResponseMatchesContract`
    and `TestUpdateTicket_ResponseMatchesContract` already exercise
    `CreateTicket`/`UpdateTicket` end to end, so they validate the three
    new `Ticket` fields and the template-rejection `400` shape against
    the contract automatically, with no new test needed to cover that
    specific drift surface.
- **Owner-scoping.** No new scoping test was needed:
  `TestUpdateTicket_ScopedToOwner`/`TestGetTicket_ScopedToOwner` already
  cover `updateTicketForOwner`/`getTicketForOwner`'s `WHERE owner_id =
  $1` filter, which every new column passes through unchanged — this
  slice added columns to an existing, already-scoped query shape, not a
  new query path.

### Swiftlet (`apps/swiftlet`)

- `src/api/tickets.ts`: `parseTicket` now also requires
  `template`/`completionCondition`/`repository` as strings (matching
  the contract's expanded `required` list); `createTicket(title,
  template = "Basic")` sends `template` alongside `title`; new
  `TICKET_TEMPLATES` constant (`["Basic", "Coding"]`) backs the capture
  form's selector. `TicketUpdate`'s new `repository`/`template`
  properties came from the regenerated schema with no hand-written
  change.
- `src/components/TicketList.tsx`: a Template `<select>`
  (`data-testid="ticket-template-select"`) beside the title input,
  defaulting to `"Basic"`, submitted alongside `title` on capture.
- `src/components/TicketDetail.tsx` (**still pure presentation** — no
  fetching, no routing, unchanged from issues #57/#58's split): view
  mode gained Template, the retained completion condition (as friendly
  text via a small `completionConditionLabel` mapping — display only,
  decides nothing), the repository reference (same placeholder
  convention as the four refinement fields), and, only for a
  Coding-template Ticket, a Pull Request section with an honest empty
  state naming M8. Edit mode gained a plain repository input.
  **Template has no edit control anywhere on this page** (D4/M8, see
  "Implementation limitations" below), and completionCondition has no
  control at all — `onSave`'s payload never includes either.
- `src/components/TicketDetailPage.tsx`: unchanged — it already passes
  every field the container fetched straight through to `TicketDetail`.
- Regenerated `src/api/generated/schema.d.ts` (openapi-typescript
  7.13.0, unchanged pin).
- **Tests** (Vitest + Testing Library): `TicketDetail.test.tsx` grew
  from 9 to 14 tests (Template/completion-condition display for both
  Templates, the Coding-only PR section and its absence on Basic,
  repository placeholder/value/pre-fill/save, and an explicit assertion
  that `onSave`'s payload never contains `template`). `TicketList.test.tsx`
  gained two tests (the selector's Basic default, and submitting a
  chosen Coding Template) — both existing and new fixtures across
  `TicketDetail.test.tsx`, `TicketDetailPage.test.tsx`,
  `TicketList.test.tsx`, and `AppShell.test.tsx` were extended with the
  three new required fields.

### e2e

- `e2e/support/tickets.ts`: `Ticket` interface gained `template`,
  `completionCondition`, `repository`; `createTicket(page, title,
  template = "Basic")` gained the optional third parameter.
- `e2e/tests/ticket-templates.spec.ts` (new, 4 specs, fresh sign-in, no
  restart needed — see Decision 4's restart note): capturing a Ticket
  through the real form with the Coding Template shows its own retained
  completion condition and the honest PR section; capturing with the
  default Basic Template retains human acceptance and shows no PR
  section; the repository reference can be set on either Template and
  persists across reload; the completion condition does not change when
  another field is edited from the full page.
- `e2e/run.sh`: runs `ticket-templates.spec.ts` in phase 10b alongside
  `ticket-detail.spec.ts`/`ticket-refinement.spec.ts` (fresh sign-in,
  no restart). Exit-code aggregation and the final summary log extended
  accordingly.

## Exact versions and toolchain

- Go `1.27.1` (darwin/arm64) — unchanged.
- Node `v26.9.0` — unchanged.
- `apps/galley`: no new runtime dependency (see `apps/galley/README.md`,
  "Exact versions and toolchain" — issue #59's own entry). The
  guardrail test uses only the standard library (`go/ast`, `go/parser`,
  `go/token`, `path/filepath`, `sort`); `oapi-codegen/oapi-codegen/v2`
  `v2.8.0` (unchanged pin) regenerated `api.gen.go`;
  `github.com/getkin/kin-openapi` `v0.149.0` (unchanged) validates the
  new contract-response shapes.
- `apps/swiftlet`: no new dependency. `openapi-typescript` `7.13.0`
  (unchanged pin, `contracts/package.json`) regenerated `schema.d.ts`.
  `vite` `8.3.0`, `vitest` `5.0.1`, `@testing-library/react` —
  unchanged.
- `e2e`: `@playwright/test` `1.63.0` — unchanged. Chromium's headless
  shell only (`--only-shell`), same as every prior slice.
- PostgreSQL server: `17.11` (Homebrew), `localhost:5432`. Go-side
  verification used `ticketit_test` (real, shared, never reset — see
  "Owner-scoping" above for why no new scoping test was needed).
  Browser-suite runs used `ticketit_e2e`, reset from empty by `run.sh`
  each time. `ticketit_dev` and `ticketit_m1_native` were untouched
  throughout.

## Reproducible commands

**Contract regeneration** (from `contracts/`):

```sh
npm ci
npm run generate:swiftlet
```

**Galley** (from `apps/galley/`, real PostgreSQL, `ticketit_test`
already created per `apps/galley/README.md`, "Local PostgreSQL
setup"):

```sh
cd apps/galley
go generate ./...
gofmt -l .
go vet ./...
go build ./...
go test ./... -count=1
go test ./internal/httpapi/... -run Contract -v
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

### `go test ./... -count=1` — all packages pass

```
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	2.753s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	1.275s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/auth	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/authtest	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.442s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	1.721s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	3.511s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	[no test files]
```

New Template/completion-condition tests, isolated (`-run` filter),
all passing:

```
$ go test ./internal/httpapi/... -run "TestNoTemplateToCapabilityMapping|TestCreateTicket_DefaultsTemplateToBasicWithHumanAcceptance|TestCreateTicket_CodingTemplateDefaultsToReviewedPrMerge|TestCreateTicket_RejectsInvalidTemplate|TestUpdateTicket_RejectsTemplateChange|TestUpdateTicket_CompletionConditionNeverChanges|TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate|TestUpdateTicket_RepositoryFollowsRefinementFieldRules" -v
=== RUN   TestNoTemplateToCapabilityMapping
--- PASS: TestNoTemplateToCapabilityMapping (0.01s)
=== RUN   TestCreateTicket_DefaultsTemplateToBasicWithHumanAcceptance
--- PASS: TestCreateTicket_DefaultsTemplateToBasicWithHumanAcceptance (0.02s)
=== RUN   TestCreateTicket_CodingTemplateDefaultsToReviewedPrMerge
--- PASS: TestCreateTicket_CodingTemplateDefaultsToReviewedPrMerge (0.01s)
=== RUN   TestCreateTicket_RejectsInvalidTemplate
--- PASS: TestCreateTicket_RejectsInvalidTemplate (0.01s)
=== RUN   TestUpdateTicket_RejectsTemplateChange
=== RUN   TestUpdateTicket_RejectsTemplateChange/to_a_different_value
=== RUN   TestUpdateTicket_RejectsTemplateChange/to_its_own_current_value
--- PASS: TestUpdateTicket_RejectsTemplateChange (0.01s)
    --- PASS: TestUpdateTicket_RejectsTemplateChange/to_a_different_value (0.00s)
    --- PASS: TestUpdateTicket_RejectsTemplateChange/to_its_own_current_value (0.00s)
=== RUN   TestUpdateTicket_CompletionConditionNeverChanges
=== RUN   TestUpdateTicket_CompletionConditionNeverChanges/Basic
=== RUN   TestUpdateTicket_CompletionConditionNeverChanges/Coding
--- PASS: TestUpdateTicket_CompletionConditionNeverChanges (0.02s)
    --- PASS: TestUpdateTicket_CompletionConditionNeverChanges/Basic (0.01s)
    --- PASS: TestUpdateTicket_CompletionConditionNeverChanges/Coding (0.00s)
=== RUN   TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate
--- PASS: TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate (0.03s)
=== RUN   TestUpdateTicket_RepositoryFollowsRefinementFieldRules
--- PASS: TestUpdateTicket_RepositoryFollowsRefinementFieldRules (0.01s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.6s
```

Restart durability (Decision 4), real two-process test:

```
$ go test ./cmd/galley/... -run TestRestartDurability_CompletionConditionSurvivesFreshProcess -v
=== RUN   TestRestartDurability_CompletionConditionSurvivesFreshProcess
--- PASS: TestRestartDurability_CompletionConditionSurvivesFreshProcess (0.88s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	1.416s
```

### Contract-response validation and both drift checks

```
$ go test ./internal/httpapi/... -run Contract -v
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract
=== RUN   TestGetStatus_DatabaseUnreachableResponseMatchesContract
--- PASS: TestGetStatus_DatabaseUnreachableResponseMatchesContract
=== RUN   TestDiagnosticNotes_ResponseMatchesContract
--- PASS: TestDiagnosticNotes_ResponseMatchesContract
=== RUN   TestTickets_ResponseMatchesContract
--- PASS: TestTickets_ResponseMatchesContract
=== RUN   TestGetTicket_ResponseMatchesContract
--- PASS: TestGetTicket_ResponseMatchesContract
=== RUN   TestUpdateTicket_ResponseMatchesContract
--- PASS: TestUpdateTicket_ResponseMatchesContract
=== RUN   TestGetSession_ResponseMatchesContract
--- PASS: TestGetSession_ResponseMatchesContract
=== RUN   TestErrorResponses_MatchContract
--- PASS: TestErrorResponses_MatchContract
=== RUN   TestAuthErrorResponses_MatchContract
--- PASS: TestAuthErrorResponses_MatchContract
PASS

$ ./scripts/check-contract-drift.sh
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).

$ cd ../../contracts && npm ci && ./check-swiftlet-drift.sh
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

Both drift checks require a clean working tree for the generated file
they check (they refuse otherwise, to avoid mistaking unrelated edits
for drift) — re-run against this slice's own committed tree immediately
before opening its pull request, with the same "OK" result.

### Swiftlet: install, typecheck, test, build

```
$ npm ci
added 108 packages, and audited 109 packages in 684ms
found 0 vulnerabilities

$ npx tsc -p tsconfig.json --noEmit
(no output -- clean)

$ npm run test -- --run
 Test Files  8 passed (8)
      Tests  49 passed (49)

$ npm run build
✓ 26 modules transformed.
dist/index.html                  0.31 kB │ gzip:  0.23 kB
dist/assets/index-BwZlVHh4.js  235.92 kB │ gzip: 72.56 kB
✓ built in 48ms
```

49 tests across 8 files (up from 45 in #58's record): `App.test.tsx`
(4), `AppShell.test.tsx` (5), `SignInPage.test.tsx` (1),
`StatusView.test.tsx` (5), `TicketList.test.tsx` (10, up from 8 — the
Template selector's default and its Coding submission),
`TicketDetail.test.tsx` (14, up from 9 — Template/completion-condition
display, the Coding-only PR section, repository), `TicketDetailPage.test.tsx`
(7), `router.test.tsx` (5).

### Browser suite — `SUITE PASSED`, 30 specs across 12 files

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
  ✓ capturing a Ticket through the real form with the Coding Template shows its own retained completion condition and an honest Pull Request section
  ✓ capturing a Ticket through the real form with the default Basic Template retains human acceptance and shows no Pull Request section
  ✓ the repository reference can be set on either Template, and persists across reload
  ✓ the completion condition does not change when another field is edited from the full page
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

`lsof -i -P` immediately after exit showed no `galley`/`githubfake`/
`vite`/`node` listener left behind, both after this run and after every
deliberately-broken run below.

## Proof the suite can fail

Four separate, targeted, reverted breaks, each capturing the actual red
output, each reverted (confirmed via `git diff`/rebuild showing no
residual change), followed by a confirming green run. Required by this
slice's own instructions: at least one break in the retained-completion-
condition logic specifically (recompute from the Template on update),
plus proof each new spec can fail.

**1. The guardrail test, broken with a deliberate mapping *function***
(`allowedAssigneesForTemplate(template TicketTemplate) []string`,
switching on `template == Coding` to pick an Agent name, appended to
`ticket.go`):

```
$ go test ./internal/httpapi/... -run TestNoTemplateToCapabilityMapping -v
=== RUN   TestNoTemplateToCapabilityMapping
    template_capability_guardrail_test.go:163: found code outside the reviewed allowlist referencing a Template/completion-condition identifier (TicketTemplate, Basic, Coding, TicketCompletionCondition, HumanAcceptance, ReviewedPrMerge):
          internal/httpapi/ticket.go: func allowedAssigneesForTemplate
        D3 permits a Template to supply presentation, required information, and a default completion condition ONLY -- never an Agent/engine restriction. If this new code is legitimate (e.g. this slice's own new plumbing), add its function name to allowedTemplateAwareFunctions in template_capability_guardrail_test.go deliberately. If it maps a Template to an allowed Agent, engine, or capability, that violates D3 and must be removed instead.
--- FAIL: TestNoTemplateToCapabilityMapping (0.01s)
FAIL
```

Reverted; re-run confirmed `--- PASS`.

**2. The same guardrail test, broken a second, structurally different
way: a deliberate mapping *variable*** (`var deliberateTemplateEngineMap
= map[TicketTemplate]string{Basic: "native-research", Coding:
"opencode-coding"}`, a package-level `var`, not a function):

```
$ go test ./internal/httpapi/... -run TestNoTemplateToCapabilityMapping -v
=== RUN   TestNoTemplateToCapabilityMapping
    template_capability_guardrail_test.go:163: found code outside the reviewed allowlist referencing a Template/completion-condition identifier (...):
          internal/httpapi/ticket.go: package scope
        D3 permits a Template to supply presentation, required information, and a default completion condition ONLY -- never an Agent/engine restriction. ...
--- FAIL: TestNoTemplateToCapabilityMapping (0.01s)
FAIL
```

Reverted; re-run confirmed `--- PASS`. This second break exercises the
scanner's other code path (attribution to package scope rather than an
enclosing function), proving the guardrail is not merely watching
function bodies.

**3. Galley's retained-completion-condition logic, broken exactly as
this slice's own instructions suggest** (`updateTicketForOwner`'s
`UPDATE` statement changed to also set `completion_condition = CASE
WHEN template = 'Coding' THEN 'reviewedPrMerge' ELSE 'humanAcceptance'
END` unconditionally, on every PATCH):

```
$ go test ./internal/httpapi/... -run "TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate|TestUpdateTicket_CompletionConditionNeverChanges" -v
=== RUN   TestUpdateTicket_CompletionConditionNeverChanges
=== RUN   TestUpdateTicket_CompletionConditionNeverChanges/Basic
=== RUN   TestUpdateTicket_CompletionConditionNeverChanges/Coding
--- PASS: TestUpdateTicket_CompletionConditionNeverChanges (0.05s)
    --- PASS: TestUpdateTicket_CompletionConditionNeverChanges/Basic (0.01s)
    --- PASS: TestUpdateTicket_CompletionConditionNeverChanges/Coding (0.01s)
=== RUN   TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate
    ticket_template_test.go:257: CompletionCondition = "reviewedPrMerge" after an unrelated PATCH, want it to stay the deliberately mismatched "humanAcceptance" -- it changed to "reviewedPrMerge", which is exactly template Coding's own default: this PATCH recomputed completionCondition from the Ticket's template instead of leaving the stored value alone
    ticket_template_test.go:270: CompletionCondition on re-fetch = "reviewedPrMerge", want it to stay "humanAcceptance"
--- FAIL: TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate (0.03s)
FAIL
```

**This is the exact result Decision 4 predicts**: the "obvious" test
(`TestUpdateTicket_CompletionConditionNeverChanges`) stayed green
throughout the break — every Ticket it constructs already has
`template`/`completion_condition` in agreement, so recomputing from a
`template` that never itself changes reproduces the same value by
coincidence. Only the mismatched-fixture test caught the regression.
Reverted (confirmed via rebuild and a clean re-run, "Observed results"
above); this is real, reproducible evidence, not a hypothetical
described after the fact.

**4. Swiftlet's completion-condition display, broken** (`TicketDetail.tsx`'s
`completionConditionLabel` changed to always return `"Human
acceptance"` regardless of the actual condition, simulating a
regression that mislabels a Coding Ticket's retained condition):

Unit level:

```
$ npm run test -- --run
 FAIL  src/components/TicketDetail.test.tsx > TicketDetail > shows the reviewed-PR-merge completion condition and a Pull Request section for a Coding ticket
Expected element to have text content: Reviewed pull request merged
Received: Human acceptance
 Test Files  1 failed | 7 passed (8)
      Tests  1 failed | 48 passed (49)
```

Browser level, same break, full suite:

```
$ cd e2e && ./run.sh
...
[run.sh] running tests/ticket-templates.spec.ts against the restarted galley
  ✘ capturing a Ticket through the real form with the Coding Template shows its own retained completion condition and an honest Pull Request section
  ✓ capturing a Ticket through the real form with the default Basic Template retains human acceptance and shows no Pull Request section
  ✓ the repository reference can be set on either Template, and persists across reload
  ✘ the completion condition does not change when another field is edited from the full page
  2 failed, 2 passed
[run.sh] ticket-templates.spec.ts exit code: 1
[run.sh] SUITE FAILED
```

Exactly the two specs that assert a Coding Ticket's displayed
completion condition failed; the Basic-only spec and the
repository-only spec (neither reads the mislabeled text) stayed green
within the same file — isolating the break precisely. `lsof -i -P`
showed no orphaned process after this failed run either (`run.sh`'s
`trap cleanup EXIT` fired normally on the non-zero exit). Reverted
(confirmed via rebuild); the confirming green run is "Observed
results" above (Swiftlet's 49/49, and the full `SUITE PASSED` browser
run, 30 specs across 12 files).

## Implementation limitations and follow-ups

- **Changing a Ticket's Template after creation is explicitly out of
  scope for M2 and explicitly rejected, per this issue's own
  instruction** — not a silent downgrade. `PATCH /api/tickets/{id}`
  rejects any request naming `template` at all with `invalid_request`
  (`internal/httpapi/ticket.go`'s `UpdateTicket`). Post-delivery
  Template/repository change is **D4**, owned by **M8**
  (`docs/decisions/d3-agent-template-compatibility.md`'s own routing
  section: "D4: closed-unmerged PRs, reopening after merge, merge
  during a Round, and repository/template changes after delivery...
  still owned by M8"). This slice does not resolve D4 and introduces no
  Template-change endpoint of any kind, per its own scope rule.
- **`repository` is a single free-text field with no format
  validation** beyond length (`maxLength: 500`) — it is not verified to
  be a real, reachable repository, resolved to a checkout, or validated
  against any provider. D3 §1 check 3 requires only that "relevant
  repository inputs must be available on either template when needed";
  resolving a repository reference to a configured local checkout and
  the authority to act on it is explicitly M4/M8 territory
  (`docs/ticket-creation.md`, "Repository-targeted coding work
  explicitly selects one target repository... The runner resolves it
  to a configured local checkout; see `agent-execution.md`").
- **The AST-based guardrail test has one stated, deliberate blind
  spot**: a mapping hidden entirely inside one of the six
  already-whitelisted functions (see Decision 3). This is recorded in
  the test's own doc comment, not left implicit; closing it completely
  would need full type-checked data-flow analysis, which is
  disproportionate to a six-function, single-file surface area at this
  milestone.
- **`UpdateTicket`'s new `repository` validation reuses the existing
  Owner-scoping test technique inherited from #56–#58** (a synthetic
  bogus owner id, since `owners` is a true one-row-per-deployment
  singleton) — not a new limitation, the same one already accepted and
  recorded by every prior M2 Ticket slice's evidence.
- No other required behavior in issue #59 was left unimplemented; every
  acceptance criterion is satisfied and verified above:
  - Both Templates are selectable at capture (`CreateTicketRequest.template`,
    the real Template selector in `TicketList.tsx`), and title-only
    capture works for either
    (`TestCreateTicket_DefaultsTemplateToBasicWithHumanAcceptance`,
    `TestCreateTicket_CodingTemplateDefaultsToReviewedPrMerge`,
    `ticket-templates.spec.ts`).
  - The completion condition is stored at creation and never
    recomputed from the Template (Decisions 1 and 4, with a captured
    red run proving the stronger test actually catches a recompute
    regression the naive test misses).
  - A repository reference is available on either Template and
    required by nothing in M2 (`TestUpdateTicket_RepositoryFollowsRefinementFieldRules`,
    `ticket-templates.spec.ts`'s repository-on-both-Templates spec).
  - The Coding PR section states honestly that PR delivery does not
    exist yet (`TicketDetail.tsx`'s `ticket-detail-pr-empty-state`,
    asserted at both unit and browser level).
  - No Template-to-Agent or Template-to-engine mapping exists anywhere
    in the code (Decision 3, with two structurally different captured
    red runs), and no permanent work-type enum was introduced (`template`
    is a closed two-value presentation/default-condition selector, not
    a work-type category — Tickets remain generic per
    `docs/ticket-creation.md`, "Flexible ticket structure").
  - The post-creation Template-change limitation is recorded with D4
    and M8 (this section, above, and `apps/galley/README.md`'s own
    "Ticket Templates and the retained completion condition" section).

## Outstanding checks and owning milestone

- **CI automation** of the commands recorded here — no owning issue
  yet, unchanged from every prior M2 slice's own recorded limitation.
- **Agent-readiness validation**, the six-cell assignment matrix, and
  every other D3 rule beyond "a Template supplies a default completion
  condition and nothing else" — explicitly **M4/M8**, per D3's own
  "Implementation rules and verification examples" table. This slice
  proves the *absence* of a mapping; it does not implement assignment,
  readiness, or execution at all (M2 has none of those concepts).
- **D2** (review/merge evidence for completing a `reviewedPrMerge`
  Ticket) — still open, still **M8**; this slice stores the condition
  but implements no completion mechanism for either condition (M2 has
  no Done-transition endpoint at all yet — that is #60/#61).
- **Status transitions** (`#60`) and **status controls** (`#61`) — this
  slice added no column, endpoint, or UI affordance anticipating
  either.
- **User-defined Templates and a template/workflow designer** —
  explicitly deferred beyond v1 per `docs/ticket-creation.md`, "Keep
  the template structure extensible... A custom-template editor or full
  form/workflow designer is deferred beyond v1." Nothing in this slice
  assumes only two Templates will ever exist, but no extensibility
  mechanism was built either — out of scope here.

## Decision impacts (open-decision IDs)

D3 is the decision this slice implements, per its own routing:
"Implementation rules and verification examples" names M2 as the owner
of "Title-only human Ready; manual Blocked/resume; explicit Accept;
rejected status skips" and implicitly this slice's own Template/
completion-condition split (docs/ticket-creation.md, "Templates
determine presentation, required information, and the default
completion condition. Retain that condition on the ticket independently
of its assigned agent."). This slice does not resolve D3 further (it
was already accepted before this slice began) — it is the first slice
to build the concrete columns, validation, and guardrail test D3's
acceptance made possible.

D1, D2, D4–D9 are not resolved or touched by this slice's own
decisions. D4 is explicitly named (not resolved) in "Implementation
limitations and follow-ups" above, exactly as this issue instructs.
This slice provisions no paid resource and creates no provider
account, per `AGENTS.md`'s "Paid resources" rule.
