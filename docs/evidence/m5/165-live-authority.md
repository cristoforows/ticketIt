# Live authority checks and ticket-based Permission grants

## Purpose

M5.7, [#165](https://github.com/cristoforows/ticketIt/issues/165).

The core Permission loop, against a **substitute** Connected Account:

- A new `act` script step names an account, an action and a resource.
- Before acting, Michelin asks Galley whether the Agent holds authority
  for that scope on this Ticket now. Galley reads its live grants and
  answers allow or deny. It records every check.
- On deny, Michelin reports `permission_requested`. The Round becomes
  Waiting for Input; the Ticket is Blocked, stays locked and keeps the
  slot. The slip reads **Waiting for a Permission**.
- The Owner sees a receipt-styled request panel and chooses **Allow for
  this Ticket** or **Decline**.
  - Approval creates a ticket-based grant for exactly this Agent, Ticket
    and scope, and queues an `approval` command. Michelin resumes the
    same Round, checks again and performs the action.
  - Decline leaves the Round waiting until Stop.
- Later `act` steps in the same scope are allowed without a new request,
  in this Round and in later Rounds of the Ticket.

**The controlled Connected Account is a substitute.** `controlled`
stands in for a real account (GitHub, M8 #9). Acting through it only
writes a progress note, and nothing outside Galley changes. Galley
returns `substituteAccount: true` for it, and Swiftlet tags it
**Substitute account** everywhere it appears.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/` and `CONTEXT.md` (Connected Account, Permission, new
**Permission Request** and **Approval**, Waiting for Input, Waiting
Reason, Blocked).

## What already existed

- M5.1–M5.6 (#159–#164) were merged to `main`. This branch starts at
  `378c902` (M5.6).
- Waiting for Input existed for questions only (M5.5). The Round held a
  question through `round_questions` and its unanswered-per-Round index.
  `resumed` carried `questionId`.
- The command channel carried `stop` and `answer`.
- There was no Permission, grant, Connected Account or authority-check
  record, and no runner endpoint for authority.
- **Baseline** (the M5.6 record):
  - Galley: 423 top-level tests.
  - Michelin: 353. Swiftlet: 576 (27 files).
  - Browser suite: 43 specs, 96 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`; `api.gen.go` and both
`schema.d.ts` regenerated):

- `POST /api/runner/rounds/{roundId}/authority-checks`
  (`checkRoundAuthority`): `AuthorityCheckRequest {account, action,
  resource, epoch}` → `AuthorityCheckResult {decision: allow|deny,
  grantId?}`.
- `POST /api/tickets/{id}/rounds/{roundId}/permission-requests/{requestId}/approve`
  (`approvePermissionRequest`, body `ApprovePermissionRequest {form}`,
  where `PermissionGrantForm` is the enum `ticket`) and `.../decline`
  (`declinePermissionRequest`, no body). Both return the Ticket.
- `RoundEventType` adds `permission_requested` (`PermissionRequestedData
  {requestId, account, action, resource}`). `resumed` takes either
  `ResumedData {questionId}` or `ApprovalResumedData {requestId}`.
  `RoundEventResult.requestId` is set for both.
- `PermissionRequest`, `PermissionGrant` (`form`, `state` `active`,
  `substituteAccount`), `RoundAuthorityCheck`.
- `Ticket.permissionGrants`, `TicketOpenRound.permissionRequest`,
  `TicketAllowedActions.permissionDecision`;
  `TicketRound.permissionRequests`, `authorityChecks`,
  `authorityCheckCount`.
- `RoundWaitingReason` adds `waiting_for_permission`.
  `RunnerCommandType` adds `approval`, with
  `RunnerCommand.approval {requestId, grantId}`.
- New error codes: `unsupported_scope`, `round_not_running`,
  `permission_already_decided`, `permission_decision_not_available`,
  `approval_not_supplied`.

**Galley**

- Migration `000022_live_authority_and_permission_grants.up.sql`:
  `permission_requests`, `permission_grants`, `round_authority_checks`;
  the event and command type constraints are widened;
  `round_commands.permission_request_id`, with at most one approval per
  request; `rounds.waiting_question_id` and
  `rounds.waiting_permission_request_id` under the CHECK
  `rounds_waits_on_one_ask`. Waiting Rounds that already exist are
  backfilled with their latest question.
- `connected_accounts.go` (new): the code-declared catalogue and its
  validation.
- `round_authority.go` (new): the check handler, `decideAuthorityCheck`,
  and the live read and record in one transaction.
- `round_permissions.go` (new):
  - `raisePermissionRequest`;
  - `decidePermission`, the one decision for both commands and for
    `allowedActions.permissionDecision`;
  - `decidePermissionForOwner`, which locks the Ticket row, then the
    request row, and writes the decision, the grant and the command
    together;
  - the Round-list and Ticket readers.
- `round_events.go`: `permission_requested` goes through the existing
  ladder. Its idempotency key must equal `requestId`, and a scope outside
  the catalogue is `400 unsupported_scope` before the lookup. `resumed`
  takes `requestId` and needs an approval (`409 approval_not_supplied`).
- `round_questions.go` and `round_waiting.go`: the waiting ask moved to
  the `rounds` columns. `waiting_for_permission` ranks below `stopping`.
- Also updated: `ticket.go`, `ticket_rounds.go`, `agent_readiness.go`,
  `ticket_lifecycle.go`, `round_commands.go` (the approval listing,
  after any Stop), `round_endings.go` (clears the waiting columns),
  and `handler.go` (405s).
- Tests:
  - `round_authority_test.go` (8 tests) and `round_permissions_test.go`
    (17 tests);
  - `permission_requested` rows and the resumed-ask test in
    `round_events_test.go`;
  - the new rows in `round_waiting_test.go`;
  - the three tables (with unchanged-count assertions) and the decision
    `404` probes in `no_execution_side_effects_test.go`;
  - `TestPermissionsAndAuthorityChecks_ResponsesMatchContractAndMethod405`.
  - `TestNoTemplateToCapabilityMapping` is unchanged.

**Michelin**

- `engineScript.ts`: the `act` step (`account`, `action`, `resource`:
  1 to 200 characters, not blank, no control characters), checked at
  start like every step.
- `engine.ts`:
  - `requestIdFor(roundId, stepIndex)`, a UUID v5 of `act:<stepIndex>`;
  - the `act` case: check, then on allow note `Performed <action> on
    <resource>`; on deny, `permission_requested`, wait for the approval,
    `resumed`, ack, re-check, then perform or fail;
  - `checkScope`, with the event retry policy.
- `galley/runner.ts`: `checkAuthority` with strict response parsing
  (`allow` needs `grantId`, `deny` has none); `approval` commands need
  `requestId` and `grantId`.
- `answerInbox.ts`: a generic `Inbox<T>`, with `AnswerInbox` and
  `ApprovalInbox`.
- `commandLoop.ts` and `claimLoop.ts`: `approval` is handed to the
  waiting step for the claim's epoch, and acked `ignored` for another
  epoch.
- Tests: "the act step" in `engine.test.ts`, "approvals" in
  `commandLoop.test.ts`, the `act` rows in `engineScript.test.ts`, and
  the approval inbox in `answerInbox.test.ts`.

**Swiftlet**

- `api/tickets.ts`: strict `parsePermissionRequest` and
  `parsePermissionGrant`; a waiting Round holds exactly one ask;
  `approvePermissionRequest` and `declinePermissionRequest`.
- `api/rounds.ts`: `permissionRequests`, `authorityChecks` and
  `authorityCheckCount`.
- `components/PermissionPanel.tsx` (new): `PermissionPanel`,
  `PermissionHistory`, `PermissionGrants` and the `SubstituteLabel` tag.
  It reuses the receipt components (`ReceiptLine`, `FieldLabel`, the
  buttons) and the question panel's bordered region, with no new colours.
- `RoundsSection.tsx`, `TicketDetail.tsx`, `TicketDetailPage.tsx`: the
  wiring, the reload, the refresh on any Galley refusal, and **Waiting
  for a Permission** as the Round outcome.
- `ActiveOrder.tsx` and `styles.css`: the slip label, with the idle
  rider.
- Tests:
  - `TicketDetail.test.tsx`: "a Permission request from the Agent", 10
    tests.
  - `TicketDetailPage.test.tsx`: 2 tests.
  - `ActiveOrder.test.tsx`: 1 test, on the list and the board.
  - `api/tickets.test.ts` and `api/rounds.test.ts`: the parsers and the
    commands.
  - Existing fixtures were updated for the new required fields.

**e2e**

- `tests/runner-permission.spec.ts` (two tests), registered in `run.sh`
  after `runner-feedback.spec.ts` and before `active-order-slip.spec.ts`,
  with an exit check.
- `support/tickets.ts` carries the new fields and
  `decidePermissionDirect`. `support/runner.ts` carries the `act` step.
- `runner-claims.spec.ts` and `runner-engine.spec.ts` were updated for
  their exact-equality assertions.

**Docs:** the Galley, Michelin, Swiftlet and e2e READMEs, and
`CONTEXT.md`.

### The matching rule

A check for scope `(account, action, resource)` on Round *R* is
**allow** exactly when a grant exists with:

- `owner_id` = R's Owner;
- `agent_id` = R's Agent (the Agent recorded on the Round when it was
  claimed);
