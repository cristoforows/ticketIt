# Stop request and the pulled-command channel

## Purpose

M5.1, [#159](https://github.com/cristoforows/ticketIt/issues/159): the
Owner can request Stop on a Ticket whose Round is open. Galley records
one `stop` command for that Round and its claim epoch. Michelin pulls the
command while it holds the Round, halts its engine at the next step
boundary, and acknowledges it `applied`. The Ticket shows **Stopping**
and stays locked. Ending the Round (`stop_confirmed`) is M5.2 and is not
built here.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/` and `CONTEXT.md`.

## What already existed

- **M4 (#5), merged up to M4.12 (`9475e2c`)**: atomic claims and the
  one-open-Round slot (`rounds.go`); the open-Round lock
  (`lockTicketForMutation`, `decideTicketMutation`); the runner event
  ladder (`round_events.go`); rework and its single decision feeding
  `allowedActions` (`decideRework`, `allowedActionsForTicket`).
- **Michelin pulled only work.** `claimLoop.ts` ran one Round's script at
  a time through `runControlledEngine`, which knew only the shutdown
  signal.
- **No command endpoint and no command table.** Migrations up to
  `000016`.
- Baseline (no app change since M4.11, per the M4.11 record):
  - Galley: 314 top-level tests.
  - Michelin: 235. Swiftlet: 436 (24 files).
  - Browser suite: 37 specs, 87 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`, regenerated into `api.gen.go` and
both `schema.d.ts`)

- `POST /api/tickets/{id}/stop` (`requestTicketStop`), no body, returns
  the `Ticket`.
- `GET /api/runner/rounds/{roundId}/commands` (`listRoundCommands`) and
  `POST /api/runner/rounds/{roundId}/commands/{commandId}/ack`
  (`acknowledgeRoundCommand`), runner bearer.
- Schemas `RunnerCommand`, `RunnerCommandType` (`stop`),
  `RunnerCommandList`, `RunnerCommandAckOutcome` (`applied`, `ignored`),
  `AcknowledgeRoundCommandRequest`, `RoundCommandAcknowledgement`.
- `TicketOpenRound.stopRequestedAt` (required, nullable) and
  `TicketAllowedActions.stop` (required).

**Galley** (`internal/httpapi`)

- Migration `000017_create_round_commands.up.sql`, exactly as the
  Decision gives it.
- `decideStop` in `ticket_lifecycle.go`, used by the command and by
  `allowedActionsForTicket` before the early mutation-lock return:

  | Check, in order | Command | `allowedActions.stop` |
  | --- | --- | --- |
  | No open Round (archived included) | `400 stop_not_available` | unavailable, same reason |
  | A `stop` row exists | `200`, unchanged Ticket, no row | unavailable, `stop_already_requested` |
  | Otherwise | `200`, `stopRequestedAt` set | available |

- `ticketLock.stopRequested`, read with the open Round in
  `lockTicketForMutation` (`EXISTS` over `round_commands`).
- `round_commands.go`: `RequestTicketStop` / `requestStopForOwner`
  (insert under the Ticket row lock; a unique violation on
  `round_commands_one_stop_per_round` answers as
  `stop_already_requested`), `ListRoundCommands` / `pendingRoundCommands`,
  and `AcknowledgeRoundCommand` / `acknowledgeRoundCommand`.
- `openRound.stopRequestedAt` is the `stop` row's `issued_at`, selected
  in `ticketSelectColumns`.
- Manual 405 registrations for the three paths; the ack body decodes
  through `decodeStrictJSON`.
- Guardrails: `round_commands` is in `no_execution_side_effects_test.go`'s
  known tables, and that test's manual lifecycle now also asks for Stop
  and expects `400 stop_not_available` with no record created.
  `TestNoTemplateToCapabilityMapping` is untouched.

**Michelin**

- `MICHELIN_COMMAND_INTERVAL_MS` (default `1000`), parsed like the claim
  interval.
- `commandLoop.ts`: started and stopped by `runRound` in `claimLoop.ts`,
  so it runs only while a Round is held. Each poll lists the Round's
  unacknowledged commands. A `stop` with the claim's epoch calls
  `onStop`. A `stop` with another epoch is acknowledged `ignored`. Any
  other type is logged and left unacknowledged.
