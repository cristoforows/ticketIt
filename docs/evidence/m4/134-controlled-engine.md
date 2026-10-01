# Controlled engine and Execution started, with replay-safe event ingestion

## Purpose

M4.8, [#134](https://github.com/cristoforows/ticketIt/issues/134): a
claimed Round starts. Michelin runs a scripted, controlled engine for
each Round it claims and reports `execution_started` to a new runner
event endpoint. Galley records each accepted event once, answers a replay
with the original result, rejects a stale claim epoch with no change, and
on the first event moves the Round to running, attaches the engine
reference and moves the Ticket Ready → In Progress in one transaction.
The endpoint is built once for M4.9 (#135) and M4.10 (#136) to reuse.
Swiftlet shows the Round and refreshes while it is open. Touches
`contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet` and `e2e/`.

## What already existed

- Runner pairing, bearer authentication, register, heartbeat and health
  derived from Galley's injectable clock (M4.4,
  [#130](https://github.com/cristoforows/ticketIt/issues/130)).
- `POST /api/runner/claims`, `rounds` in state `claimed` (epoch 1) and
  the one-open-Round-per-Owner index (M4.6,
  [#132](https://github.com/cristoforows/ticketIt/issues/132)). A claimed
  Round left the Ticket Ready and nothing executed; Michelin logged the
  claim and stopped polling for the rest of the process.
- The open-Round lock: `lockTicketForMutation`, `decideTicketMutation`,
  `lockMutableTicket`, and `round_open` on every Owner mutation (M4.7,
  [#133](https://github.com/cristoforows/ticketIt/issues/133)).
- `Ticket.openRound` and its subquery, `RoundState` `[claimed, running]`,
  `ClaimedTag`, the lock glyph, and the runner health pill and hook.
- Migrations up to `000013`. Baseline on clean `main`: Galley 7 packages
  pass (220 top-level tests, 876 with subtests at M4.7), Swiftlet 291
  tests, Michelin 68 tests, the browser suite 33 specs and 81 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`, regenerated into `api.gen.go` and
both `schema.d.ts`):

- `POST /api/runner/rounds/{roundId}/events` (`reportRoundEvent`,
  `runnerBearer`). `RoundEventRequest` is `{type, idempotencyKey,
  claimEpoch, occurredAt, data}`. `RoundEventType` is `[execution_started]`
  and grows by slice. `data` is `oneOf` the per-type data schemas
  (`ExecutionStartedData` now). The response is `RoundEventResult`
  (`roundId`, `type`, `state`, `startedAt`) with `201`, or `200` for a
  replay.
- `GET /api/tickets/{id}/rounds` (`listTicketRounds`) returning
  `TicketRoundList`; `TicketRound` is `TicketOpenRound` plus `endedAt`.
- `RoundState` stays `[claimed, running]`; only its description changed.

**Galley** (`internal/httpapi`)

- Migration `000014_create_round_events_and_engine_references.up.sql`:
  `rounds_owner_id_id_unique`, `round_events` (`UNIQUE (round_id,
  idempotency_key)`, `round_events_type_m4` allows `execution_started`
  only) and `round_engine_references` (partial unique index
  `round_engine_references_one_current_per_round`). Both carry `owner_id`
  and a composite foreign key to `rounds (owner_id, id)`, the pattern
  `rounds` uses toward `tickets` and `agents`.
- `round_events.go`: `ReportRoundEvent`, `validateRoundEvent`,
  `recordRoundEvent`, `decideRoundEvent`, `attachEngineReference`.
- `round_event_hash.go`: `roundEventPayloadHash` and the canonical JSON
  encoding it hashes.
- `ticket_rounds.go`: `ListTicketRounds`.
- `handler.go`: manual 405s for both paths. `status.go`: the server
  keeps the logger `newHandler` already receives, for the one invariant
  log.
- Guardrail: `round_events` and `round_engine_references` join
  `knownPublicTables`, and the manual-action table asserts that no manual
  action creates a row in either. `TestNoTemplateToCapabilityMapping` is
  untouched and passes.

**Michelin**

- `engineScript.ts`: the script format, its parser and the interim
  default. `engine.ts`: the controlled engine and the retry schedule.
  `claimLoop.ts`: claim → run the Round's script → resume polling.
  `config.ts`: `MICHELIN_ENGINE_SCRIPT`. `galley/runner.ts`:
  `reportRoundEvent`.

**Swiftlet**

- `RoundsSection`, `useOpenRoundRefresh`, polling in the receipt, board
  and list, `useRunnerHealth(…, enabled)`, and a stricter `openRound`
  parse.

**e2e**

- `tests/runner-engine.spec.ts` (new); `tests/runner-claims.spec.ts`
  drives its claim directly; `run.sh` resets the database between them;
  `support/` gains `signInWithoutBrowser`, `pairRunnerViaApi`,
  `runnerCalls`, `listRounds`, an `Api` type so the Ticket helpers accept
  a page or an API context, and `startMichelin` takes an engine script.

### The decision ladder

Steps 1-3 run before any lock. Steps 4-9 run in one transaction.

| # | Check | Outcome |
| --- | --- | --- |
| 1 | `requireRunner`: bearer only. A session cookie is refused even beside a valid bearer | `401` |
| 2 | `{roundId}` through `canonicalPublicID` | shared `404` |
| 3 | Body through `decodeStrictJSON`, then the field rules below | `400 invalid_request` |
| 4 | Plain read of the Round's Ticket, scoped to the runner's Owner. Then the Owner's priority lock, `lockTicketForMutation` on the Ticket, and the Round row `FOR UPDATE` | unknown, foreign or a Ticket's id: shared `404` |
| 5 | Lookup on `(round, idempotencyKey)` | equal payload hash: `200`, stored result; different: `409 idempotency_key_conflict` |
| 6 | `claimEpoch` equals the Round's | else `409 stale_claim_epoch` |
| 7 | Round state is open | else `409 round_not_open` |
| 8 | The type suits the state | else `409 event_out_of_order` |
| 9 | Apply, commit | `201` |

Field rules (step 3). `type` is a known value. `idempotencyKey` is 1 to
200 characters without control characters and is never trimmed.
`claimEpoch` is an integer from 1 to 2147483647. `occurredAt` is RFC
3339. For `execution_started`, `data` is an object with exactly
`engineReference` (1 to 200 characters, no control characters), matched
case-exactly; any other key, a non-object, `null`, or a non-string is
`400`.

Applying `execution_started` (step 9), in the one transaction:

1. The Round becomes `running`; `started_at` is
   `GREATEST(Galley's clock, claimed_at)`.
2. Any current reference of the Round becomes `is_current = false`; the
   new one is inserted current.
3. The Ticket becomes `In Progress`, `updated_at = now()`, with `AND
   status = 'Ready'`. Zero rows means an invariant broke: roll back, log
   `round event refused: the Ticket of a claimed Round is not Ready` with
   the Round id, answer `500 internal_error`, record nothing.
4. The `round_events` row stores the type, epoch, the runner's
   `occurred_at`, Galley's `received_at`, the payload hash and the result.

### Engineering choices inside the Decisions

- **Why the lookup (5) precedes the epoch (6) and open (7) checks.** A
  legitimate retry of an applied event must get the same answer after the
  Round has moved on: another epoch, or ended. Michelin retries after
  timeouts whose response Galley may have sent. `TestRoundEvent_DecisionLadderOrder`
  and the mutations below pin the order both ways.
- **`event_out_of_order` is an addition to the issue's list.** The issue
  names `idempotency_key_conflict`, `stale_claim_epoch` and
  `round_not_open`. A valid type at the wrong moment, here a second
  `execution_started` with a new key on a running Round, is none of
  those. The code is the general "valid type, wrong moment" rejection
  that M4.9 and M4.10 reuse; its message names the type and the state.
- **`started_at` is Galley's clock, not the event's `occurredAt`.**
  Michelin's clock can precede `claimed_at`, and `rounds_timestamps_ordered`
  would turn that skew into a `500` that every retry repeats. The
  runner's instant is kept in `round_events.occurred_at`. The same CHECK
  can fail if Galley's own wall clock steps back between claim and
  event, so the value is clamped with `GREATEST(…, claimed_at)`
  (`TestRoundEvent_StartedAtNeverPrecedesClaimedAt`).
- **An event from a runner that is not Connected is accepted, and does not
  touch `last_seen_at`.** Events are facts. Refusing a late one would
  strand a claimed Round whose `201` the runner never saw, and acceptance
  changes nothing about health: only register and heartbeat are
  heartbeats, as for claims
  (`TestRoundEvent_IsAcceptedFromARunnerThatIsNotConnectedAndIsNotAHeartbeat`).
- **This path does not use `lockMutableTicket` or `decideTicketMutation`.**
  They reject because of the Round's own lock (M4.7). The runner's event
  is the one writer allowed to change a Ticket under its own open Round,
  and only that Round's Ticket, which it reaches through the Round row.
  It takes `lockTicketForMutation` only for the row lock.
- **Lock order: the Owner's priority lock, the Ticket row, the Round
  row.** Every other Ticket-mutating path takes the priority lock before
  any Ticket row, and claim takes the Ticket rows before inserting the
  Round. Keeping that order means the event cannot close a cycle with
  claim, reorder or a transition. Field edits, assignment, Badges and
  archive take only the Ticket row and then wait for nothing else. The
  priority lock is not needed for correctness here: the Ticket and Round
  row locks already serialise events for one Round (mutation 12 found no
  failing test until `TestRoundEvent_TakesTheOwnersPriorityLockThenTheTicketRowThenTheRoundRow`
  pinned the order by holding each lock and probing which the event
  already holds).
- **The payload hash.** SHA-256 of the canonical JSON of `{claimEpoch,
  data, occurredAt, type}`. Canonical JSON: object keys sorted bytewise
  at every depth; array order kept; numbers kept as the text they were
  written with (`json.Number`), so nothing passes through a float;
  strings re-encoded, so `\u00e9` and `é` agree; no insignificant
  whitespace. `occurredAt` is the instant in UTC as RFC 3339 with
  nanoseconds and trailing zeros trimmed, so `+08:00` and `Z` spellings
  of one instant hash alike. The key and the Round id are not hashed. A
  different reference, epoch or instant is a different payload. Unit
  tests cover key order, whitespace, offsets, number text (2^53 and
  2^53+1), every single-field difference, and a golden digest computed
  outside the implementation with `shasum`.
- **A replay re-encodes the stored result.** PostgreSQL's JSONB does not
  keep key order or spacing, so returning its text would differ from the
  first answer. The result is scanned back into `RoundEventResult` and
  written by the same encoder, which gives the first answer's bytes
  (`TestRoundEvent_ReplayReturnsTheOriginalResultAndChangesNothing`).
  `TestRoundEvent_ReplayIsAnsweredFromTheStoredResult` edits the stored
  JSONB and sees the edit returned, so the replay is not recomputed from
  the Round.
- **The body is validated before the Round is looked up.** An invalid body
  for a Round that does not exist is `400`, not `404`, so validation
  cannot be used to probe for Round ids. A malformed `{roundId}` is `404`
  before the body is read.
- **The 404 says "no round with that identifier".** Every resource keeps
  its own `not_found` wording (`writeTicketNotFound`,
  `writeAgentNotFound`). Unknown, foreign, malformed and a Ticket's id
  used as a Round id return the identical body.
- **`TicketRound` beside `TicketOpenRound`.** The list needs `endedAt`,
  and `TicketOpenRound` is embedded in every Ticket response, so it is
  left alone.
- **The 405 path.** `GET` on the events path and anything but `GET` on the
  rounds path return the shared 405 with `Allow`.
- **The interim default script is `start`, `hold`.** The issue's full
  default (start, three progress notes a second apart, one usage
  observation, deliver) needs `progress`, `usage` and `deliver`, which
  M4.9 and M4.10 add. With the variable unset a Round starts and then
  holds, which is also what the browser suite needs. The parser rejects
  `progress`, `usage` and `deliver` with the slice that adds each
  (M4.9 #135, M4.10 #136), so a script never silently does nothing. It
  also rejects unknown steps and unknown keys.
- **What Michelin retries, and what it abandons.** Retried, with the
  identical request (same key, body, `occurredAt`, reference) at 1, 2, 4,
  8, 16, then 30 s repeating: no response, a timeout, any `5xx`, and a
  `200` or `201` whose body is not the expected result (the event may
  have been applied and only the answer lost; a replay is harmless).
  Final: every other status, including `400`, `401`, `404` and `409`, and
  any unexpected success such as `204`. A final answer logs `round event
  refused; round abandoned locally` with Galley's error code, stops that
  Round's script, sends nothing further and does not exit. Nothing is
  closed, failed or unlocked by a failed check (the #5 follow-up on
  lost contact, unknown execution and stale reports). A Michelin that
  restarts does not resume a Round; that is reconciliation (M5 #6).
- **Michelin injects its clock, sleep and reference generator**
  (`EngineDeps`, `ClaimLoopOptions.engineDeps`), so the schedule is tested
  as numbers rather than with real waits, and a thrown error in the
  engine is caught in the claim loop (`engine failed unexpectedly`) so it
  cannot end the process.
- **Swiftlet decides nothing.** The Rounds section reads `openRound`. The
  **Runner disconnected** notice shows when Galley's health is loaded and
  not Connected, including `not_paired`; while the health is loading or
  failed to load nothing is known, so nothing is claimed. The health
  request is the header's `useRunnerHealth`, enabled only while a Round is
  open, so it adds no fetch mechanism and no request for a Ticket with no
  Round.
- **One refresh hook for three screens.** `useOpenRoundRefresh` ticks every
  3 s while active and skips a tick while the previous call is pending.
  Each screen's refresh keeps the previous data, replaces state only when
  the fetched data differs (so a focused control or an action message is
  not reset by an unchanged poll), and shows the message of a failed
  refresh beside the data until the next good one. The board and list skip
  a tick while a move or reorder is pending and discard a poll that a
  newer request overtook.
- **The parser is stricter.** A `running` Round must carry `startedAt`, a
  `claimed` one must not.
- **The two browser specs cannot share a database.** A Round cannot end
  before M4.10, and an Owner has one open Round at a time, so
  `runner-claims.spec.ts` (claimed, left open) and `runner-engine.spec.ts`
  (running, held) cannot both claim. `run.sh` resets and migrates the
  database and restarts Galley between them, as it does at the start of
  the run; the specs still create all data through Galley's API. The
  alternative, direct SQL from a spec, breaks the suite's rule.
- **`runner-claims.spec.ts` keeps every assertion.** Michelin now starts
  the Round within milliseconds, so the claim is made with a raw
  `POST /api/runner/claims` from a context with no Owner cookie, after a
  raw register. The claimed-state assertions (Ready, `requestingAgentWork`
  false, `updatedAt` unchanged, the claimed `openRound`, the slip and
  receipt tag, the lock, the nine refusals, the disabled controls, the
  Ticket unchanged, the health window passing with the Round unchanged)
  are unchanged. Added there: the Rounds section's claimed state and the
  overlay once the runner is Disconnected. The real-Michelin assertions
  moved to `runner-engine.spec.ts`: Michelin's log names the Round, the
  process stops with exit code 0, and its output never contains the
  credential.

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), pgx v5.11.0, golang-migrate v4.20.1,
  oapi-codegen v2.8.0, kin-openapi v0.149.0 (`apps/galley/go.mod`).
- PostgreSQL 18.1 (local Docker server, trust auth).
- Node v26.9.0. openapi-typescript 7.13.0. Swiftlet: Vitest 5.0.1,
  TypeScript 7.0.2. Michelin: Vitest 5.0.1, TypeScript 5.9.3. e2e:
  `@playwright/test` 1.63.0.

## Reproducible commands

```sh
cd apps/galley
gofmt -l . && go vet ./... && go build ./...
go test ./... -count=1
go test -race ./internal/httpapi -run 'TestRoundEvent_|TestRoundEvents_|TestEngineReferences|TestListTicketRounds|TestCanonicalJSON|TestRoundEventPayloadHash|TestDecideRoundEvent|TestClaim_ConcurrentClaims' -count=1
./scripts/check-contract-drift.sh
cd ../../contracts && npm ci && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh
cd ../apps/swiftlet && npm ci && npm test && npm run build
cd ../michelin && npm ci --registry=https://registry.npmjs.org/ && npm run typecheck && npm test
cd ../../e2e && env -u FORCE_COLOR ./run.sh
```

The manual run used a scratch database `ticketit_scratch_m48`, migrated
with `go run ./cmd/migrate` and dropped afterwards. Galley ran on port
18481 from a `go build` binary with `cmd/githubfake` for sign-in through
`curl -L` and a cookie jar. A real Michelin
(`node apps/michelin/src/main.ts`) ran with
`MICHELIN_ENGINE_SCRIPT` naming a file that holds the script shown under
"Manual run: a real Michelin". Tokens are redacted.

## Observed results

**Checks.**

- `gofmt -l .` printed nothing. `go vet ./...` and `go build ./...` were
  clean.
- Galley `go test ./... -count=1`: 7 packages `ok`; 261 top-level tests,
  940 with subtests, 0 failed, 0 skipped. `go test -race` on the new and
  concurrency tests: `ok`, no race report.
- Drift checks, after the regenerated files were staged:
  - `OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).`
  - `OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`
  - `OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`
- Swiftlet: 20 files, 339 tests passed (was 291); `npm run build`
  succeeded.
- Michelin: typecheck clean; 9 files, 155 tests passed (was 68).
- Browser suite: `SUITE PASSED`, 34 specs with exit code 0, 82 tests
  passed (was 33 and 81). `runner-claims.spec.ts` passed in 0.9 s;
  `runner-engine.spec.ts` in 14.1 s.

The new Galley tests (`internal/httpapi`):

| Test | What it pins |
| --- | --- |
| `TestRoundEvent_ExecutionStartedStartsTheRoundAndMovesTheTicketToInProgress` | the `201` body byte for byte; Ticket In Progress; `openRound` running; `started_at` and `received_at` equal the injected clock; one current reference; one `round_events` row with the hash and the stored result |
| `…StartedAtNeverPrecedesClaimedAt`, `…TheRunnersOwnClockNeverTimesTheRound` | the clamp; a far-past and far-future `occurredAt` |
| `…ReplayReturnsTheOriginalResultAndChangesNothing` | `200` with identical bytes for the same bytes, another zone, another layout; full-table snapshots unchanged; still `200` after the Round was ended by SQL |
| `…ReplayIsAnsweredFromTheStoredResult`, `…AKeyBelongsToOneRound` | the stored result is what is returned; a key is per Round |
| `…SameKeyWithADifferentPayloadConflicts` | different reference, epoch, `occurredAt`: `409`, snapshot unchanged |
| `…StaleClaimEpochIsRejectedWithNoStateChange` | epoch 1 and 3 against 2: `409`, no row, snapshot unchanged; epoch 2 accepted |
| `…UnknownForeignAndMalformedRoundsAreTheSameNotFound` | six forms, one body; snapshot unchanged |
| `…EndedAndRunningRoundsRejectNewEventsWithNoStateChange`, `…DecisionLadderOrder`, `TestDecideRoundEvent` | `round_not_open`, `event_out_of_order`, and the order of 1-8 |
| `…RunnerAuthentication`, `…IsAcceptedFromARunnerThatIsNotConnectedAndIsNotAHeartbeat` | eight ways to be refused, a revoked token, no change; a disconnected runner accepted and `last_seen_at` untouched |
| `…StrictDecodeRejectsMalformedRequestsWithNoStateChange`, `…TheKeyIsStoredVerbatim` | 49 malformed forms, snapshot unchanged; a 200-character key accepted; keys with spaces stored verbatim |
| `…ConcurrentIdenticalEventsApplyExactlyOnce`, `…ConcurrentEventsWithDifferentKeysStartTheRoundOnce`, `…RacingTheOwnersCommandsNeitherDeadlocksNorLeavesInconsistentState` | 24 concurrent senders, 3 trials each: one `201` and 23 `200`, or one `201` and 23 `event_out_of_order`; a start racing archive, status change, edit, reorder and a second claim, 6 trials, each finished within 20 s |
| `…TakesTheOwnersPriorityLockThenTheTicketRowThenTheRoundRow` | the lock order, by holding each lock and probing which one the waiting event holds |
| `…OnlyAnExecutionStartedEventMovesAnAgentTicketToInProgress` | a direct move to In Progress is `agent_owned_transition` with no Round and `round_open` with one; Owner routes create no events or references |
| `TestEngineReferences_AtMostOneIsCurrentAndThePriorIsRetained` | the index rejects a second current row; `attachEngineReference` retires and keeps the first |
| `…AFailureAfterTheTicketGuardRollsEverythingBack`, `…ABrokenTicketInvariantRecordsNothingAndAnswers500` | a trigger that fails the last insert rolls back the Round, reference and Ticket; a Ticket not Ready gives `500`, nothing recorded, the Round still claimed, the log line carries the Round id |
| `TestListTicketRounds_*` | fields and states as the Round moves; newest first across three Rounds; `{"rounds":[]}`; archived Ticket; foreign, unknown and malformed Ticket give one `404`; `401` for no session and for a runner token; `405` with `Allow: GET` |
| `TestRoundEvents_ResponsesMatchContractAndMethod405` | every `201`, `200`, `400`, `401`, `404`, `409` and the rounds list validate against `openapi.yaml`; `Allow` on both paths |
| `TestCanonicalJSON_*`, `TestRoundEventPayloadHash_*` | the canonical encoding and the hash |

The ended Rounds in `TestListTicketRounds_NewestFirst` are made with SQL
(`deliverRoundDirect`, as in earlier slices) and have state `delivered`,
which `RoundState` on the wire does not yet list, so that response is
decoded rather than validated against the schema. See the limitations.

**Manual run: Galley and curl.**

```text
$ POST /api/runner/claims
{'roundId': '734a58b9-9281-44c5-999a-d61adfb52fcf', 'sequence': 1, 'claimEpoch': 1}
$ POST events (first)
201 {"roundId":"734a58b9-…","startedAt":"2026-10-01T08:18:56.442579Z","state":"running","type":"execution_started"}
$ POST events (replay, same key and payload)
200 {"roundId":"734a58b9-…","startedAt":"2026-10-01T08:18:56.442579Z","state":"running","type":"execution_started"}
$ POST events (same key, different reference)
409 {"error":{"code":"idempotency_key_conflict","message":"this idempotency key was already recorded with a different payload"}}
$ POST events (new key, epoch 2)
409 {"error":{"code":"stale_claim_epoch","message":"claimEpoch is not this Round's current claim epoch"}}
$ POST events (new key, epoch 1, Round already running)
409 {"error":{"code":"event_out_of_order","message":"execution_started cannot be reported while the Round is running"}}
$ POST events (a Round never admitted)
{"error":{"code":"not_found","message":"no round with that identifier"}} 404
$ POST events (no credential)            {"error":{"code":"unauthenticated","message":"sign-in required"}} 401
$ POST events (session cookie)           {"error":{"code":"unauthenticated","message":"sign-in required"}} 401
$ POST events (unknown field)
{"error":{"code":"invalid_request","message":"unknown request property \"extra\" -- request body must be JSON matching {…}"}} 400
$ GET /api/tickets/{id}
{'status': 'InProgress', 'requestingAgentWork': False, 'openRound': {…, 'sequence': 1, 'startedAt': '2026-10-01T08:18:56.442579Z', 'state': 'running'}}
$ POST /api/tickets/{id}/status {InProgress} (direct)
{"error":{"code":"round_open","message":"this Ticket has an open Round; it can be changed once the Round ends","roundId":"734a58b9-…"}} 400
$ psql
 idempotency_key | 734a58b9-…:0        type | execution_started   claim_epoch | 1
 occurred_at | 2026-10-01 04:00:00.123+00     received_at | 2026-10-01 08:18:56.442579+00
 payload_hash | 37d0db74cad18b4e5929036155f2f072014554082d066b7826bab63339603445
 reference | controlled:manual-1   is_current | t   attached_at | 2026-10-01 08:18:56.442579+00
 state | running   claimed_at | 08:18:56.303002   started_at | 08:18:56.442579
```

`occurred_at` (the runner's instant, 04:00:00.123) and `started_at` (Galley's
clock, 08:18:56.44) are different values, as designed.

**Manual run: a real Michelin** with `{"steps":[{"step":"start"},{"step":"wait","ms":1500},{"step":"hold"}]}`:

```text
{"level":"info","msg":"michelin starting","engineSteps":["start","wait","hold"],"claimIntervalMs":500,…}
{"level":"info","msg":"runner registered",…}
{"level":"info","msg":"round claimed","roundId":"40d1d9aa-…","sequence":1,"claimEpoch":1,"ticketTitle":"Summarise the M4 findings"}
{"level":"info","msg":"execution started reported","roundId":"40d1d9aa-…","step":"start","stepIndex":0,"attempt":1,"engineReference":"controlled:bafabeec-798d-4c70-92c2-82bdcaf16269","httpStatus":201,"replayed":false}
{"level":"info","msg":"engine holding","roundId":"40d1d9aa-…"}
$ GET /api/tickets/{id}   status InProgress, openRound.state running, startedAt 2026-10-01T08:18:58.342811Z
galley access log, requests to /api/runner/claims: 1
michelin exit: 0  (SIGTERM)
after michelin stopped: status=InProgress round=running
```

Michelin polled claims once and never again while the Round held. The
Round and the Ticket stayed as they were after Michelin stopped.

**Falsification.** Each change was applied, the named tests were run, and
the change was reverted; the file was checked identical to its backup.

| # | Change | Result |
| --- | --- | --- |
| 1 | Skip the idempotency lookup | 7 failed: `…ReplayReturnsTheOriginalResult…`, `…ReplayIsAnsweredFromTheStoredResult`, `…SameKeyWithADifferentPayloadConflicts`, `…ConcurrentIdenticalEventsApplyExactlyOnce`, `…DecisionLadderOrder`, `…IsAcceptedFromARunnerThatIsNotConnected…`, `TestRoundEvents_ResponsesMatchContractAndMethod405` |
| 2 | Skip the epoch check | 3 failed: `…StaleClaimEpochIsRejectedWithNoStateChange`, `…DecisionLadderOrder`, `TestDecideRoundEvent` |
| 3 | Drop the Ticket update from the transaction | 6 failed: `…ExecutionStartedStartsTheRound…`, `…OnlyAnExecutionStartedEventMoves…`, `…ReplayReturnsTheOriginalResult…`, `…ConcurrentIdenticalEventsApplyExactlyOnce`, `…RacingTheOwnersCommands…`, `…ABrokenTicketInvariant…`. In the browser suite `runner-engine.spec.ts` failed at `expect(started.status).toBe("InProgress")` and the run printed `SUITE FAILED` |
| 4a | Do not retire the prior current reference | `TestEngineReferences_AtMostOneIsCurrentAndThePriorIsRetained`: unique violation on the second attach |
| 4b | Drop the partial unique index | `TestEngineReferences_AtMostOneIsCurrentAndThePriorIsRetained`: "a second current reference: err = <nil>" |
| 5 | `lockMutableTicket` in place of the raw lock | 25 failed: every test that expects a `201` (the Round's own lock rejects the runner), plus the list and contract tests |
| 6 | Michelin regenerates `occurredAt` and the reference on retry | 9 failed in `engine.test.ts`: the retry tests for an unreachable Galley, a `503`, a `500` and a `502` without a JSON body, an unreadable `201`, a `201` for another Round, a `200` without a state, the 1-2-4-8-16-30-30 schedule, and "generated once" |
| 7 | The claim loop keeps polling while a Round runs | 5 failed: `claimLoop.test.ts` (holds without polling, finite script, retrying without polling, heartbeat beside a hold) and `main.test.ts` |
| 8 | `started_at` from the event's `occurredAt` | 3 failed: `…ExecutionStartedStartsTheRound…`, `…TheRunnersOwnClockNeverTimesTheRound`, `TestListTicketRounds_ReportsTheOpenRoundAsItMoves` |
| 9 | No clamp to `claimed_at` | `…StartedAtNeverPrecedesClaimedAt` |
| 10 | Epoch check before the idempotency lookup | 2 failed: `…DecisionLadderOrder`, `…SameKeyWithADifferentPayloadConflicts` |
| 11 | Replay answered from a recomputed value | 4 failed: both replay tests, the concurrency test and the ladder test |
| 12 | No priority lock | All passed at first: the row locks already serialise one Round's events. `…TakesTheOwnersPriorityLockThenTheTicketRowThenTheRoundRow` was added, and fails without the lock |
| 13 | Swiftlet: refresh ticks overlap | 4 failed: the hook, the receipt, the list and the board "never overlaps" tests |
| 14 | Swiftlet: the refresh runs while inactive | 8 failed: the hook, receipt, list and board stop and "no open Round" tests |
| 15 | Swiftlet: overlay unless Connected | 4 failed: no overlay while loading, failed, or unsupplied |
| 16 | Swiftlet: `parseOpenRound` ignores `startedAt` | 2 failed: a running Round without a start, a claimed Round with one |
| 17 | Swiftlet: the board polls whenever loaded | 2 failed: no refetch without an open Round, stops when it closes |

## Implementation limitations and follow-ups

- **A Round is not resumed after a Michelin restart, and a lost answer can
  strand one.** If Michelin dies after a claim, the Round stays `claimed`;
  after `execution_started`, it stays `running`, locked, with **Runner
  disconnected**. A restarted Michelin cannot claim while the slot is
  taken. Recovery, reconciliation and Interrupted belong to M5
  ([#6](https://github.com/cristoforows/ticketIt/issues/6), D5).
- **A Round never ends in M4.** `delivered` is M4.10
  ([#136](https://github.com/cristoforows/ticketIt/issues/136)); Stop,
  Failed, Interrupted, questions and Permissions are M5. This is why the
  browser suite needs a reset between its two Round-holding specs, and why
  the Galley tests end Rounds with SQL.
- **Only `execution_started` is accepted.** `progress` and
  `usage_observed` are M4.9
  ([#135](https://github.com/cristoforows/ticketIt/issues/135)); the
  built-in default script is the interim `start`, `hold` until then.
- **`RoundState` on the wire is `[claimed, running]`.** `GET
  /api/tickets/{id}/rounds` returns the stored state, so an ended Round
  (`delivered`, which only SQL makes before M4.10) is outside the schema's
  enum. M4.10 widens the enum.
- **Swiftlet does not call `GET /api/tickets/{id}/rounds` yet.** The
  receipt's Rounds section reads `openRound`. M4.9
  ([#135](https://github.com/cristoforows/ticketIt/issues/135)) adds the
  fetcher with its first consumer; the list of ended Rounds and the
  active card are M4.11 and M5.
- **Events are scoped to the Owner, not to a runner identity.** A new
  credential issued by pairing can report on the Owner's open Round, and
  the old one cannot. Fencing by runner identity beyond the claim epoch is
  not in M4; reconciliation (M5) establishes which runner holds a Round.
- **The receipt's Runner disconnected notice follows the 10 s health
  poll,** so it can lag the header by less than one poll after the
  receipt loads, and by up to 10 s after the runner is lost.
- **Michelin sends no event for `wait`,** which is local to the script, and
  retries a report forever while Galley stays down; a supervisor restart
  abandons it (see the first bullet).

## Outstanding checks and owning milestone

- Reconciling a running Round with a restarted or missing Michelin:
  M5 (#6).
- Progress, usage and delivery through the same endpoint, and the full
  default script: M4.9 (#135) and M4.10 (#136).
- The active card, delivery animation and View/Stop controls: M5 (#6).
- Round history in the receipt: M4.11 and M5.
- The milestone gate reconciles `docs/evidence/m4/README.md`,
  `docs/open-decisions.md` and the plan documents; this slice does not
  edit them.

## Decision impacts (open-decision IDs)

- **D5** (stranded-runner recovery): a Round now outlives its runner in
  both `claimed` and `running`. The ladder keeps a stale or unknown report
  from changing anything and closes nothing because a check failed; it
  does not decide how a stranded Round is recovered.
- None of D1, D2, D4 or D6-D9.