- `ticket_id` = R's Ticket;
- `account`, `action` and `resource` byte-equal to the check's;
- `state = 'active'`.

Otherwise the check is **deny**. The resource pattern is not used when
matching. It only decides whether a scope may be checked or requested
at all:

| Account | Action | Resource pattern |
| --- | --- | --- |
| `controlled` | `read_note`, `write_note` | `^notes/[a-z0-9][a-z0-9-]{0,63}$` |
| `controlled` | `post_message` | `^channels/[a-z0-9][a-z0-9-]{0,63}$` |

A grant for `write_note` on `notes/weekly-report` therefore denies
`notes/weekly-reports`, `notes/weekly`, `notes/other`, `read_note` on
the same note, `post_message` on `channels/weekly-report`, another
Agent on the same Ticket (after reassignment) and the same Agent on
another Ticket. Each of these is a row in
`TestAuthorityCheck_MatchesTheGrantsAgentTicketAndScopeExactly`. In the
same test, `github`, `Controlled`, `notes/*`, `notes/`,
`notes/Weekly-report` and `channels/…` for `write_note` are
`400 unsupported_scope`, so a wildcard, a prefix or a change of case
can never reach the grant read. The
account's existence authorizes nothing: with no grant, every check is
deny (`TestAuthorityCheck_ReadsGrantsLive`).

