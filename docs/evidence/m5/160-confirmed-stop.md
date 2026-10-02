# Confirmed Stop: terminal Stopped Rounds and the Stopped Badge

## Purpose

M5.2, [#160](https://github.com/cristoforows/ticketIt/issues/160). After
its engine halts on a Stop, Michelin reports `stop_confirmed` with
evidence. In one transaction Galley then:

- ends the Round `stopped`, with that evidence as its `outcomeNote`;
- frees the slot and lifts the lock;
- moves the Ticket to **Backlog** with the **Stopped** Badge.

Stopped is terminal. Only an explicit Ready starts another Round, with a
new ID and epoch.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/` and `CONTEXT.md`.

## What already existed

- **M5.1 (#159, PR #174, branch `m5/159-stop-request`)**, which this
  branch is based on:
  - the Stop request and **Stopping**;
  - one `stop` command per Round;
  - Michelin's pulled, acknowledged command channel.
  - A stopped Round stayed open, and the Ticket stayed In Progress and
    locked.
- **The event ladder** (`round_events.go`) ended a Round only through
  `deliverRound`.
- **Badges** had manual attach and detach (M3). No Badge had a system
  meaning, and Badges cannot be renamed or deleted.
- **Migrations** up to `000017`.
- **Baseline** (per the M5.1 record):
  - Galley: 329 top-level tests.
  - Michelin: 252. Swiftlet: 448 (24 files).
  - Browser suite: 38 specs, 88 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`; `api.gen.go` and both
`schema.d.ts` were regenerated):

- `RoundEventType` gains `stop_confirmed`, with `StopConfirmedData`
  `{evidence}` (1–2000 characters).
- `RoundState` gains `stopped`.
- `TicketRound` gains the required `outcomeNote: string | null`.
- The error `stop_not_requested` is added.

**Galley**

- **Migration `000018_stop_rounds`:**
  - `rounds_state_m5`;
  - a `stopped` Round needs `ended_at` but not `started_at`;
  - `rounds.outcome_note`, set exactly when the state is `stopped`, 1–2000
    characters;
  - `round_events_type_m5`;
  - `badges.system_key`, with its check and the
    `badges_owner_system_key_unique` partial index.
- **`round_events.go`:**
  - `lockedRound.stopRequested` is read in the same `FOR UPDATE` query;
  - `roundStateTakes` accepts `stop_confirmed` in `claimed` and `running`;
  - after the state check, `decideRoundEvent` answers
    `409 stop_not_requested`.
- **New `round_endings.go`:**
  - `validateStopConfirmedData`;
  - `stopRound` (Round, then Ticket, then Badge, then `ticket_badges`);
  - `ensureStoppedBadge`.
- **`ticket_rounds.go`** lists `outcomeNote`.

**Michelin**

- `runControlledEngine`'s `stopped()` reports `stop_confirmed` with key
  `${roundId}:stop`, using `sendEvent`'s retry policy, then returns
  `"stopped"` only when the event was sent.
- `claimLoop` acks the command `applied` only on that outcome. A refusal
  abandons the Round locally and sends no ack.
- `parseRoundEventResult` accepts `endState: stopped`.

**Swiftlet**

- `parseRound` accepts `stopped`, and requires `outcomeNote` to be a
  string exactly when the Round is stopped.
- New `StoppedTag` (`ui/Tags.tsx`).
- `RoundsSection` shows, for a stopped Round:
  - the Stopped tag;
  - "Stopped at";
  - an Outcome section holding the `outcomeNote`;
  - its activity and usage.
- The Badge renders through the existing Badge tags.

**e2e**

- `runner-stop-request.spec.ts` was renamed `runner-stop.spec.ts` and
  extended to the full path.
- New helper `stopRoundThroughGalley` in `support/tickets.ts`.
- `runner-activity.spec.ts` now ends by stopping its Round.
- Two `run.sh` resets were removed. Two remain; see below.

**`CONTEXT.md`:** the Stopped entry is rewritten. It no longer claims
"available partial results".

### Engineering choices beyond the Decisions

- **`ensureStoppedBadge` adds `ON CONFLICT (owner_id, lower(name)) DO
  UPDATE SET system_key` to the insert branch.** The Decision holds that
  the priority lock makes the three branches safe. That is true between
  two confirmations. It is not true against `POST /api/badges`
  (`CreateBadge`), which does not take the priority lock. An Owner who
  creates "stopped" while a confirmation waits would otherwise turn the
  confirmation into a `badges_owner_name_ci_unique` violation (500).
  `TestStoppedBadge_AdoptsABadgeTheOwnerCommitsWhileTheConfirmationWaits`
  forces that interleaving. The three branches are kept as written; this
  adds to the insert and substitutes nothing.
