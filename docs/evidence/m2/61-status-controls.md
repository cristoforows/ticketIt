# Swiftlet status controls, Accept, and honest rejections

## Purpose

Adds, in Swiftlet only, the Owner-facing controls for the human-assigned
workflow #60 built in Galley: Status transition buttons, an explicit
Accept action, and Assign/Unassign the Owner -- all inside the reusable
`TicketDetail` presentation component -- plus the end-to-end browser
proof of the full M2 lifecycle. Touches `apps/swiftlet` and `e2e` only;
no `contracts/` or `apps/galley` change was needed, since #60 already
added every endpoint this slice calls. Tracking issue: [#61 — M2.13 —
Swiftlet status controls, Accept, and honest
rejections](https://github.com/cristoforows/ticketIt/issues/61), under
[M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3). Blocked by
[#60](https://github.com/cristoforows/ticketIt/issues/60) -- built on
top of its branch (`m2/60-lifecycle-transitions`, PR #77, code-complete
and verified but not yet merged to `main` at the time this slice began,
per this issue's own stacked-branch instructions) rather than waiting
for that merge.

## What already existed

- **Galley** (#60, `apps/galley/internal/httpapi/ticket_lifecycle.go`):
  `POST /api/tickets/{id}/status` (plain Status change, implementing D3
  S2's table literally via `allowedSourceStatusesForTarget`; `Done` is
  never a valid target and `Blocked -> Ready` is not allowed), `POST
  /api/tickets/{id}/accept` (the only path to Done; rejects with
  `reviewed_pr_merge_not_implemented` for a `reviewedPrMerge` Ticket,
  naming D2 and M8), `PUT`/`DELETE /api/tickets/{id}/assignee`
  (assign/unassign the Owner, no Status precondition in M2). All four
  Owner-scoped, enforced server-side, proven directly against the API by
  #60's own Go test suite (`ticket_lifecycle_test.go`,
  `no_execution_side_effects_test.go`).
- **Contract**: `TicketStatus` (6-value enum), `TicketAssigneeType`
  (plain string, `""`/`"owner"`), `ChangeTicketStatusRequest`, and all
  four operations already in `contracts/openapi.yaml` and regenerated
  into both clients (#60). `Ticket.assigneeType` already required and
  parsed by `apps/swiftlet/src/api/tickets.ts`'s `parseTicket`.
  `src/api/tickets.ts` had no functions calling the four new endpoints
  yet -- #60 was explicitly Galley-only for this surface.
  `src/components/TicketDetail.tsx` rendered `status`/`template`/
  `completionCondition` as read-only text with no transition, Accept,
  or Assignee control of any kind.
- **e2e**: 12 spec files covering capture, refinement, Templates,
  sign-in, and restart durability; none exercised a Status transition,
  Accept, or Assignee (`docs/evidence/m2/60-lifecycle-transitions.md`:
  "Swiftlet's own controls for these commands are #61").
- No sibling slice was landing in parallel that this slice depended on.

## What this slice added

### Decision 1 — presentation-only mirror of D3 S2, not an imported map

`src/components/TicketDetail.tsx`'s `presentationNextStatuses` is a
second, independent transcription of D3 S2's table (matching Galley's
own `allowedSourceStatusesForTarget` cell-by-cell, written without
importing it) mapping each current Status to the Status buttons this
component offers next. It decides nothing on its own: every click still
submits a real command, and Galley's own authoritative check is what
actually applies or rejects it (ADR 0001). `Done` is deliberately never
a key's value here -- Done is reachable only through the separate Accept
control, never a Status button, mirroring #60's own
`decidePlainStatusChange` structurally rejecting `Done` before
consulting its map.

This choice was deliberately tested for staleness, not just correctness
under ideal conditions: `ticket-lifecycle.spec.ts`'s "rejected skip"
case loads the detail page at one Status, changes the Ticket's real
Status out from under the loaded page via a direct API call, and clicks
a button that was valid under the stale view -- proving Galley's
rejection (not a fabricated success) is what the Owner sees when this
component's own offer turns out to be wrong.

### Decision 2 — Accept's "unavailable" reason is a verbatim static copy, cross-checked live by the browser suite instead of fetched by an automatic command

The retained `completionCondition` already tells this component,
deterministically and without any network call, whether Accept can ever
succeed for the current Ticket. Two options were considered for the
`reviewedPrMerge` "Accept unavailable" text:

- **Option A (rejected):** automatically call `POST
  /api/tickets/{id}/accept` in the background whenever a `reviewedPrMerge`
  Ticket is In Review, purely to read Galley's rejection message. This
  guarantees the exact live wording but fires a real owner command with
  no explicit user gesture behind it -- the issue frames Accept as "an
  explicit Accept action," and an automatic background POST undercuts
  that even though it can never mutate anything (the rejection happens
  before any write).
- **Option B (chosen):** a static, verbatim copy of Galley's own fixed
  message string (`decideAccept`'s `reviewedPrMergeNotImplementedCode`
  branch in `apps/galley/internal/httpapi/ticket_lifecycle.go` -- a
  compile-time constant with no dynamic parts), shown without calling
  Accept, exactly the "guidance text copied verbatim from a documented
  source" precedent #58 already established for the refinement fields'
  guidance prompts.

Copying a message string across languages by hand is a real drift risk
that #58's docs-sourced guidance text does not have (there, both sides
read the same Markdown file's prose; here, one side is a Go string
literal). `ticket-lifecycle.spec.ts`'s Coding-Template case closes that
gap: it calls `POST /api/tickets/{id}/accept` directly first to capture
Galley's own live rejection message, then asserts the UI's static text
equals that live response exactly -- so a future wording change on
either side that goes out of sync fails this spec immediately, rather
than silently rendering stale text.

### Decision 3 — never an optimistic update; a single shared `runAction`

Every one of the four new buttons (Status transition, Accept, Assign,
Unassign) calls one shared `runAction(action)` helper: it clears any
previous action error, disables the controls, calls the
container-supplied command, and on success replaces the whole displayed
Ticket with exactly what Galley returned. On rejection, it shows
Galley's own `error.message` verbatim in a single shared
`data-testid="ticket-detail-action-error"` region and leaves the
displayed Ticket completely unchanged -- there is no code path anywhere
in this component that updates `current` before Galley's response
confirms the command applied (ADR 0001: Swiftlet renders what Galley
returns, never what it assumes).

### Decision 4 — the four command callbacks are props, not a direct import

`TicketDetail`'s new `onChangeStatus`/`onAccept`/`onAssign`/`onUnassign`
props follow `onSave`'s existing container/presentation split (#57,
preserved by #58/#59): each performs one real request and returns the
updated Ticket or throws Galley's rejection, and `TicketDetailPage` is
the only place that calls the underlying `api/tickets.ts` functions.
`TicketDetail` itself still neither fetches nor routes, which is what
lets M3's modal container supply its own callbacks and render this
exact component unchanged, per the issue's own requirement to "keep the
controls inside the reusable detail component."

### Contract (`contracts/openapi.yaml`)

No change. #60 had already added every schema and operation this slice
calls; both drift checks (below) confirm no accidental drift was
introduced.

### Swiftlet (`apps/swiftlet`)

- `src/api/tickets.ts`: added `changeTicketStatus`, `acceptTicket`,
  `assignTicketOwner`, `unassignTicket`, all sharing a new private
  `ticketCommand` helper (`updateTicket` was refactored onto the same
  helper, behavior-preserving, to avoid five near-duplicate
  fetch/404/error-message/parse blocks).
- `src/components/TicketDetail.tsx`: the Workflow section (Assignee
  display + Assign/Unassign button, Status transition buttons, Accept
  button or its unavailable-reason text, and the shared action-error
  region), `presentationNextStatuses`, `OWNER_ASSIGNEE_TYPE`, and
  `REVIEWED_PR_MERGE_NOT_IMPLEMENTED_MESSAGE` (Decisions 1-3 above).
  Still pure presentation: no fetching, no routing.
- `src/components/TicketDetailPage.tsx`: four new container functions
  (`changeStatus`/`accept`/`assign`/`unassign`) wiring the new props to
  `api/tickets.ts`, mirroring `saveTicket`'s existing pattern exactly.
- **Tests** (`TicketDetail.test.tsx`, `TicketDetailPage.test.tsx`): 15
  new cases covering Assignee display/toggle, the exact D3 S2-derived
  button set per Status (all six current Statuses), a successful Status
  move, a rejected Status move leaving the displayed Status unchanged,
  Accept's success and its Status/condition gating, the reviewedPrMerge
  unavailable text, and (in `TicketDetailPage.test.tsx`) the real
  `fetch` calls each button issues (`POST .../status`, `POST
  .../accept`, `PUT`/`DELETE .../assignee`).

### `e2e`

- `support/tickets.ts`: added `changeTicketStatusDirect`/
  `acceptTicketDirect` -- unlike `createTicket`, these never throw on a
  rejection; specs need Galley's actual `error.code`/`error.message` to
  arrange background state and to assert the UI shows Galley's live
  response rather than a hardcoded literal (README.md, "Adding a spec").
- `tests/ticket-lifecycle.spec.ts` (new, signs in fresh): the full human
  path (capture -> refine -> assign -> Ready -> In Progress -> In Review
  -> Accept -> Done -> unassign, with a reload check); manual Blocked
  and resume, also asserting no `Blocked -> Ready` button exists; the
  rejected-skip case (Decision 1); the Coding-Template Accept-unavailable
  case (Decision 2).
- `tests/ticket-lifecycle-before.spec.ts` / `-after.spec.ts` (new):
  reach In Progress and Owner-assigned through the real controls, then
  prove both survive a genuine Galley restart, sharing
  `session-restart-before.spec.ts`'s storage state and `run.sh`'s one
  restart, positioned (like `ticket-refinement-before.spec.ts`) before
  `ticket-persistence-before.spec.ts` so its own Ticket's `created_at`
  does not disturb that spec's "newest two" assertion.
- `run.sh`: two new restart-phase invocations plus one new
  fresh-sign-in phase (after `ticket-templates.spec.ts`), and the
  corresponding exit-code variables/log lines/failure condition.

## Exact versions and toolchain

- Go `1.27.1` (darwin/arm64) -- unchanged; no Galley code was touched by
  this slice.
- Node `v26.9.0`, npm `11.19.1` -- unchanged.
- `apps/swiftlet`: no new dependency. `vite` `8.3.0`, `vitest` `5.0.1`,
  TypeScript per `tsconfig.json` -- unchanged pins.
- `contracts`: `openapi-typescript` `7.13.0` -- unchanged pin; no
  contract edit, so no regeneration was needed (confirmed idempotent
  below anyway, matching every prior slice's own verification step).
- `e2e`: `@playwright/test` `1.63.0` -- unchanged. Chromium's headless
  shell only (`--only-shell`), same as every prior slice.
- PostgreSQL server: `17.11` (Homebrew), `localhost:5432`. Go-side
  verification used `ticketit_test` (real, shared, never reset;
  read-only from this slice's perspective since no Galley code
  changed). Browser-suite runs used `ticketit_e2e`, reset from empty by
  `run.sh` on every invocation. `ticketit_dev` and `ticketit_m1_native`
  were untouched throughout.

## Reproducible commands

**Galley** (from `apps/galley/`, real PostgreSQL, `ticketit_test`
already created -- unchanged by this slice, run only to confirm no
regression):

```sh
cd apps/galley
gofmt -l .
go vet ./...
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

### Galley -- unchanged, confirmed green

```
$ gofmt -l .
(no output -- clean)
$ go vet ./...
(no output -- clean)
$ go test ./... -count=1
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	3.324s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	0.509s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/auth	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/authtest	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	1.294s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	1.738s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	4.165s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	[no test files]
$ ./scripts/check-contract-drift.sh
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
```

### Contract drift, Swiftlet side

```
$ cd contracts && npm ci && ./check-swiftlet-drift.sh
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

### Swiftlet: install, typecheck, test, build

```
$ npm ci
added 108 packages, and audited 109 packages in 849ms
found 0 vulnerabilities

$ npx tsc -p tsconfig.json --noEmit
(no output -- clean)

$ npm run test -- --run
 Test Files  8 passed (8)
      Tests  64 passed (64)

$ npm run build
✓ 26 modules transformed.
dist/index.html                  0.31 kB │ gzip:  0.22 kB
dist/assets/index-Nr_regpp.js  238.70 kB │ gzip: 73.27 kB
✓ built in 49ms
```

Test count: 64, up from #60's 49 -- 15 new cases (workflow controls in
`TicketDetail.test.tsx`, real-request wiring in `TicketDetailPage.test.tsx`).

### Browser suite -- `SUITE PASSED`, 15 spec files (12 unchanged + 3 new)

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
[run.sh] running tests/ticket-lifecycle-before.spec.ts (moves a Ticket to In Progress and assigns the Owner)
  ✓ a Status and Assignee reached through the real controls survive a Galley restart
[run.sh] running tests/ticket-persistence-before.spec.ts (captures two Tickets, newest first)
  ✓ the Owner captures two Tickets, newest first, before Galley restarts
[run.sh] restarting galley (same database, same origin, new process) to prove the session and Tickets survive
[run.sh] running tests/session-restart-after.spec.ts against the restarted galley
  ✓ the session survives a Galley restart
[run.sh] running tests/ticket-persistence-after.spec.ts against the restarted galley
  ✓ the two captured Tickets are still listed, in the same order, after a Galley restart
[run.sh] running tests/ticket-refinement-after.spec.ts against the restarted galley
  ✓ the edited title and manual refinement fields are still there after a Galley restart
[run.sh] running tests/ticket-lifecycle-after.spec.ts against the restarted galley
  ✓ the Status and Assignee reached before a Galley restart are still there after it
[run.sh] running tests/ticket-detail.spec.ts against the restarted galley
  ✓ 5 passed
[run.sh] running tests/ticket-refinement.spec.ts against the restarted galley
  ✓ 4 passed
[run.sh] running tests/ticket-templates.spec.ts against the restarted galley
  ✓ 4 passed
[run.sh] running tests/ticket-lifecycle.spec.ts against the restarted galley
  ✓ the full human path: capture, refine, Ready, In Progress, In Review, Accept, Done
  ✓ manual Blocked and resume return work to In Progress, and Blocked never offers a shortcut straight to Ready
  ✓ a rejected skip is surfaced with Galley's actual reason -- never hidden, retried, or applied as if it had succeeded
  ✓ a Coding-Template Ticket In Review has no Accept button and states Galley's actual not-yet-implemented reason
[run.sh] stopping galley to exercise the failure-mode spec
[run.sh] running tests/backend-failure.spec.ts against a stopped galley
  ✓ the app shows its error state when Galley is stopped, instead of a blank or fabricated page
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
[run.sh] stopping swiftlet preview server
[run.sh] stopping the substitute GitHub provider
```

`lsof -i -P` immediately after exit showed no `galley`/`githubfake`/
`vite`/`node` listener left behind, both before this slice's changes and
after every run recorded here.

## Proof the suite can fail

Four separate, targeted, reverted breaks against a full `./run.sh`
invocation each, each capturing the actual red output, each reverted
(confirmed via `grep` showing no residual change, then a green
`./run.sh` re-run). Required by this slice's own instructions: at least
one break that makes Swiftlet *hide* a Galley rejection rather than
surface it, plus proof that the other new specs depend on the behavior
they claim to.

**1. Hides a Galley rejection (the required case)** --
`TicketDetail.tsx`'s `runAction` catch block changed from
`setActionError(...)` to an empty `catch { }` (silently swallowing the
rejection instead of surfacing it):

```
1) [chromium] › tests/ticket-lifecycle.spec.ts:96:3 › a rejected skip is surfaced with Galley's actual reason -- never hidden, retried, or applied as if it had succeeded
   Error: expect(locator).toHaveText(expected) failed
   Locator: getByTestId('ticket-detail-action-error')
   Error: element(s) not found
```

Only this one test failed (3 other `ticket-lifecycle.spec.ts` cases
still passed, since they never trigger a rejection); `run.sh` reported
`SUITE FAILED`. Reverted; confirmed via `grep -n "BREAK-"` showing no
residual change, then a full green `./run.sh` re-run.

**2. An allowed transition, broken** --
`presentationNextStatuses.InProgress` changed from `["Ready", "Blocked",
"InReview"]` to `["Ready", "InReview"]` (silently dropping the
`InProgress -> Blocked` button):

```
1) [chromium] › tests/ticket-lifecycle.spec.ts:71:3 › manual Blocked and resume ...
   Test timeout of 30000ms exceeded.
   Error: locator.click: Test timeout of 30000ms exceeded.
   Call log:
     - waiting for getByTestId('ticket-detail-status-button-Blocked')