### Engineering choices beyond the Decisions

- **The catalogue is declared in code.** The Decision asks for a fixed,
  declared set. A table would invite edits that the slice has no UI or
  rule for.
- **An unsupported scope is `400 unsupported_scope` on both the check
  and `permission_requested`, and nothing is recorded.** A request for a
  scope Galley cannot grant could never be approved, so it is refused
  rather than left pending forever. Michelin ends the Round as Failed
  with `… Galley does not support this scope`.
- **Michelin validates only the shape of `act` at start, and Galley
  decides support.** Two copies of the catalogue would drift.
- **A check needs the Round to be `running`** (`409 round_not_running`;
  an ended Round is `409 round_not_open`, as decided). A Round that is
  waiting or claimed performs no action, so a check then is out of
  order.
- **The read and the record share one transaction, under a share lock
  on the Round row.** The Round cannot end or change epoch between the
  decision and its record, and a grant committed before the check is
  always seen.
- **Both allow and deny are recorded**, with the grant on allow (a CHECK
  ties the two) and the claim epoch. The Round list shows the latest 50
  per Round plus `authorityCheckCount`, bounded like activity.
- **`permission_requested`'s idempotency key must equal
  `data.requestId`**, as for questions, so a replay cannot raise a
  second request.
- **One pending ask per Round, enforced in the database.**
  `rounds.waiting_question_id` and `waiting_permission_request_id` name
  the ask, and `rounds_waits_on_one_ask` requires exactly one of them
  while `waiting_for_input` and neither otherwise. A partial unique
  index allows one undecided request per Round.
- **Composite foreign keys bind the grant to the request's Agent, Ticket
  and scope**, and the request to its Round's Agent and Ticket. A grant
  cannot drift from what was asked, even through a direct insert.