- **`RoundEventResult.startedAt` is nullable.** A Round stopped while
  `claimed` has no start. The contract allows null only in that case.
  Michelin's parser accepts null only for `stop_confirmed`.
- **`ended_at = GREATEST(now, COALESCE(started_at, claimed_at))`**, so a
  Round never ends before it started, even when the runner's
  `occurredAt` is skewed. This is the same rule as delivery.
- **A Ticket neither Ready nor In Progress makes `stopRound` fail with
  500 and roll back** rather than move the Ticket. The open-Round lock
  makes that state unreachable. If it is ever reached, it is a bug to
  surface rather than a Ticket to move silently.
  `TestStopConfirmed_ATicketNeitherReadyNorInProgressRollsBackAndAnswers500`
  pins it.
- **A null `evidence` gets the length message**, matching
  `validateProgressData` for `note`.
- **Michelin sends the confirmation from inside the engine's
  `stopped()` path**, so it reuses `sendEvent` and the engine's shutdown
  handling. The command id reaches the engine as `stop.reason`
  (`claimLoop` calls `stop.abort(stopCommand.id)`). If the reason is not
  a string, the `on Stop command …` suffix is omitted. That happens only
  in direct engine tests, never through `claimLoop`.
- **The evidence deviates from the pinned formula only where it would
  read "step N+1 of N".** A Stop during the last step's `wait` halts after
  every step has run, so the evidence reads `Stopped after step N of N on
  Stop command <id>`. Every other case keeps the pinned `Stopped before
  step <index + 1> of N …`. The note is shown on the receipt, and "before
  step 3 of 2" would persist nonsense there.
- **The ack is `applied` only after a sent confirmation.** On a refused
  confirmation Michelin abandons the Round and does not ack. The command
  stays listed, and recovery (D5) owns it.
- **Swiftlet always fetches the Round list** when a Ticket opens, and on
  every refresh. Before, it fetched only when an open Round or a delivery
  existed. A stopped Ticket has neither, so its receipt would never show
  the stopped Round. The cost is one extra `GET /rounds` per open, for
  Tickets that never had a Round. The Rounds section shows when there is
  an open Round, a delivery, or any listed Round.
- **The `StoppedTag` fills with `status-blocked-deep` and uses paper
  text.** `StoppingTag` is the outline of the same colour, so the end
  state reads as the filled form of the transitional one.
- **Guardrail test `TestStopped_OnlyTheStopConfirmationWritesTheStoppedState`**:
  a source scan finds that only `round_endings.go` writes the `stopped`
  state. This pins "No other signal ever ends a Round as Stopped" against
  future code. `TestStopped_NoSignalButStopConfirmedEndsARound` covers the
  runtime half: command polls, a lapsed and a fresh heartbeat, and an
  `applied` ack.
- **`stopRoundThroughGalley`** (e2e): `requestStopDirect`, expect `200`,
  then poll the Ticket until `openRound` is null.

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), pgx v5.11.0, golang-migrate v4.20.1,
  oapi-codegen v2.8.0, kin-openapi v0.149.0 (`apps/galley/go.mod`).
- PostgreSQL 17.11 (Homebrew).
- Node v26.9.0.
- Swiftlet: React 19.3.0, Vite 8.3.0, Vitest 5.0.1, TypeScript 7.0.2,
  Tailwind CSS 4.3.3.
- Michelin: Vitest 5.0.1, TypeScript 5.9.3.
- Contracts: openapi-typescript 7.13.0.
- e2e: `@playwright/test` 1.63.0.

No dependency changed in this slice, so every lockfile is unchanged.

## Reproducible commands

```sh
cd apps/galley
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m52?sslmode=disable'
gofmt -l . && go vet ./... && go build ./...
go test ./... -count=1
go test -race -count=1 ./...
./scripts/check-contract-drift.sh      # with the regenerated files staged
cd ../../contracts && npm ci && npm run check:swiftlet-drift && npm run check:michelin-drift
cd ../apps/michelin && npm ci && npm run typecheck && npm test
cd ../swiftlet && npm ci && npx tsc -p tsconfig.json --noEmit && npm test && npm run build
cd ../../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m52?sslmode=disable' ./run.sh
```