```

Reverted; confirmed via `grep`, then a full green `./run.sh` re-run.

**3. Accept's completion-condition gate, broken** -- the Accept
button's render condition changed from `current.status === "InReview"
&& current.completionCondition === "humanAcceptance"` to just
`current.status === "InReview"` (ignoring the retained condition
entirely -- exactly the "silently downgrade the condition" failure mode
this issue and D3 both name):

```
1) [chromium] › tests/ticket-lifecycle.spec.ts:134:3 › a Coding-Template Ticket In Review has no Accept button ...
   Locator:  getByTestId('ticket-detail-accept-button')
   Expected: 0
   Received: 1
```

Reverted; confirmed via `grep`, then a full green `./run.sh` re-run.

**4. The Assignee display, broken** -- `ticket-detail-assignee`'s
ternary inverted (`current.assigneeType === OWNER_ASSIGNEE_TYPE ?
"Unassigned" : "Owner"`, swapping the two branches):

```
1) [chromium] › tests/ticket-lifecycle.spec.ts:17:3 › the full human path ...
   Locator:  getByTestId('ticket-detail-assignee')
   Expected: "Unassigned"
   Received: "Owner"

1) [chromium] › tests/ticket-lifecycle-after.spec.ts:23:1 › the Status and Assignee reached before a Galley restart are still there after it
   Locator:  getByTestId('ticket-detail-assignee')
   Expected: "Owner"
   Received: "Unassigned"
