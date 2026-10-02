# Failed and Interrupted Rounds, and recovery from Blocked

## Purpose

M5.3, [#161](https://github.com/cristoforows/ticketIt/issues/161).
Michelin can report that a running Round `failed`, with an explanation,
or was `interrupted`, with its own evidence. In one transaction Galley
then:

- ends the Round `failed` or `interrupted`, with that text as its
  `outcomeNote`;
- keeps the Round's activity and usage (the partial results; no Report);
- frees the slot and lifts the lock;
- moves the Ticket from In Progress to **Blocked**.

No Round starts automatically. The Owner's explicit move of the
Agent-assigned Ticket from Blocked to **Ready** is the recovery. It
passes the readiness check, enters Ready at the bottom of the order, and
the next claim is a new Round with a new id and epoch.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/`, `CONTEXT.md` and the D3 decision table
(`docs/decisions/d3-agent-template-compatibility.md`).

## What already existed

- **M5.2 (#160, PR #175, branch `m5/160-confirmed-stop`)**, which this
  branch is based on, itself on M5.1 (#159, PR #174). Neither is merged.
  - `stop_confirmed` ended a Round as `stopped` through `stopRound`, with
    `outcome_note` set exactly when the state is `stopped`.
  - Delivery ended a Round through `deliverRound`.
- **The D3 S2 table** (`allowedSourceStatusesForTarget`) had no
  `Blocked -> Ready` for anyone; human work resumed only through
  `Blocked -> InProgress`. `Blocked` was an Agent-owned target, so no
  Agent-assigned Ticket could reach Blocked through the Owner either.
  Nothing in Galley moved a Ticket to Blocked from a Round.
- **Migrations** up to `000018`.
- **Baseline** (per the M5.2 record):
  - Galley: 353 top-level tests (1199 with subtests).
  - Michelin: 265. Swiftlet: 458 (25 files).
  - Browser suite: 38 specs, 88 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`; `api.gen.go` and both
`schema.d.ts` were regenerated):

- `RoundEventType` gains `failed` and `interrupted`, with `FailedData`
  `{explanation}` and `InterruptedData` `{evidence}` (1–2000 characters
  each).
- `RoundState` gains `failed` (`RoundFailed`) and `interrupted`
  (`RoundInterrupted`).
- `TicketRound.outcomeNote` is set for `stopped`, `failed` and
  `interrupted`.
- `RoundEventRequest.data` is `anyOf` instead of `oneOf` (see choices).
- `changeTicketStatus` and `reportRoundEvent` descriptions name the
  recovery and the new endings.
- No new path, so no new `405` registration.

**Galley**

- **Migration `000019_fail_and_interrupt_rounds.up.sql`** replaces, under
  the same names:
  - `rounds_state_m5` (adds `failed`, `interrupted`);
  - `rounds_timestamps_follow_state` (both need `started_at` and
    `ended_at`);
  - `rounds_outcome_note_follows_state`:
    `(state IN ('stopped','failed','interrupted')) = (outcome_note IS NOT NULL)`;
  - `round_events_type_m5` (adds `failed`, `interrupted`).
- **`round_endings.go`:**
  - one `endRound(ctx, tx, ownerID, ticketID, roundID, ending, now)` with
    `roundEnding{state, ticketStatus, note, attachStoppedBadge}`;
  - the `roundEndings` table keyed by event type: `stop_confirmed` →
    `stopped`, Backlog, Badge; `failed` → `failed`, Blocked;
    `interrupted` → `interrupted`, Blocked;
  - `validateOutcomeNoteData(raw, field)` for `evidence` and
    `explanation`;
  - `stopRound`, `validateStopConfirmedData` and
    `errStoppedTicketNotActive` are replaced by `endRound`,
    `validateOutcomeNoteData` and `errEndingTicketNotActive`.
    `deliverRound` stays separate.
- **`round_events.go`:** the ladder validates the two new types,
  `roundStateTakes` accepts both only in `running`, and the apply step
  ends all three non-delivery endings through `roundEndings`.