## Observed results

- `gofmt -l .` printed nothing. `go vet ./...` and `go build ./...` were
  clean.
- Galley `go test ./... -count=1`: every package `ok`. Counted from
  `go test -json`: 353 top-level tests (was 329), 1199 with subtests;
  0 failed, 0 skipped.

  ```text
  ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	2.057s
  ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	0.616s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	0.674s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.174s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	0.484s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	47.623s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	1.659s
  ```

- `go test -race -count=1 ./...`: every package `ok`, no race report
  (`internal/httpapi` 121.396s).

- Drift checks, with the generated files staged:

  ```text
  OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
  OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  ```

- Michelin: typecheck clean. `Test Files 10 passed (10)`,
  `Tests 265 passed (265)`. The baseline was 252.
- Swiftlet: `tsc --noEmit` clean. `Test Files 25 passed (25)`,
  `Tests 458 passed (458)`. The baseline was 448 in 24 files.
  `npm run build` output:

  ```text
  dist/assets/index-2dMGonxU.css             39.95 kB │ gzip:   8.39 kB
  dist/assets/MarkdownRenderer-DJ5DyC2x.js  116.65 kB │ gzip:  35.45 kB
  dist/assets/index-fBjgieY0.js             393.10 kB │ gzip: 118.47 kB
  ✓ built in 132ms
  ```

- Browser suite: `SUITE PASSED` on three runs, with `exit=0`. The third
  ran after the review fix (last-step evidence, Stopping in
  `runner-claims.spec.ts`). On each run
  all 38 specs exited 0 and 88 tests passed, the same as the baseline:
  one spec was renamed and none was added. `run.sh` logged three resets:
  the initial one, then before `runner-engine` and before
  `runner-activity`.

  ```text
  [run.sh] resetting 'ticketit_e2e_m52' schema to a known empty state
  [run.sh] resetting 'ticketit_e2e_m52' and restarting galley: runner-claims.spec.ts leaves the Owner's one open Round
  [run.sh] resetting 'ticketit_e2e_m52' and restarting galley: runner-engine.spec.ts leaves the Owner's one open Round
  [run.sh] running tests/runner-stop.spec.ts (the Owner's Stop ends a real michelin's Round as Stopped, then Round 2) against the same galley
    ✓  1 [chromium] › tests/runner-stop.spec.ts:24:1 › the Owner's Stop ends a real Michelin's Round as Stopped: Backlog with the Stopped Badge, its activity and usage kept, and an explicit Ready claims Round 2 (9.0s)
  [run.sh] runner-stop.spec.ts exit code: 0
  [run.sh] SUITE PASSED
  ```

  `runner-stop.spec.ts` took 9.0 s, 9.7 s and 9.0 s.
  `runner-activity.spec.ts`, which now ends with a Stop, took 22.9 s and
  23.0 s.

**New and changed Galley tests**