- `runControlledEngine` takes `stop: AbortSignal`, separate from the
  shutdown `signal`. It is checked at each step boundary and passed to
  `wait` and `hold`, never to event requests. A Stop returns the new
  outcome `"stopped"`; shutdown still returns `"aborted"`.
- `acknowledgeCommand` retries with `retryDelayMs` / `isRetryable`, now
  exported from `engine.ts`. `runRound` sends `applied` only after the
  engine returns `"stopped"`.
- `galley/runner.ts`: `pullRoundCommands`, `acknowledgeRoundCommand`, and
  an `errorCodeOf` helper shared with `reportRoundEvent`.

**Swiftlet**

- `parseTicket` requires `openRound.stopRequestedAt` (null or string) and
  `allowedActions.stop`. `requestTicketStop` in `api/tickets.ts`.
- **Stop** (`ticket-detail-stop-button`) beside Request rework, only
  when `stop.available`. No confirmation.
- **Stopping…** as a new `StoppingTag` (the `tag` cva's `stopping`
  variant) on the receipt (`ticket-detail-stopping`) and on the slip
  (`board-stopping`), rendered right after the Claimed by runner tag.

**e2e**

- New `tests/runner-stop-request.spec.ts`. `run.sh` resets the database
  and restarts Galley before it, and checks its exit code.
- `support/tickets.ts`: `stopRequestedAt`, `stop` and
  `requestStopDirect`. `support/runner.ts`: `commands`, `ack` and
  `claimStatus` on `runnerCalls`.
- `runner-claims.spec.ts` expects `stop: { available: true }` for a
  claimed Round.

**`CONTEXT.md`** gains **Stopping**: an open Round after the Owner's
Stop request and before its end is confirmed. It is not a Status.

### Engineering choices beyond the Decisions

- **Galley's clock for `issued_at` and `acknowledged_at`**
  (`s.clockNow()`), the same clock as every other Galley timestamp and
  the dev clock the browser suite advances.
- **The "Stop already requested" path re-reads the Ticket inside the
  locked transaction.** After a unique violation the transaction is
  aborted, so it is rolled back and the Ticket is read fresh with
  `getTicketForOwner`.
- **One `404` message for the ack path** ("no round or command with that
  identifier"), covering an unknown, malformed or foreign Round or
  command, and a command of another Round. The Decision asks for the
  shared `404`; one message keeps a foreign Round indistinguishable from
  a missing command.
- **An ack on a Round that is no longer open is accepted.** The Decision
  says an ack never changes Round state and says nothing about closed
  Rounds. Refusing it would leave a late `applied` from a Michelin
  racing the Round's end unrecorded.
- **The ack locks the command row `FOR UPDATE`.** Without it, two acks
  with different outcomes both pass the "not yet acknowledged" read and
  the later write wins. `TestAck_TwoOutcomesQueuedBehindTheRowLockRecordOne`
  fails without the lock (see Falsification).
- **Michelin handles each command id once per Round.** A command that
  stays unacknowledged (an unknown type, or an `ignored` ack that failed
  finally) is not logged or acted on at every poll.
- **The `ignored` ack is sent from the command loop, with the same
  retry.** The engine keeps running meanwhile.
- **The command loop sleeps before its first poll**, as the claim loop
  does. A Stop therefore reaches Michelin within one interval of the
  first poll after it was requested.
- **A Stop arriving after the last step returns `"stopped"`**, not
  `"completed"`, so a finite script that ends while a Stop is pending is
  still acknowledged `applied`.
- **A Round that ends as delivered or abandoned sends no ack.** The
  delivery in flight landed, so the Stop was not applied. The command
  stays unacknowledged on a Round that is no longer open, which the list
  then omits.
- **`engine stopped` logs `stepIndex`**: the index of the step the engine
  did not run, or of the `hold` it left.
- **Poll failures are logged at `error`**, like claim failures, and the
  next poll runs on schedule.
- **`StoppingTag` uses the Blocked-deep status colour** (outline and text
  on paper). The issue requires the status colours and the tag; Blocked
  is the status that marks an intervention. Its contrast is pinned in
  `tokens.test.ts`.
- **Stop is the one receipt action the open-Round lock does not
  disable.** Every other mutating control is disabled while a Round is
  open, and Stop exists only then.
- **The `Stopping` tag renders beside `Claimed by runner`**, not instead
  of it, so a claimed Round's state stays visible.
- **The e2e slot gets its own reset.** `runner-rework.spec.ts` frees the
  slot when it passes, but a failure there could leave a Round open, and
  the stopped Round stays open until M5.2.
- **Test fixtures**: `databaseSnapshot` includes `round_commands`, and
  `TestOpenRoundLock_EveryMutationRejectedWhileOpenAndAcceptedOnceClosed`
  runs every case again while Stopping.

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), pgx v5.11.0, golang-migrate v4.20.1,
  oapi-codegen v2.8.0, kin-openapi v0.149.0 (`apps/galley/go.mod`).