- **`ticket_lifecycle.go`:** `Blocked` is added to
  `allowedSourceStatusesForTarget[Ready]`, allowed only through the named
  rule `agentRecoveryFromBlocked` in `decidePlainStatusChange`, which
  cites v1-scope "explicit recovery required" and #161. A human or
  unassigned Ticket's `Blocked -> Ready` stays `invalid_transition`. An
  open Round is `round_open` through `decideTicketMutation`; readiness is
  `decideAgentReadiness`; the move to the bottom of the order is the
  existing `transitionLockedTicket` path. `allowedActionsForTicket`
  advertises it through the same `decidePlainStatusChange`.
- **D3 table** row added: `Blocked → Ready | Agent-assigned only, no open
  Round | Owner's explicit recovery after Failed or Interrupted (M5.3)`.

**Michelin**

- `engineScript.ts`: steps `{ "step": "fail", "explanation" }` and
  `{ "step": "interrupt", "evidence" }`, validated at startup with the
  progress note's rules, only as the last step, mutually exclusive with
  `deliver` and `hold`; `SUPPORTED_STEPS` and the last-step message name
  all four.
- `engine.ts`: reports `failed` / `interrupted` with key
  `${roundId}:${stepIndex}` through `sendEvent`'s retry policy, logs
  `engine failed` / `engine interrupted`, and returns the new
  `EngineOutcome` `"failed"` / `"interrupted"`. A Stop that lands before
  the step boundary still wins.
- `galley/runner.ts`: `parseRoundEventResult` requires state `failed`
  for `failed` and `interrupted` for `interrupted`, with `endedAt`.

**Swiftlet**

- `api/rounds.ts`: `parseRound` accepts both states and requires
  `outcomeNote` exactly for `stopped`, `failed` and `interrupted`.
- `ui/Tags.tsx`: `FailedTag` and `InterruptedTag`.
- `RoundsSection.tsx`: **Round n · Failed** / **Interrupted** with the tag,
  "Failed at" / "Interrupted at", the note beneath under Outcome, the
  activity and **Usage** (not "so far").
- The Ready move is the existing status control, shown when
  `allowedActions.statusChanges` lists it. No new button.

**e2e**

- `tests/runner-failed.spec.ts` and `tests/runner-interrupted.spec.ts`,
  registered in `run.sh` after `runner-stop.spec.ts` with exit-code
  checks in the final log lines and the suite condition. No reset.
- `support/runner.ts` (`fail` / `interrupt` steps) and
  `support/tickets.ts` (`Round.state`) carry the new fields.