| Test | What it pins |
| --- | --- |
| `TestStopConfirmed_EndsTheRoundAsStoppedMovesTheTicketToBacklogWithTheStoppedBadgeAndFreesTheSlot` | for a `claimed` and a `running` Round: result `stopped` with `endedAt`; Round `stopped` with the evidence; Ticket Backlog with the Badge, unlocked; a claim of another Ticket succeeds |
| `TestStopConfirmed_EndedAtNeverPrecedesTheRoundsStart` | a skewed clock still gives `endedAt` ≥ start |
| `TestStopConfirmed_WithoutAStopRequestIsStopNotRequestedAndChangesNothing` | `409 stop_not_requested`; no row changed |
| `TestStopConfirmed_AnUnacknowledgedStopIsEnough` | it ends the Round before any ack |
| `TestStopConfirmed_AtAStaleEpochIsStaleClaimEpochAndChangesNothing` | `409 stale_claim_epoch` |
| `TestStopConfirmed_OnAnEndedRoundIsRoundNotOpenAndChangesNothing` | delivered and already stopped Rounds: `409 round_not_open` |
| `TestStopConfirmed_ReplayReturnsTheStoredResultAndChangesNothing` | `200` with the stored result |
| `TestStopConfirmed_ConcurrentIdenticalConfirmationsApplyExactlyOnce` | 8 concurrent identical confirmations: one apply, identical bodies |
| `TestStopped_IsTerminal` | new-key events are `round_not_open`; Stop is `stop_not_available` |
| `TestStopped_TheRoundsActivityAndUsageStayListedUnderIt` | activity and usage listed under the stopped Round |
| `TestStopped_OnlyAnExplicitReadyStartsANewRoundWithANewIdentityAndEpoch` | no claim without Ready; Round 2 has a new id, sequence + 1, epoch + 1 |
| `TestStoppedBadge_DetachingLeavesTheRoundStoppedAndTheNextStopReusesIt` | detaching leaves the Round unchanged; the next Stop attaches the same Badge |
| `TestStoppedBadge_IsAdoptedFromAnOwnersBadgeNamedStoppedInAnyCase` | `stopped`, `STOPPED` and `sToPpEd` are adopted; another Owner's Badge is not |
| `TestEnsureStoppedBadge_ReusesAdoptsOrCreatesWithinTheOwner` | each branch, called directly |
| `TestStoppedBadge_AdoptsABadgeTheOwnerCommitsWhileTheConfirmationWaits` | a Badge committed while the insert waits on it is adopted |
| `TestStoppedBadge_ConcurrentBadgeCreationAndConfirmationLeaveOneStoppedBadge` | 5 concurrent `CreateBadge` calls beside a confirmation leave one Badge |
| `TestStopConfirmed_ATicketNeitherReadyNorInProgressRollsBackAndAnswers500` | the Round is not stopped; the failure is logged |
| `TestStopConfirmed_AFailureAtTheLastWriteRollsBackEveryChange` | a trigger refusing the `stop_confirmed` `round_events` insert gives `503`; nothing is kept |
| `TestStopConfirmed_EvidenceLimitsAtTheAPI` | missing, extra field, number, null, empty, blank, 2001 characters, CR and NUL refused with nothing written; 2000 characters with tab and line feed stored verbatim |
| `TestStopped_NoSignalButStopConfirmedEndsARound` | repeated command polls, 24 h without a heartbeat, a fresh heartbeat and an `applied` ack leave the Round open and Stopping; only `stop_confirmed` ends it |
| `TestStopped_OnlyTheStopConfirmationWritesTheStoppedState` | source-scan guardrail |
| `TestRounds_TheDatabaseEnforcesTheStoppedOutcome` | state, timestamp and `outcome_note` constraints |
| `TestBadges_TheDatabaseEnforcesOneSystemBadgePerOwner` | `system_key` check and the unique index |
| `TestStopConfirmed_ResponsesMatchContract` (`contract_test.go`) | `201`, the replay, each `409` and the `400`, validated against the contract |
| `TestDecideRoundEvent` (changed) | 9 `stop_confirmed` cases through the ladder |
| lock-order test, snapshots, `no_execution_side_effects_test.go` (changed) | cover `stopped`, `outcome_note` and Badges |

**New and changed Michelin tests** (252 → 265)

| Test file | What it pins |
| --- | --- |
| `engine.test.ts` ("a Stop request") | evidence and key pinned, including a Stop in the last step's `wait` (`Stopped after step 2 of 2 …`); retry through 5xx and network failures with the same bytes; a replay and a null `startedAt` accepted; invalid result bodies retried; `409` and `400` refusals abandoned; shutdown during the confirmation's backoff is `aborted`; a delivery in flight and shutdown confirm nothing |
| `commandLoop.test.ts` | `applied` ack only after the confirmation lands through 5xx; no ack and claiming resumes when the confirmation is refused; every existing Stop test now expects the confirmation before the ack |

**New and changed Swiftlet tests** (448 → 458)

| Test file | What it pins |
| --- | --- |
| `api/rounds.test.ts` (new) | a stopped Round's `outcomeNote`, activity and usage kept; a missing note, a note on a non-stopped Round and a non-string note rejected |
| `TicketDetail.test.tsx` (2) | Stopped tag, outcome note, activity, usage and the Badge; a Round stopped while claimed shows no start |
| `TicketDetailPage.test.tsx` | the Round list is fetched on open and on the refresh that sees the Round stop |
| `ui/tokens.test.ts` (1) | stopped tag contrast |

**Browser spec** (`tests/runner-stop.spec.ts`): all data goes through
Galley's API, against a real Michelin running `start`, `progress`, `usage`
and `hold`.

1. Before the claim, Stop is unavailable. Once the Round is running and
   holding, Stop is available.
2. Stop is clicked on the receipt and returns `200` with Stopping.
3. Michelin's log shows, in order:
   - `engine stopped` at step index 3;
   - `stop confirmation reported` with `201` and `endedAt`;
   - one `command acknowledged` with outcome `applied`.

   No `round event refused` line appears and no credential is logged.