- PostgreSQL 17.11 (Homebrew), `psql` 17.11.
- Node v26.9.0.
- Swiftlet: React 19.3.0, Vite 8.3.0, Vitest 5.0.1, TypeScript 7.0.2,
  Tailwind CSS 4.3.3.
- Michelin: Vitest 5.0.1, TypeScript 5.9.3.
- Contracts: openapi-typescript 7.13.0.
- e2e: `@playwright/test` 1.63.0.

All confirmed against `go.mod` and each `package-lock.json`.

## Reproducible commands

```sh
cd apps/galley
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m51?sslmode=disable'
gofmt -l . && go vet ./... && go build ./...
go test ./... -count=1
go test -race -count=1 ./...
./scripts/check-contract-drift.sh      # with the regenerated files staged
cd ../../contracts && npm ci && npm run check:swiftlet-drift && npm run check:michelin-drift
cd ../apps/michelin && npm ci && npm run typecheck && npm test
cd ../swiftlet && npm ci && npx tsc -p tsconfig.json --noEmit && npm test && npm run build
cd ../../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m51?sslmode=disable' ./run.sh
```

Swiftlet has no separate typecheck or lint script (`npm run build` runs
`tsc --noEmit` first), and neither Michelin nor Swiftlet has a lint
script.

## Observed results

- `gofmt -l .` printed nothing. `go vet` and `go build` were clean.
- Galley `go test ./... -count=1`: every package `ok`. 329 top-level
  tests, 1142 with subtests (was 314). 0 failed, 0 skipped.
- `go test -race -count=1 ./...`: every package `ok`, no race report.
- Drift checks, with the generated files staged: all three printed
  `OK … (no drift)`.
- Michelin: typecheck clean; 10 files, 252 tests passed (was 235).
- Swiftlet: `tsc --noEmit` clean; 24 files, 448 tests passed (was 436).
  `npm run build` succeeded:
  - `index` 392.22 kB (118.24 kB gzipped);
  - `MarkdownRenderer` 116.65 kB (35.45 kB gzipped);
  - CSS 39.88 kB.
- Browser suite: `SUITE PASSED` twice. Each run: 38 specs exited 0, 88
  tests passed (was 37 and 87). `runner-stop-request.spec.ts` passed in
  2.1 s (first run) and 2.2 s (second run).

**New and changed Galley tests**

