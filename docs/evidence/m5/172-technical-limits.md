# Technical execution limits

## Purpose

M5.14, [#172](https://github.com/cristoforows/ticketIt/issues/172) (D8,
limits).

Galley alone measures two limits on each Round and stops a running Round
that reaches either:

- **Active time** (`wall_clock`), the time spent `running` by Galley's
  clock;
- **Denial streak** (`denial_loop`), the recorded `deny` authority
  checks since the last recorded `allow`.

A breach records one `round_limit_breaches` row and requests the Stop
through the Owner's Stop path. The runner's `stop_confirmed` then ends
the Round **Failed**: Blocked, no Stopped Badge, Galley's explanation.
Michelin gains a `retry_act` step that produces a denial loop.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/`, `CONTEXT.md` (the new Technical Limit, and Stopping, Stopped and
Failed) and the READMEs of the three apps and the browser suite.

**Owner question, resolved as (a): Failed.** A breached Round's
`stop_confirmed` ends it `failed`, not `stopped`. This is an exception
to M5.2's "`stop_confirmed` ends Stopped": the Owner did not request
that Stop. Without a breach, `stop_confirmed` still ends Stopped. The
defaults stand: `4h` active duration, `10` consecutive denials. **The
Owner should reconfirm both the outcome and the defaults at the M5
gate.**

## What already existed

- M5.1–M5.13 merged; this branch starts at `dda5693` (M5.13).
- Stop as a pending command, Stopping until `stop_confirmed`, and the
  shared pending-Stop idempotency in `requestStop` (M5.1, M5.10).
- `stop_confirmed` ending Stopped through `roundEndings` (M5.2); `failed`
  ending Failed and the Ticket Blocked (M5.3).
- Recorded authority checks (M5.7); refused checks are not recorded
  (M5.12).
- Nothing bounded a Round's time or retries. The authority check took no
  Ticket lock.

## What this slice added

### Configuration

`GALLEY_ROUND_MAX_ACTIVE_DURATION` and
`GALLEY_ROUND_MAX_CONSECUTIVE_DENIALS`, on `config.Config` as
`RoundMaxActiveDuration` and `RoundMaxConsecutiveDenials`.

- **Active duration.** A Go duration from `1s` to `168h`, default `4h`.
  `0`, a negative value, an unparsable value, more than `168h` and a
  value that is not a whole number of seconds (`999ms`, `1500ms`,
  `4h0.5s`) all fail startup.
- **Denials.** An integer from `1` to `1000`, default `10`, parsed with
  `strconv.Atoi`, so `10.5`, `1e3`, ` 10` and `0x10` fail.
- **Errors.** Each names the variable and the accepted form:
  `invalid GALLEY_ROUND_MAX_ACTIVE_DURATION "0s": must be a Go duration
  of whole seconds from "1s" to "168h", such as "4h"`.

### Migration `000029_round_technical_limits`

- `rounds.active_ms BIGINT NOT NULL DEFAULT 0`, which must be at least 0.
- `rounds.active_since TIMESTAMPTZ`, which may be set only while
  `running` (`rounds_active_since_only_running`).
- `round_limit_breaches`, with:
  - `owner_id`, `round_id` (unique, composite FK to `rounds`);
  - `kind` (`wall_clock|denial_loop`);
  - `"limit"` of at least 1, and `measured` of at least `"limit"`;
  - `breached_at`.
- **Backfill.** A Round `running` at the migration gets
  `active_since = started_at`. No record says when it last left
  `running`, so earlier waits are overcounted. Every other Round starts
  at `active_ms = 0`.

### Measurement (`round_limits.go`)

`enterRunningSQL(now)` and `leaveRunningSQL(now)` are the one helper
pair. Leaving adds `floor((now − active_since) in ms)`, clamped at 0, to
`active_ms` and clears `active_since`. Every state-changing `UPDATE
rounds` in Galley uses one of them:

| Transition | Call site | Helper |
|---|---|---|
| `execution_started` (claimed → running) | `startRound` | enter |
| `resumed` (waiting → running) | `moveRoundAndTicket` | enter |
| `question_raised`, `permission_requested` | `moveRoundAndTicket` | leave |
| `delivered` | `deliverRound` | leave |
| `stop_confirmed`, `failed`, `interrupted`, attestation | `endRound` | leave |

`measureRound` reads, under the caller's Round row lock:

- active time, as `active_ms` plus `now − active_since`;
- the denial streak, as recorded `deny` checks whose id is above the
  newest recorded `allow`;
- whether a Stop command exists.

Time with the runner disconnected counts, because the state is
unchanged.

### `decideLimitBreach`

`decideLimitBreach` is the one pure function holding both rules.

- It returns nothing unless the Round is `running` with no Stop
  requested.
- It breaches the wall clock when `active ≥ limit`. `limit` and
  `measured` are recorded in whole seconds, floored, so the explanation
  reads `4h0m1s` rather than `4h0m1.234s`.
- Otherwise it breaches the denial loop when `streak ≥ limit`.
- When both are reached, the wall clock is named.

### Evaluation points and lock orders

There is no background job. `enforceRoundLimits` runs at three points,
each holding the Owner's priority lock, then the Ticket row, then the
Round row:

1. **Heartbeat** (`recordHeartbeat`). Takes the priority lock, then the
   runner row (the `last_seen_at` update), then the open Round's Ticket
   row and Round row (`lockOwnerOpenRound`). Then it sets the Reconcile
   flag and evaluates. Nothing that holds a Ticket or Round row waits
   for a runner row, so the order is acyclic with the event path.
2. **Accepted event** (`recordRoundEvent`). The existing ladder already
   holds the priority lock, the Ticket row and the Round row. The
   evaluation runs before the event row is inserted, when the result
   leaves the Round `running`.
3. **Authority check** (`checkAuthority`).
   - The Ticket id is looked up without a lock. Then the check takes the
     priority lock and the Ticket row, reads the Round `FOR SHARE`,
     records the check and evaluates.
   - Before this slice the check held no Ticket lock. It now
     serialises with every other mutation of the Owner's open Round.
     That includes a revocation (`grant_revocation.go`'s comment was
     updated).

The evaluation continues while a Round awaits Reconcile. The breach is
Galley's own measurement and needs no runner account.

### Enforcement

1. `enforceRoundLimits` inserts the breach row with a plain `INSERT`, not
   `ON CONFLICT`, so a second breach of one Round would fail loudly.
2. In the same transaction it calls `requestStop`, the Owner's Stop path.
   - `requestStop` is guarded by `decideStop`'s `stop_already_requested`
     and the partial unique index on the stop command.
   - A breach, an Owner Stop and a revocation therefore share one Stop
     command per Round.
3. A Round with a Stop already requested never reaches the insert, so
   the first cause wins.

### Outcome

`stopConfirmedEnding(breach, evidence)` (`round_endings.go`) is the one
place `stop_confirmed`'s ending is chosen. It reads the breach row
under the Round lock.

- **With a breach:** M5.3's `failed` ending. The Ticket goes to Blocked
  with no Badge, and the explanation is:
  - `Technical limit reached: active time <measured> exceeded the <limit> limit.`
  - or `Technical limit reached: <measured> consecutive denied authority checks (limit <limit>).`
  - Durations are `time.Duration(seconds)*time.Second` as Go prints them.
- **Without one:** M5.2's `stopped` ending, unchanged.

The ladder is otherwise unchanged:

- A late `delivered` ends Delivered (In Review).
- A late `failed` ends Failed with the runner's explanation.
- An attestation ends Interrupted.

In each case the breach row stays and `limitBreach` is still returned.

### API

`RoundLimitBreach {kind, limit, measured, breachedAt}`. A required,
nullable `limitBreach` is on `TicketOpenRound` (for the Stopping copy)
and on `TicketRound`. The descriptions of the event, heartbeat and
authority-check endpoints name where the limits are checked. The
`stop_confirmed` description names the Failed outcome.

### Michelin

- **`retry_act`.**
  - Fields: `{account, action, resource, times, intervalMs?}`, with
    `act`'s field validation; `times` 1–1000; `intervalMs` 0–60000,
    default 100. Anything else is rejected at start.
  - Each attempt is one *answered* check. A `deny` waits `intervalMs`
    and checks again. An `allow` sends `act`'s progress note and ends
    the step. After `times` denials it logs `engine gave up retrying a
    denied action`, and the script continues.
  - The Stop is checked between attempts, and the wait is aborted by it.
  - Refusals are retried inside `checkScope` and are not attempts:
    `runner_disconnected`, `reconcile_required`, network failures and
    `5xx`. `capability_not_supported` fails the Round as `act` does.
    Other refusals abandon it.
- **`stop_confirmed` result.** The result parser now accepts `failed` as
  well as `stopped` for `stop_confirmed`. Without this a breached
  Round's confirmation is an `invalid_body`, retried until the report
  bound halts the engine. Michelin otherwise does nothing special.

### Swiftlet

- **Parser.** `api/limitBreach.ts` is the strict parser, used by both
  shapes. It requires:
  - `null`, or a known `kind`;
  - safe integers, with `limit` at least 1 and `measured` at least
    `limit`;
  - a string `breachedAt`.

  An open Round with a breach must have `stopRequestedAt`.
- **Stopping copy.** The slip's waiting reason and the detail's
  `StoppingTag` read *Technical limit reached. Stopping the Round.*
- **Failed copy.** Above Galley's explanation, the Round entry shows
  *Active time limit reached: <measured> of <limit>* or *Denied-check
  limit reached: <measured> of <limit>*. The same line names the limit
  on the open Round's entry while it is Stopping.
- **Formatting.** `formatSeconds` prints whole seconds as Go's
  `time.Duration` does (`14401` → `4h0m1s`). It is deterministic and
  ignores locale, so it reads the same as Galley's explanation.

### e2e

- `tests/runner-limit-wall-clock.spec.ts`:
  - a holding Michelin is paused (`SIGSTOP`);
  - the dev clock is walked past `4h` in 20 s steps, with a heartbeat
    sent on its credential after each, so the runner stays connected;
  - the Ticket shows the Stopping copy and the open Round's entry names
    the limit;
  - after `SIGCONT`, Michelin confirms the Stop and the Round ends
    Failed.
- `tests/runner-limit-denials.spec.ts`: `retry_act` on a never-granted
  scope reaches the default limit of 10 and ends Failed.
- Both run after `runner-attest.spec.ts`, with exit codes checked.
- Both read the measure from Galley, never from the browser's clock.

### Engineering choices beyond the Decisions

| Choice | Reason |
|---|---|
| Duration must be whole seconds | The breach records seconds; a sub-second limit would be stored as a different value than configured. |
| A zero `config.Config` limit falls back to the default (`roundLimitsOf`) | Tests and tools build `config.Config` literals; a zero limit would breach every running Round. `config.Load` never yields zero. |
| Wall clock named first when both reach | One breach per Round; the order is fixed so the outcome is deterministic. |
| `active_since` constraint is one-directional | `running ⇒ active_since` would reject existing direct `running` inserts in tests and the backfill of Rounds not running. |
| Backfill from `started_at` | No earlier record of when a Round left `running`. Overcounting can only bring a breach earlier, never hide one. |
| Evaluation continues while a Round awaits Reconcile | The limit is Galley's own measure and needs no runner account. |
| The authority check takes the priority and Ticket locks | Required by the Decision's lock order; it also serialises a check with a concurrent revoke. |
| Plain breach `INSERT` | A double record would be a bug; failing loudly surfaces it. |
| `limitBreach` on `TicketOpenRound` too | Swiftlet's Stopping copy is decided from the open Round. |
| Galley's explanation replaces the runner's Stop evidence | M5.3 stores one explanation; the Decision names Galley's. |
| A refused check is not a `retry_act` attempt | "Consecutive authority checks" means answered ones, matching Galley's streak, which counts only recorded checks. |
| Michelin accepts `failed` for `stop_confirmed` | Needed for the breach outcome; it is parsing, not behaviour. |
| Wall-clock spec uses the default 4h and the dev clock | An env override would change the limit for every other spec sharing the Galley. |

## Exact versions and toolchain

Go 1.27.1 (darwin/arm64), Node 26.9.0, npm 11.19.1, PostgreSQL 17.11
(local), Playwright and Vitest as locked in each `package-lock.json`;
no dependency changed.

## Reproducible commands

```
createdb ticketit_test_m514; createdb ticketit_e2e_m514
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m514?sslmode=disable'
cd apps/galley && gofmt -l . && go vet ./... && go build ./... && go test ./... -count=1 && go test -race -count=1 ./...
cd apps/michelin && npm ci && npm run typecheck && npx vitest run
cd apps/swiftlet && npm ci && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd apps/galley && ./scripts/check-contract-drift.sh
cd contracts && npm ci && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh
cd e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m514?sslmode=disable' ./run.sh
```

## Observed results

All on the final tree, 2026-10-05, macOS (darwin/arm64), local PostgreSQL.

| Command | Result |
|---|---|
| `gofmt -l .` | no output |
| `go vet ./...` | pass |
| `go build ./...` | pass |
| `go test ./... -count=1` | pass, 7 packages ok (`internal/httpapi` 166 s) |
| `go test ./... -count=1 -race` | pass, 7 packages ok, no race reported |
| Michelin `npm run typecheck` | pass |
| Michelin `npx vitest run` | 492 passed (492) |
| Swiftlet `tsc --noEmit` | pass |
| Swiftlet `npx vitest run` | 28 files, 791 passed (791) |
| Swiftlet `npm run build` | pass |
| `apps/galley/scripts/check-contract-drift.sh` | pass, on the committed tree |
| `contracts/check-swiftlet-drift.sh` | pass, on the committed tree |
| `contracts/check-michelin-drift.sh` | pass, on the committed tree |
| `e2e/run.sh` | `EXIT=0`: 52 spec invocations exit 0, 109 tests passed, none failed or flaky (4 min 35 s) |

Earlier e2e runs on this branch failed, and each failure changed the
tree:

- Run 1: `runner-engine.spec.ts` compared the open Round with exact
  equality and lacked `limitBreach: null`; the spec was updated. The
  wall-clock spec jumped the dev clock 4 h in one step, so the heartbeat
  that found the breach was the first after a gap past the health
  window and the Round showed `reconciling`, not `stopping` (see
  limitations). The spec now walks the clock in 20 s steps with a
  heartbeat after each. The denial spec and `active-order-slip.spec.ts`
  then failed only because the wall-clock spec left its Round open.
- Run 2: the wall-clock spec used a 10 min command interval, so after
  `SIGCONT` Michelin did not pull the Stop within the poll; it now uses
  500 ms. The same two specs failed downstream again.

### Falsification

Each mutation was applied alone, the named suite run, and the file
restored by the script. Galley mutations ran `go test ./internal/httpapi/
./internal/postgres/ -count=1 -run 'Limit|ActiveTime|WallClock|Denial|RoundLimits|Migration29'`;
Michelin and Swiftlet ran their whole Vitest suite. `git diff --stat`
was identical before and after, and the untracked new files were
checked for the original text.

| # | Mutation | Result | First failing tests |
|---|---|---|---|
| G1 | wall clock `>=` to `>` | killed | `TestDecideLimitBreach_AtEachBoundary/active_at_the_limit`, `TestLimitBreach_ResponsesMatchContract/wall_clock` |
| G2 | denials `>=` to `>` | killed | `.../the_limit-th_denial`, contract `denial_loop` |
| G3 | breach despite a requested Stop | killed | `.../Stop_already_requested`, `TestWallClockLimit_BreachesOnHeartbeat` |
| G4 | breach outside `running` | killed | `.../claimed`, `.../waiting_for_input`, `.../ended` |
| G5 | denial named before wall clock | killed | `.../both_reached_names_the_wall_clock` |
| G6 | leaving running does not fold `active_ms` | killed | `TestActiveTime_CountsRunningOnly`, `TestActiveTime_FoldsOnEveryEnding` |
| G7 | entering running does not stamp `active_since` | killed | `TestActiveTime_CountsRunningOnly`, contract `wall_clock` |
| G8 | open running time not added to the measure | killed | `TestActiveTime_CountsTimeWithTheRunnerDisconnected` |
| G9 | an allow does not reset the streak | killed | `TestDenialLimit_AnAllowResetsTheStreak` |
| G10 | streak counted across Rounds | killed | `TestDenialLimit_TheStreakDoesNotCarryAcrossRounds` |
| G11 | breach row not inserted | killed | contract `wall_clock`/`denial_loop`, `TestActiveTime_CountsTimeWithTheRunnerDisconnected` |
| G12 | breach requests no Stop | killed | contract, `TestActiveTime_CountsTimeWithTheRunnerDisconnected` |
| G13 | `stop_confirmed` ignores the breach | killed | `TestLimits_StopConfirmedOnABreachedRoundEndsItFailed`, contract |
| G14 | Failed keeps the runner's evidence | killed | `TestLimits_StopConfirmedOnABreachedRoundEndsItFailed`, `...WhileWaitingAfterABreachEndsFailed` |
| G15 | no evaluation on an authority check | killed | `TestWallClockLimit_BreachesOnAuthorityCheck`, `TestDenialLimit_TheLimitThDenialBreachesAndStillDenies` |
| G16 | no evaluation on an accepted event | killed | `TestWallClockLimit_BreachesOnEvent` |
| G17 | no evaluation on a heartbeat | killed | `TestWallClockLimit_BreachesOnHeartbeat` |
| G18 | waiting does not leave running | killed | `TestWallClockLimit_ExcludesClaimedAndWaitingTime` |
| G19 | Round record omits the breach | killed | contract, `TestWallClockLimit_BreachesOnHeartbeat` |
| G20 | explanation wording changed | killed | `TestLimitBreachExplanation_IsGalleysExactWording` |
| G21 | a zero limit not defaulted | killed | `TestProgress_NoteLimitsAtTheAPI` and other fixtures built without `config.Load` |
| G22 | migration does not backfill `active_since` | killed | `TestMigration29_CountsARunningRoundFromItsStart` |
| G23 | `lockOwnerOpenRound` drops the Round row's `FOR UPDATE` | **survived** | none |
| M1 | `stop_confirmed` accepts only `stopped` | killed | "accepts a confirmation that ends a Round a technical limit stopped as failed" |
| M2 | `retry_act` skips its interval | killed | "asks again on each deny ..., waiting intervalMs between" |
| M3 | `retry_act` ignores a Stop between attempts | killed | "checks for a Stop between attempts and confirms it" |
| M4 | one attempt fewer | killed | "asks again on each deny ...", "does not count a refused check as an attempt" |
| M5 | an allow keeps retrying | killed | "performs the action at the first allow and checks no more" |
| M6 | `times` bound raised | killed | "rejects a retry_act with times 1001" |
| M7 | default interval changed | killed | "accepts retry_act steps at their bounds, intervalMs defaulting to 100" |
| M8 | "gave up" log removed | killed | "asks again on each deny ..." |
| S1 | open Round breach accepted without a Stop | killed | "rejects a Ticket with a limitBreach without a Stop" |
| S2 | `measured` below `limit` accepted | killed | "rejects a measure under the limit" |
| S3 | unknown `kind` accepted | killed | "rejects an unknown kind" |
| S4 | hours printed without minutes | killed | "prints 14401 seconds as Go does: 4h0m1s" |
| S5 | denial label wording | killed | "names the limit kind with the measure of the limit" |
| S6 | slip ignores the breach | killed | "labels a Stop a technical limit requested" |
| S7 | `StoppingTag` ignores the breach | killed | "says a technical limit is stopping the Round when Galley recorded a breach" |
| S8 | open Round entry names no limit | killed | "names the breached limit on a Round that is still Stopping" |
| S9 | label on any ended Round | killed | "names no limit on a Round a breach did not end Failed" |
| S10 | Failed entry names no limit | killed | "puts the breached limit above Galley's explanation on a Failed Round" |
| S11 | Round record parser drops the breach | killed | "keeps the limit breach of a Round a technical limit ended Failed" |

Two first attempts were invalid and were redone: G11 first made the
INSERT's error ignored rather than removing the INSERT (equivalent
mutant), and G15 first failed to compile.

G23 survives because every caller already holds the Owner's priority
lock and the Ticket row lock, which serialise all evaluators of one
Round; the Round row lock adds nothing a test can observe. It is kept
to match the event path's lock order.

## Implementation limitations and follow-ups

- **A silent runner is never measured.** With no background job, a
  Round whose runner sends no heartbeat, event or check is not
  evaluated. If the runner is gone, that is a Stranded Round (M5.13,
  attestation). If it is paused, the breach is recorded at its next
  call.
- **The breach is as late as the next call.** Michelin heartbeats every
  few seconds, so a breach lands within one heartbeat interval of the
  limit. `measured` records the actual value, which may exceed `limit`.
- **The runner's Stop evidence is not stored on a breached Round.** The
  explanation is Galley's. The runner's `data.evidence` is kept only in
  the stored event payload, for replay comparison.
- **A breach found after a disconnect shows Reconciling, not Stopping.**
  When the call that finds the breach is the first after a gap past the
  health window, the breach and its Stop are recorded, but the open
  Round's waiting reason is `reconciling` until the runner reconciles;
  the Round entry still names the limit. The first e2e run hit this with
  a single 4h clock jump.
- **Backfilled Rounds overcount** waits taken before migration 000029.
- **Dispatched work is not undone.**
  - Checks Michelin makes before it pulls the Stop are recorded, as
    denies or allows. The e2e denial spec records more than 10.
  - An allowed action after the breach is performed and recorded, as in
    M5.10.
- **Defaults are for the controlled engine.** M7 (#8) and M8 (#9)
  revisit them with real engines, as the Decision states.
- **There are no per-Agent, per-Ticket or per-Owner overrides**, by
  Decision. Spending budgets stay deferred.

## Outstanding checks and owning milestone

- The Owner's reconfirmation, at the M5 gate, of option (a), Failed on a
  breach (the exception to M5.2), and of the `4h`/`10` defaults.
- Gate-report reconciliation of the evidence index,
  `docs/integration-feasibility.md`, `docs/open-decisions.md` (D8) and
  `docs/contracts/execution-interface.md`: the M5 gate-report slice
  (#173).

## Decision impacts (open-decision IDs)

D8 (technical limits): implemented as the Owner decided.

- There is a per-Round wall-clock limit and a per-Round denial-loop
  limit, measured by Galley alone.
- A breach ends the Round Failed through the shared Stop.
- No usage figure is read; spending budgets stay deferred.

Nothing is resolved here; the gate report reconciles it.