**Docs:** the Galley, Michelin, Swiftlet and e2e READMEs; `CONTEXT.md`'s
Interrupted and Failed entries (terminal; the runner's own evidence or
explanation kept; activity and usage, not "available partial work"; only
the Owner's Ready starts another Round).

### Engineering choices beyond the Decisions

- **`RoundEventRequest.data` is `anyOf`, not `oneOf`.**
  `StopConfirmedData` and `InterruptedData` are both exactly
  `{evidence}`, so a valid `interrupted` (or `stop_confirmed`) body
  matches two branches and fails `oneOf`. Galley validates `data` by
  `type` itself; the contract keeps every branch closed. The generated Go
  union and both `schema.d.ts` unions are unchanged in form.
- **`endRound`'s Ticket guard derives the source Status from the Round:**
  `Ready` when the Round never started (only `stop_confirmed` can end
  one), `In Progress` when it did. The Decision's `roundEnding` has no
  source field, and the Decision says failed/interrupted move the Ticket
  only from In Progress. M5.2's guard accepted Ready *or* In Progress for
  a stop regardless of start, so a stop is now stricter on a state the
  open-Round lock makes unreachable (a claimed Round's Ticket In
  Progress). Zero rows is `errEndingTicketNotActive`: rolled back,
  logged, `500`. Every M5.2 stop test still passes.
- **`failed` / `interrupted` after a Stop request end the Round as
  reported, without the Stopped Badge.** The Decisions do not say; the
  runner's report is the fact Galley has, and a Stop request is not an
  outcome. The `stop` command then stops being listed, as for any ended
  Round. Michelin matches: a `fail` or `interrupt` already in flight
  lands as reported and the Stop is not acknowledged; a Stop before the
  step wins and the step is never sent.
- **The 1–2000 code-point rule is one function** for `evidence` and
  `explanation`, so the three notes cannot drift apart. A null field
  gets the length message, as for `note`.
- **`ended_at = GREATEST(now, COALESCE(started_at, claimed_at))`**, the
  M5.2 rule, now shared by all three endings.
- **Recovery is an extra condition after the source check in
  `decidePlainStatusChange`** rather than a separate decision, so
  `allowedActions` and the command can never disagree (the Decision's
  "same decision function"). Blocked → Backlog was not added: D3 has no
  such row.
- **Guardrail generalised:** M5.2's
  `TestStopped_OnlyTheStopConfirmationWritesTheStoppedState` is replaced
  by `TestRoundEndings_OnlyTheEndingCodeNamesTheEndedStates`, a source
  scan that finds `RoundStopped`, `RoundFailed`, `RoundInterrupted`,
  `'stopped'`, `'failed'` or `'interrupted'` only in `round_endings.go`
  among non-test, non-generated files. "Interrupted only from the
  runner's own evidence" is pinned at runtime by
  `TestInterrupted_NoSignalButTheRunnersOwnReportEndsARound`: command
  polls, 24 h without a heartbeat, a stale-epoch report and a fresh
  heartbeat leave the Round running.
- **Swiftlet colours.** `FailedTag` is paper on `status-blocked-deep`
  (filled, like Stopped: the Ticket is now Blocked). `InterruptedTag` is
  a dashed `status-blocked-deep` outline on paper, so the two Blocked
  outcomes differ by more than the word. Both pairs are pinned in
  `tokens.test.ts`, and the tags' classes in `TicketDetail.test.tsx`
  (added after the first falsification pass showed a class change
  survived; see below).
- **`agent_readiness_test.go`:** the existing
  `TestTicketAllowedActions_MatchCommandsForEveryAssignee` grid now also
  checks, independently of the implementation, that `Blocked -> Ready`
  is advertised exactly for an Agent-assigned Ticket with complete
  inputs. The readiness race test gains a third race: clearing the goal
  against recovering a Blocked Agent Ticket.
- **Michelin's parser uses an end-state table** (`END_STATES`) instead
  of a ternary chain, and drops the now-redundant "state is not a Round
  state" check: every state is either the event's end state or
  `claimed`/`running`.
- **The e2e specs show "no automatic Round" by waiting 2 s** with
  Michelin polling every 500 ms and asserting one claim and an unchanged
  Round list. A negative timing assertion only bounds the window; the
  Go test `TestFailedAndInterrupted_NoRoundStartsUntilTheOwnerMovesTheTicketToReady`
  is the exact proof (`204` claim).

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), pgx v5.11.0, golang-migrate v4.20.1,
  oapi-codegen v2.8.0, kin-openapi v0.149.0 (`apps/galley/go.mod`).
- PostgreSQL 17.11 (Homebrew).
- Node v26.9.0, npm 11.19.1.
- Swiftlet: React 19.3.0, Vite 8.3.0, Vitest 5.0.1, TypeScript 7.0.2.
- Michelin: Vitest 5.0.1, TypeScript 5.9.3.
- Contracts: openapi-typescript 7.13.0.
- e2e: `@playwright/test` 1.63.0.

No dependency changed in this slice, so every lockfile is unchanged.

## Reproducible commands

```sh
cd apps/galley
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m53?sslmode=disable'
gofmt -l . && go vet ./... && go build ./...
go test ./... -count=1
go test -race -count=1 ./...
./scripts/check-contract-drift.sh      # with the regenerated files staged
cd ../../contracts && npm ci && npm run check:swiftlet-drift && npm run check:michelin-drift
cd ../apps/michelin && npm ci && npm run typecheck && npm test
cd ../swiftlet && npm ci && npx tsc -p tsconfig.json --noEmit && npm test && npm run build
cd ../../e2e && npm ci && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m53?sslmode=disable' ./run.sh
```

## Observed results

- `gofmt -l .` printed nothing. `go vet ./...` and `go build ./...` were
  clean.