4. In Galley:
   - the Ticket is Backlog with no `openRound`, the Stopped Badge, and
     Stop unavailable;
   - Round 1 is `stopped` with the logged `endedAt`;
   - its `outcomeNote` is `Stopped before step 4 of 4 on Stop command <id>`;
   - its activity and usage are kept.
5. The receipt shows Backlog, no Stopping and no lock, the Stopped tag,
   the outcome note, the activity, the cost, the tokens and the Badge.
   The same holds after a reload.
6. With the runner credential:
   - a late event is `409 round_not_open`;
   - the command list is empty;
   - the ack replays its stored value, and `ignored` is `409`.

   A second Stop is `400 stop_not_available`.
7. The board slip in Backlog shows the Stopped Badge and no Stopping.
8. "Remove Stopped" on the receipt returns `200`, and the Round list is
   unchanged.
9. Ready on the receipt is `200`. Michelin claims Round 2, with a new
   id, sequence 2 and epoch 2. The receipt lists two Rounds, and Round 1
   is unchanged.
10. A second Stop, through `stopRoundThroughGalley`, reattaches the same
    Badge. There is still one Badge named "stopped" in any case. Both
    Rounds are `stopped`, and there are two acks.
11. Michelin exits 0 on `SIGTERM`.

**Remaining `run.sh` resets**

| Reset | Why it stays |
| --- | --- |
| before `runner-engine.spec.ts` | `runner-claims.spec.ts` claims with the runner credential and no Michelin. Nothing that has ceased work can confirm a Stop, so the Round would stay open. |
| before `runner-activity.spec.ts` | `runner-engine.spec.ts` kills its Michelin on purpose, to show that the Round stays open after the runner is lost. No Michelin holds the Round to confirm a Stop. |

Removed:

- the reset after `runner-activity.spec.ts`. That spec now stops its own
  Round through Galley.
- the reset before `runner-stop.spec.ts`. `runner-rework.spec.ts` leaves
  every Round delivered and no Ticket Ready.

The initial schema reset at the start of the run is unchanged.

**Falsification.** For each mutation:

- Galley: the change was applied and `go test ./internal/httpapi
  -count=1` run, then the file was restored with `git checkout --` from
  the staged index.
- Michelin and Swiftlet: the full `npm test` was run.

`git diff --stat` was empty afterwards.

| Layer | Change | Result |
| --- | --- | --- |
| Galley | no `stop_not_requested` check | 3 tests failed: `TestDecideRoundEvent`, `…WithoutAStopRequest…`, `…ResponsesMatchContract` |
| Galley | `roundStateTakes` accepts `running` only | 5 failed, including `…EndsTheRoundAsStopped…` and `…EndedAtNeverPrecedes…` |
| Galley | Ticket moved to Ready instead of Backlog | 10 failed |
| Galley | Badge never attached | 9 failed |
| Galley | `ended_at = now` | 1 failed: `…EndedAtNeverPrecedesTheRoundsStart` |
| Galley | Ticket guard ignored | 1 failed: `…ATicketNeitherReadyNorInProgressRollsBackAndAnswers500` |
| Galley | no `ON CONFLICT` on the Badge insert | 1 failed: `…AdoptsABadgeTheOwnerCommitsWhileTheConfirmationWaits` |
| Galley | no adopt branch and no `ON CONFLICT` | 4 failed, including `…IsAdoptedFromAnOwnersBadgeNamedStoppedInAnyCase` and `TestEnsureStoppedBadge_…` |
| Galley | evidence not stored (constant note) | 3 failed |
| Galley | no adopt branch only | **0 failed**: equivalent mutant (see Limitations) |
| Galley | no reuse-by-`system_key` branch only | **0 failed**: equivalent mutant (see Limitations) |
| Michelin | `"stopped"` returned even when the confirmation is refused | 6 failed |
| Michelin | wrong idempotency key | 5 failed |
| Michelin | wrong evidence | 5 failed |
| Michelin | last-step wording reverted to `before step N+1 of N` | 1 failed (`engine.test.ts`, the last-step `wait` case) |
| Michelin | no confirmation sent | 19 failed |
| Michelin | a 5xx treated as final | 10 failed |
| Michelin | parser accepts any `endState` | 2 failed |
| Michelin | ack before the confirmation | 8 failed |
| Swiftlet | no outcome note rendered | 2 failed |
| Swiftlet | no Stopped tag | 3 failed |
| Swiftlet | parser accepts a note on any Round | 2 failed |
| Swiftlet | Round list fetched only with an open Round | 2 failed |
| Swiftlet | Rounds section only with an open Round | 3 failed |
| Swiftlet | `--color-status-blocked-deep` lightened to `#f08080` | 4 failed in `tokens.test.ts`, including the stopped tag pair |

