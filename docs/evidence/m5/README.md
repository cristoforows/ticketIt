# M5 evidence index

[M5 — Human input, live Permissions, and execution recovery (#6)](https://github.com/cristoforows/ticketIt/issues/6) has fourteen implementation slices (#159–#172), all merged to `main` as #174–#187. [M5.15 (#173)](https://github.com/cristoforows/ticketIt/issues/173) records the gate on branch `m5/173-gate` at `main` `b7dc26e`. M5 executes only Michelin's scripted controlled engine against the substitute Connected Account `controlled`: no model, provider, object storage or GitHub call.

## Records

| File | Slice / Issue / PR | Establishes |
| --- | --- | --- |
| [159-stop-request.md](159-stop-request.md) | M5.1 [#159](https://github.com/cristoforows/ticketIt/issues/159) / [#174](https://github.com/cristoforows/ticketIt/pull/174) | Owner Stop records one `stop` command; the pulled-command channel and acknowledgement |
| [160-confirmed-stop.md](160-confirmed-stop.md) | M5.2 [#160](https://github.com/cristoforows/ticketIt/issues/160) / [#175](https://github.com/cristoforows/ticketIt/pull/175) | `stop_confirmed` ends the Round Stopped; Backlog with the removable Stopped Badge; two `run.sh` resets removed |
| [161-failed-interrupted.md](161-failed-interrupted.md) | M5.3 [#161](https://github.com/cristoforows/ticketIt/issues/161) / [#176](https://github.com/cristoforows/ticketIt/pull/176) | `failed` and `interrupted` end the Round; Blocked, and only the Owner's Ready starts another Round |
| [162-active-order-slip.md](162-active-order-slip.md) | M5.4 [#162](https://github.com/cristoforows/ticketIt/issues/162) / [#177](https://github.com/cristoforows/ticketIt/pull/177) | Greyed active slip, food-delivery animation, `waitingReason`, View/Stop; receipt local time and paging |
| [163-questions-answers.md](163-questions-answers.md) | M5.5 [#163](https://github.com/cristoforows/ticketIt/issues/163) / [#178](https://github.com/cristoforows/ticketIt/pull/178) | `question_raised`, the Owner's answer, `answer` command and `resumed` continue the same Round |
| [164-round-feedback.md](164-round-feedback.md) | M5.6 [#164](https://github.com/cristoforows/ticketIt/issues/164) / [#179](https://github.com/cristoforows/ticketIt/pull/179) | Round Feedback reaches the next Round once; Done → Ready is the reopen route |
| [165-live-authority.md](165-live-authority.md) | M5.7 [#165](https://github.com/cristoforows/ticketIt/issues/165) / [#180](https://github.com/cristoforows/ticketIt/pull/180) | Authority checks per action; `permission_requested`, approval and ticket grants |
| [166-time-based-grants.md](166-time-based-grants.md) | M5.8 [#166](https://github.com/cristoforows/ticketIt/issues/166) / [#181](https://github.com/cristoforows/ticketIt/pull/181) | Time grants, expiry by Galley's clock, renewal as a new grant |
| [167-full-account-access.md](167-full-account-access.md) | M5.9 [#167](https://github.com/cristoforows/ticketIt/issues/167) / [#182](https://github.com/cristoforows/ticketIt/pull/182) | Explicit full access to a Connected Account's declared capabilities |
| [168-revocation.md](168-revocation.md) | M5.10 [#168](https://github.com/cristoforows/ticketIt/issues/168) / [#183](https://github.com/cristoforows/ticketIt/pull/183) | Revocation ends a grant at once and requests Stop of covered Rounds; `authority_changed` |
| [169-grants-end-at-done.md](169-grants-end-at-done.md) | M5.11 [#169](https://github.com/cristoforows/ticketIt/issues/169) / [#184](https://github.com/cristoforows/ticketIt/pull/184) | Ticket grants end at Done and stay ended on reopen; fresh grants work |
| [170-reconcile.md](170-reconcile.md) | M5.12 [#170](https://github.com/cristoforows/ticketIt/issues/170) / [#185](https://github.com/cristoforows/ticketIt/pull/185) | Reconcile on register or after a health gap: `continue`, `stop`, `report_cessation`, `hold` |
| [171-stranded-round-recovery.md](171-stranded-round-recovery.md) | M5.13 [#171](https://github.com/cristoforows/ticketIt/issues/171) / [#186](https://github.com/cristoforows/ticketIt/pull/186) | Idempotent claims, runner fencing (`runner_not_holder`), bounded report retry, Owner-attested recovery (D5) |
| [172-technical-limits.md](172-technical-limits.md) | M5.14 [#172](https://github.com/cristoforows/ticketIt/issues/172) / [#187](https://github.com/cristoforows/ticketIt/pull/187) | Wall-clock and denial-loop limits; a breach requests Stop and ends the Round Failed (D8) |

## Clean-worktree gate verification (M5.15, 2026-10-06)

Run on a clean worktree of `main` `b7dc26e` (`git status --short` empty before and after). Go 1.27.1, Node 26.9.0/npm 11.19.1, PostgreSQL 17.11 (Homebrew). Each database was created for this gate; the Galley count below is from `ticketit_test_m515v`, created with **0 public tables**. Steps ran one at a time; no build ran during the browser suite. No deployment was part of this gate.

### Galley and Go contract drift

```sh
cd apps/galley
gofmt -l . && go vet ./...
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m515v?sslmode=disable' go test ./... -count=1 -json
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m515r?sslmode=disable' go test -race ./... -count=1 -p 1
cd ../.. && apps/galley/scripts/check-contract-drift.sh
```

Observed: `gofmt -l .` emitted nothing; `go vet` exited 0. `go test ./... -count=1` (first on `ticketit_test_m515`, then with `-json` on the fresh `ticketit_test_m515v`): every package `ok` (`internal/httpapi` in `158.69s`); 611 top-level tests and 1580 subtests passed, 0 failed, 0 skipped. `go test -race ./... -count=1 -p 1` on a fresh `ticketit_test_m515r`: every package `ok` (`internal/httpapi` in `189.760s`), no race report. `OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).`

### TypeScript contract drift

```sh
cd contracts && npm ci && cd ..
contracts/check-swiftlet-drift.sh
contracts/check-michelin-drift.sh
```

Observed: `OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).` and `OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`

### Michelin

```sh
cd apps/michelin
npm ci && npm run typecheck && npx vitest run
```

Observed: typecheck clean; `Test Files  12 passed (12)`, `Tests  492 passed (492)`.

### Swiftlet

```sh
cd apps/swiftlet
npm ci && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
```

Observed: `tsc` clean; `Test Files  28 passed (28)`, `Tests  791 passed (791)`; production build transformed 300 modules.

### Browser-to-backend suite

```sh
cd e2e
E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m515?sslmode=disable' ./run.sh
```

Observed, one full run (Chromium headless shell against a real Swiftlet build, Galley, PostgreSQL, real Michelin processes and the local substitute GitHub OAuth provider; `migrations applied: schema version 29`; a **local** run, not CI): `[run.sh] SUITE PASSED`. All 52 spec invocations exited `0`; 109 tests passed, none failed, flaked or skipped. `run.sh` logged three resets: the initial one, then after `runner-claims.spec.ts` and after `runner-engine.spec.ts` (see "Scope bullets", resets). No flake, so no spec was changed.

## Acceptance criteria verification (#6)

Galley tests are in `apps/galley/internal/httpapi`; Michelin tests in `apps/michelin/src`; Swiftlet tests in `apps/swiftlet/src`; specs in `e2e/tests/`. Each passed in the gate run above; the record named holds the slice's own output. Verdicts cover the controlled engine; the real-adapter checks #6 assigns to M7 and M8 are follow-ups.

| # | Criterion | Verdict | Evidence | Caveat / pending |
| --- | --- | --- | --- | --- |
| 1 | Duplicate answers do not repeat effects; answering resumes the same Round in In Progress | **Verified** | [163](163-questions-answers.md): `TestAnswer_TheFirstAnswerWins` (second answer `400 question_already_answered`, snapshot unchanged), `TestAnswer_ConcurrentAnswersRecordExactlyOne` (8 racers, one answer, one command), `TestResumed_ContinuesTheSameRoundToDelivery` (same Round id, In Progress, replay `200`) in `round_questions_test.go`; `runner-ask.spec.ts` "a real Michelin's questions block the Ticket, … and the Owner's answers resume the same Round to delivery". | |
| 2 | Ticket and time grants distinct, never combined; ticket grants end at Done and never revive; time grants expire independently | **Verified** | [166](166-time-based-grants.md): `TestDecideGrantForm_IsTicketOrTimeNeverBoth`, `TestApprove_RefusesBothFormsAndAnExpiryOutsideTheWindowChangingNothing`, `TestAuthorityCheck_ATimeGrantExpiresAtItsInstantByGalleysClockBetweenTwoChecks`, `TestAuthorityCheck_ATimeGrantSurvivesItsOriginatingTicketReachingDone` (`round_time_grants_test.go`); [169](169-grants-end-at-done.md): `TestDone_ReopenedRoundsDenyEndedGrantsAndKeepTimeGrants`, `TestDone_EveryPathToDoneEndsGrantsAndNoOtherPathExists` (`grant_ending_test.go`); `runner-time-grant.spec.ts`, `runner-grant-done.spec.ts`. | The merged-PR path to Done does not exist yet: [#191](https://github.com/cristoforows/ticketIt/issues/191). |
| 3 | Later actions observe expired or revoked authority; permitted work continues; renewal only when necessary | **Verified** | [165](165-live-authority.md): `TestAuthorityCheck_ReadsGrantsLive` (`round_authority_test.go`); [168](168-revocation.md): `TestRevoke_EndsAGrantOfEitherFormAtOnceAndTheNextCheckDenies`, `TestRevoke_AnActionAllowedBeforeItCompletesAndStaysRecordedAndNoLaterActionIsAllowed`, `TestAuthorityCheck_QueuedBehindARevokeDenies` (`grant_revocation_test.go`); [166](166-time-based-grants.md): `TestRenewal_OnlyAnExpiredTimeGrantOfTheRoundsAgentForTheSameScopeCanBeNamed`; Michelin `engine.test.ts` "raises a renewal naming the expired grant only at the act step that needs it, while other act steps keep running"; `runner-time-grant.spec.ts`, `runner-revoke.spec.ts`. | Expiry sends no `authority_changed` (Owner reconfirmation, [#196](https://github.com/cristoforows/ticketIt/issues/196) item 6). |
| 4 | Lost contact prevents new actions and retains locks; a queued Stop precedes continuation on reconnect | **Verified** | [170](170-reconcile.md): `TestAuthorityCheck_RefusesADisconnectedRunnerThenAnUnreconciledRoundRecordingNothing` (`409 runner_disconnected`, then `409 reconcile_required`, nothing recorded), `TestReconcile_ReturnsTheDispositionAndThePendingCommandsStopFirst`, `TestReconcile_NeverChangesRoundStateTicketStatusSlotOrLock` (`reconcile_test.go`); Michelin `reconcile.test.ts` "gates the next event: stop halts without the next step, confirms the Stop and acknowledges it" and "gates the authority check itself: stop halts before checking"; `runner-reconcile.spec.ts` "a Stop queued while the runner was away reaches it in the Reconcile answer: the Round ends Stopped, not delivered" (log order `reconciled` < `engine stopped` < `stop confirmation reported`, no `engine delivered`). | Controlled engine only; in-flight model calls are [#188](https://github.com/cristoforows/ticketIt/issues/188) / [#189](https://github.com/cristoforows/ticketIt/issues/189). |
| 5 | Confirmed Stop returns Backlog with a manually removable Stopped Badge and preserved partial work | **Partially verified** | [160](160-confirmed-stop.md): `TestStopConfirmed_EndsTheRoundAsStoppedMovesTheTicketToBacklogWithTheStoppedBadgeAndFreesTheSlot`, `TestStoppedBadge_DetachingLeavesTheRoundStoppedAndTheNextStopReusesIt`, `TestStopped_TheRoundsActivityAndUsageStayListedUnderIt` (`round_endings_test.go`); `runner-stop.spec.ts` (Badge removed in the browser, Round still `stopped`). | Partial work is activity, usage and stop evidence only. Partial Reports or results are **Pending → [#8](https://github.com/cristoforows/ticketIt/issues/8) / [#9](https://github.com/cristoforows/ticketIt/issues/9)** ([#188](https://github.com/cristoforows/ticketIt/issues/188), [#189](https://github.com/cristoforows/ticketIt/issues/189)). |
| 6 | Failed and Interrupted leave Blocked Tickets and never start another Round automatically | **Verified** | [161](161-failed-interrupted.md): `TestFailedAndInterrupted_NoRoundStartsUntilTheOwnerMovesTheTicketToReady` (`round_blocked_endings_test.go`, claim `204` while Blocked); [171](171-stranded-round-recovery.md): `TestAttestCessation_EndsTheRoundInterruptedBlocksTheTicketFreesTheSlotAndKeepsTheRecord`, `TestAttestCessation_ThenReadyCreatesANewRoundWithANewEpoch` (`round_attestation_test.go`); [172](172-technical-limits.md): `TestLimits_StopConfirmedOnABreachedRoundEndsItFailed` (`round_limits_test.go`, Blocked, claim `204`, then Ready); `runner-failed.spec.ts`, `runner-interrupted.spec.ts`, `runner-attest.spec.ts`, `runner-limit-wall-clock.spec.ts`, `runner-limit-denials.spec.ts`. | The browser's "no automatic Round" check is a 2 s window; Galley's tests assert the `204`. |
| 7 | Intact execution may continue after Reconcile; lost contact alone never confirms Stop or process death | **Verified** | [170](170-reconcile.md): `runner-reconcile.spec.ts` "a runner seen again after the health window reconciles its running Round, which continues to delivery with one Reconcile note"; [160](160-confirmed-stop.md), [161](161-failed-interrupted.md): `TestStopped_NoSignalButStopConfirmedEndsARound`, `TestInterrupted_NoSignalButTheRunnersOwnReportEndsARound`; [171](171-stranded-round-recovery.md): `TestStrandedRound_NothingEndsOrUnlocksItWithoutAnAttestation` (`stranded_round_test.go`); `runner-reconcile.spec.ts` "a restarted runner cannot confirm the Round an earlier process held: it stays open, the Ticket stays locked, …". | An attestation is the Owner's assertion, not proof; recorded as such (`RoundAttestation`). |
| 8 | Open Rounds, including Waiting for Input, stay locked and cannot be archived | **Verified** | [163](163-questions-answers.md): `TestWaitingForInput_TheTicketStaysLockedAndRecoveryIsNotOffered` (archive, Ready, Backlog, In Progress, edit and unassign all `round_open`); [165](165-live-authority.md): `assertTicketLockedWhileWaiting` in `round_permissions_test.go` (Permission wait); [159](159-stop-request.md): `TestOpenRoundLock_EveryMutationRejectedWhileOpenAndAcceptedOnceClosed` (`ticket_open_round_lock_test.go`, also while Stopping). | |

### Scope bullets of #6 outside the eight criteria

| Bullet | Verdict | Evidence | Caveat / pending |
| --- | --- | --- | --- |
| Active slip, food-delivery animation, waiting reasons, View/Stop | **Partially verified** | [162](162-active-order-slip.md): `active-order-slip.spec.ts` (both tests: list and board, reduced motion, local time, paging past 50 notes, Stop from the slip, Starting, Runner disconnected, Reconciling, Stopping, desktop and phone); `components/ActiveOrder.test.tsx`; `components/ui/slip.test.ts` "turns off tilt and lift under reduced motion, …", "stops the rider under reduced motion". | Records 162–168 deferred the Owner's visual review and a screen-reader pass to this gate; neither was done: **Pending → [#197](https://github.com/cristoforows/ticketIt/issues/197)** (M10). |
| Round Feedback ([#154](https://github.com/cristoforows/ticketIt/issues/154)) and the reopen route | **Verified** | [164](164-round-feedback.md): `TestFeedback_ReopeningADoneTicketQueuesItAtTheBottomAndItsClaimCarriesTheFeedback`, `TestFeedback_TheReworkClaimCarriesAllUnconsumedFeedbackAndLaterClaimsDoNot` (`round_feedback_test.go`); [171](171-stranded-round-recovery.md): `TestClaim_ReplayReturnsTheSameRoundAndBodyAndSurvivesFeedbackConsumption`; `runner-feedback.spec.ts` (rework, and "Done → Ready is the reopen route: …"). | Feedback consumed by a failed, interrupted or stopped Round is not re-sent ([#196](https://github.com/cristoforows/ticketIt/issues/196) item 5). |
| Stopped Badge, manually removable without changing the outcome | **Verified** | As criterion 5: `TestStoppedBadge_DetachingLeavesTheRoundStoppedAndTheNextStopReusesIt`; `runner-stop.spec.ts`. | |
| Removal of the `e2e/run.sh` resets | **Partially verified** | [160](160-confirmed-stop.md) removed two resets (Stop now frees the slot); [171](171-stranded-round-recovery.md) removed the one after `runner-reconcile.spec.ts`. The gate run logged two remaining after the initial reset. | Both remaining resets follow a Round no live Michelin holds; attestation can now end it: **Pending → [#198](https://github.com/cristoforows/ticketIt/issues/198)** (M10). |
| Explicit full Connected Account access bounded by actual authenticated capabilities | **Partially verified** | [167](167-full-account-access.md): `TestAuthorityCheck_AFullGrantAllowsEveryDeclaredScopeWithoutAnotherRequest`, `TestAuthorityCheck_AFullGrantNeverAllowsAnUndeclaredScopeAndNothingIsRecorded` (`round_full_access_test.go`); `runner-full-access.spec.ts`. | Bounded by the substitute account's declared catalogue, not by authenticated capabilities: **Pending → [#190](https://github.com/cristoforows/ticketIt/issues/190)** (M8). |
| D8: revocation of in-flight work and technical limits, apart from budgets | **Verified** | [168](168-revocation.md): `TestRevoke_ACoveredOpenRoundGetsTheOwnersStopAndEndsOnlyOnStopConfirmed`, `runner-revoke.spec.ts`; [172](172-technical-limits.md): `TestDenialLimit_TheLimitThDenialBreachesAndStillDenies`, `TestWallClockLimit_ExcludesClaimedAndWaitingTime`, `runner-limit-wall-clock.spec.ts`, `runner-limit-denials.spec.ts`. | Controlled engine only; real-engine defaults [#192](https://github.com/cristoforows/ticketIt/issues/192); budgets [#194](https://github.com/cristoforows/ticketIt/issues/194). |

## M1 sanity-check follow-up (#6 comment, 2026-09-19)

| Point | Verdict | M5 did | Owner for the rest |
| --- | --- | --- | --- |
| 1. Admission must not become stale before actual execution | **Partially verified** | Michelin checks authority at each act step, after any approval (`POST /api/runner/rounds/{roundId}/authority-checks`); a check is refused while disconnected or unreconciled ([170](170-reconcile.md), `TestAuthorityCheck_RefusesADisconnectedRunnerThenAnUnreconciledRoundRecordingNothing`), denies after a revoke queued ahead of it ([168](168-revocation.md), `TestAuthorityCheck_QueuedBehindARevokeDenies`), and is not made with a Stop pending (`reconcile.test.ts` "gates the authority check itself: stop halts before checking"). An allowed action may complete and stays recorded (`TestRevoke_AnActionAllowedBeforeItCompletesAndStaysRecordedAndNoLaterActionIsAllowed`). | The native OpenCode approval wait the point names: **Pending → [#9](https://github.com/cristoforows/ticketIt/issues/9)** ([#189](https://github.com/cristoforows/ticketIt/issues/189)); the native interrupt counterpart [#188](https://github.com/cristoforows/ticketIt/issues/188). |
| 2. Confirmed Stop is terminal for the Round | **Partially verified** | [160](160-confirmed-stop.md): `TestStopped_IsTerminal` (every later event `409 round_not_open`, Stop `stop_not_available`, no commands), `TestStopped_OnlyAnExplicitReadyStartsANewRoundWithANewIdentityAndEpoch`; `TestAnswer_IsRefusedOnceStopIsRequestedAndAfterTheRoundEnds`, `TestPermissionDecision_IsRefusedOnceStopIsRequestedAndAfterTheRoundEnds`; an authority check on an ended Round is `409 round_not_open` (`TestAuthorityCheck_IsAnsweredOnlyForTheRunningRoundAtItsEpoch`, [165](165-live-authority.md)). | "Each adapter": **Pending → [#8](https://github.com/cristoforows/ticketIt/issues/8)** and **[#9](https://github.com/cristoforows/ticketIt/issues/9)** ([#188](https://github.com/cristoforows/ticketIt/issues/188), [#189](https://github.com/cristoforows/ticketIt/issues/189)). |
| 3. Unknown or stale reconciliation does not prove cessation | **Verified** | [170](170-reconcile.md): `hold` for unknown execution, `report_cessation` only names the event the runner must send; `TestReconcile_NeverChangesRoundStateTicketStatusSlotOrLock`. [171](171-stranded-round-recovery.md): `TestFencing_ARepairedCredentialIsAnotherRunnerAndChangesNothing` (old runner while another holds), `TestStrandedRound_NothingEndsOrUnlocksItWithoutAnAttestation`; `runner-attest.spec.ts` (a restarted runner holds until the Owner attests). No timeout ends a Round. | |
| 4. Expire grants, not the Ticket's ability to receive future grants | **Verified** | [169](169-grants-end-at-done.md): `TestDone_AFreshGrantAfterReopeningWorksAndTheEndedOneStaysEnded`; `runner-grant-done.spec.ts` "a ticket grant ends at Done in the browser, the reopened Round asks for the Permission again, and a fresh approval lets it deliver". | Reopening after a merged PR stays D4 ([#9](https://github.com/cristoforows/ticketIt/issues/9)). |

## M4 gate inputs (#6 comment, 2026-10-01)

| Input | Verdict | Covered by | Rest |
| --- | --- | --- | --- |
| A claimed or running Round outlives its runner; nothing recovers it | **Verified** | [171](171-stranded-round-recovery.md): Owner attestation, `TestAttestCessation_*` (`round_attestation_test.go`), `runner-attest.spec.ts` (killed runner; restarted runner). | |
| A claim is not idempotency-keyed; a lost `201` strands the Round | **Verified** | [171](171-stranded-round-recovery.md): `ClaimWorkRequest.idempotencyKey`; `TestClaim_ReplayReturnsTheSameRoundAndBodyAndSurvivesFeedbackConsumption`, `TestClaim_AReplayIsNever204`, `TestClaim_AnotherRunnersKeyIsIdempotencyKeyConflict`, `TestClaim_AKeyWhoseRoundLeftClaimedIsNotReplayable`. | The key is not persisted across a Michelin restart; that Round is the attestation case (accepted, [171](171-stranded-round-recovery.md)). |
| A restarted Michelin does not resume and cannot claim; it retries a report forever while Galley is down | **Verified** | [170](170-reconcile.md), [171](171-stranded-round-recovery.md): a runner holding nothing reconciles before each claim poll (`reconcile.test.ts`), the held Round is recovered by attestation; reports stop at a 5-minute bound and then reconcile (`engine.test.ts` "halts exactly at the bound, …", "reconciles at claim cadence without bound, …"). | Authority checks and acknowledgements still retry without the bound ([#196](https://github.com/cristoforows/ticketIt/issues/196) item 7). |
| Runner events are fenced by epoch and Owner, not runner identity | **Verified** | [171](171-stranded-round-recovery.md): `409 runner_not_holder`; `TestFencing_ARepairedCredentialIsAnotherRunnerAndChangesNothing`, `TestFencing_ComesAfterLookupAndShapeAndBeforeReplayAndEpoch`. | Two processes on one credential are one runner: [#193](https://github.com/cristoforows/ticketIt/issues/193). |
| Stop, Failed, Interrupted, questions, Permissions, pulled commands, the `waiting_for_input` lock and Reconcile do not exist | **Verified** | Criteria 1–8 above; [execution-interface.md](../../contracts/execution-interface.md) reconciled with `contracts/openapi.yaml` in this slice. | `listRoundCommands`' description omits `authority_changed`'s place: [#199](https://github.com/cristoforows/ticketIt/issues/199). |
| Terminal-Stop regression checks from the M1 follow-up | **Partially verified** | M1 point 2 above. | Per adapter: [#188](https://github.com/cristoforows/ticketIt/issues/188), [#189](https://github.com/cristoforows/ticketIt/issues/189). |
| Receipt: local time, paging past 50 notes, disconnected notice lagging the header, active card and View/Stop | **Verified** | [162](162-active-order-slip.md): `active-order-slip.spec.ts` (local time, paging, the receipt's Runner disconnected notice within 2 s of the header pill, the slip and its controls). | The slip's reason (3 s Ticket refresh) and the header pill (10 s health poll) can disagree for one poll (accepted, [162](162-active-order-slip.md)). |
| The browser suite resets its database between Round-holding specs | **Partially verified** | "Removal of the `e2e/run.sh` resets" above. | [#198](https://github.com/cristoforows/ticketIt/issues/198). |

## Follow-ups

"New issue" rows were opened by this gate. Every other limitation in the fourteen records was resolved by a later slice or is listed as covered.

| Item | Source | Disposition | Labels |
| --- | --- | --- | --- |
| Native adapter checks: admission across the native interrupt, revocation and Stop in flight, confirmed Stop terminal, partial Reports, engine reading answers and feedback; a real engine halting mid-model-call | M1 points 1–2, [160](160-confirmed-stop.md), [161](161-failed-interrupted.md), [164](164-round-feedback.md) | New issue [#188](https://github.com/cristoforows/ticketIt/issues/188) → **M7 [#8](https://github.com/cristoforows/ticketIt/issues/8)** | `ready-for-agent` |
| OpenCode adapter checks: native approval wait, revocation and Stop in flight, confirmed Stop terminal, orphaned host processes, partial results | M1 points 1–2, [D5](../../open-decisions.md) M1 findings | New issue [#189](https://github.com/cristoforows/ticketIt/issues/189) → **M8 [#9](https://github.com/cristoforows/ticketIt/issues/9)** | `ready-for-agent` |
| Real GitHub PAT Connected Account; full access bounded by authenticated capabilities | [165](165-live-authority.md), [167](167-full-account-access.md) | New issue [#190](https://github.com/cristoforows/ticketIt/issues/190) → **M8** | `ready-for-agent` |
| The reviewed-PR merge path to Done must end ticket grants | [169](169-grants-end-at-done.md) | New issue [#191](https://github.com/cristoforows/ticketIt/issues/191) → **M8** | `ready-for-agent` |
| Limit defaults (4h, 10) chosen for the controlled engine | [172](172-technical-limits.md) | New issue [#192](https://github.com/cristoforows/ticketIt/issues/192) → **M7**, M8 repeats | `ready-for-human` |
| Two Michelin processes sharing one credential are not fenced | [171](171-stranded-round-recovery.md) | New issue [#193](https://github.com/cristoforows/ticketIt/issues/193) → **M10 [#11](https://github.com/cristoforows/ticketIt/issues/11)** | `ready-for-agent` |
| Spending budgets stay deferred | D8 Owner decision on [#172](https://github.com/cristoforows/ticketIt/issues/172) | New issue [#194](https://github.com/cristoforows/ticketIt/issues/194) → **M9 [#10](https://github.com/cristoforows/ticketIt/issues/10)** | `ready-for-human` |
| Waiting time not reported apart from active time; 000029's backfill | [163](163-questions-answers.md), [172](172-technical-limits.md) | New issue [#195](https://github.com/cristoforows/ticketIt/issues/195) → **M9** | `ready-for-agent` |
| Owner reconfirmation: attestation Interrupted with a Stop pending; breach Failed and the 4h/10 defaults; Reconciling after a gap on a breach; a non-holder's empty Reconcile answers `hold` and records nothing; feedback not re-sent; no `authority_changed` on expiry; unbounded check and ack retries; 000029 backfill overcount | [164](164-round-feedback.md), [168](168-revocation.md), [170](170-reconcile.md), [171](171-stranded-round-recovery.md), [172](172-technical-limits.md) | New issue [#196](https://github.com/cristoforows/ticketIt/issues/196) → **M6 [#7](https://github.com/cristoforows/ticketIt/issues/7)** | `ready-for-human` |
| Owner visual review and screen-reader pass over the M5 screens | [162](162-active-order-slip.md)–[168](168-revocation.md) | New issue [#197](https://github.com/cristoforows/ticketIt/issues/197) → **M10**, beside [#157](https://github.com/cristoforows/ticketIt/issues/157) | `accessibility`, `ready-for-human` |
| Two `run.sh` resets remain | [160](160-confirmed-stop.md) | New issue [#198](https://github.com/cristoforows/ticketIt/issues/198) → **M10**, beside [#109](https://github.com/cristoforows/ticketIt/issues/109) | `ready-for-agent` |
| `listRoundCommands` says "a Stop first, then oldest `issuedAt`"; Galley lists `authority_changed` second | `round_commands.go`, `TestRoundCommands_DeliverStopThenAuthorityChangesThenTheRestInIssuedOrder` | New issue [#199](https://github.com/cristoforows/ticketIt/issues/199) → **M6** | `documentation`, `ready-for-agent` |
| A restarted Michelin does not pick up a waiting Round; a lost claim response loses its feedback; Interrupted only from the runner; a claimed Round cannot report a cessation; untested command order | [159](159-stop-request.md), [161](161-failed-interrupted.md), [163](163-questions-answers.md)–[167](167-full-account-access.md) | Covered: M5.12 and M5.13 (Reconcile, replayable claims, attestation, `interrupted` on any open Round); M5.10's command-order test | |
| Raw RFC 3339 times; no paging past 50 notes | [159](159-stop-request.md), [160](160-confirmed-stop.md), M4 gate | Covered by M5.4 | |
| Rounds claimed before migration 000028 have no holder; a silent runner is never measured; a breach lands as late as the next call; the 30-day time-grant cap needs a migration; the receipt's remaining time is as of the last read; one extra `GET /rounds` per Ticket open; redundant `ensureStoppedBadge` branches; one question at a time; feedback API-only on earlier Rounds | [160](160-confirmed-stop.md), [163](163-questions-answers.md), [164](164-round-feedback.md), [166](166-time-based-grants.md), [171](171-stranded-round-recovery.md), [172](172-technical-limits.md) | Accepted as recorded; the stranded cases end by attestation | |
| No notification of a question or Permission request | [163](163-questions-answers.md), [165](165-live-authority.md) | Not a v1 requirement; the messaging Manager Agent is v2 | |
| `TestRoundEvent_ConcurrentEventsWithDifferentKeysStartTheRoundOnce` flake | M4 gate | [#152](https://github.com/cristoforows/ticketIt/issues/152) closed as not reproducible; passed in this run | |

## Scope and decisions

The Owner's decisions recorded on the slice issues resolve **D5** (Owner-attested recovery, [#171](https://github.com/cristoforows/ticketIt/issues/171)) and **D8** (revoke also requests Stop, [#168](https://github.com/cristoforows/ticketIt/issues/168); wall-clock and denial-loop limits with budgets deferred, [#172](https://github.com/cristoforows/ticketIt/issues/172)); [open-decisions.md](../../open-decisions.md) marks both Resolved and records the M5 observations. D1, D2, D4, D6, D7 and D9 are unchanged.

No ADR is added: attestation and the limits are configuration and Owner commands behind the existing contract, reversible without a data migration of past Rounds, and they follow the recommendations already in D5 and D8.

[integration-feasibility.md](../../integration-feasibility.md) is unchanged: its conclusions concern real adapters, and M5 ran none.

[#154](https://github.com/cristoforows/ticketIt/issues/154) is still open. The Owner's comment there (2026-10-02) asks for feedback on the order slip; the "Done → Ready stays the reopen route" wording is #164's Decision and M5.6's implementing comment on #154, not the Owner's own words.