| Test | What it pins |
| --- | --- |
| `TestDecideStop_AnswersEachCase` | the decision table: open Round, Stop requested, no open Round, archived, every Status |
| `TestStop_RecordsOneStopForAClaimedAndARunningRound` | one `stop` row with the Round's epoch and Galley's clock; `stopRequestedAt` set; Status and Round state unchanged; a repeat is `200` with the same Ticket and no new row |
| `TestStop_ConcurrentRequestsRecordOneStop` | concurrent requests all `200`, one row |
| `TestStop_AStopCommittedBesideTheLockIsAnsweredAsAlreadyRequested` | a row committed by another transaction while the request waits is answered through the unique-violation path |
| `TestStop_WithoutAnOpenRoundIsStopNotAvailableAndAdvertisedSo` | Backlog, Ready, delivered, a stopped Round that then delivered, archived: `400 stop_not_available`, advertised the same, nothing written |
| `TestStop_UnknownMalformedAndForeignTicketsAreTheSameNotFoundAndUnauthenticatedIs401` | shared `404` and `401` |
| `TestStopping_TheTicketStaysLockedAndTheSlotTaken` | edit, Status, archive and unassign refused with `round_open`; claims `204` while another Ticket waits; a progress event still accepted; still In Progress, running and Stopping |
| `TestRoundCommands_ListsOnlyThatRoundsUnacknowledgedCommands` | the Stop listed on every poll until acknowledged; `[]` once the Round has delivered; Round 2 lists only its own Stop, at its own epoch, and `[]` after its ack |
| `TestRoundCommands_UnknownMalformedAndForeignRoundsAreTheSameNotFoundAndUnauthenticatedIs401` | shared `404` and `401` |
| `TestAck_RecordsOnceReplaysTheStoredValuesAndRefusesAnotherOutcome` | first ack stored; same outcome replays stored values; other outcome `409 command_already_acknowledged`, nothing changed; Round and Ticket unchanged |
| `TestAck_RefusesAnotherRoundsCommandAndAMalformedBody` | another Round's, an unknown and a malformed command id are `404`; empty, `{}`, unknown outcome, extra field, trailing data and an array are `400` naming the shape; nothing written |
| `TestAck_ConcurrentAcknowledgementsRecordOneOutcome` | eight concurrent acks with both outcomes: one stored, the matching ones `200` with identical bodies, the others `409` |
| `TestAck_TwoOutcomesQueuedBehindTheRowLockRecordOne` | two acks forced to queue behind a held row lock: one `200`, one `409` |
| `TestRoundCommands_AStaleEpochStopHasNoEffectOnTheNextRound` | Round 1's unacknowledged Stop is not Round 2's: Round 2 starts with Stop available and no commands; acking Round 1's Stop `ignored` after Round 1 ended changes no Ticket or Round; Round 2's own Stop carries its epoch |
| `TestStopAndRoundCommands_ResponsesMatchContractAndMethod405` | every new response validated against the contract; 405s |
| `TestTicketCommandAvailability_ResponseContractRejectsInvalidCombinations` | now covers `stop` too |
| `TestOpenRoundLock_EveryMutationRejectedWhileOpenAndAcceptedOnceClosed` | every case repeated "while Stopping" |
| manual lifecycle in `no_execution_side_effects_test.go` | Stop without a Round is refused and creates no record |

**New and changed Michelin tests** (235 → 252)

| Test file | What it pins |
| --- | --- |
| `commandLoop.test.ts` (10) | polls only while a Round is held; Stop during `hold` and during `wait` → `engine stopped` → one `applied` ack → claim polling resumes, no timer left; another epoch → one `ignored` ack, engine keeps holding; ack retried through `503`, `502` at 1 s and 2 s; a `409` ack not retried; unknown type warned once, never acked; failed poll logged, polling continues; no ack when the delivery in flight lands after the Stop; shutdown leaves no timer |
| `engine.test.ts` ("a Stop request") | ends a `wait` or `hold` at once and sends nothing further; an in-flight event finishes and its retries continue, then the engine halts; a delivery in flight returns `delivered`; shutdown still returns `aborted` |
| `config.test.ts` | default `1000`, a set value, bad values rejected |
| `main.test.ts` | the process polls the held Round's commands and logs no poll failure; `commandIntervalMs` in the start line |

**New and changed Swiftlet tests** (436 → 448)

| Test file | What it pins |
| --- | --- |
| `api/tickets.test.ts` (4) | `stopRequestedAt` and `stop` read; a missing or non-string `stopRequestedAt` and a missing `stop` rejected |
| `TicketDetail.test.tsx` ("Stop", 5) | button only when available and not disabled by the lock; click with no confirmation shows Stopping on the locked In Progress receipt; Stopping beside Claimed by runner; Galley's rejection verbatim; disabled while pending |
| `TicketDetailPage.test.tsx` (1) | `POST /api/tickets/{id}/stop` with no body, Stopping shown, refresh continues |
| `TicketBoard.test.tsx` (1) | the slip shows Stopping in its Status column, locked, after a refresh |
| `ui/tokens.test.ts` (1) | stopping tag contrast |

