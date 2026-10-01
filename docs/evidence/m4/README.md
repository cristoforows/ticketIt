# M4 evidence index

[M4 — Connected runner and durable controlled Rounds (#5)](https://github.com/cristoforows/ticketIt/issues/5) has eleven implementation slices (#127–#137), all merged to `main`. [M4.12 (#138)](https://github.com/cristoforows/ticketIt/issues/138) records the gate on branch `m4/138-gate` at `main` `24de28f`. M4 executes only Michelin's scripted controlled engine: no model, provider, object storage or GitHub call.

## Records

| File | Issue / PR | Establishes | Headline result |
| --- | --- | --- | --- |
| [127-agents.md](127-agents.md) | [#127](https://github.com/cristoforows/ticketIt/issues/127) / [#140](https://github.com/cristoforows/ticketIt/pull/140) | Reusable Agents and Agent assignment, with no execution | Owner isolation held through HTTP (foreign Agent → `404`); removing the `owner_id` filter turned `TestAgents_OwnersAreIsolatedThroughHTTP` red. |
| [128-agent-readiness.md](128-agent-readiness.md) | [#128](https://github.com/cristoforows/ticketIt/issues/128) / [#141](https://github.com/cristoforows/ticketIt/pull/141) | Ready for an Agent-assigned Ticket needs its inputs in either order; In Progress, In Review and Blocked are execution-owned | The clear-versus-Ready race test saw both winners (14/6 and 10/10 of 20 trials); removing `FOR UPDATE` failed it. |
| [129-michelin-boot.md](129-michelin-boot.md) | [#129](https://github.com/cristoforows/ticketIt/issues/129) / [#139](https://github.com/cristoforows/ticketIt/pull/139) | `apps/michelin` boots, polls Galley's status and exits cleanly | 30 tests passed; a local run logged three `galley status ok` lines, two `unreachable` errors, and exit 0 on `SIGINT`. |
| [130-runner-pairing.md](130-runner-pairing.md) | [#130](https://github.com/cristoforows/ticketIt/issues/130) / [#142](https://github.com/cristoforows/ticketIt/pull/142) | One runner credential per Owner, bearer authentication, registration, heartbeat and derived health | Runner bearer tokens and Owner sessions were refused on each other's routes across all 25 non-public Owner operations; disconnect changed no Ticket. |
| [131-priority-order.md](131-priority-order.md) | [#131](https://github.com/cristoforows/ticketIt/issues/131) / [#143](https://github.com/cristoforows/ticketIt/pull/143) | Owner priority order and reorder command, the order [#108](https://github.com/cristoforows/ticketIt/issues/108) makes the claim order | 16- and 24-writer concurrency tests kept a strict total order; the browser compared board and list order with live `GET /api/tickets`. |
| [132-claims.md](132-claims.md) | [#132](https://github.com/cristoforows/ticketIt/issues/132) / [#144](https://github.com/cristoforows/ticketIt/pull/144) | Atomic claim creates a durable Round and takes the Owner's sequential slot; the Ticket stays Ready | Concurrent claims created one Round; archive-versus-claim raced both ways with one winner. |
| [133-open-round-lock.md](133-open-round-lock.md) | [#133](https://github.com/cristoforows/ticketIt/issues/133) / [#145](https://github.com/cristoforows/ticketIt/pull/145) | Every Owner mutation of a Ticket with an open Round is `400 round_open`; read-only receipt and lock glyph | Every mutation was rejected while open and accepted once the Round was closed (by SQL, as no Round could end yet). |
| [134-controlled-engine.md](134-controlled-engine.md) | [#134](https://github.com/cristoforows/ticketIt/issues/134) / [#146](https://github.com/cristoforows/ticketIt/pull/146) | Michelin's controlled engine, the runner event endpoint, `execution_started`, idempotency and epoch fencing | A real Michelin started a claimed Round with no browser open; replay, conflicting payload and stale epoch each left state unchanged. |
| [135-activity-usage.md](135-activity-usage.md) | [#135](https://github.com/cristoforows/ticketIt/issues/135) / [#147](https://github.com/cristoforows/ticketIt/pull/147) | Append-only activity notes and usage observations with an application-owned observation identity | Replays appended nothing; unknown usage stayed null, never zero; the receipt matched Galley's live summary after reload. |
| [136-delivery.md](136-delivery.md) | [#136](https://github.com/cristoforows/ticketIt/issues/136) / [#148](https://github.com/cristoforows/ticketIt/pull/148) | `delivered` stores the result, ends the Round, frees the slot, lifts the lock and moves the Ticket to In Review | A delivery replay returned the stored result and kept one deliverable; a Coding Ticket stopped at In Review with Accept refused. |
| [137-rework.md](137-rework.md) | [#137](https://github.com/cristoforows/ticketIt/issues/137) / [#151](https://github.com/cristoforows/ticketIt/pull/151) | Explicit rework returns a delivered Ticket to Ready; the next claim creates Round 2 with a new epoch | Round 1's rows and deliverable were unchanged after Round 2 delivered; Round 1 events could not affect Round 2. |

Context, not M4 slices: [#149](https://github.com/cristoforows/ticketIt/pull/149) and [#150](https://github.com/cristoforows/ticketIt/pull/150) changed the board default and the e2e list routes; #150 fixed the 35 tests #149 broke.

## Clean-worktree gate verification (M4.12, 2026-10-02)

Run on a clean detached worktree of `main` `24de28f`. Go 1.27.1, Node 26.9.0/npm 11.19.1, PostgreSQL 18.1 (Debian build). `ticketit_m4_gate_test` was created fresh with **0 public tables** before Galley's tests applied migrations; `run.sh` reset only `ticketit_m4_gate_e2e`'s `public` schema. No deployment was part of this gate.

### Galley and Go contract drift

```sh
cd apps/galley
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_m4_gate_test?sslmode=disable'
gofmt -l . && go vet ./... && go build ./...
go test ./... -count=1 -v
go test -race ./... -count=1 -p 1
./scripts/check-contract-drift.sh
```

Observed: `gofmt -l .` emitted nothing; `go vet` and `go build` exited 0. `go test ./... -count=1 -v`: every package `ok` (`internal/httpapi` in `93.307s`); 314 top-level tests, 1086 with subtests, 0 `--- FAIL`, 0 `--- SKIP`. `go test -race ./... -count=1 -p 1`: every package `ok` (`internal/httpapi` in `117.965s`), no race report. `OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).`

### TypeScript contract drift

```sh
cd contracts
npm ci
npm run check:swiftlet-drift
npm run check:michelin-drift
```

Observed: `OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).` and `OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`

### Michelin

```sh
cd apps/michelin
npm ci && npm run typecheck && npm test
```

Observed: typecheck clean; `Test Files  9 passed (9)`, `Tests  235 passed (235)`.

### Swiftlet

```sh
cd apps/swiftlet
npm ci && npm test && npm run build
```

Observed: `tsc` clean; `Test Files  24 passed (24)`, `Tests  436 passed (436)`; production build transformed 293 modules.

### Browser-to-backend suite

```sh
cd e2e
env -u FORCE_COLOR E2E_DATABASE_URL='postgres://localhost:5432/ticketit_m4_gate_e2e?sslmode=disable' ./run.sh
```

Observed, three full runs (Chromium headless shell against a real Swiftlet build, Galley, PostgreSQL and the local substitute GitHub OAuth provider; each at `migrations applied: schema version 16`; a **local** run, not CI):

1. **Unmodified `main` `24de28f`: `[run.sh] SUITE FAILED`.** 36 of 37 spec invocations exited `0`, 86 tests passed and 1 failed. The failure was `ticket-capture.spec.ts` "Enter in the bar opens the modal with the typed title, and a title alone creates a Ticket" (`expect(ticket).toBeDefined()` received `undefined`). The spec read `GET /api/tickets` straight after clicking submit, without waiting for the create request to finish, so it raced the response. [137](137-rework.md) had seen the same failure once.
2. **Fix, in this slice:** the spec now waits for the `POST /api/tickets` response, as its sibling "creates a Ticket with details in one request" test does, and looks the Ticket up by the returned ID.
3. **Two full reruns with the fix: `[run.sh] SUITE PASSED` both times.** Each run: all 37 spec invocations exited `0` and 87 tests passed, including `agents`, `agent-readiness`, `runner`, `runner-claims`, `runner-engine`, `runner-activity`, `runner-delivery` and `runner-rework` and `ticket-priority-order`.

## Acceptance criteria verification (#5)

Each row of #5's seven criteria is split into the parts #138 names. Test names are Galley tests in `apps/galley/internal/httpapi` unless marked; specs are in `e2e/tests/`. Anything not demonstrated, or that depends on M5 behaviour (Stop, Failed, Interrupted, reconciliation, stranded recovery, D5), is **Pending → #6**.

| # | Criterion part | Verdict | Evidence | Caveat / pending |
| --- | --- | --- | --- | --- |
| 1a | Agent first, then Ready, yields an eligible Ticket | **Verified** | [128](128-agent-readiness.md): `TestAgentReadiness_EitherOrderGrid`, `TestAgentReadiness_ClearingRequiredInputOnReadyAgentTicket`; `agent-readiness.spec.ts` "A research Agent first, then Ready: …". | |
| 1b | Ready first, then an Agent, yields an eligible Ticket | **Verified** | [128](128-agent-readiness.md): `TestAgentReadiness_EitherOrderGrid`, `TestAgentReadiness_SwitchingToCodingAgentOnReadyTicketNeedsRepository`, `TestAgentReadiness_ConcurrentClearAndReadinessNeverBothApply`; `agent-readiness.spec.ts` "Ready first, then a coding Agent: …". | |
| 1c | Competing claims produce one execution | **Verified** | [132](132-claims.md): `TestClaim_ConcurrentClaimsCreateExactlyOneRound`, `TestClaim_SecondClaimWhileARoundIsOpenIsNoWork`, `TestRounds_DatabaseEnforcesTheSlotAndInvariants`; [134](134-controlled-engine.md): `TestRoundEvent_ConcurrentIdenticalEventsApplyExactlyOnce`, `TestRoundEvent_ConcurrentEventsWithDifferentKeysStartTheRoundOnce`. | Races are concurrent HTTP requests on one runner credential; v1 pairs one runner per Owner and no spec races two Michelin processes. `…DifferentKeysStartTheRoundOnce` failed once under load in [137](137-rework.md) and passed on rerun; [#152](https://github.com/cristoforows/ticketIt/issues/152). |
| 2a | Queued work stays Ready until execution starts | **Verified** | [132](132-claims.md), [134](134-controlled-engine.md): `TestClaim_CreatesOneRoundAndLeavesTheTicketReady`, `TestRoundEvent_ExecutionStartedStartsTheRoundAndMovesTheTicketToInProgress`, `TestRoundEvent_OnlyAnExecutionStartedEventMovesAnAgentTicketToInProgress`; `runner-claims.spec.ts` (claimed Ticket is Ready), `runner-engine.spec.ts` (In Progress only after the started event), `runner-delivery.spec.ts` "a second queued Ticket is claimed only once the first delivers, …" (second Ticket Ready with no Round, polled every 250 ms). | |
| 2b | Unavailable Michelin does not imply In Progress | **Verified** | [132](132-claims.md), [130](130-runner-pairing.md): `TestClaim_RunnerMustBeConnected` (no heartbeat or expired window → `204`, Ticket Ready, no Round), `TestRunnerDisconnect_ChangesNoTicket` (31 s, 1 h, 48 h: API, rows and table counts unchanged); `runner.spec.ts` "a paired Michelin shows Connected, and once it stops, Runner disconnected with no Ticket changed". | A runner lost after the Round started leaves the Ticket In Progress and locked by design; resolving it is **Pending → [#6](https://github.com/cristoforows/ticketIt/issues/6)** (D5). |
| 3a | Archived Tickets cannot execute | **Verified** | [128](128-agent-readiness.md), [132](132-claims.md): `TestAgentWorkRequest_ArchivedTicketsNeverRequest`, `TestClaim_RechecksTheLockedTicket/archived`, `TestArchive_RejectedWhileARoundIsOpenAndAllowedWithout`. | |
| 3b | Insufficiently defined Tickets cannot execute | **Verified** | [128](128-agent-readiness.md), [132](132-claims.md): `TestAgentReadiness_ClearingRequiredInputOnReadyAgentTicket`, `TestClaim_SkipsAnIneligibleTopCandidate`, `TestClaim_RechecksTheLockedTicket/inputs_cleared`; `agent-readiness.spec.ts` (both tests). | Repository is checked only for being non-blank; a reference the runner cannot check out is **Pending → [#9](https://github.com/cristoforows/ticketIt/issues/9)**. |
| 3c | Archive-versus-claim races | **Verified** | [132](132-claims.md): `TestClaimAndArchive_RaceEitherOrder`, `TestClaim_ArchiveCommittedWhileTheClaimWaitsIsNotClaimed`; the same test ran again in [133](133-open-round-lock.md)'s suite. | Galley-level only; no browser spec races archive and claim. The "inputs cleared" race is simulated under a held row lock (`TestClaim_RechecksTheLockedTicket`), as the API refuses the clear itself. |
| 4a | Ticket fields are locked during an open Round | **Verified** | [133](133-open-round-lock.md): `TestOpenRoundLock_EveryMutationRejectedWhileOpenAndAcceptedOnceClosed`, `TestTicketAllowedActions_MatchCommandsWhileARoundIsOpen`, `TestClaimAndUnassign_RaceEitherOrder`; [134](134-controlled-engine.md): `TestRoundEvent_RacingTheOwnersCommandsNeitherDeadlocksNorLeavesInconsistentState` (running Round); [136](136-delivery.md): `TestDelivered_ReleasesTheOpenRoundLock`; `runner-claims.spec.ts`, `runner-engine.spec.ts`. | Delivery is the only way a Round ends in M4; lock behaviour for `waiting_for_input`, Stop, Failed and Interrupted is **Pending → [#6](https://github.com/cristoforows/ticketIt/issues/6)**. |
| 4b | Browser closure does not stop a live runner | **Verified** | [134](134-controlled-engine.md): `runner-engine.spec.ts` starts the Round with no browser open, closes a browser mid-Round, and asserts Michelin's process is still running and the Round unchanged; [137](137-rework.md): `runner-rework.spec.ts` claims, starts and delivers Round 1 with no page open (its context has no page until after delivery). | No spec closes an open page and then observes the same Round deliver; the two specs together cover each half. |
| 5a | Delivery enters In Review, not Done | **Verified** | [136](136-delivery.md): `TestDelivered_MovesTheTicketToInReviewAndRetainsTheDeliverable`; `runner-delivery.spec.ts` "a Basic Ticket goes Ready, claimed, running, delivered to In Review on the open receipt without a reload, …". | |
| 5b | Only the retained completion condition determines completion | **Partially verified** | [136](136-delivery.md): `TestDelivered_AcceptFollowsTheRetainedCompletionCondition`; `runner-delivery.spec.ts` (Basic: Accept → Done; Coding: "stops at In Review, with Accept refused by both the receipt and the command"). | `humanAcceptance` completion is demonstrated. `reviewedPrMerge` is only shown to be refused (`reviewed_pr_merge_not_implemented`); completion by merge is **Pending → [#9](https://github.com/cristoforows/ticketIt/issues/9)** (D2, D4). |
| 6 | Explicit rework creates a new Round and retains prior results and usage | **Verified** | [137](137-rework.md): `TestRework_TheNextClaimCreatesRound2AndRound1IsRetainedUnchanged`, `TestRework_Round1EventsCannotAffectRound2`, `TestRework_NothingRestartsOrRequeuesADeliveredRound`; `runner-rework.spec.ts` "explicit rework delivers a second Round and the receipt keeps both Rounds' results and usage". | Rework starts only from In Review after delivery. Requeue after Stop, Failed or Interrupted is **Pending → [#6](https://github.com/cristoforows/ticketIt/issues/6)**. |
| 7a | Repeated claims and pulled-command replay do not duplicate execution | **Partially verified** | [132](132-claims.md): `TestClaim_SecondClaimWhileARoundIsOpenIsNoWork`, `TestClaim_ConcurrentClaimsCreateExactlyOneRound`. | A repeated claim creates no second Round, but a claim is not idempotency-keyed: a committed claim whose `201` is lost strands the Round and later polls get `204` (**Pending → [#6](https://github.com/cristoforows/ticketIt/issues/6)**, D5). No pulled commands (Stop, answers) exist, so their replay is **Pending → [#6](https://github.com/cristoforows/ticketIt/issues/6)**. |
| 7b | Event replay does not duplicate execution | **Verified** | [134](134-controlled-engine.md): `TestRoundEvent_ReplayReturnsTheOriginalResultAndChangesNothing`, `TestRoundEvent_SameKeyWithADifferentPayloadConflicts`, `TestRoundEvent_StaleClaimEpochIsRejectedWithNoStateChange`, `TestRoundEvent_ConcurrentIdenticalEventsApplyExactlyOnce`; Michelin `engine.test.ts` "resends the identical bytes under the same key on every retry, and accepts a replay". | No spec drops a response to force a real retry; Michelin's retry is tested with an injected `fetch`. |
| 7c | Delivery replay does not duplicate deliveries | **Verified** | [136](136-delivery.md): `TestDelivered_ReplayReturnsTheOriginalResultAndRetainsOneDeliverable`, `TestDelivered_ConcurrentDeliveriesApplyExactlyOnce`; [137](137-rework.md): `TestRework_Round1EventsCannotAffectRound2` (Round 1 delivery replay after Round 2 exists). | |
| 7d | Usage replay does not duplicate usage observations | **Verified** | [135](135-activity-usage.md): `TestUsage_ReplayAppendsNothingAndReturnsTheOriginalResult`, `TestUsage_TheKeyIsTheObservationID`, `TestUsage_AnObservationIDRecordedForAnotherRoundConflicts`, `TestProgressAndUsage_ConcurrentIdenticalEventsApplyExactlyOnce`; Michelin `engine.test.ts` "generates one observationId per usage step and resends it, in the identical body, on every retry". | Same no-dropped-response limit as 7b. |
| P | Presentation: order-rail components; Agent and runner state on slip and receipt; WCAG AA; reduced motion | **Partially verified** | Slip and receipt: `runner-engine.spec.ts` (assignee, lock glyph, Rounds section), `runner-delivery.spec.ts` ("Delivered by" on slip and receipt), `runner.spec.ts` (header health pill), [133](133-open-round-lock.md). Contrast: `tokens.test.ts` asserts ≥ 4.5:1 for the queued, claimed, delivered, estimate and lock pairs and all nine health-pill pairs ([130](130-runner-pairing.md), [132](132-claims.md), [135](135-activity-usage.md)). Motion: no M4 change adds animation (`HealthPill` is asserted animation-free); the existing `slip motion` test covers reduced motion for the slip. Keyboard: `Disclosure.test.tsx` ([137](137-rework.md)). | No manual screen-reader pass or automated accessibility audit of the new screens ([130](130-runner-pairing.md)); [#157](https://github.com/cristoforows/ticketIt/issues/157). The greyed active card, delivery animation and View/Stop controls are **Pending → [#6](https://github.com/cristoforows/ticketIt/issues/6)**. |

## M1 sanity-check follow-up (#5 comment)

| Checkbox | Status | M4 did | Owner for the rest |
| --- | --- | --- | --- |
| Keep lost contact, unknown execution, stale reports and confirmed cessation distinct; close or unlock nothing because a check failed | **Partially verified** | No M4 path ends a Round except `delivered`. Disconnect changes no Ticket (`TestRunnerDisconnect_ChangesNoTicket`; `runner-engine.spec.ts` keeps the Ticket In Progress and locked with **Runner disconnected**). A stale epoch is `409 stale_claim_epoch` and an ended Round `409 round_not_open`, each with no change (`TestRoundEvent_StaleClaimEpochIsRejectedWithNoStateChange`, `TestRoundEvent_EndedAndRunningRoundsRejectNewEventsWithNoStateChange`). [execution-interface.md](../../contracts/execution-interface.md) now states the distinction and no longer makes a failed check Interrupted. | **Pending → [#6](https://github.com/cristoforows/ticketIt/issues/6)**: unknown-execution and cessation reports, reconciliation and stranded recovery (D5) do not exist. |
| Round identity independent of engine identity; terminal outcomes explicit | **Partially verified** | Round IDs are Galley-issued and `rounds` has no engine column (`TestRounds_IdentityIsGalleyIssuedAndHasNoEngineReference`); engine references are a separate table with at most one current (`TestEngineReferences_AtMostOneIsCurrentAndThePriorIsRetained`). `delivered` is the one explicit terminal outcome. | **Pending → [#6](https://github.com/cristoforows/ticketIt/issues/6)**: the terminal-Stop regression checks and the Stop, Failed and Interrupted outcomes. |
| Observations carry a stable application-owned identity when provider IDs are absent | **Verified** for M4's scope | [135](135-activity-usage.md): `observationId` is a runner-generated UUID, the idempotency key and the global primary key; `providerGenerationId` is nullable, non-unique and never identity (`TestUsage_ObservationsWithoutAProviderIDNeverCollide`, `TestUsage_TheSameProviderGenerationIDIsKeptTwiceAndNotMerged`, `TestUsage_TheKeyIsTheObservationID`). No `"unknown-generation"` fallback exists. Observations stay attributed to their Round. | [#10](https://github.com/cristoforows/ticketIt/issues/10): late or partial enrichment, aggregation and detailed regression checks. |

## Follow-ups

"New issue" rows were opened by this gate. All other limitations named in the eleven records were resolved by a later slice (for example #132's "archive is the only block" by #133, the never-ending Round by #136, Round history by #137) or are listed under "Existing owner".

| Item | Source | Disposition | Proposed labels |
| --- | --- | --- | --- |
| `TestRoundEvent_ConcurrentEventsWithDifferentKeysStartTheRoundOnce` failed once at 6 s under load and passed on rerun; the cause is undiagnosed. | [137](137-rework.md) | New issue [#152](https://github.com/cristoforows/ticketIt/issues/152) → **M5 [#6](https://github.com/cristoforows/ticketIt/issues/6)**, which extends the same event ladder | `bug`, `ready-for-agent` |
| Only the events endpoint caps its request body; every other endpoint reads unbounded bodies. | [136](136-delivery.md) | New issue [#153](https://github.com/cristoforows/ticketIt/issues/153) → **M10 [#11](https://github.com/cristoforows/ticketIt/issues/11)** | `ready-for-agent` |
| A Done Ticket moved to Ready queues a new Round without the rework command, as D3 permits (`TestDelivered_ADoneTicketMovedBackToReadyIsQueuedForANewRound`); whether that stays the reopen route for Agent Tickets is undecided. | [136](136-delivery.md), [D3](../../decisions/d3-agent-template-compatibility.md) | New issue [#154](https://github.com/cristoforows/ticketIt/issues/154) → **M5 [#6](https://github.com/cristoforows/ticketIt/issues/6)** (reopened-Ticket grants); merged-PR reopening stays D4/[#9](https://github.com/cristoforows/ticketIt/issues/9) | `ready-for-human` |
| A Round's usage sum has no bound: above 2^53−1 Swiftlet loses precision, above 2^63−1 the rounds list answers `500`; `observation_id_conflict` reveals another Owner's observation ID. | [135](135-activity-usage.md) | New issue [#155](https://github.com/cristoforows/ticketIt/issues/155) → **M9 [#10](https://github.com/cristoforows/ticketIt/issues/10)** | `bug`, `ready-for-agent` |
| A queued Ticket is polled at every refresh interval for as long as it waits, with no backoff. | [137](137-rework.md) | New issue [#156](https://github.com/cristoforows/ticketIt/issues/156) → **M10 [#11](https://github.com/cristoforows/ticketIt/issues/11)** (sleeping free-tier hosting) | `ready-for-agent` |
| No manual screen-reader or keyboard pass over Agents, Runner, the slip and receipt states, or the Rounds section. | [130](130-runner-pairing.md) | New issue [#157](https://github.com/cristoforows/ticketIt/issues/157) → **M10 [#11](https://github.com/cristoforows/ticketIt/issues/11)** | `ready-for-human` |
| Stranded claim (lost `201`, dead Michelin) and stranded `running` Round; a restarted Michelin cannot resume or claim while the slot is taken; events are scoped to the Owner, not a runner identity; Michelin retries a report forever while Galley is down. | [132](132-claims.md), [134](134-controlled-engine.md) | Existing owner **M5 [#6](https://github.com/cristoforows/ticketIt/issues/6)** (D5); add as inputs by comment | |
| Local time formatting on the receipt; notes beyond the latest 50 have no paging; the receipt's Runner disconnected notice can lag the header by up to 10 s; the e2e `run.sh` database resets exist only because no Round can be stopped. | [134](134-controlled-engine.md), [135](135-activity-usage.md), [137](137-rework.md) | Existing owner **M5 [#6](https://github.com/cristoforows/ticketIt/issues/6)** (active card, View, Stop) | |
| Agent delete or retirement, model, instructions, Skills, provider settings, kind changes; no assignment history. | [127](127-agents.md) | Existing owner **M6 [#7](https://github.com/cristoforows/ticketIt/issues/7)** | |
| Reports are stored in PostgreSQL (1 MiB) pending object storage. | [136](136-delivery.md) | Existing owner **M7 [#8](https://github.com/cristoforows/ticketIt/issues/8)** (D7) | |
| Repository reference is checked only for being non-blank; reviewed-PR-merge evidence. | [128](128-agent-readiness.md), [136](136-delivery.md) | Existing owner **M8 [#9](https://github.com/cristoforows/ticketIt/issues/9)** (D2, D4) | |
| Usage aggregation, per-Ticket, per-Agent and period totals, enrichment by `providerGenerationId`. | [135](135-activity-usage.md) | Existing owner **M9 [#10](https://github.com/cristoforows/ticketIt/issues/10)** | |
| The browser suite is not in CI. | [130](130-runner-pairing.md) | Existing [#109](https://github.com/cristoforows/ticketIt/issues/109), **M10 [#11](https://github.com/cristoforows/ticketIt/issues/11)** | |
| Priority renumbering updates all of an Owner's Tickets in one statement and was exercised at test sizes only. | [131](131-priority-order.md) | Accepted; v1 has one Owner with a personal backlog. | |
| The not-blank CHECK on notes and Reports covers ASCII whitespace only; Galley validation rejects every Unicode-blank value. | [136](136-delivery.md) | Accepted; the CHECK is a backstop. | |

## Scope and decisions

M4 is a controlled-engine milestone: no real model, research, coding, GitHub, Stop, Failed, Interrupted, questions, Permissions or recovery. No open decision D1, D2 or D4–D9 is resolved by #138; [open decisions](../../open-decisions.md) records the M4 observations, including the [#108](https://github.com/cristoforows/ticketIt/issues/108) queue-order decision as shipped.