- **`resumed` carries `{requestId}`** (`ApprovalResumedData`), the
  counterpart of `{questionId}`. Galley accepts it only for the request
  the Round waits on, once approved.
- **First decision wins.** A second approve or decline is
  `400 permission_already_decided` and changes nothing. Concurrent
  decisions record exactly one. A late approval after the Round ended,
  or after Stop was requested, is refused and creates no grant.
- **Decline queues no command.** The Round keeps waiting with
  `waitingReason` `waiting_for_permission`, and Michelin keeps waiting
  until Stop. The Decision says the Round stays waiting; telling the
  runner would only let it end the Round itself.
- **Approval writes the decision, the grant and one `approval` command
  in one transaction**, so none exists without the others.
- **Lock order: the Ticket row, then the request row**, as for answers.
  A test pins it, and race tests run approve against Stop.
- **Michelin asks at most once per `act` step.** After an approval it
  checks again. A second deny means Galley no longer allows it, and
  asking again would loop. The Round ends as Failed with
  `… Galley still denies it after the Owner's approval`.
- **Michelin acks the approval only after `resumed` is recorded**, as
  for answers, so a crash between them leaves the command listed.
- **Michelin never caches an allow.** Every `act` calls Galley; a test
  runs two steps against a check that flips from allow to deny.
- **Swiftlet refreshes the receipt on any Galley refusal of a
  decision**, and explains `permission_already_decided` and
  `permission_decision_not_available`. Any other refusal is shown in
  Galley's words.
- **The decision buttons show only while
  `allowedActions.permissionDecision.available`.** Otherwise Galley's
  reason is shown.

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), `go.mod` `go 1.27.1`; oapi-codegen via the
  `tool` directive in `go.mod`.
- PostgreSQL 17.11 (Homebrew), local.
- Node v26.9.0, npm 11.19.1.
- Swiftlet: React 19.3.0, Vite 8.3.0, Vitest 5.0.1, TypeScript 7.0.2.
- Michelin: Vitest 5.0.1, TypeScript 5.9.3.
- Contracts: openapi-typescript 7.13.0.
- e2e: @playwright/test 1.63.0 (chromium).

## Reproducible commands

```sh
cd apps/galley
gofmt -l . ; go vet ./... ; go build ./...
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m57?sslmode=disable' go test ./... -count=1
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m57?sslmode=disable' go test -race ./... -count=1
./scripts/check-contract-drift.sh

cd ../michelin && npm run typecheck && npx vitest run
cd ../swiftlet && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd ../../contracts && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh

cd ../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m57?sslmode=disable' ./run.sh
```

The drift checks refuse a generated file with uncommitted changes, so
they run on the committed tree.

## Observed results

Run on the committed tree (`1eaa502`, before this record's results
were added), 2026-10-04.

- Drift: all three checks exited 0.

  ```text
  OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
  OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  ```

- Galley: `gofmt -l .` printed nothing, and `go vet ./...` and
  `go build ./...` were clean.
  - `go test ./... -count=1` exited 0. `go test -json` counted 450
    top-level tests (baseline 423) and 1704 with subtests, 0 failed.
  - `go test -race ./... -count=1`, with no `FAIL` line:

    ```text
    ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	6.199s
    ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	2.173s
    ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	2.243s
    ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	3.711s
    ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	3.298s
    ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	159.148s
    ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	2.920s
    ```

  - A targeted `-v` run of the race tests logged both orders:

    ```text
    round_permissions_test.go:475: map[approved:3 declined:3]
    --- PASS: TestPermissionDecision_ConcurrentDecisionsRecordExactlyOne (1.43s)
    round_permissions_test.go:592: map[approved first:3 stopped first:5]
    --- PASS: TestApprove_RacingStopLeavesEitherAStoppingRoundWithNoGrantOrBothCommands (1.67s)
    ```

- Michelin: the typecheck was clean. `Test Files 11 passed (11)`,
  `Tests 380 passed (380)` (baseline 353).
- Swiftlet: `tsc --noEmit` was clean. `Test Files 27 passed (27)`,
  `Tests 621 passed (621)` (baseline 576). `npm run build`:
  `✓ built in 141ms`.