The first contrast mutation was invalid. It edited the new pair in the
test to read paper on `status-blocked`, which also passes AA, so 0
failed. It was replaced by the token mutation above. That mutation also
shows the new pair overlaps the existing
`Blocked > deep colour … as a tag fill under paper text` check.

**M5.1's behaviour changed.**

- A confirmed Stop now ends the Round. Stopping is therefore transient
  against a live Michelin: it lasts until the confirmation lands.
- M5.1's browser assertions that the Ticket stays In Progress and locked
  after the ack, are gone from `runner-stop.spec.ts`. These were:
  - `stop_already_requested` on a repeat;
  - a `204` claim;
  - `400 round_open` on an edit;
  - the board's Stopping slip.

  They raced the confirmation. The rule is still pinned in three places:
  - in Go, by `TestStopping_TheTicketStaysLockedAndTheSlotTaken`;
  - on the receipt, by `TicketDetail.test.tsx` ("requests Stop without a
    confirmation and shows Stopping on the locked receipt Galley
    returned" and "shows Stopping beside the claimed tag for a claimed
    Round") and `TicketDetailPage.test.tsx` ("requests Stop through
    POST /api/tickets/:id/stop, shows Stopping, …");
  - on the slip, by `TicketBoard.test.tsx` ("shows Stopping on the locked
    slip once Galley reports the Stop request, …").
- One lasting browser observation of Stopping moved to
  `runner-claims.spec.ts`. Its Round is claimed directly with no
  Michelin, so nothing polls the commands or confirms the Stop, which
  makes the observation deterministic. After the receipt's Stop:
  - the receipt shows Stopping after a reload, still Claimed by runner
    and locked;
  - the Ready slip shows Stopping;
  - Galley reports `stop_already_requested`.

  A slow `MICHELIN_COMMAND_INTERVAL_MS` was rejected: the Stop lands at an
  arbitrary phase of the poll timer, so it would only shrink the race.
  The reset after this spec was already kept.
- Michelin's `applied` ack now follows the confirmation, where it
  previously followed `engine stopped`.

## Implementation limitations and follow-ups

- **Partial Reports are not kept.** A stopped Round keeps its activity,
  usage and evidence only. Partial results and Reports belong to M7
  ([#8](https://github.com/cristoforows/ticketIt/issues/8)) and M8
  ([#9](https://github.com/cristoforows/ticketIt/issues/9)).
  `CONTEXT.md` no longer promises them.
- **Two `ensureStoppedBadge` branches are redundant with the insert's
  `ON CONFLICT`.** Badges cannot be renamed or deleted, so a keyed Badge
  is always still named "Stopped". The reuse and adopt branches then give
  the same result as the insert. Removing either branch alone fails no
  test. Both are kept because the Decision specifies them. They become
  observable once Badge rename or delete exists.
- **Swiftlet makes one extra `GET /rounds` per Ticket open**, including
  for Tickets that never had a Round. See the choices above.
- **A refused confirmation leaves the command unacknowledged and the
  Round open** with its Michelin gone, as for any abandoned Round.
  Recovery is D5.
- **Times on the receipt are raw RFC 3339**, as before.

## Outstanding checks and owning milestone

- Stop of a Round that is `waiting_for_input`, Failed and Interrupted
  outcomes, and the greyed active card: later M5 slices
  ([#6](https://github.com/cristoforows/ticketIt/issues/6)).
- Recovery of a Round whose runner never confirms: M5 (#6, D5).
- A real engine halting mid-model-call: M6.
- The milestone gate reconciles `docs/evidence/m5/README.md`,
  `docs/open-decisions.md` and the plan documents. This slice does not
  edit them.

## Decision impacts (open-decision IDs)

- **D5** (recovery authority): only the runner's evidence-bearing
  `stop_confirmed` ends a Round as Stopped. Command polls, a lapsed
  heartbeat and an `applied` ack do not
  (`TestStopped_NoSignalButStopConfirmedEndsARound`). A Round whose
  runner is lost still stays open for recovery. Not decided here.
- None of D1–D4 or D6–D9.
