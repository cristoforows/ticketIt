# Reconcile on reconnect

## Purpose

M5.12, [#170](https://github.com/cristoforows/ticketIt/issues/170).

- A runner that registers, or is seen again after the 30 s health
  window, owes a Reconcile for the Owner's open Round. Until it answers,
  Galley refuses that Round's authority checks and Michelin takes no
  step.
- `POST /api/runner/reconcile` takes what the runner holds and what it
  believes about execution. Galley answers one disposition, `continue`,
  `stop`, `report_cessation` (naming `stop_confirmed` or `interrupted`)
  or `hold`, plus the Round's pending commands. It never changes the
  Round's state, the Ticket's Status, the slot or the lock: fail closed.
- Belief is never evidence. A runner that cannot confirm execution
  leaves the Round open and the Ticket locked, shown to the Owner as
  **Runner cannot confirm execution**.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/`, `CONTEXT.md` (Waiting Reason, Reconcile, Execution Unknown) and
the READMEs of the three apps and the browser suite.

## What already existed

- M5.1–M5.11 merged; this branch starts at `fe7e218` (M5.11).
- Runner health was `last_seen_at` under 30 s by Galley's clock
  (`runnerConnected`); `runner_disconnected` was already the top waiting
  reason. Register and heartbeat answered only a timestamp.
- `GET /api/runner/rounds/{roundId}/commands` listed unacknowledged
  commands Stop first, then `authority_changed`, then by `issued_at`.
- A restarted Michelin claimed nothing while the Owner's slot was held
  (`204`) and never learned of the Round.
- Counts before this slice: Galley 524 top-level tests, Michelin 394,
  Swiftlet 710, 48 browser spec files.

## What this slice added

**Contract.** `POST /api/runner/reconcile` with `ReconcileRequest`
(`held`: zero or one `HeldRound {roundId, claimEpoch, execution:
running | stopped | unknown}`), `ReconcileResult {round:
ReconciledRound | null}`, `ReconcileDisposition`, `CessationEvent`.
`reconcileRequired` (required boolean) on `RunnerRegistration` and
`RunnerHeartbeat`. Waiting reasons `reconciling` and
`execution_unknown`. The authority-check description lists its refusal
order. Regenerated `api.gen.go` and both `schema.d.ts`.

**Galley.**

- Migration `000027_reconcile_rounds.up.sql`: `rounds.reconcile_required`
  (default false), `reconcile_execution`, `reconciled_at`, with CHECKs
  that the execution is known, that `reconciled_at` is set exactly with
  it, and that `unknown` keeps the flag.
- `reconcile.go`: the pure `decideReconcile(belief, stopRequested)` and
  the handler. Ladder: bearer auth (`401`), shape (`400`), lookup (the
  shared `404`), epoch (`409 stale_claim_epoch`), open
  (`409 round_not_open`), decide.

  | Belief | Stop pending | Disposition | Flag | Recorded execution |
  |--------|--------------|-------------|------|--------------------|
  | `running` | no | `continue` | cleared | `running` |
  | `running` | yes | `stop` | cleared | `running` |
  | `stopped` | no | `report_cessation`, `interrupted` | unchanged | `stopped` |
  | `stopped` | yes | `report_cessation`, `stop_confirmed` | unchanged | `stopped` |
  | `unknown` | either | `hold` | set | `unknown` |

  "Stop pending" means a Stop command exists for the Round, acknowledged
  or not: an acknowledged Stop whose cessation Galley has not recorded
  still answers `stop`.
- Flag lifecycle: register sets it on the Owner's open Round; a
  heartbeat sets it when the previous `last_seen_at` was absent or at
  least `runnerHealthWindow` old (`heartbeatAfterAGap` =
  `!runnerConnected`, so exactly 30 s flags); only `continue` and `stop`
  clear it; `report_cessation` leaves it; `hold` sets it. Both responses
  carry `reconcileRequired`, read in the same transaction after the
  write.
- Activity notes, appended only when the recorded execution changes:
  *Reconciled with the runner: execution running*, *… the runner cannot
  confirm execution*, *… the runner reports execution stopped*.
- Authority checks (`round_authority.go`): epoch, open,
  `409 runner_disconnected`, `409 reconcile_required`, then
  `round_not_running`. The two new refusals are logged (`authority check
  refused`, `roundId`, `code`), not recorded as checks, and create no
  Permission request. Round events are not gated on either.
- Waiting reasons (`decideWaitingReason`), first match wins:

  | Predicate | Reason |
  |-----------|--------|
  | runner not connected | `runner_disconnected` |
  | flag set and recorded execution `unknown` | `execution_unknown` |
  | flag set | `reconciling` |
  | otherwise | the existing reasons |

**Lock order.** Reconcile takes the Owner's priority lock
(`lockOwnerPriority`), then the Ticket row (`lockTicketForMutation`),
then the Round row (`FOR UPDATE OF r`): the event ladder's order, so the
note's activity `seq` is serialised with every event's. Register and
heartbeat lock the runners row then update rounds; no transaction locks
a Round and then the runners row (the authority check only reads it), so
no cycle. Tested on real PostgreSQL by holding each lock in another
transaction and by 8 each of concurrent reconciles, progress events and
heartbeats.

**Commands-endpoint reading.** The issue's "commands" is the M5.1
endpoint `GET /api/runner/rounds/{roundId}/commands`. The Reconcile
answer reuses its listing (`pendingRoundCommands`, now taking the
transaction) and adds no endpoint; Michelin keeps polling that endpoint
as before.

**Michelin.**

- `Registration` gains `reconcileRequired` and a raise counter. A
  successful registration, any non-aborted heartbeat failure, or a
  heartbeat answering `true` raises it.
- `reconciler.ts`: one Reconcile at a time (concurrent callers share
  it). `continue`, `stop` and `{round: null}` clear the flag only if it
  was not raised again while the request was in flight. A timeout,
  an unreachable Galley, an invalid body or a `5xx` retries after
  `retryDelayMs` (1 s doubling, capped at 30 s); any `4xx` (`409`,
  `404` among them) or `hold` drops the Round.
- The claim loop reconciles holding nothing before each claim poll and
  skips the claim while the flag stays set.
- The engine gates every step, event and authority check on the
  Reconciler. `stop` halts the engine, which sends `stop_confirmed` and
  then acknowledges the Stop listed in the answer. `report_cessation`
  lets the one named event through, as the stop report's type. A
  `409 reconcile_required` check raises the flag and asks again after
  reconciling; `409 runner_disconnected` is asked again with the same
  retry. A watch reconciles an idle engine's Round on the claim
  interval. No new environment variable.

**Swiftlet.** The strict parser accepts both reasons; slip labels
*Reconciling with the runner* and *Runner cannot confirm execution*
(still rider). The receipt shows the `execution_unknown` notice in the
Runner disconnected style (`border-status-blocked-deep`,
`text-status-blocked-deep`, the token pair that notice already uses for
AA contrast) and a field note for `reconciling`; disconnected outranks
both.

**e2e.** `tests/runner-reconcile.spec.ts`, three tests, registered in
`run.sh` with an exit-code check, followed by a reset (the third leaves
a Round only M5.13 can end). `startMichelin` takes an optional command
interval; `runnerCalls` gains `reconcile`, and `register` returns its
body. `active-order-slip.spec.ts` test 2 re-registers mid-Round, so it
now sees *Reconciling with the runner* and reconciles directly before
Starting returns.

### Engineering choices beyond the Decisions

| Choice | Reason |
|--------|--------|
| Missing or empty `roundId` is `400`; a malformed one is the shared `404` | Shape first; a non-UUID is an unknown id, as on every other Round route |
| `held: []` reconciles the Owner's open Round as `unknown`, else `{round: null}` | A process holding nothing cannot vouch for anything; one open Round per Owner makes the target unique |
| UPDATE only when execution or flag changes | An identical repeat changes nothing, so retries are safe |
| Previous `last_seen_at` read in the heartbeat's own `UPDATE … FROM (… FOR UPDATE)` | Two concurrent heartbeats cannot both miss the gap |
| Connectivity read inside the check's transaction from the runners row | The refusal reflects Galley's clock at decision time |
| `runner_disconnected` before `reconcile_required` | A disconnected runner cannot have reconciled; the coarser fact first |
| Michelin raise counter | An in-flight `continue` must not clear a flag raised by a heartbeat meanwhile |
| Single-flight Reconcile | The engine, the watch and the claim loop never send overlapping Reconciles |
| Watch on the claim interval | An engine waiting on an answer takes no step, so nothing else would reconcile |
| A cessation answer for a running, non-stopping step abandons the Round locally | Michelin never reports `stopped` while running, so this answer is inconsistent: fail closed |
| A heartbeat failure raises the flag | The heartbeat may have failed because Galley saw a gap; reconciling once is cheap |

## Exact versions and toolchain

Go 1.27.1 (darwin/arm64), Node 26.9.0, npm 11.19.1, PostgreSQL 17.11
(local), Playwright and Vitest as locked in each `package-lock.json`;
no dependency changed.

## Reproducible commands

```
createdb ticketit_test_m512; createdb ticketit_e2e_m512
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m512?sslmode=disable'
cd apps/galley && gofmt -l . && go vet ./... && go build ./... && go test ./... -count=1 && go test -race -count=1 ./...
cd apps/michelin && npm ci && npm run typecheck && npx vitest run
cd apps/swiftlet && npm ci && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd apps/galley && ./scripts/check-contract-drift.sh
cd contracts && npm ci && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh
cd e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m512?sslmode=disable' ./run.sh
```

## Observed results

Final tree, generated files staged first, as the drift scripts require:

```
gofmt -l .            (no output)
go vet ./...          ok
go build ./...        ok
go test ./... -count=1
ok  .../apps/galley/cmd/galley           3.930s
ok  .../apps/galley/cmd/githubfake       1.320s
ok  .../apps/galley/internal/auth        1.458s
ok  .../apps/galley/internal/config      0.435s
ok  .../apps/galley/internal/githubfake  2.167s
ok  .../apps/galley/internal/httpapi     156.513s
ok  .../apps/galley/internal/postgres    3.151s
go test -race -count=1 ./...
ok  .../apps/galley/internal/httpapi     193.183s   (all other packages ok)
go test -list '.*' ./... | grep -c '^Test'   542
Michelin: tsc ok; Test Files 12 passed (12), Tests 440 passed (440)
Swiftlet: tsc ok; Test Files 27 passed (27), Tests 726 passed (726); build ok
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

Browser suite, `./run.sh`, run twice with no change between them other
than one added Galley test and docs. Both runs: 49 spec files, 49
exit codes 0, 105 tests passed, 0 failed, `SUITE PASSED`, exit 0. No
flake seen. `runner-reconcile.spec.ts`:

```
✓ 1 … a runner seen again after the health window reconciles its running Round, which continues to delivery with one Reconcile note (2.8s)
✓ 2 … a Stop queued while the runner was away reaches it in the Reconcile answer: the Round ends Stopped, not delivered (1.4s)
✓ 3 … a restarted runner cannot confirm the Round an earlier process held: it stays open, the Ticket stays locked, and the slip and receipt say so (3.1s)
3 passed (7.7s)
```

Each test moves the dev clock by a relative 31 s, so the 2 h left by
`runner-time-grant.spec.ts` does not matter (it runs earlier in the same
Galley). The Galley behaviours, each through the HTTP handler on real
PostgreSQL (`reconcile_test.go`):

- Decision and waiting-reason tables, every row.
- `400` for each bad shape, then the ladder in order (`404` unknown,
  malformed and foreign; `409 stale_claim_epoch`; `409 round_not_open`),
  each with an unchanged DB snapshot.
- For claimed, running, waiting on an answer and waiting on a Permission,
  each with and without Stop and each belief: state, Status, slot, lock
  and `claim_epoch` unchanged.
- Commands listed Stop first; an acknowledged unconfirmed Stop still
  answers `stop`; the named cessation event ends the Round through the
  event ladder.
- Held nothing: the open Round as `unknown`, else `{round: null}`.
- Flag lifecycle; heartbeat at window − 1 µs (no flag), exactly the
  window, + 1 µs and 24 h (flag); only the Owner's open Round.
- Notes only on a change of recorded execution.
- Authority refusals in order, recording nothing, logged; all 11 event
  types accepted while flagged, disconnected, both and neither.
- Lock order, and 8 each of concurrent reconciles, events and
  heartbeats: all succeed, activity `seq` gap-free, one note.
- `TestReconcile_ResponsesMatchContractAndMethod405`.

### Falsification

Each mutation applied alone by a script, the listed tests run, the file
restored from a copy. `git diff --stat` before and after the run is
identical.

| Mutation | Result |
|----------|--------|
| G1 `unknown` answers `continue` and clears | killed (decision table, snapshots, contract) |
| G2 `stopped` clears the flag | killed (table, flag lifecycle, waiting reasons, authority) |
| G3 an acknowledged Stop no longer counts | **survived** at first; `TestReconcile_AnAcknowledgedButUnconfirmedStopStillAnswersStop` added, then killed |
| G4 note on every Reconcile | killed (notes, concurrency) |
| G5 Reconcile bumps `claim_epoch` | killed (snapshots, contract) |
| G6 epoch not checked | killed (ladder, contract) |
| G7 heartbeat flags only past, not at, the window | killed (`…/30s` boundary row) |
| G8 register does not flag | killed (lifecycle, waiting reasons, authority, contract) |
| G9 authority refusals swapped | killed (authority order) |
| G10 authority not gated on the flag | killed |
| G11 `execution_unknown` never shown | killed (table, held-nothing, waiting reasons) |
| G12 Reconcile skips the priority lock | killed (lock-order test) |
| M1 an in-flight answer clears a newer raise | killed |
| M2 the gate never reconciles | killed (gate table) |
| M3 `hold` proceeds | killed |
| M4 registration raises nothing | killed (heartbeat loop, `main.test.ts`) |
| M5 claims while flagged | killed |
| S1 `execution_unknown` notice missing | killed (`TicketDetail.test.tsx`) |
| S2 parser refuses `reconciling` | killed (`tickets.test.ts`, `ActiveOrder.test.tsx`) |

Not mutated: the e2e spec; the Galley and Michelin behaviours it shows
are each killed above.

## Implementation limitations and follow-ups

- A `stopped` belief on a `claimed` or `waiting_for_input` Round with no
  Stop answers `report_cessation` naming `interrupted`, which the event
  ladder refuses (`409 event_out_of_order`; tested). The Round stays
  open. Michelin never reports `stopped` without a Stop, so it does not
  produce this case; a correct way to end such a Round is Owner-attested
  recovery, M5.13.
- A Round whose execution is unknown stays open with its Ticket locked
  until M5.13 recovery exists. The browser suite resets the database
  after its third test for this reason.
- A null previous `last_seen_at` cannot be reached through the API (the
  `runners_registration_complete` CHECK requires it once registered), so
  that row is tested through the pure `heartbeatAfterAGap`.
- Stranded-Round recovery, claim fencing, bounded retry and technical
  limits are M5.13 and M5.14: not touched.

## Outstanding checks and owning milestone

Recovery of Rounds that stay `execution_unknown`: M5.13. Gate-report
reconciliation of the evidence index: the M5 gate-report slice.

## Decision impacts (open-decision IDs)

None resolved. This slice implements the issue's settled Decisions.