- Galley `go test ./... -count=1`: every package `ok`. Counted from
  `go test -json`: 375 top-level tests (was 353), 1342 with subtests
  (was 1199); 0 failed, 0 skipped.

  ```text
  ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	4.163s
  ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	1.965s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	0.947s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	2.350s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	1.532s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	67.859s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	3.151s
  ```

- `go test -race -count=1 ./...`: every package `ok`, no race report
  (`internal/httpapi` 137.173s).
- Drift checks, with the generated files staged:

  ```text
  OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
  OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  ```

- Michelin: typecheck clean. `Test Files 10 passed (10)`,
  `Tests 316 passed (316)`. The baseline was 265.
- Swiftlet: `tsc --noEmit` clean. `Test Files 25 passed (25)`,
  `Tests 467 passed (467)`. The baseline was 458. `npm run build`:

  ```text
  dist/assets/index-2dMGonxU.css             39.95 kB │ gzip:   8.39 kB
  dist/assets/MarkdownRenderer-Dumue_m4.js  116.65 kB │ gzip:  35.45 kB
  dist/assets/index-ZVkXZCIC.js             394.05 kB │ gzip: 118.64 kB
  ✓ built in 120ms
  ```

- Browser suite: `SUITE PASSED` with `exit 0` on two runs, the second on
  the final tree. On each, all 40 specs exited 0 and 90 tests passed (the
  baseline was 38 specs, 88 tests; the two new specs add one test each).
  `run.sh` logged the same three resets as before (the initial one, then
  before `runner-engine` and before `runner-activity`); none was added.

  ```text
  [run.sh] running tests/runner-failed.spec.ts (a real michelin's Round ends Failed, Blocked, then the Owner's Ready claims Round 2) against the same galley
    ✓  1 [chromium] › tests/runner-failed.spec.ts:26:1 › a real Michelin's failed report ends the Round as Failed: Blocked with its explanation, activity and usage kept, no Round until the Owner's Ready claims Round 2 (6.7s)
  [run.sh] running tests/runner-interrupted.spec.ts (a real michelin's Round ends Interrupted, Blocked, then the Owner's Ready claims Round 2) against the same galley
    ✓  1 [chromium] › tests/runner-interrupted.spec.ts:26:1 › a real Michelin's interrupted report ends the Round as Interrupted: Blocked with its evidence, activity and usage kept, no Round until the Owner's Ready claims Round 2 (6.5s)
  [run.sh] runner-stop.spec.ts exit code: 0
  [run.sh] runner-failed.spec.ts exit code: 0
  [run.sh] runner-interrupted.spec.ts exit code: 0
  [run.sh] SUITE PASSED
  ```

  Each new spec took 6.7 s on the first run; 6.7 s and 6.5 s on the
  second.

**New and changed Galley tests**

