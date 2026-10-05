# Stranded-Round recovery

## Purpose

M5.13, [#171](https://github.com/cristoforows/ticketIt/issues/171).

- **Idempotent claim.** A claim carries an idempotency key. A repeat of
  the key replays the same Round, so a claim whose `201` was lost no
  longer strands it.
- **Runner-identity fencing.** A Round records the runner that claimed
  it, and only that runner may report on it, pull its commands,
  reconcile it or check authority.
- **Bounded report retry.** Michelin stops retrying a report after
  `MICHELIN_REPORT_RETRY_MAX_MS`, halts locally, and reports its own
  cessation after the next Reconcile.
- **Owner-attested recovery (D5).** When no runner can end a Round, the
  Owner attests that its execution has ceased, and the Round ends
  Interrupted. Nothing else ends or unlocks it: not lost contact, a
  restart, unknown execution, a stale epoch or elapsed time.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/`, `CONTEXT.md` (Interrupted, Waiting Reason, Execution Unknown,
and the new Stranded Round and Cessation Attestation) and the READMEs of
the three apps and the browser suite.

**Owner question, resolved as (a): Interrupted always.** An attested
Round ends `interrupted` even when a Stop was pending. `CONTEXT.md`
says to avoid "Interrupted" for an outcome the Owner requested. This
slice's Decisions make attestation the one exception, and `CONTEXT.md`
now says so under Cessation Attestation. **The Owner should reconfirm
this at the M5 gate.**

## What already existed

- M5.1–M5.12 merged; this branch starts at `0806ca8` (M5.12).
- `POST /api/runner/claims` took no body and had no key.
- Runner routes authorised by Owner and epoch, not by which runner
  claimed.
- Michelin's `sendEvent` retried a report forever (1 s doubling to
  30 s).
- A Round in `execution_unknown` stayed open with no way to end it. The
  browser suite reset the database after `runner-reconcile.spec.ts` for
  that reason.
- Counts before this slice: Galley 542 top-level tests, Michelin 440,
  Swiftlet 726, 49 browser spec files.

## What this slice added

**Contract.**

- `ClaimWorkRequest {idempotencyKey}`, required.
- `200` on claim (a replay) and the `409` codes `idempotency_key_conflict`
  and `claim_not_replayable`.
- `409 runner_not_holder` on events, authority checks, Reconcile and
  command acks.
- `POST /api/tickets/{id}/rounds/{roundId}/attest-cessation` with
  `AttestCessationRequest {basis, note?}`, answering the ended
  `TicketRound`.
- `RoundAttestation` on `TicketRound.attestation`, and
  `allowedActions.attestCessation`.
- The waiting reason `runner_replaced`.
- Regenerated `api.gen.go` and both `schema.d.ts`.

**Galley.**

- Migration `000028_stranded_round_recovery.up.sql`:
  - `rounds.runner_id` (no foreign key: a re-pair deletes the runners
    row), `claim_idempotency_key` and `claim_payload`, all three set
    together (`rounds_claim_recorded_together`);
  - the key's length CHECK and the unique partial index
    `rounds_claim_idempotency_key_unique` on
    `(owner_id, claim_idempotency_key)`;
  - `rounds_timestamps_follow_state` relaxed, so that `interrupted`,
    like `stopped`, does not need `started_at`;
  - `round_attestations`, one row per Round, with named CHECKs on the
    basis, the note length, Other needing a note, the Round state, the
    holder health and the execution.
- `round_attestations` is added to the `no_execution_side_effects` table
  list.

**Claim ladder** (`rounds.go`):

1. bearer auth (`401`);
2. strict shape (`400`; a missing body is `400`);
3. the Owner's priority lock;
4. key lookup;
5. replay (`200`), or `409 idempotency_key_conflict` when the key
   belongs to another runner, or `409 claim_not_replayable` when its
   Round is not `claimed`;
6. connected (`204`);
7. slot and eligibility (`204`);
8. new claim (`201`, storing `runner_id`, the key and the returned body).

A replay returns the stored body byte for byte, after feedback
consumption too, and is never `204`.

**Event ladder, with fencing** (`round_events.go`):

1. auth;
2. lookup (the shared `404`);
3. shape;
4. **holder (`409 runner_not_holder`)**;
5. replay;
6. epoch;
7. open;
8. suited to state.

Authority checks, Reconcile and acks put the holder step after their
lookup and before their replay or epoch step. `GET /api/runner/rounds/{id}/commands`
answers `[]` to a non-holder. `runnerHolds(nil, _)` is false: a Round
claimed before the migration is held by no runner and needs an
attestation.

**Holder health** (`holderHealthOf`):

- `not_paired` when the Owner has no runner;
- `replaced` when the holder is not the current runner;
- otherwise `connected` or `disconnected` by the 30 s window.

**Waiting reasons:** Runner disconnected, then `runner_replaced`, then
`execution_unknown`, then `reconciling`, then the rest.

**Attestation predicate**, one function, `decideCessationAttestation`:

```
available ⇔ ¬archived ∧ roundOpen ∧ ¬(holderHealth = connected ∧ recordedExecution ≠ unknown)
```

`allowedActions.attestCessation` is `commandAvailability` over the same
function and facts, and a refusal is `400 attestation_not_available`
with that reason.

**Attestation ladder:**

1. session auth (`401`), then a malformed id (the shared `404`);
2. strict shape (`400 invalid_request`): the basis, a note of 1–1000
   characters, and a note required with `other`;
3. the transaction: priority lock, Ticket row (`lockTicketForMutation`;
   an unknown or foreign Ticket is the shared `404`), Round row
   `FOR UPDATE` (an unknown Round, or one on another Ticket, is the
   shared `404`);
4. an existing attestation returns `200` with the stored Round;
5. `decideCessationAttestation` (`400`);
6. insert the attestation row, end the Round through `endRound` with
   `roundEndings[interrupted]` and the explanation
   `Ended by Owner attestation: <basis label>.`, then append one
   activity note;
7. commit, then `200` with the Round as `GET …/rounds` shows it, read
   after the commit.

`endRound` is the event ladder's own ending. It moves the Ticket to
Blocked and frees the slot and the lock. Activity, usage and work are
untouched. A pending Stop command stays recorded and undelivered, since
the command pull lists commands only for open Rounds.

**Lock order.**

- **Event ladder:** `lockOwnerPriority` (`pg_advisory_xact_lock`), then
  the Ticket row (`lockTicketForMutation`), then the Round row
  `FOR UPDATE`.
- **Attestation, claim and Reconcile:** take the same order. The
  attestation reads the `runners` row without locking it.
- **Register and heartbeat:** lock the runners row, then flag the open
  Round. They never take the priority lock, so no cycle exists with the
  attestation: it never locks `runners`, and register and heartbeat
  never wait on the priority lock.
- The order is stated in the comment on `claimRoundForRunner` and tested
  by `TestAttestCessation_InterleavesWithRegisterAndHeartbeatWithoutDeadlock`.

**Michelin.**

- **Claim key:**
  - `claimWork(request, idempotencyKey)` sends `{idempotencyKey}` and
    accepts `200` and `201`;
  - `claimKeyOutlives(result)` is true for unreachable, timeout,
    invalid_body and any 5xx;
  - the claim loop keeps one pending key in memory and reuses it until a
    definite answer;
  - a pending key is retried before any `held: []` Reconcile.
- **Retry bound:**
  - `MICHELIN_REPORT_RETRY_MAX_MS` (default 300000; a positive integer,
    parsed like the intervals);
  - in `sendEvent`, the elapsed time on `deps.now` from a report's first
    failed attempt, checked after each retryable failure; at or past the
    bound it logs `round event failed; retry bound reached` and returns
    `halted`.
- **`recoverHalted`:**
  - logs `report retry exhausted; round halted locally` and runs no
    further step;
  - every claim interval, settles a Reconcile through the claim loop's
    reconciler, whose belief for a halted engine is `stopped`;
  - on `report_cessation` it sends the unsent report if it is terminal,
    byte for byte, or else the named cessation with key
    `<roundId>:halted` and evidence `Halted locally at step N of M
    (<type>) at <ISO time>: report retry bound of X ms reached`;
  - `hold` keeps waiting, a `drop` or a refusal (a `409` among them)
    abandons the Round, and a replay is success;
  - the cessation send is bounded too, so a second exhaustion returns to
    the loop.

**Swiftlet.**

- **Parsers:** `runner_replaced`, a strict `parseAttestation` (allowed
  only on Interrupted Rounds; Other requires a note), and the required
  `allowedActions.attestCessation`.
- **`attestRoundCessation`.**
- **`AttestCessation.tsx`:**
  - the control renders only when the action is available;
  - an accessible Radix dialog: a title, the copy as its description, a
    fieldset legend and radios, a labelled note with a hint, Keep
    waiting focused on open, and confirm disabled until ready;
  - the receipt's **Ended by your attestation** record.
- `TicketDetailPage` posts the attestation, then reloads the Ticket and
  Rounds; a refusal shows inline.

**Browser suite.**

- The claim helpers send a key.
- `support/tickets.ts` has the new types and `attestCessationDirect`.
- `runner-claims.spec.ts`'s exact `allowedActions` gains
  `attestCessation`.
- `runner-reconcile.spec.ts`'s third test ends its Round by attestation,
  and `run.sh`'s database reset after it is gone.
- `runner-attest.spec.ts` is new and registered in `run.sh` with its exit
  code.

### Engineering choices beyond the Decisions

| Choice | Reason |
|--------|--------|
| Key lookup after the priority lock | A concurrent same-key claim waits, then sees the committed Round; the unique index backs it |
| A replay's holder check before its state check | Another runner's key is a conflict whatever its Round's state |
| A non-holder's `held: []` Reconcile answers `hold` with no commands and records nothing | The Decision reads "reconciled as unknown"; this answers as for `unknown` but writes nothing, because a non-holder must not change a Round it does not hold (fencing's "change nothing") |
| A repeat attestation answers the stored Round whatever its body | The first attestation is the record; a second basis is not a correction |
| Attestation's shape check before the Ticket and Round lookup (a malformed id is still `404` first) | As the other Round commands (answer, feedback): `400` before the database is read |
| `holder_last_seen_at` stored only for `connected` or `disconnected` | For `replaced` or `not_paired` it would be another runner's time |
| `holder_runner_id` stored but not exposed | An internal row id; the health already says whose |
| Galley basis labels: "the Michelin process was ended", "the machine running Michelin was off", "other" | The explanation is Galley's past-tense record; Swiftlet's radios use the issue's first-person copy |
| Michelin drops the key on every status other than 5xx | Only a 5xx is ambiguous about a commit; 4xx answers are definite |
| Authority checks and command acks keep unbounded retry | The Decision bounds reports only; widening it would change M5.7's and M5.1's retry contracts |
| An unsent `stop_confirmed` is sent as is on `report_cessation` | It is a terminal report; the Decision says to send the unsent terminal report |
| Swiftlet omits a blank optional note | Galley refuses a blank note |
| Dialog legend "How you know it stopped"; slip label "Runner replaced" | Not given by the issue |

## Exact versions and toolchain

Go 1.27.1 (darwin/arm64), Node 26.9.0, npm 11.19.1, PostgreSQL 17.11
(local), Playwright and Vitest as locked in each `package-lock.json`;
no dependency changed.

## Reproducible commands

```
createdb ticketit_test_m513; createdb ticketit_e2e_m513
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m513?sslmode=disable'
cd apps/galley && gofmt -l . && go vet ./... && go build ./... && go test ./... -count=1 && go test -race -count=1 ./...
cd apps/michelin && npm ci && npm run typecheck && npx vitest run
cd apps/swiftlet && npm ci && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd apps/galley && ./scripts/check-contract-drift.sh
cd contracts && npm ci && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh
cd e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m513?sslmode=disable' ./run.sh
```

## Observed results

Final tree, all changes staged first (the drift scripts compare against
the index):

```
gofmt -l .            (no output)
go vet ./...          ok
go build ./...        ok
go test ./... -count=1
ok  .../apps/galley/cmd/galley           4.313s
ok  .../apps/galley/cmd/githubfake       2.194s
ok  .../apps/galley/internal/auth        0.944s
ok  .../apps/galley/internal/config      1.745s
ok  .../apps/galley/internal/githubfake  1.350s
ok  .../apps/galley/internal/httpapi     160.512s
ok  .../apps/galley/internal/postgres    3.168s
go test -race -count=1 ./...
ok  .../apps/galley/internal/httpapi     249.111s   (all other packages ok)
go test -list '.*' ./... | grep -c '^Test'   580
Michelin: tsc ok; Test Files 12 passed (12), Tests 473 passed (473)
Swiftlet: tsc ok; Test Files 27 passed (27), Tests 754 passed (754); build ok
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

**Browser suite** (`./run.sh` on the final tree): 50 spec files, 50 exit
codes 0, 107 tests passed, 0 failed, `SUITE PASSED`, exit 0.

```
✓ 1 … runner-attest.spec.ts › a killed runner's Round stays locked until the Owner attests it stopped: Interrupted, Blocked, and Ready claims Round 2 (2.3s)
✓ 2 … runner-attest.spec.ts › a restarted runner that cannot confirm execution holds the Round until the Owner attests it stopped; the same runner then claims Round 2 (2.6s)
2 passed (5.2s)
✓ 3 … runner-reconcile.spec.ts › a restarted runner cannot confirm the Round an earlier process held: it stays open, the Ticket stays locked, and the slip and receipt say so (3.0s)
```

An earlier run of the suite failed two existing specs, and both are now
updated:

- `runner-claims.spec.ts` compares exact `allowedActions`, which now
  include `attestCessation`.
- `runner-engine.spec.ts` compares an exact Round, which now includes
  `attestation: null`.

**Galley behaviours.** Each is shown through the HTTP handler on real
PostgreSQL.

- **Claim** (`stranded_round_test.go`):
  - the runner and key are recorded;
  - a replay returns the same Round and body after feedback consumption;
  - a replay is never `204`, and a key that found no Round stays `204`;
  - another runner's key, and a key whose Round left `claimed`, are
    `409`;
  - keys are Owner-scoped;
  - the body is required and strict;
  - 16 concurrent same-key claims, in each of 4 trials, make one Round;
  - the index and CHECK reject a second Round per key or a partial
    record.
- **Fencing:**
  - after a re-pair, the new credential's events, checks, Reconcile and
    acks get `409 runner_not_holder`, its command pull is `[]`, and the
    database snapshot is unchanged;
  - the old credential is `401`;
  - fencing comes after lookup and shape and before replay and epoch;
  - the holder is unaffected;
  - a null holder is held by nobody.
- **Stranded Rounds stay stranded.** The dead, restarted, replaced and
  revoked cases each stay open and locked, with claims `204`, until
  attested.
- **Attestation** (`round_attestation_test.go`):
  - the decision table;
  - `allowedActions.attestCessation` equals the command's outcome, and
    its refusal body, in 15 states;
  - the full effect, with usage compared as JSON;
  - claimed and waiting Rounds;
  - a repeat;
  - bad bodies `400` before the lookup, and unknown, foreign and
    mismatched ids `404`;
  - late `delivered`, `progress` and Reconcile get `round_not_open`;
  - Ready then claims a new Round with epoch + 1;
  - the observed holder for each health;
  - the constraints.
- **Lock order and races:**
  - a deterministic order test holds the priority lock in its own
    transaction, queues the attestation and an event (FIFO via
    `waitForLockWaiters`), and checks that the first in line wins, in 4
    subtests;
  - 40 free races of attestation against a runner ending each leave
    exactly one winner (logged `map[attestation:38 event:2]`);
  - 8 concurrent attestations record one row and one note;
  - 20 interleavings with register and heartbeat finish without
    deadlock.
- **Contract:**
  `TestAttestCessationAndFencing_ResponsesMatchContractAndMethod405`.

**Michelin** (Vitest, fake clock):

- **Key reuse** after unreachable, timeout, a non-JSON or non-claim
  `201`, `500` and `503`.
- **A fresh key** after `204`, `401`, both `409`s and `400`, and after a
  `201` or `200` Round ends.
- **A pending key** is asked again before the owed `held: []` Reconcile.
- **The bound:**
  - it halts at exactly the bound (7000 ms: 5 sends) and not just under
    it (7001 ms: 6 sends);
  - it is measured per report;
  - cessation with evidence; `stop_confirmed`;
  - an unsent terminal report is sent byte for byte;
  - a replay is accepted, and a `409` or `400` drops the Round;
  - hold, drop and aborted leave the Round unreported;
  - a cessation that itself hits the bound reconciles again;
  - with no reconciler, the Round is abandoned.
- **The claim loop** reconciles a halted Round believing `stopped`.
- **Config:** the default, a set value and rejected values.

### Falsification

Each mutation was applied alone by a script. The listed tests were run
and the file restored from a copy. `git diff --stat` was identical
before and after each batch. Galley mutations ran the `httpapi` tests
matching `Attest|Claim|Fencing|Stranded|WaitingReason|HolderHealth|RunnerHolds|Reconcile|Authority|Command|Contract|NoExecution|Interrupted|Blocked`.
Michelin ran the full Vitest suite, and Swiftlet ran the affected test
files.

| Mutation | Result (failing tests, abridged) |
|----------|--------|
| G1 a connected holder is always attestable | killed (decision table, parity, contract) |
| G2 a connected holder with `unknown` is not attestable | killed (table, parity, observed holder) |
| G3 an archived Ticket is attestable | killed (decision table) |
| G4 no activity note | killed (effects, concurrent attestations) |
| G5 a repeat re-decides | killed (repeat, concurrent, contract) |
| G6 the attestation skips the priority lock | killed (`WhicheverReachesTheLadderFirstWins`) |
| G7 the attestation ends Failed | killed |
| G8 `holder_last_seen_at` stored for a replaced holder | killed (observed holder) |
| G9 `GET rounds` omits the attestation | killed |
| G10 no claim-key lookup | killed (replay, concurrency) |
| G11 a Round that left `claimed` replays | killed |
| G12 another runner's key replays | killed |
| G13 key lookup after the connected check | killed (`AReplayIsNever204`) |
| G14 a null holder holds for everyone | killed |
| G15 events not fenced | killed |
| G16 authority checks not fenced | killed |
| G17 a non-holder's `held: []` Reconcile records `unknown` | killed |
| G18 the command pull not fenced | killed |
| G19 acks not fenced | killed |
| G20 a replaced holder reads as its health | killed |
| G21 `runner_replaced` never shown | killed |
| G22 `allowedActions` ignores the holder | killed |
| M1 the key never outlives a failure | killed |
| M2 the key outlives a 4xx | killed |
| M3 Reconcile before the pending key | killed |
| M4 a new key every attempt | killed |
| M5 bound exclusive (`>`) | killed (boundary test) |
| M6 bound measured from the latest failure | killed |
| M7 an unsent terminal report replaced by the cessation | killed |
| M8 hold and drop keep waiting | killed |
| M9 the cessation send unbounded | killed |
| M10 default 30000 | killed |
| M11 a halted engine reconciles believing `running` | killed |
| M12 exhaustion not logged | killed |
| S1 the control renders when unavailable | killed |
| S2 confirm enabled with Other and no note | killed |
| S3 the copy altered | killed |
| S4 Keep waiting not focused | killed |
| S5 a blank optional note sent | killed |
| S6 the record omits the note | killed |
| S7 the parser accepts an attestation on any state | killed |
| S8 the parser accepts Other without a note | killed |
| S9 `attestCessation` not required | killed |
| S10 the `runner_replaced` notice missing | killed |
| S11 `runner_replaced` dropped from the parser | killed |

45 mutations, 45 killed, none survived. G3 is killed only by the pure
decision table: no HTTP test attests an archived Ticket, because an
archived Ticket cannot have an open Round (archive refuses
`round_open`). The e2e specs were not mutated; the behaviours they show
are each killed above.

## Implementation limitations and follow-ups

- **Shared credential.** Two Michelin processes sharing one credential
  are one runner to Galley and are not fenced from each other.
  Re-pairing is the only way to tell them apart.
- **The attestation is the Owner's assertion, not Galley's proof.** If
  the old process is alive, its later reports get `round_not_open` (or
  `401`/`runner_not_holder` after a re-pair). Whatever it already did
  outside ticketIt stands; the dialog copy says so.
- **A silent connected holder.** A runner that heartbeats but never
  reconciles is not attestable while connected. The Owner revokes or
  re-pairs the credential first (`not_paired` or `replaced`), as the
  Decision states.
- **The claim key is not persisted.** A Michelin restarted between a
  committed claim and its answer cannot replay it. That Round is the
  restarted-runner case and needs an attestation.
- **Authority checks and command acks retry without the bound.** A
  Galley outage during a check holds the step until Galley returns.
- **Rounds claimed before migration 000028** have no holder. Runner
  requests on them get `409 runner_not_holder`, or an empty command
  list, until the Owner attests.
- Technical limits are M5.14 and were not touched.

## Outstanding checks and owning milestone

- The Owner's reconfirmation of option (a), Interrupted always, at the
  M5 gate.
- Gate-report reconciliation of the evidence index,
  `docs/integration-feasibility.md`, `docs/open-decisions.md` (D5) and
  `docs/contracts/execution-interface.md`: the M5 gate-report slice.

## Decision impacts (open-decision IDs)

D5 (recovery authority): implemented as the Owner decided. Only the
Owner's explicit attestation ends a stranded Round, and there is no
timeout or takeover. Nothing is resolved here; the gate report
reconciles it.