**Browser spec** (`tests/runner-stop-request.spec.ts`, Basic Ticket, all
data through Galley's API, a real Michelin with `start`, `hold`):

1. Before the claim, `stop` is unavailable with `stop_not_available`.
2. Once Michelin holds the running Round, `stop` is available and
   `stopRequestedAt` is null.
3. The receipt's Stop returns `200`. The receipt shows **Stopping…**,
   In Progress and the lock, and no Stop button.
4. Michelin's log shows `stop requested`, then `engine stopped` before
   exactly one `command acknowledged` with outcome `applied`, no
   acknowledgement failure, and no credential.
5. Galley's Ticket: In Progress, the same open Round with
   `stopRequestedAt` set, `stop` unavailable with
   `stop_already_requested`. A repeated Stop returns the same
   `stopRequestedAt`.
6. With the runner credential: the command list is empty; replaying the
   logged ack returns the logged `acknowledgedAt`; `ignored` is
   `409 command_already_acknowledged`; a claim is `204`. An edit is
   `400 round_open` naming the Round.
7. The board slip shows **Stopping…** in the In Progress column with the
   lock glyph.
8. Michelin exits 0 on `SIGTERM`; the Round is unchanged.

**Falsification.** Each change was applied, the named tests run, and the
file restored (checked with `cmp` or `md5`).

| Layer | Change | Result |
| --- | --- | --- |
| Galley | drop the `stop_already_requested` case from `decideStop` | `TestDecideStop_AnswersEachCase`, `TestStop_RecordsOneStopForAClaimedAndARunningRound`, `TestStop_AStopCommittedBesideTheLockIsAnsweredAsAlreadyRequested` |
| Galley | no unique-violation handling | `TestStop_AStopCommittedBesideTheLockIsAnsweredAsAlreadyRequested` |
| Galley | accept another outcome on replay | `TestAck_RecordsOnceReplaysTheStoredValuesAndRefusesAnotherOutcome`, `TestAck_ConcurrentAcknowledgementsRecordOneOutcome`, `TestStopAndRoundCommands_ResponsesMatchContractAndMethod405` |
| Galley | drop `FOR UPDATE` from the ack read | `TestAck_TwoOutcomesQueuedBehindTheRowLockRecordOne` (both `200`). `TestAck_ConcurrentAcknowledgementsRecordOneOutcome` passed 3 of 3 runs: it does not force the interleaving, which is why the queued test was added |
| Galley | list acknowledged commands too | `TestRoundCommands_ListsOnlyThatRoundsUnacknowledgedCommands` |
| Galley | list commands of an ended Round | `TestRoundCommands_ListsOnlyThatRoundsUnacknowledgedCommands` |
| Michelin | no epoch comparison | the another-epoch test |
| Michelin | unknown types handled as `stop` | the unknown-type test |
| Michelin | ack never retried | the 5xx retry test |
| Michelin | `onStop` does not abort the engine | 5 tests |
| Michelin | `applied` ack for any outcome | the delivered-after-Stop test |
| Swiftlet | Stop for any open Round | 3 failed |
| Swiftlet | Stop disabled by the lock | 5 failed |
| Swiftlet | Stopping for any open Round | 3 failed |
| Swiftlet | no slip tag | 1 failed |

## Implementation limitations and follow-ups

- **A stopped Round stays open.** Ending it (`stop_confirmed`), the
  Stopped outcome, the return to Backlog with the Stopped Badge, and the
  greyed active card are M5.2 and M5.4 of
  [#6](https://github.com/cristoforows/ticketIt/issues/6).
- **"Oldest `issued_at` first" is implemented but not exercised by a
  test.** The partial unique index allows one `stop` per Round and
  `stop` is the only type, so a Round cannot hold two commands yet. The
  first slice that adds a second command type should add the ordering
  test.
- **A Stop requested on a Round whose Michelin has gone away stays
  unacknowledged.** Nothing else reads it until recovery: M5 (#6, D5).
- **A Stop that loses the race with a delivery stays unacknowledged** on
  the delivered Round, which the list then omits. The Round is no longer
  open, so nothing acts on it.
- **Times on the receipt are raw RFC 3339**, as before.

## Outstanding checks and owning milestone

- `stop_confirmed`, the Stopped outcome, and Stop of a Round that is
  `waiting_for_input`: M5.2 and later M5 slices (#6). `parseTicket`
  still accepts only `claimed` and `running` open Rounds.
- Recovery of a Round whose runner never acknowledges: M5 (#6, D5).
- A real engine halting mid-model-call: M6.
- The milestone gate reconciles `docs/evidence/m5/README.md`,
  `docs/open-decisions.md` and the plan documents. This slice does not
  edit them.

## Decision impacts (open-decision IDs)

- **D5** (recovery authority): a Stop leaves the Round open and the
  slot taken until confirmed cessation; nothing closes or unlocks the
  Round because a Stop was requested or acknowledged. Not decided here.
- None of D1–D4 or D6–D9. D3's guardrail
  (`TestNoTemplateToCapabilityMapping`) is unchanged and passes.