- Browser suite: `SUITE PASSED`, exit 0, on the first full run. All 44
  specs exited 0 and 98 tests passed (baseline 43 specs and 96 tests;
  the new spec adds two). The new spec:

  ```text
  Running 2 tests using 1 worker
  ✓  1 [chromium] › tests/runner-permission.spec.ts:39:1 › a real Michelin's denied action blocks the Ticket, and one approval for this Ticket lets both actions run in the same Round (4.6s)
  ✓  2 [chromium] › tests/runner-permission.spec.ts:136:1 › a declined Permission request leaves the Round waiting until the Owner's Stop ends it (4.2s)
  [run.sh] SUITE PASSED
  ```

  The first test asserts that the `controlled` account shows as
  `controlledSubstitute account` on the receipt.

Only this record changed after these runs.

## Falsification

Each row breaks the implementation in one place with an uncommitted
script that makes one exact-text replacement (two for M1 and M3). The
script runs the named suite and then restores the file. `git diff
--stat` was identical before and after the pass (`57 files changed,
3218 insertions(+), 259 deletions(-)`, with eight new files untracked).

Galley rows ran `go test ./internal/httpapi -run
'Authority|Permission|Approve|Decline|Resumed|Waiting|DecideRoundEvent|Contract|NoExecution|QuestionRaised|Answer'`.
Michelin and Swiftlet rows ran the app's whole `npx vitest run`.

| # | Break | Result | Failing test(s) |
| --- | --- | --- | --- |
| G1 | the grant read ignores the Agent | killed | `TestAuthorityCheck_MatchesTheGrantsAgentTicketAndScopeExactly` |
| G2 | the grant read ignores the Ticket | killed | `TestAuthorityCheck_MatchesTheGrants…Exactly` |
| G3 | the grant read ignores the resource | killed | `TestAuthorityCheck_MatchesTheGrants…Exactly` |
| G4 | the grant read ignores the action | killed | `TestAuthorityCheck_MatchesTheGrants…Exactly`, `TestAuthorityCheck_ReadsGrantsLive` |
| G5 | the check ignores the claim epoch | killed | `TestAuthorityCheck_IsAnsweredOnlyForTheRunningRoundAtItsEpoch`, contract test |
| G6 | a check is answered while the Round is not running | killed | `TestAuthorityCheck_IsAnsweredOnly…`, `TestDecline_LeavesTheRoundWaiting…`, contract test |
| G7 | the check accepts an unsupported scope | killed | `TestAuthorityCheck_MatchesTheGrants…Exactly`, contract test |
| G8 | `permission_requested` accepts an unsupported scope | killed | `TestPermissionRequested_DataIsValidatedStrictly`, contract test |
| G9 | a second decision is accepted | killed | `TestPermissionDecision_TheFirstDecisionWins`, `…_ConcurrentDecisionsRecordExactlyOne`, `…_IsRefusedOnceStopIsRequested…`, `TestApprove_RecordsTheGrant…`, `TestDecline_…`, contract test |
| G10 | a decision is accepted while Stop is requested | killed | `TestPermissionDecision_IsRefusedOnceStopIsRequestedAndAfterTheRoundEnds`, `TestPermissionRequested_IsAcceptedOnlyFromARunningRound` |
| G11 | approval writes neither the grant nor the command | killed | `TestAuthorityCheck_ReadsGrantsLive` (it panicked on the missing grant, ending the run). Re-run without it (`-run 'Approve\|Permission\|Decline\|Resumed'`): `TestApprove_RecordsTheGrant…`, `TestResumed_AfterApprovalContinuesTheSameRoundToDelivery`, `TestPermissionRequested_KeyIsTheRequestId…` |
| G12 | `resumed` is accepted without the approval | killed | `TestResumed_NeedsTheApprovalOfTheRequestTheRoundWaitsOn`, `TestDecideRoundEvent_ResumedNeedsTheSuppliedAskTheRoundWaitsOn`, `TestDecline_…`, contract test |
| G13 | the `permission_requested` key need not equal `requestId` | killed | `TestPermissionRequested_KeyIsTheRequestIdAndAReplayRaisesNoSecondRequest`, `…_DataIsValidatedStrictly` |
| G14 | a Round waiting on a Permission reports `waiting_for_answer` | killed | `TestDecideWaitingReason`, `TestWaitingReason_AWaitingForAPermission…`, `TestPermissionRequested_MovesTheRunningRound…`, `TestDecline_…` |
| M1 | the approval is acked before `resumed` is sent | killed | `engine.test.ts` "asks for a Permission on a deny, waits, resumes…", `commandLoop.test.ts` "hands the approval to the waiting engine…" |
| M2 | no re-check after the approval | killed | 4 tests in "the act step" and "approvals" |
| M3 | an allow is cached across `act` steps | killed | `engine.test.ts` "never caches an allow: each act step checks again…" |
| M4 | an approval for another claim epoch is applied | killed | `commandLoop.test.ts` "acknowledges an approval for another claim epoch as ignored…" |
| M5 | `approval` is treated as an unknown command | killed | 2 tests in "approvals" |
| M6 | `requestId` is not deterministic | killed | 7 tests, including "derives a stable version 5 requestId apart from the question ids" |
| M7 | a second deny after the approval performs the action anyway | killed | `engine.test.ts` "fails the Round rather than asking again when Galley still denies after the approval" |
| S1 | the parser accepts a waiting Round with both asks or none | killed | 4 tests in `tickets.test.ts` |
| S2 | the decision buttons show whatever Galley advertises | killed | `TicketDetail.test.tsx` "offers no decision Galley does not advertise, and names why" |
| S3 | no Substitute account tag on the scope | killed | `TicketDetail.test.tsx` "shows the request as a receipt that labels the controlled account a substitute…", `TicketDetailPage.test.tsx` "approves for this Ticket…" |
| S4 | no receipt refresh on a refused decision | killed | `TicketDetailPage.test.tsx` "refreshes the receipt when Galley already recorded a decision" |
| S5 | the wrong slip label | killed | `ActiveOrder.test.tsx`, on the board and on the list |
| S6 | approve sends another form | killed | `tickets.test.ts` "approves with the ticket form…", `TicketDetailPage.test.tsx` "approves for this Ticket…" |
| S7 | the parser accepts an approval without its grant | killed | 3 tests in `tickets.test.ts` and `rounds.test.ts` |
| S8 | truncated authority checks are not flagged | killed | `TicketDetail.test.tsx` "says when Galley lists only the latest authority checks" |
| S9 | the parser accepts an allow without its grant | killed | 2 tests in `rounds.test.ts` |

