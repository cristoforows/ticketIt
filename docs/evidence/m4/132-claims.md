# Atomic work claims, durable Rounds, and the sequential slot

## Purpose

M4.6, [#132](https://github.com/cristoforows/ticketIt/issues/132): a
connected Michelin claims the Owner's highest-priority Ticket that is
requesting Agent work. The claim creates a durable, Galley-issued Round
in one transaction, and the database allows one open Round per Owner
(the sequential slot). The Ticket stays in its Status. Archive is
refused while a Round is open. Nothing executes yet. Touches
`contracts/`, `apps/galley`, `apps/swiftlet`, `apps/michelin` and
`e2e/`.

## What already existed

- `decideAgentWorkRequest` (M4.2,
  [#128](https://github.com/cristoforows/ticketIt/issues/128)): the one
  definition of a Ticket requesting Agent work. It is unarchived, Ready,
  assigned to an Agent, and has every input that Agent's readiness
  requires. It is published as `requestingAgentWork`.
- Runner pairing, bearer authentication, register, heartbeat and health
  derived from Galley's injectable clock (M4.4,
  [#130](https://github.com/cristoforows/ticketIt/issues/130)).
  Michelin registered, then heartbeated, and never claimed.
- Owner priority order (M4.5,
  [#131](https://github.com/cristoforows/ticketIt/issues/131)):
  `tickets.priority_rank`. Capture, reorder and transitions take
  `pg_advisory_xact_lock(0x7072696f, int32(owner))` before any row lock.
- `lockTicketForMutation` (#93): the row-locked decision point for
  every Ticket mutation.
- The guardrails in `no_execution_side_effects_test.go`, which had no
  `rounds` table to list, and `TestNoTemplateToCapabilityMapping`.
- Migrations up to `000012`.

## What this slice added

**Contract** (`contracts/openapi.yaml`). It is regenerated into
`api.gen.go` and both `schema.d.ts` files.

- `POST /api/runner/claims` (`claimWork`, `runnerBearer`, no request
  body). It returns `201 RunnerClaim`, `204` with no body, or the
  shared error.
- `RunnerClaim` contains `roundId`, `sequence`, `claimEpoch`, the
  `ticket` and the `agent`. `ticket` is a `ClaimedTicket`: id, title,
  goal, context, Success Criteria, constraints and repository.
  `claimEpoch` is described as the fencing token that events must carry
  with `roundId`.
- `Ticket.openRound` is required: either `null` or a `TicketOpenRound`
  with `id`, `sequence`, `state`, `agent`, `claimedAt` and `startedAt`.
  `RoundState` on the wire is `[claimed, running]`.
- The `requestingAgentWork` description now says "and no open Round".
  The `archiveTicket` description names `round_open`.

**Galley**

- Migration `000013_create_rounds.up.sql`:
  - **Columns:** `id`, `owner_id`, `public_id` (UUID, unique),
    `ticket_id`, `agent_id`, `sequence`, `state`, `claim_epoch`,
    `claimed_at`, `started_at` and `ended_at`.
  - **Foreign keys:** both are owner-scoped composite keys,
    `(owner_id, ticket_id)` and `(owner_id, agent_id)`.
  - **Constraints:** `UNIQUE (ticket_id, sequence)`. `sequence` and
    `claim_epoch` must be positive. `rounds_state_m4` allows
    `claimed`, `running` and `delivered`.
    `rounds_timestamps_follow_state` sets which timestamps each state
    requires. `rounds_timestamps_ordered` keeps the timestamps in
    order.
  - **Sequential slot:** `rounds_one_open_per_owner` is a partial
    unique index on `(owner_id) WHERE state IN ('claimed', 'running',
    'waiting_for_input')`.
- `internal/httpapi/rounds.go`:
  - `ClaimWork`, `claimRoundForOwner`, `claimCandidates` and
    `insertClaimedRound`.
  - `ticketHasOpenRound` and the `round_open` error.
  - `openRoundStatesSQL`.
- `runner.go`: `requireRunner` now also returns the owner and
  `last_seen_at`. `runnerConnected` is the 30 s rule, shared by health
  and claims.
- `agent_readiness.go`: `decideAgentWorkRequest` also requires no open
  Round.
- `ticket.go`: `openRound` is read by a subquery in
  `ticketSelectColumns`, so every Ticket response carries it.
- `ticket_archive.go`: after the row lock, archive returns
  `400 round_open` while the Ticket has an open Round.
- `handler.go`: the manual 405 for `/api/runner/claims`.
- Guardrail: `rounds` joins `knownPublicTables`. The manual-action
  table now asserts that no manual action creates a Round.

**Swiftlet**

- `parseTicket` validates `openRound`. It must be `null` or a Round
  with a known state, an Agent and `claimedAt`.
- A `ClaimedTag` uses the `tag` cva's new `claimed` variant: an ink
  outline with ink text on paper. Slip (`board-claimed`) and receipt
  (`ticket-detail-claimed`) show **Claimed by runner** while
  `openRound.state === "claimed"`.
- `tokens.test.ts` adds "claimed tag: ink on paper".
- Archive already put Galley's message on the receipt's action error.
  A new test pins the `round_open` case.

**Michelin**

- `MICHELIN_CLAIM_INTERVAL_MS` defaults to 5000 and is validated like
  the other intervals.
- `galley/runner.ts` has `claimWork`. `201` is parsed and validated.
  `204` means no work. `401` is `credential_rejected`. Any other status
  is `http_status`.
- `claimLoop.ts` polls only while the shared `registration` flag is
  set. Only `heartbeatLoop.ts` writes that flag. On `201` the loop logs
  `round claimed; claim polling stopped` with `roundId`, `sequence`,
  `claimEpoch`, `ticketId` and `ticketTitle`, then returns.

**e2e**

- `tests/runner-claims.spec.ts`, registered in `run.sh` after
  `runner.spec.ts` with its exit-code check.
- `support/runner.ts` holds the pairing flow and `startMichelin`,
  shared with `runner.spec.ts`.
- `support/tickets.ts` gains `openRound`.

### Engineering choices

- **One source for the open states per language.** In SQL it is
  `rounds_one_open_per_owner`'s predicate. In Go it is
  `openRoundStatesSQL`, used by the slot check, `ticketHasOpenRound`
  and the `openRound` subquery.
  `TestOpenRoundStates_MatchTheSlotIndexPredicate` reads
  `pg_get_indexdef` and fails if the two differ. The index already
  lists M5's `waiting_for_input`, so M5 changes CHECKs, not the slot
  index.
- **The CHECK allows only M4's states.** M4.6 writes only `claimed`.
  `running` and `delivered` are listed because M4.8 and M4.10 write
  them. M5 (#6) replaces the CHECK.
- **`requestingAgentWork` is false while a Round is open.** An open
  Round has consumed the request. The claim's eligibility check is
  that same function, so the Ticket a claim picks is always one that
  Swiftlet showed as **Queued for**.
- **A runner that is not Connected gets `204`, not `409`.** The
  Decision says a disconnected runner gets `204`. A runner that never
  registered has a null `last_seen_at`, so it is not Connected either.
  Re-registering is the heartbeat loop's job.
- **A claim is not a heartbeat.** It does not move `last_seen_at`
  (`TestClaim_RunnerMustBeConnected`).
- **An ineligible top candidate is skipped, not reported as no work.**
  The candidate list is read under the priority lock as a superset:
  unarchived, Ready and assigned to an Agent. Each row is then locked
  and decided with `decideAgentWorkRequest`. The loop is bounded by
  that list.
- **`claimed_at` comes from the injected clock**, so tests and the dev
  clock see consistent times.
- **No claim body.** The runner identity comes from the bearer
  credential, and Galley chooses the work.
- **A unique violation on the slot index maps to `204`.** It is the
  database backstop, and it means "a Round is already open".
- **Archive is not advertised in `allowedActions`**, so advertised and
  actual stay equal. Nothing new is advertised.
- **Michelin's poll waits one interval before its first claim.**
  Registration usually completes within that interval. Before then the
  check is cheap and makes no request.
- **`runner.spec.ts` runs Michelin with a one-hour claim interval.**
  Its Ticket snapshot asserts that nothing changed, and a claim would
  break that. Claims are the new spec's subject.

### Lock order and deadlock reasoning

The claim runs in one transaction:

1. The Owner's priority advisory lock.
2. Slot check: does an open Round exist for the Owner?
3. Candidate list in priority order.
4. For each candidate, `lockTicketForMutation` (`SELECT … FOR UPDATE`),
   then a re-read and `decideAgentWorkRequest`.
5. `INSERT` the Round (sequence = max for the Ticket + 1, epoch 1).
6. Commit.

Every other path that locks more than one Ticket row takes the same
advisory lock first: capture, reorder (and its renumbering), and every
Status transition and Accept. So no two of these paths can hold rows in
conflicting orders. Paths that hold only one Ticket row lock skip the
advisory lock: field edits, assignment, Badges, archive and restore.
They wait for no other Ticket row after it, so they cannot close a
cycle with the claim.

The Round insert's foreign-key checks also take `FOR KEY SHARE` locks:

- on the Ticket row, which the claim already holds `FOR UPDATE`;
- on the Agent row. Agent rename is a non-key `UPDATE` (`FOR NO KEY
  UPDATE`), which does not conflict with `FOR KEY SHARE`, and nothing
  deletes Agents.

Archive's added statement reads `rounds` without locking. Under READ
COMMITTED it sees a Round committed by a claim that held the row first.
Either way, exactly one of the claim and the archive takes effect:

- **Claim wins.** The archive waits on the row lock, then sees the
  committed Round and returns `round_open`.
- **Archive wins.** The claim waits on the row lock, then its re-read
  sees `archived_at` and skips the Ticket. If the archive commits
  before the claim reads candidates, the candidate list excludes it.

`TestClaimAndArchive_RaceEitherOrder` observed both orders, and
`TestClaim_ArchiveCommittedWhileTheClaimWaitsIsNotClaimed` pins the
second case deterministically.

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), pgx v5.11.0, oapi-codegen v2.8.0,
  golang-migrate (unchanged from `go.mod`).
- PostgreSQL: local server, the same as earlier M4 slices.
- Node v26.9.0. Swiftlet: Vitest 5.0.1, TypeScript 7.0.2. Michelin:
  TypeScript 5.9.3, Vitest 5.0.1. e2e: `@playwright/test` 1.63.0.

## Reproducible commands

```sh
cd apps/galley
gofmt -l . && go vet ./...
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m46?sslmode=disable' go test -count=1 ./...
./scripts/check-contract-drift.sh
cd ../../contracts && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh
cd ../apps/swiftlet && npm ci && npm test && npm run build
cd ../michelin && npm ci && npm run typecheck && npm test
cd ../../e2e && env -u FORCE_COLOR E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m46?sslmode=disable' ./run.sh
```

The manual run below used a scratch database `ticketit_scratch_m46`,
migrated with `go run ./cmd/migrate` and dropped afterwards. Galley ran
on port 18461 from a `go build` binary, with `cmd/githubfake` for
sign-in through `curl -L` and a cookie jar. A real Michelin
(`node apps/michelin/src/main.ts`) ran with
`MICHELIN_CLAIM_INTERVAL_MS=500`. The token is redacted here.

## Observed results

**Checks.**

- `gofmt -l` printed nothing, and `go vet` was clean.
- Galley `go test ./...`: all 7 packages `ok`; 842 tests and subtests
  passed, 0 failed.
- All three drift checks printed `OK … (no drift)`.
- Swiftlet: 19 files, 282 tests passed, and `npm run build` succeeded.
- Michelin: typecheck clean; 7 files, 68 tests passed.
- Browser suite: `SUITE PASSED`, every spec's exit code 0, 81 tests.
  `runner-claims.spec.ts` passed in 1.5 s.

Claim tests (`internal/httpapi`):

```text
--- PASS: TestClaim_ResponsesMatchContractAndMethod405 (0.12s)
--- PASS: TestClaim_CreatesOneRoundAndLeavesTheTicketReady (0.09s)
--- PASS: TestClaim_ConcurrentClaimsCreateExactlyOneRound (0.64s)
--- PASS: TestClaim_SecondClaimWhileARoundIsOpenIsNoWork (0.10s)
--- PASS: TestClaim_FollowsTheOwnerPriorityOrder (0.10s)
--- PASS: TestClaim_SequenceCountsRoundsPerTicket (0.10s)
--- PASS: TestClaim_SkipsAnIneligibleTopCandidate (0.09s)
--- PASS: TestClaim_RechecksTheLockedTicket (0.39s)
--- PASS: TestClaim_ArchiveCommittedWhileTheClaimWaitsIsNotClaimed (0.11s)
--- PASS: TestClaimAndArchive_RaceEitherOrder (0.36s)
    rounds_test.go:424: outcomes: map[archive won:10 claim won:94]
--- PASS: TestArchive_RejectedWhileARoundIsOpenAndAllowedWithout (0.09s)
--- PASS: TestClaim_RunnerMustBeConnected (0.11s)
--- PASS: TestClaim_ScopedToTheRunnersOwner (0.11s)
--- PASS: TestRounds_IdentityIsGalleyIssuedAndHasNoEngineReference (0.12s)
--- PASS: TestRounds_DatabaseEnforcesTheSlotAndInvariants (0.11s)
--- PASS: TestOpenRoundStates_MatchTheSlotIndexPredicate (0.10s)
```

How the concurrency tests work:

- **Concurrent claims:** 4 trials. In each, 24 goroutines send real HTTP
  claims at once against 3 queued Tickets. Exactly one `201`, the rest
  `204`, and one row in `rounds`.
- **`TestClaim_RechecksTheLockedTicket`:** the test holds the
  candidate's row lock in its own transaction. It waits in
  `pg_stat_activity` until the claim blocks on it, then commits one
  change: clear its inputs, archive it, unassign it, or move it off
  Ready. The claim must then take the next Ticket.
- **`TestClaimAndArchive_RaceEitherOrder`:** it adds 0–800 µs of random
  jitter before the archive. It repeats until each order has won at
  least 10 times, up to 300 trials. Exactly one of the two applies in
  every trial.

**Contrast.** "claimed tag: ink on paper" is `ink` #292524 on `paper`
#fffdf7, 14.91:1. No token changed.

**Falsification (Galley).** Each guard was broken on purpose, then the
suite was run. Every change was reverted with `git checkout`.

| # | Change | Result |
| --- | --- | --- |
| 1 | `lockTicketForMutation` without `FOR UPDATE` | `TestClaim_RechecksTheLockedTicket` failed: no query like "FOR UPDATE" blocked on a lock within 5 s. `TestClaimAndArchive_RaceEitherOrder` failed on trial 1: claim 201 and archive 200 both applied. |
| 2 | Claim skips the locked re-check | `TestClaim_SkipsAnIneligibleTopCandidate` failed ("claimed X, want the next eligible Ticket"). `TestClaim_RechecksTheLockedTicket` failed: it claimed the Ticket whose inputs were cleared, and the unassigned case panicked on a nil Agent. |
| 3 | No `rounds_one_open_per_owner` | `TestRounds_DatabaseEnforcesTheSlotAndInvariants` failed: a second claimed Round inserted with err=nil. `TestOpenRoundStates_MatchTheSlotIndexPredicate` failed: the relation does not exist. |
| 4 | No transactional slot check (index kept) | All passed. The index plus the 204 mapping is the backstop, so the check is an early exit, not the guarantee. |
| 5 | No slot check and no index | The concurrency test failed with "3 claims admitted". The second-claim and priority-order tests also failed. |
| 6 | Claim without the priority lock | All passed. The row-lock re-check sees the committed `openRound` and skips, and the index stops the next candidate. |
| 7 | No priority lock and no unique-violation mapping | The concurrency test failed with `503 database_unavailable`. |
| 8 | Archive ignores the open Round | `TestArchive_RejectedWhileARoundIsOpenAndAllowedWithout`, the race test and the contract test all failed. |
| 9 | `requestingAgentWork` ignores the open Round | `TestClaim_CreatesOneRoundAndLeavesTheTicketReady` failed (`requestingAgentWork=true`). |

Results 4 and 6 show defence in depth rather than redundant code. The
priority lock is what serializes claims per Owner so that they happen
in priority order. Without it, two claims on different Tickets would
race, and the index would turn the loser into a `204`, never a second
Round.

**Falsification (Swiftlet and Michelin).**

```text
### parseTicket accepts any openRound
 FAIL  TicketDetailPage > an open Round > rejects a Ticket response with no openRound
 FAIL  TicketDetailPage > an open Round > rejects a Ticket response with an unknown Round state
 FAIL  TicketDetailPage > an open Round > rejects a Ticket response with a Round with no Agent
 FAIL  TicketDetailPage > an open Round > rejects a Ticket response with a Round with no claimedAt
### slip shows Claimed by runner for any open Round
 FAIL  TicketBoard > shows Claimed by runner only on slips whose open Round Galley reports as claimed
### claim loop ignores registration
 × never claims until registered, and pauses while registration is lost
 × claims only after registration succeeds
### claim loop keeps polling after 201
 × logs the claimed Round and stops polling
 × checks Galley, registers, heartbeats, claims once, then exits 0 on SIGTERM without logging the token
```

**Manual run: Galley and a real Michelin** (development, scratch
database):

```text
$ POST /api/tickets/{id}/status {"status":"Ready"}  (research Agent, goal and Success Criteria set)
{'status': 'Ready', 'requestingAgentWork': True, 'openRound': None, 'updatedAt': '2026-10-01T04:49:26Z'}
$ POST /api/runner/claims (bearer, paired, not registered)
204
$ POST /api/runner/claims (wrong bearer)
{"error":{"code":"unauthenticated","message":"sign-in required"}} 401
$ POST /api/runner/claims (session cookie)
{"error":{"code":"unauthenticated","message":"sign-in required"}} 401
$ node apps/michelin/src/main.ts   (MICHELIN_CLAIM_INTERVAL_MS=500, MICHELIN_HEARTBEAT_INTERVAL_MS=1000)
{"time":"2026-10-01T04:49:31.892Z","level":"info","msg":"michelin starting","galleyUrl":"http://127.0.0.1:18461/","statusIntervalMs":10000,"heartbeatIntervalMs":1000,"claimIntervalMs":500,"node":"v26.9.0","michelinVersion":"0.1.0","hostname":"Mac-mini.local"}
{"time":"2026-10-01T04:49:31.923Z","level":"info","msg":"galley status ok",…,"migrationVersion":13}
{"time":"2026-10-01T04:49:31.925Z","level":"info","msg":"runner registered",…,"registeredAt":"2026-10-01T04:49:31.924712Z",…}
{"time":"2026-10-01T04:49:32.424Z","level":"info","msg":"round claimed; claim polling stopped","galleyUrl":"http://127.0.0.1:18461/","durationMs":7,"roundId":"01d3bed7-33a0-4b6c-87c6-61333718589e","sequence":1,"claimEpoch":1,"ticketId":"005db39a-1883-4858-add2-b2e3cb3d5aa7","ticketTitle":"Summarise the M4 findings"}
{"time":"2026-10-01T04:49:32.929Z","level":"info","msg":"runner heartbeat ok",…}
{"time":"2026-10-01T04:49:33.933Z","level":"info","msg":"runner heartbeat ok",…}
$ POST /api/runner/claims (bearer, Round open)
204
$ GET /api/tickets/005db39a-…
{"status": "Ready", "requestingAgentWork": false, "openRound": {"agent": {"id": "b541a069-…", "kind": "research", "name": "atlas"}, "claimedAt": "2026-10-01T04:49:32.418261Z", "id": "01d3bed7-33a0-4b6c-87c6-61333718589e", "sequence": 1, "startedAt": null, "state": "claimed"}, "updatedAt": "2026-10-01T04:49:26Z", "archivedAt": null}
$ POST /api/tickets/005db39a-…/archive
{"error":{"code":"round_open","message":"this Ticket has an open Round; it can be archived once the Round ends"}} 400
$ psql: SELECT id, owner_id, public_id, ticket_id, agent_id, sequence, state, claim_epoch, claimed_at, started_at, ended_at FROM rounds
 1 | 1 | 01d3bed7-33a0-4b6c-87c6-61333718589e | 1 | 1 | 1 | claimed | 1 | 2026-10-01 12:49:32.418261+08 |  |
$ kill -TERM <michelin>
{"msg":"michelin stopping","signal":"SIGTERM"} / {"msg":"michelin stopped"}
$ POST /api/dev/clock/advance {"seconds":30}
200
$ GET /api/runner-health
disconnected
$ GET /api/tickets/005db39a-… (after stop)
{"status": "Ready", "requestingAgentWork": false, "openRound": { …unchanged, "state": "claimed" }}
```

The Ticket's `updatedAt` did not move at claim time. The Round outlived
Michelin and the runner going Disconnected.

The same run then showed what an open Round does not yet block (see
the limitations):

```text
$ PUT /api/tickets/005db39a-…/assignee {"type":"owner"}   (while claimed)
200
{"assigneeType": "owner", "assigneeAgent": null, "status": "Ready", "openRound": {"agent": {…"name": "atlas"}, …, "state": "claimed"}}
$ POST /api/tickets/005db39a-…/status {"status":"Backlog"}   (while claimed)
200
{"status": "Backlog", "openRound": {…, "state": "claimed"}}
```

## Implementation limitations and follow-ups

- **Archive is the only block.** In M4.6 an open Round does not yet
  block the following. M4.7
  ([#133](https://github.com/cristoforows/ticketIt/issues/133)) owns
  all of them, and its Decisions reuse `round_open`.
  - Unassigning or reassigning the Ticket. Afterwards the Round's
    `agent` differs from the Ticket's Assignee, as the manual run
    shows.
  - Status changes away from Ready (for example Ready → Backlog), and
    Accept.
  - Reorder.
  - Field edits and Template. M4.2's readiness rule already refuses
    clearing an input that a Ready Agent-assigned Ticket needs.
  - Badge attach and detach.
- **The claimed Round never closes in M4.6.** Nothing moves it to
  `running` or `delivered`. Execution start is M4.8
  ([#134](https://github.com/cristoforows/ticketIt/issues/134)) and
  delivery is M4.10
  ([#136](https://github.com/cristoforows/ticketIt/issues/136)). Until
  then the Owner's slot stays taken. Tests free it with direct SQL
  (`deliverRoundDirect`).
- **A stranded claim is not recovered.** If Michelin stops, or never
  starts the Round, the Round stays `claimed`. The same happens when
  Galley commits a claim whose `201` never reaches Michelin intact (a
  timeout or an unreadable body): Michelin logs `runner claim failed`
  and keeps polling, and every later poll is `204`. Recovery belongs to
  D5, M5 (#6).
- **Michelin claims once per process.** After a `201` it stops polling
  and holds the Round in memory only. A restarted Michelin cannot claim
  again while the Round is open, because the slot returns `204`.
  Resuming a held Round is M4.8 and M5.

## Outstanding checks and owning milestone

- Event ingestion fenced by `roundId` and `claimEpoch`: M4.8 (#134).
- Advertised-versus-actual coverage for locked Tickets: M4.7 (#133).
- Reconciling a claimed Round with a disconnected runner: M5 (#6), D5.

## Decision impacts (open-decision IDs)

- **D5** (stranded-runner recovery): this slice makes the case real.
  A claimed Round outlives its runner, as shown above. Nothing recovers
  it, and this slice does not decide how.
- None of D1–D4 or D6–D9.