| Test | What it pins |
| --- | --- |
| `TestFailedAndInterrupted_EndTheRunningRoundMoveTheTicketToBlockedAndFreeTheSlot` | for each ending: result state and `endedAt`; Round ended with the note; activity and usage still listed; Ticket Blocked, unlocked, no Badge, Ready offered; another Ticket can be claimed |
| `TestFailedAndInterrupted_NoRoundStartsUntilTheOwnerMovesTheTicketToReady` | claim `204` while Blocked; after Ready, Round 2 with a new id, `sequence + 1`, `claimEpoch + 1`; Round 1 unchanged |
| `TestFailedAndInterrupted_OnAClaimedRoundIsEventOutOfOrderAndChangesNothing` | `409 event_out_of_order`; snapshot unchanged |
| `TestFailedAndInterrupted_AtAStaleEpochIsStaleClaimEpochAndChangesNothing` | `409 stale_claim_epoch` |
| `TestFailedAndInterrupted_OnAnEndedRoundIsRoundNotOpenAndChangesNothing` | after delivered, stopped, failed and interrupted: `409 round_not_open` |
| `TestFailedAndInterrupted_ReplayReturnsTheStoredResultAndChangesNothing` | `200` with the stored body |
| `TestFailedAndInterrupted_ConcurrentIdenticalReportsApplyExactlyOnce` | 8 concurrent identical reports: one `201`, identical bodies, one event row |
| `TestFailedAndInterrupted_ConcurrentDifferentEndingsLeaveExactlyOne` | failed vs interrupted vs delivered, 5 trials: exactly one ending wins and the Ticket matches it |
| `TestFailedAndInterrupted_AfterAStopRequestEndTheRoundAsReportedWithoutTheStoppedBadge` | Round ends as reported; the `stop` command is no longer listed; no Badge; a later `stop_confirmed` is `round_not_open` |
| `TestFailedAndInterrupted_AreTerminal` | new-key events `round_not_open`; Stop `stop_not_available` |
| `TestFailedAndInterrupted_ATicketNotInProgressRollsBackAndAnswers500` | Ready, Blocked and Backlog Tickets: `500`, Round still running, logged |
| `TestFailedAndInterrupted_AFailureAtTheLastWriteRollsBackEveryChange` | a trigger refusing the `round_events` insert: `503`, nothing kept |
| `TestFailedAndInterrupted_NoteLimitsAtTheAPI` | no field, the other ending's field, an extra field, a number, null, an array, empty, blank, 2001 characters, CR and NUL refused with nothing written; 2000 characters with tab and line feed stored verbatim |
| `TestInterrupted_NoSignalButTheRunnersOwnReportEndsARound` | see choices |
| `TestRecoveryFromBlocked_TheReadinessCheckApplies` | goal cleared: `agent_readiness_incomplete`, not advertised, Ticket stays Blocked |
| `TestRecoveryFromBlocked_EntersReadyAtTheBottomOfTheOrder` | rank below every other Ticket |
| `TestRecoveryFromBlocked_IsAgentOnlyAndNeedsNoOpenRound` | human and unassigned `invalid_transition`, unchanged; an open Round (set in SQL) `round_open`, nothing advertised |
| `TestRecoveryFromBlocked_ConcurrentRequestsApplyOnce` | 6 concurrent Ready requests: one applies, the rest `invalid_transition`; one bottom rank |
| `TestRecoveryFromBlocked_RacingTheEndingIsSerialisedEitherWay` | ending vs Ready, 8 trials each: either `round_open` and Blocked, or Ready after the ending; never an open Round left |
| `TestDecidePlainStatusChange_RecoveryFromBlocked` | the decision table directly |
| `TestRounds_TheDatabaseEnforcesTheFailedAndInterruptedOutcomes` | state, timestamp and `outcome_note` constraints |
| `TestFailedAndInterrupted_ResponsesMatchContract` (`contract_test.go`) | `201`, replay, each `409`, `400`, Round and Ticket lists and both status changes, validated against the contract |
| `TestRoundEndings_OnlyTheEndingCodeNamesTheEndedStates` (replaces M5.2's) | source-scan guardrail |
| `TestDecideRoundEvent`, lock-order test (changed) | failed and interrupted cases through the ladder (each rejection rung and acceptance in `running` only); both events take the locks in order |
| `TestTicketAllowedActions_MatchCommandsForEveryAssignee`, `TestAgentReadiness_ConcurrentClearAndReadinessNeverBothApply`, `no_execution_side_effects_test.go` (changed) | see choices; the side-effects test now recovers an Agent Ticket Blocked → Ready and still finds no Round, command or work record created by a manual action |
| `rounds_test.go`, `round_delivery_test.go`, `round_endings_test.go` (changed) | the "unknown" state and type are now `abandoned`; the guard log message is `errEndingTicketNotActive` |

**New and changed Michelin tests**

| Test file | What it pins |
| --- | --- |
| `engineScript.test.ts` | both steps accepted at their bounds and with tab and line feed; refused before the last step, beside `deliver`/`hold`/each other, as the first step, with a missing, empty, blank (including U+0085), over-long, CR, escape or non-string text, or the other step's field; the unknown-step message lists `fail, interrupt` |
| `engine.test.ts` ("the fail step", "the interrupt step") | event, key `${roundId}:${stepIndex}`, epoch, `occurredAt` and data pinned; the outcome and log lines; identical bytes through network, 5xx and invalid-body retries with 1, 2, 4 s backoff, and a replay; a running, endless or other-ended result retried; five `409`/`400` refusals abandoned; a Stop before the step wins; a report in flight when a Stop lands ends as reported |
| `claimLoop.test.ts` | polling resumes after either ending, and no command is acknowledged |

**New and changed Swiftlet tests**

| Test file | What it pins |
| --- | --- |
| `api/rounds.test.ts` | a failed and an interrupted Round's note, activity and usage kept; a missing note, no field or a deliverable on them refused; `abandoned` refused as unknown |
| `TicketDetail.test.tsx` (2) | tag text and colour classes, summary, the note beneath, "Failed at"/"Interrupted at", activity, Usage, no Report, Blocked status and the Ready button offered |
| `ui/tokens.test.ts` (2) | failed and interrupted tag contrast (WCAG AA) |

**Browser specs** (`runner-failed.spec.ts`, `runner-interrupted.spec.ts`):
all data goes through Galley's API, against a real Michelin running
`start`, `progress`, `usage` and then `fail` or `interrupt`.

1. Michelin logs the report at step index 3, `201` with `endedAt`, then
   `engine failed` / `engine interrupted`; no refusal, no credential.
2. Galley: the Ticket is Blocked with no open Round, no delivery, no
   Badge, not requesting work, and Ready offered. Round 1 is
   `failed`/`interrupted` with the logged `endedAt`, the runner's text
   as `outcomeNote`, the note and usage kept, no deliverable.
3. Two seconds later Michelin has claimed only once and the Round list
   is unchanged. A late event is `409 round_not_open`.
4. The receipt shows Blocked, no lock, the tag, the note, the ended-at
   time, the activity, the cost and tokens, and no Report.
5. Ready on the receipt is `200` with no open Round. The same Michelin
   claims Round 2 (new id, sequence 2, epoch 2), which ends the same way.
   Round 1 is unchanged, the Ticket is Blocked again, and the receipt
   lists two Rounds.
6. Michelin exits 0 on `SIGTERM`.

**Falsification.** For each mutation the change was applied to the
staged tree, the tests were run, and the file was restored from a copy:

- Galley: `go test ./internal/httpapi -count=1 -json`, counting failed
  top-level tests;
- Michelin and Swiftlet: the full `npx vitest run`.

`git diff --stat` afterwards showed only the two test edits made during
this work (the Swiftlet class pin and the assignee-grid check below),
which were then staged.

| Layer | Change | Result |
| --- | --- | --- |
| Galley | `failed` leaves the Ticket In Progress (skips Blocked) | 7 failed, including `…EndTheRunningRoundMoveTheTicketToBlocked…`, `…NoRoundStartsUntil…`, `…ResponsesMatchContract` |
| Galley | `interrupted` moves the Ticket to Ready (an automatic next Round) | 9 failed, including `…NoRoundStartsUntilTheOwnerMovesTheTicketToReady` |
| Galley | Stopped Badge attached on `failed` | 5 failed, including `…AfterAStopRequest…WithoutTheStoppedBadge` |
| Galley | epoch check skipped for both events | 3 failed: `TestDecideRoundEvent`, `…AtAStaleEpoch…`, `TestInterrupted_NoSignalButTheRunnersOwnReportEndsARound` |
| Galley | `roundStateTakes` accepts both while `claimed` | 3 failed: `TestDecideRoundEvent`, `…OnAClaimedRoundIsEventOutOfOrder…`, `…ResponsesMatchContract` |
| Galley | outcome note replaced by a constant | 6 failed, across the new and the M5.2 stop tests |
| Galley | recovery skips the readiness check | 4 failed: `…TheReadinessCheckApplies`, `TestDecidePlainStatusChange_RecoveryFromBlocked`, the readiness race, the assignee grid |
| Galley | recovery open to human and unassigned Tickets | 5 failed, including `TestChangeTicketStatus_D3S2Table` and `…IsAgentOnly…` |
| Galley | `Blocked` removed from Ready's sources (no recovery) | 11 failed, including `no_execution_side_effects_test.go`'s `TestManualLifecycleActionsCreateNoExecutionRecords` |
| Galley | recovery keeps its old place in the order | 2 failed: `…EntersReadyAtTheBottomOfTheOrder`, `…ConcurrentRequestsApplyOnce` |
| Galley | Ticket guard ignores the source Status | 2 failed: `…ATicketNotInProgressRollsBackAndAnswers500` and M5.2's stop equivalent |
| Galley | migration: `failed` needs no `outcome_note` | 1 failed: `TestRounds_TheDatabaseEnforcesTheFailedAndInterruptedOutcomes` |
| Galley | migration: `interrupted` needs no `started_at` | 1 failed: the same test |
| Michelin | wrong `failed` idempotency key | 1 failed |
| Michelin | `fail` returns `completed` | 6 failed |
| Michelin | `fail` allowed before the last step | 3 failed |
| Michelin | no `explanation`/`evidence` validation | 10 failed |
| Michelin | parser drops the `interrupted` end state | 7 failed |
| Michelin | `interrupt` sends `explanation` instead of `evidence` | 1 failed |
| Michelin | a Stop ignored at the boundary before `fail`/`interrupt` | 2 failed |
| Swiftlet | no Failed tag (plain text) | 1 failed |
| Swiftlet | note not required on failed/interrupted | 3 failed |
| Swiftlet | parser refuses `interrupted` | 1 failed |
| Swiftlet | no "Interrupted at" line | 1 failed |
| Swiftlet | ended Rounds labelled "Usage so far" | 3 failed |
| Swiftlet | Interrupted tag text changed to `text-dim` | **0 failed on the first pass**; after pinning the tag classes in `TicketDetail.test.tsx`, 1 failed |
| Swiftlet | Failed tag fill changed to `bg-paper` | 1 failed (after the pin) |
| Swiftlet | `--color-status-blocked-deep` lightened to `#f08080` | 6 failed in `tokens.test.ts`, including both new pairs |

Before the Galley pass, the independent `Blocked -> Ready` check was
added to `TestTicketAllowedActions_MatchCommandsForEveryAssignee`: that
grid compared advertised against applied only, so it would pass with the
recovery missing on both sides. The open-Round refusal on recovery is
the existing `decideTicketMutation` rule and was not mutated here; it is
pinned by `…IsAgentOnlyAndNeedsNoOpenRound` and the racing test. No
surviving mutant remains in the table.

## Implementation limitations and follow-ups

- **Partial results are activity and usage only**, as decided. No
  partial Report, deliverable or artifact is kept for a failed or
  interrupted Round; Reports and partial results are M7
  ([#8](https://github.com/cristoforows/ticketIt/issues/8)) and M8
  ([#9](https://github.com/cristoforows/ticketIt/issues/9)).
- **Interrupted is only ever the runner's own report.** A runner that
  dies without reporting leaves its Round open and the Ticket locked;
  reconciliation of lost Rounds is a later M5 slice (D5).
- **A failed or interrupted Round of a claimed (never started) Round
  is not reportable** (`event_out_of_order`): the Decision limits both to
  `running`. A runner that fails before `execution_started` must start
  first or leave the Round to recovery.
- **The Owner has no way back from Blocked other than Ready** on an
  Agent-assigned Ticket (D3 has no Blocked → Backlog). Unassigning the
  Agent makes it human work, which resumes through In Progress.
- **The e2e "no automatic Round" check is a 2 s window**; see choices.
- **Times on the receipt are raw RFC 3339**, as before.

## Outstanding checks and owning milestone

- Waiting for Input, reconciliation of lost Rounds, and the greyed
  active card: later M5 slices
  ([#6](https://github.com/cristoforows/ticketIt/issues/6)).
- A real engine failing or being interrupted mid-model-call: M6.
- The milestone gate reconciles `docs/evidence/m5/README.md`,
  `docs/open-decisions.md` and the plan documents. This slice does not
  edit them.

## Decision impacts (open-decision IDs)

- **D3** (agent/template compatibility): the S2 table gains one row,
  `Blocked → Ready` for Agent-assigned Tickets with no open Round, as the
  issue decided. Human Blocked work is unchanged.
- **D5** (recovery authority): only the runner's evidence-bearing
  `interrupted` ends a Round as Interrupted
  (`TestInterrupted_NoSignalButTheRunnersOwnReportEndsARound`); Galley
  infers nothing from lost contact, time or a stale epoch. Not decided
  here.