```

Both the same-run full-path spec and the separate restart-persistence
spec failed from this one change, confirming both actually exercise the
Assignee display. Reverted; confirmed via `grep`, then a full green
`./run.sh` re-run (the one recorded under "Observed results" above).

**A fifth, unplanned finding surfaced while designing break 4:** the
first attempt at that break (miscapitalizing `OWNER_ASSIGNEE_TYPE` from
`"owner"` to `"Owner"`, rather than inverting the ternary) never reached
the browser at all -- `apps/swiftlet`'s own `npm run build` step inside
`run.sh` failed at `tsc`:

```
src/components/TicketDetail.tsx(254,18): error TS2367: This comparison
appears to be unintentional because the types '"" | "owner"' and
'"Owner"' have no overlap.
```

`contracts/openapi-typescript` generates `TicketAssigneeType` as the
literal union `"owner" | ""` (not widened to `string`), so TypeScript's
own strict comparison check already catches an assignee-type literal
typo at compile time, before any test runs -- a stronger guardrail than
this slice added on purpose. The break was redesigned (inverting the
ternary instead, which type-checks) to actually exercise the intended
runtime assertions, and this compile-time behavior is noted here as a
genuine, unplanned finding rather than discarded.

## Implementation limitations and follow-ups

- **The `reviewedPrMerge` "Accept unavailable" message is a static,
  hand-copied string, not fetched live.** Decision 2 above records why
  (an automatic background command undercuts "explicit Accept action")
  and how the drift risk is mitigated (a live cross-check in
  `ticket-lifecycle.spec.ts`, not merely a hardcoded assumption). If a
  future change to Galley's `reviewedPrMergeNotImplementedCode` message
  text is not mirrored here, that browser spec fails immediately rather
  than silently drifting -- no owning-milestone follow-up is needed
  beyond that existing guardrail, since M8/D2 already own removing this
  limitation entirely once reviewed-PR-merge completion is implemented.
- **`Done -> Ready`'s D4 caveat remains unenforced**, exactly as #60
  recorded: this slice's `presentationNextStatuses.Done` offers `Ready`
  unconditionally (mirroring Galley's own unconditional acceptance), so
  no new limitation is introduced here -- D4 is still owned by **M8**.
- **No Status precondition on Assignee changes**, exactly as #60
  recorded: the Assign/Unassign buttons render regardless of the
  current Status, matching Galley's own unconditional acceptance in M2.
  M4's open-Round field lock is still out of scope here.
- **No Agent Assignee option anywhere** -- `TicketDetail.test.tsx`
  asserts no element anywhere in the rendered output matches `/agent/i`.
  Agent Assignee, agent-assignment, and Agent-readiness validation
  remain **M4**'s, per D3 and this issue's own scope statement.
- No other required behavior in issue #61 was left unimplemented; every
  acceptance criterion is satisfied and verified above:
  - The complete human-assigned workflow is demonstrable in a real
    browser and persists across a backend restart
    (`ticket-lifecycle.spec.ts`'s full-path case;
    `ticket-lifecycle-before/after.spec.ts`).
  - Manual Blocked and resume work
    (`ticket-lifecycle.spec.ts`'s Blocked/resume case) and create no
    Round or execution record (already proven at the Galley level by
    #60's `TestManualLifecycleActionsCreateNoExecutionRecords`, which
    this slice's UI calls exercise through the same handlers -- no new
    Galley-level guardrail was needed since no new Galley behavior was
    added).
  - A rejected transition surfaces Galley's actual reason
    (`ticket-lifecycle.spec.ts`'s rejected-skip case, compared against a
    live direct API response, not a literal).
  - Accept appears only for human-acceptance completion; the PR-merge
    case states why it is unavailable, cross-checked against Galley's
    live response (`ticket-lifecycle.spec.ts`'s Coding-Template case).
  - No UI element implies Agent execution exists
    (`TicketDetail.test.tsx`'s Agent-absence assertion; no Agent
    Assignee control was added anywhere).

## Outstanding checks and owning milestone

- **CI automation** of the commands recorded here -- no owning issue
  yet, unchanged from every prior M2 slice's own recorded limitation.
- **D4's `Done -> Ready` caveat, Agent Assignee, Agent-readiness
  validation, open-Round field locks** -- **M4**, per D3's own
  "Implementation rules and verification examples" table (unchanged from
  #60's own recording; this slice adds no new instance of these gaps).
- **D2** (review/merge evidence) and the shared completion mechanism it
  selects -- still open, still **M8**; this slice's Accept-unavailable
  text names both explicitly and is cross-checked live against Galley's
  own current rejection, but implements no completion path for
  `reviewedPrMerge` itself.
- **M3's ticket-detail modal** reusing these same controls unchanged --
  the container/presentation split (Decision 4) is designed for this,
  but building the modal itself is M3's own work, not verified here.

## Decision impacts (open-decision IDs)

D3 is the decision this slice's controls present; this slice adds no
new Swiftlet-side rule beyond what D3 S2/S4 and #60's Galley
implementation already establish -- every offered transition, the
Accept gate, and the Assignee toggle are presentation of Galley's own
authoritative decisions, proven live rather than assumed
(`ticket-lifecycle.spec.ts`'s two live-comparison cases). D1, D2, D4-D9
are not resolved or touched by this slice. D2 and D4 are named (not
resolved) in "Implementation limitations and follow-ups" above, exactly
as this issue instructs. This slice provisions no paid resource and
creates no provider account, per `AGENTS.md`'s "Paid resources" rule.
