# Round activity and initial usage observations

## Purpose

M4.9, [#135](https://github.com/cristoforows/ticketIt/issues/135): a
running Round now has two append-only records: an activity history of
notes, and a ledger of usage observations. Both arrive through the
runner event endpoint M4.8 built, with the same authentication, decision
ladder, idempotency and epoch fencing. Michelin's controlled engine
reports both from its script. `GET /api/tickets/{id}/rounds` returns each
Round's latest 50 notes and a usage summary in which unknown is never
zero. Swiftlet's receipt shows them and refreshes while the Round is
open. Touches `contracts/`, `apps/galley`, `apps/michelin`,
`apps/swiftlet` and `e2e/`.

## What already existed

- M4.8 ([#134](https://github.com/cristoforows/ticketIt/issues/134),
  `134-controlled-engine.md`): `POST /api/runner/rounds/{roundId}/events`
  with `execution_started` only, `round_events` with
  `UNIQUE (round_id, idempotency_key)` and the payload hash, the
  decision ladder, `GET /api/tickets/{id}/rounds` without activity or
  usage, and Michelin's script with `start`, `wait`, `hold`. The default
  script was `start`, `hold`. Michelin's parser rejected `progress` and
  `usage` as "a later slice adds it".
- Swiftlet's receipt showed the open Round from `Ticket.openRound` and
  refreshed every 3 s (`useOpenRoundRefresh`). It did not call the rounds
  endpoint.
- Migrations up to `000014`. Baseline on `main` at `74a62c6`:
  - Galley: 7 packages pass, 261 top-level tests and 940 with subtests
    (from the M4.8 record).
  - Swiftlet: 340 tests.
  - Michelin: 155 tests.
  - Browser suite: 34 specs, 82 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`, regenerated into `api.gen.go` and
both `schema.d.ts`):

- `RoundEventType`: `[execution_started, progress, usage_observed]`.
  `data` is `oneOf` `ExecutionStartedData`, `ProgressData {note}` and
  `UsageObservedData`.
- `UsageObservedData` has all nine keys required:
  - `observationId`: a UUID.
  - `provider` and `model`.
  - `inputTokens`, `outputTokens` and `activeMs`: integer or `null`, at
    most 2^53−1.
  - `costUsd`: a string or `null`.
  - `basis`: `reported` or `estimated`.
  - `providerGenerationId`: a string or `null`.
- `RoundEventResult` gains `seq` (on progress) and `observationId` (on
  usage).
- `TicketRound` gains required `activity` (`RoundActivityNote[]`, at most
  50) and `usage` (`RoundUsage`).
- `RoundUsage` is `{observations, complete, estimated, costUsd,
  inputTokens, outputTokens, activeMs}`. Each of the last three is
  `UsageCount {sum, complete, estimated}`.

**Galley** (`internal/httpapi`)

- Migration `000015_create_round_activity_and_usage_observations.up.sql`:
  - `round_events_type_m4` now allows the three types.
  - `round_activity (id, owner_id, round_id, seq, note, occurred_at)` with
    `UNIQUE (round_id, seq)`, `seq >= 1`, `char_length(note) BETWEEN 1 AND
    2000`, and a not-blank CHECK.
  - `usage_observations`, with the columns the issue names plus
    `owner_id`. `id UUID PRIMARY KEY` is the observationId. The figure
    columns are nullable, with CHECKs on range and length and `cost_usd
    NUMERIC(12,6)`. `provider_generation_id` is nullable and not unique.
  - Both tables have a composite foreign key to `rounds (owner_id, id)`,
    as M4.8's tables do.
- `round_events.go`:
  - per-type validation;
  - the `idempotencyKey == data.observationId` rule;
  - the state rule for the new types;
  - the apply step's per-type switch, with `startRound` extracted
    unchanged from M4.8.
- `round_activity.go`: note validation, `appendActivity` and
  `latestActivity`.
- `usage_observations.go`: usage validation, `insertUsageObservation`
  and `roundUsageSummaries`.
- `ticket_rounds.go`: the list reads Rounds, activity and usage in one
  `REPEATABLE READ READ ONLY` transaction, so all three come from the
  same snapshot.
- Guardrail: `round_activity` and `usage_observations` join
  `knownPublicTables`. The manual-action table asserts that no Owner
  action creates a row in either.
  `TestNoTemplateToCapabilityMapping` is untouched and passes.

**Michelin**

- `engineScript.ts`:
  - `progress {note}` and `usage {provider, model, inputTokens,
    outputTokens, costUsd, activeMs, basis, providerGenerationId}` steps,
    parsed against Galley's limits;
  - the new default script;
  - `deliver` stays "M4.10 (#136) adds it".
- `engine.ts`: `newObservationId` as an injectable dependency, with one
  pending event per reporting step.
- `galley/runner.ts`: `reportRoundEvent` checks the result's type, its
  `seq` and its `observationId` against what was sent.

**Swiftlet**

- `src/api/rounds.ts` holds `fetchTicketRounds` with a full parse.
- `TicketDetailPage` fetches the list on load and on each tick of the
  existing 3 s refresh.
- `RoundsSection` shows Activity and "Usage so far".
- `roundUsage.ts` holds the formatting.
- `EstimateTag` is the "est." marker.

**e2e**

- `tests/runner-activity.spec.ts` (new). `runner-engine.spec.ts` expects
  `activity: []` and the unknown summary.
- `support/` gains the `Round` activity and usage types, `NO_USAGE` and
  the new script steps.
- `run.sh` resets the database again before the new spec.

### The decision ladder for the new types

The ladder is M4.8's, unchanged in order. Additions:

| # | Check | Outcome |
| --- | --- | --- |
| 3 | `progress`: `data` is exactly `{note}`. The note is 1 to 2000 characters, not blank, with no control character except tab and line feed | `400 invalid_request` |
| 3 | `usage_observed`: `data` has exactly the nine keys; each figure is valid; `idempotencyKey` equals `data.observationId` byte for byte | `400 invalid_request` |
| 8 | `progress` and `usage_observed` need a `running` Round. A `claimed` Round gives "progress cannot be reported while the Round is claimed" | `409 event_out_of_order` |
| 9 | `usage_observed` whose observationId is already recorded for another Round | `409 observation_id_conflict` |

A replay is still answered at step 5, before the epoch and open checks. A
progress or usage event replayed after its Round ended or moved to a
later epoch gets `200` with the stored result, and nothing is appended.

**How a claimed Round treats the new events.** It rejects them with
`409 event_out_of_order` and stores nothing. No `round_events` row is
written for a rejection, so the key is not spent: once
`execution_started` is recorded, the same event with the same key is
accepted (`TestProgressAndUsage_OnAClaimedRoundAreOutOfOrder`). The
reason is in the code: progress and usage are facts about execution,
and Galley knows execution began only once `execution_started` is
recorded. Michelin's script always starts first, so a claimed-Round
report means a runner bug, and Michelin abandons the Round on it.

### Engineering choices inside the Decisions

- **Key = observationId.** For `usage_observed`, the idempotency key must
  equal `data.observationId` byte for byte. Otherwise the event is
  `400`, before any lock. The observationId must be a non-nil UUID in
  lowercase canonical form. That gives each observation one spelling,
  so the key, the hash input and the primary key are the same text.
  - A replay of the same observation is caught by the
    `(round_id, idempotency_key)` lookup.
  - A different payload under the same id is `409
    idempotency_key_conflict`.
  - The same id on another Round reaches the insert. There
    `ON CONFLICT (id) DO NOTHING` affects zero rows, and the event is
    `409 observation_id_conflict` with nothing stored.
  - Tests: `TestUsage_TheKeyIsTheObservationID` and
    `TestUsage_AnObservationIDRecordedForAnotherRoundConflicts`.
- **No provider id is identity.** Two observations with
  `providerGenerationId: null` are two rows. So are two with the same
  generation id, and nothing is merged
  (`TestUsage_ObservationsWithoutAProviderIDNeverCollide`,
  `TestUsage_TheSameProviderGenerationIDIsKeptTwiceAndNotMerged`).
  Enrichment and reconciliation join on `provider_generation_id` later
  (M9 [#10](https://github.com/cristoforows/ticketIt/issues/10)).
- **seq.** `INSERT … SELECT COALESCE(max(seq), 0) + 1 … RETURNING seq`
  runs inside the event's transaction while it holds the Round's Ticket
  row lock. Every event for a Round takes that lock first, so a second
  event's `max(seq)` read waits for the first event's commit. It is not
  a sequence, so a rolled-back event leaves no gap.
  `UNIQUE (round_id, seq)` is the backstop. 24 goroutines × 3 notes on
  one Round give seq 1..72 exactly once
  (`TestProgress_ConcurrentNotesGetDistinctGapFreeSeq`, also under
  `-race`).
- **Characters, not bytes.** The 2000 limit counts Unicode code points:
  `utf8.RuneCountInString` in Galley, `char_length` in a UTF-8 database
  and `[...s].length` in Michelin. 2000 × "é" (4000 bytes) is accepted
  and 2001 code points is rejected, at the API and in the CHECK. "Blank"
  means every character is `unicode.IsSpace`, which includes U+00A0. The
  DB CHECK trims ASCII whitespace only, as a backstop. Control
  characters other than tab and LF are rejected. A carriage return is
  rejected too, so a note has one line-ending form.
- **Precision.** Cost is a decimal string on the wire, never a JSON
  number, matching `^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$`, which is the
  range of `NUMERIC(12,6)`.
  - Stored as `$8::text::numeric`.
  - Summed by PostgreSQL. The sum is returned as the text of
    `sum(cost_usd)`, always at scale 6 (e.g. `"0.300000"`), so nothing
    passes through a float in Galley, the JSON or Swiftlet.
  - `TestUsage_NumericPrecisionRoundTrips`:
    - `"0.1"`, `"0.2"`, `"999999.999999"`, `"0.000001"` and `"123.45"`
      are each stored at scale 6 and sum to exactly `"1000123.750000"`;
    - `0.1 + 0.2` reads `"0.300000"` on the wire;
    - `inputTokens` 2^53−1 is stored exact.
  - Swiftlet formats the string by text manipulation (`dollars()`).
- **Counts.** Counts are plain JSON integers from 0 to 2^53−1, with no
  sign, fraction or exponent; an exponent such as `1e3` is rejected. The
  limit is the largest integer JSON consumers (Swiftlet, Michelin) hold
  exactly. Every key is required, and `null` means unknown, so "absent"
  and "unknown" cannot drift apart on the wire. In Michelin's script an
  absent figure means `null`.
- **Summary semantics.** Per Round:
  - `observations` is the count.
  - `costUsd` is the sum of known costs, or `null` if none is known.
  - `complete` is true when there is at least one observation and every
    one has a known cost; zero observations is not complete.
  - `estimated` is true when an observation with a known cost has basis
    `estimated`. An unknown estimated cost adds nothing, so it does not
    mark the figure.
  - Tokens and active time each have their own `UsageCount` with the
    same three meanings.

  Swiftlet maps each figure without deciding anything:
  - `sum` `null` → "Unknown";
  - not `complete` → "≥ x (incomplete)";
  - otherwise "x";
  - plus "est." when `estimated`.

  Tests: `TestRoundUsageSummary_UnknownPartialCompleteAndEstimated`
  covers no observations, all unknown, partial, complete, mixed basis,
  and an estimated figure that is unknown.
- **The 50-note window.**
  `row_number() OVER (PARTITION BY round_id ORDER BY seq DESC) <= 50`,
  then ordered by `round_id, seq`. That gives the latest 50 per Round,
  oldest first. 60 notes return seq 11..60
  (`TestListTicketRounds_ActivityIsTheLatest50OldestFirst`). The full
  history stays stored.
- **Owner scoping.** Every query carries `owner_id`:
  - the event's Round lookup;
  - both inserts (whose composite foreign keys bind the row's Owner to
    the Round's);
  - `latestActivity` and `roundUsageSummaries`.

  An unknown, malformed or foreign Round, or a Ticket id used as a Round
  id, gets the shared `404`. Another Owner's rounds list is the shared
  Ticket `404`
  (`TestProgressAndUsage_UnknownAndForeignRoundsAreTheSameNotFound`,
  `TestListTicketRounds_ActivityAndUsageBelongToTheirRoundAndOwner`).
- **`occurred_at` is the runner's clock** for notes and observations: it
  is when the runner saw the fact. Galley's receipt time is in
  `round_events.received_at`. Arrival order, not `occurred_at`, decides
  `seq`.
- **Locks and deadlock.** The lock order is M4.8's, for all three types:
  1. the Owner's priority advisory lock;
  2. the Ticket row (`lockTicketForMutation`);
  3. the Round row `FOR UPDATE`;
  4. then the inserts.

  The inserts' foreign keys take `FOR KEY SHARE` on the Round row, which
  this transaction already holds, so nothing new is awaited. No cycle is
  possible:
  - Claim and every priority-ordered Owner command take the priority
    lock before any Ticket row.
  - Field edits, assignment, Badges and archive take only a Ticket row
    and then wait for nothing else.
  - The rounds list takes no lock: it reads an MVCC snapshot.
  - Two events for one Round queue at step 1.
  - The one wait outside this order is a usage insert behind another
    transaction's uncommitted insert of the same UUID. For the same
    Owner, the priority lock has already serialised the two. For
    different Owners, the waiting transaction holds only its own
    Owner's locks, which the other never requests.

  `TestProgressAndUsage_RacingTheOwnersCommandsNeitherDeadlocksNorChangesTheTicket`
  runs four trials. Each sends 4 notes and 4 observations concurrently
  with an archive, a reorder, a second claim, a status change and a
  rename. Every event got `201`. No request got a `500` or hung past the
  20 s deadlock bound. The Ticket was unchanged.
  `TestRoundEvent_TakesTheOwnersPriorityLockThenTheTicketRowThenTheRoundRow`
  now runs for all three types.

  The Round row lock is not what makes `seq` safe; the Ticket row lock
  is. Mutation 2b below shows this. The Round row lock is kept for
  M4.8's state check.
- **Michelin's keys.**
  - `start` and `progress` use `<roundId>:<step index>`.
  - `usage` uses its observationId, generated once when the step runs
    (`randomUUID()`, injectable).
  - The request body is serialised once per event, so every retry sends
    identical bytes, with the same key, `occurredAt` and observationId.
  - A retried observation therefore cannot record a second row.
- **The default script** is now: `start`; progress "Reading the Ticket",
  "Working towards the goal" and "Writing up the result", one second
  apart; one `reported` usage observation (`controlled` / `scripted`,
  1200 in, 300 out, `"0.004500"` USD, 2000 ms); then `hold`. It holds
  where M4.10 will deliver. The order and timing are pinned with fake
  timers in `engine.test.ts`.
- **Swiftlet reuses the refresh.** The rounds fetch runs inside the
  existing `refreshTicket`, after the Ticket fetch, while the Ticket has
  an open Round. That gives one timer, and a slow fetch delays the next
  tick rather than overlapping it.
  - A failed fetch keeps the last record and shows the error.
  - A malformed list is rejected whole.
  - A `401` signs out.
  - The "est." tag is `muted` on `paper` with a `muted` border. Its
    contrast entry is in `tokens.test.ts`.

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), pgx v5.11.0, golang-migrate v4.20.1,
  oapi-codegen v2.8.0, kin-openapi v0.149.0 (`apps/galley/go.mod`).
- PostgreSQL 17.11 (Homebrew, local, trust auth).
- Node v26.9.0. openapi-typescript 7.13.0.
- Swiftlet: Vitest 5.0.1, TypeScript 7.0.2.
- Michelin: Vitest 5.0.1, TypeScript 5.9.3.
- e2e: `@playwright/test` 1.63.0.

## Reproducible commands

```sh
cd apps/galley
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m49?sslmode=disable'
gofmt -l . && go vet ./... && go build ./...
go test ./... -count=1
go test -race -count=1 -run 'Progress|Usage|ListTicketRounds|RoundActivity|RoundEvent|NoExecution' ./internal/httpapi
./scripts/check-contract-drift.sh      # with the regenerated api.gen.go staged
cd ../../contracts && npm ci && npm run check:swiftlet-drift && npm run check:michelin-drift
cd ../apps/michelin && npm ci && npm run typecheck && npm test
cd ../swiftlet && npm ci && npm test && npm run build
cd ../../e2e && env -u FORCE_COLOR E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m49?sslmode=disable' ./run.sh
```

## Observed results

**Checks.**

- `gofmt -l .` printed nothing. `go vet ./...` and `go build ./...` were
  clean.
- Galley `go test ./... -count=1`: 7 packages `ok` (3 have no tests).
  286 top-level tests, 976 with subtests; 0 failed, 0 skipped.
- `go test -race` on the new and event tests: 62 top-level tests pass,
  with no race report.
- Drift checks, with the regenerated files staged:
  - `OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).`
  - `OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`
  - `OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`
- Michelin: typecheck clean; 9 files, 194 tests passed (was 155).
- Swiftlet: 21 files, 373 tests passed (was 340); `npm run build`
  succeeded.
- Browser suite: `SUITE PASSED`, 35 specs with exit code 0, 83 tests
  passed (was 34 and 82). `runner-engine.spec.ts` passed in 13.8 s and
  `runner-activity.spec.ts` in 22.5 s.
- The first full run failed in `runner-engine.spec.ts` (M4.8), not in
  this slice's code. That spec read the body of a
  `/api/runner-health` response, and the page's next navigation had
  already discarded it ("No resource with given identifier found"). The
  assertion now checks that response's status and reads Galley's live
  health from the API. The second full run passed.

**New Galley tests** (`round_activity_usage_test.go`, plus additions to
`contract_test.go`, `round_events_test.go` and
`no_execution_side_effects_test.go`):

| Test | What it pins |
| --- | --- |
| `TestProgress_AppendsActivityInArrivalOrderAndChangesNoStatus` | `201` bodies with `seq` 1, 2, 3; rows in order; Ticket status, `updated_at` and Round unchanged |
| `TestProgress_…Replay…`, `TestUsage_…Replay…` | same bytes → `200`, identical body, full-table snapshot unchanged; still `200` after the Round ended |
| `TestProgressAndUsage_SameKeyWithADifferentPayloadConflicts` | nine variants: another note, instant, cost, basis, generation id or epoch, and keys reused across types → `409 idempotency_key_conflict`, no change |
| `TestProgressAndUsage_StaleClaimEpochIsRejectedWithNoChange` | epochs 1 and 3 against 2 → `409 stale_claim_epoch`, no row |
| `TestProgressAndUsage_OnAClaimedRoundAreOutOfOrder`, `…OnAnEndedRound…` | `409 event_out_of_order` / `round_not_open`, no change; the same key accepted once started |
| `TestProgressAndUsage_UnknownAndForeignRoundsAreTheSameNotFound` | four forms, one `404` body |
| `TestUsage_ObservationsWithoutAProviderIDNeverCollide`, `…SameProviderGenerationID…` | distinct rows, never merged |
| `TestUsage_TheKeyIsTheObservationID`, `…RecordedForAnotherRoundConflicts` | seven forms → `400`: another key, a key differing in case, uppercase, braced, unhyphenated, nil and non-UUID ids; the stored event key equals the row's id; cross-Round reuse → `409 observation_id_conflict` |
| `TestUsage_StrictDecodeRejectsMalformedDataWithNoChange` | 42 malformed bodies → `400`, snapshot unchanged; all-unknown and at-the-bounds bodies → `201` |
| `TestProgress_NoteLimitsAtTheAPI`, `TestRoundActivity_TheDatabaseEnforcesItsInvariants`, `TestUsageObservations_TheDatabaseEnforcesItsInvariants` | limits at both layers; each CHECK and key named by `ConstraintName` |
| `TestUsage_NumericPrecisionRoundTrips` | the sums above, exact |
| `TestRoundUsageSummary_UnknownPartialCompleteAndEstimated` | each summary case |
| `TestListTicketRounds_ActivityIsTheLatest50OldestFirst` | 60 notes → seq 11..60 |
| `TestListTicketRounds_ActivityAndUsageBelongToTheirRoundAndOwner`, `…SurviveANewServer` | scoping; a new server on the same database returns the same JSON |
| `TestProgress_ConcurrentNotesGetDistinctGapFreeSeq`, `TestProgressAndUsage_ConcurrentIdenticalEventsApplyExactlyOnce` | 72 distinct gap-free seq; 16 identical events → one `201`, the rest `200`, one row |
| `TestProgressAndUsage_RacingTheOwnersCommands…`, `…OwnerRoutesWriteNoActivityOrUsage` | no deadlock; an Owner session cannot report |
| `TestRoundEvents_ResponsesMatchContractAndMethod405` | every new `201`/`200`/`400`/`409` body, and the rounds list with 51 notes, validated against the contract |

**Browser suite.** `tests/runner-activity.spec.ts` drives a real
Michelin with the script below. It passed in 22.5 s.

1. `start`.
2. A progress note.
3. Wait 10 s.
4. An estimated observation.
5. Wait 10 s.
6. A reported observation with unknown cost and output tokens.
7. A second note.
8. `hold`.

The receipt showed, in order, all from its own 3 s refresh:

1. the note, with every figure "Unknown" and no `$0`;
2. "$0.0045 est.", "1,200 est.", "300 est." and "2.0 s est.";
3. both notes, "≥ $0.0045 (incomplete) est.", "1,250 est.",
   "≥ 300 (incomplete) est." and "2.5 s est.".

Galley's live summary equalled `{observations: 2, complete: false,
estimated: true, costUsd: "0.004500", …}`, and a reload showed the same.
Michelin logged two distinct observationIds and not the credential.

**Falsification.** Each change was applied, the named tests were run,
and the file was restored from a backup and checked byte-identical.

| # | Change | Result |
| --- | --- | --- |
| 1 | Skip the idempotency lookup | 11 failed, including `TestProgress_ReplayAppendsNothing…`, `TestUsage_ReplayAppendsNothing…`, `TestProgressAndUsage_SameKeyWithADifferentPayloadConflicts`, `TestProgressAndUsage_ConcurrentIdenticalEventsApplyExactlyOnce` and the contract test, plus M4.8's six replay and ladder tests |
| 2 | Drop all three locks (priority, Ticket, Round row) | 3 failed: `TestProgress_ConcurrentNotesGetDistinctGapFreeSeq` (duplicate `seq`), `TestProgressAndUsage_ConcurrentIdenticalEventsApplyExactlyOnce`, `TestRoundEvent_TakesTheOwnersPriorityLock…` |
| 2b | Drop only the Round row `FOR UPDATE` | All passed. The Ticket row lock alone serialises a Round's events, and the inserts' foreign keys still conflict with a held Round row lock, so the lock-order probe cannot tell. The `appendActivity` comment was corrected to name the Ticket row lock |
| 3 | Accept progress and usage on a claimed Round | `TestProgressAndUsage_OnAClaimedRoundAreOutOfOrder` failed (the handler dereferenced the nil `started_at` and the test binary panicked); `TestDecideRoundEvent` failed |
| 4 | Skip key == observationId | 2 failed: `TestUsage_TheKeyIsTheObservationID`, the contract test |
| 5 | `complete` ignores unknown costs | 3 failed: `TestRoundUsageSummary_…`, `TestUsage_TheSameProviderGenerationID…`, the contract test |
| 6 | Unknown cost summed as zero (`COALESCE(sum, 0)`) | `TestRoundUsageSummary_UnknownPartialCompleteAndEstimated` |
| 7 | Drop the 50-note window | 2 failed: `TestListTicketRounds_ActivityIsTheLatest50OldestFirst`, the contract test |
| 8 | Accept a blank note at the API | 2 failed: `TestProgress_NoteLimitsAtTheAPI`, the contract test |
| 9 | Cost through `float4` in SQL | 2 failed: `TestUsage_NumericPrecisionRoundTrips`, `TestUsage_StrictDecodeRejects…` |
| 10 | Treat `ON CONFLICT DO NOTHING` as recorded | 2 failed: `TestUsage_AnObservationIDRecordedForAnotherRoundConflicts`, the contract test |
| 11 | Drop the DB note-length CHECK (migration) | `TestRoundActivity_TheDatabaseEnforcesItsInvariants` |
| M1 | Michelin regenerates the observationId on each attempt | 3 failed in `engine.test.ts`: "generates one observationId per usage step and resends it, in the identical body, on every retry", the key test and the default-script test |
| M2 | Michelin keys usage by step index | 6 failed: the key, retry, two result-validation and default-script tests in `engine.test.ts`, and the `main.test.ts` process test. On the first try the engine-test worker aborted on an endless instant retry; the fake Galley now refuses after 50 calls so the test fails cleanly |
| S1 | Swiftlet shows an unknown cost as `$0.00` | 2 failed: "…shows no activity and usage as Unknown, never as zero", "observed but every cost unknown" |
| S2 | No "est." tag | 2 failed: the two estimated cases |
| S3 | Rounds not refetched on the tick | 2 failed: the same-tick refresh test and the refresh-failure test |
| S4 | Incomplete shown as a plain figure | 2 failed: both incomplete cases |

## Implementation limitations and follow-ups

- **Aggregation, reporting and enrichment are M9
  ([#10](https://github.com/cristoforows/ticketIt/issues/10)).** M4 keeps
  one row per observation and never merges or updates one. Later or
  partial reconciliation joins on `provider_generation_id`, which is
  stored but not used. There are no per-Ticket, per-Agent or period
  totals.
- **Count sums are not bounded.** One observation's count is at most
  2^53−1, but a Round's sum is not. Above 2^53−1, Swiftlet's JSON parse
  loses precision. Above 2^63−1, the `::bigint` cast fails and the rounds
  list answers `500`. Reaching that takes more than a thousand
  maximal observations on one Round. Bounded aggregation belongs to M9
  (#10).
- **`observation_id_conflict` spans Owners.** `usage_observations.id` is
  a global primary key, as the Decisions specify. A runner that sends a
  UUID another Owner already recorded learns that it exists. Finding one
  means guessing a random 122-bit UUID, so this is recorded rather than
  worked around.
- **Only the latest 50 notes are on the wire.** There is no paging to
  older notes. Round history in the receipt is M4.11 and M5
  ([#6](https://github.com/cristoforows/ticketIt/issues/6)).
- **Swiftlet shows activity and usage only for the open Round.** The
  section goes away when the Round ends, as M4.8's section did. Ended
  Rounds in the receipt are M4.11.
- **A Round still never ends in M4.9.** `deliver` is M4.10
  ([#136](https://github.com/cristoforows/ticketIt/issues/136)), so the
  browser suite resets the database before each of its three
  Round-holding specs. Galley tests end Rounds with SQL.
- **Times on the receipt are raw RFC 3339**, as M4.8's start time is.
  Local formatting belongs with the visual work for Rounds in M5.

## Outstanding checks and owning milestone

- Delivery and the full default script through the same endpoint: M4.10
  (#136).
- Real provider usage (OpenRouter/OpenCode), reported versus estimated
  from a live engine, and enrichment by generation id: M9 (#10). M4 makes
  no provider call.
- Reconciling a Round whose runner is gone, including observations that
  arrive late: M5 (#6, D5).
- The milestone gate reconciles `docs/evidence/m4/README.md`,
  `docs/open-decisions.md` and the plan documents; this slice does not
  edit them.

## Decision impacts (open-decision IDs)

- **D5** (stranded-runner recovery): a stale or replayed note or
  observation changes nothing, and a late one for an ended Round is
  refused with no change. Recovery is not decided here.
- None of D1, D2, D4 or D6–D9.