No break survived. The e2e assertions were not falsified separately.
Each behaviour has a unit-level or Go-level kill above, and a full
browser suite takes about ten minutes per run.

## Implementation limitations and follow-ups

- **Ticket grants do not yet end at Done.** `state` is always `active`,
  and the CHECK allows only that value. Ending at Done and staying
  expired on reopen is M5.11 (#169). Manual revocation and the
  authority-changed command are M5.10 (#168).
- **Only the ticket form.** `form` is an enum with one value, so M5.8
  (#166) can add `time` without a breaking change. Full account access
  is M5.9 (#167).
- **The Connected Account is a substitute.** `controlled` performs
  nothing outside Galley. Real accounts and real provider calls are M8
  (#9).
- **A Michelin restarted while a Round waits for an approval does not
  pick it up**, the same limitation as questions. Recovery is M5.12
  (#170) and M5.13 (#171).
- **A declined request ends only by Stop.** There is no way to re-ask in
  the same Round, as decided.
- **An action Galley denies again after the approval fails the Round.**
  This can only happen once revocation exists (M5.10).
- **No notification.** The Owner sees the request on the slip and the
  receipt only.

## Outstanding checks and owning milestone

- Visual review of the request panel, the grants list and the slip
  label by the Owner (M5 gate, #173).
- A screen-reader pass beyond the role, name and label assertions here
  (M5 gate).
- Concurrency between a check and a grant ending, once grants can end
  (M5.10, M5.11).

## Decision impacts (open-decision IDs)

None resolved. The slice implements #165's settled Decisions and
touches none of D1, D2, D4, D6, D7 or D9. It does not touch D8's
in-flight revocation either, which the Owner settled for M5.10.
