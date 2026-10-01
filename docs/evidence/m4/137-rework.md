# Explicit rework creates a new Round

## Purpose

M4.11, [#137](https://github.com/cristoforows/ticketIt/issues/137): the
Owner can return a delivered, Agent-assigned Ticket to Ready with one
command. The next claim creates Round 2 with a new ID and a new claim
epoch. Round 1's result, activity and usage stay unchanged and visible,
and nothing else requeues or restarts a Round.

Touches `contracts/`, `apps/galley`, `apps/swiftlet` and `e2e/`.
Michelin's code is unchanged: it already sends the epoch it was claimed
with.

## What already existed

- **M4.10 (#136):** delivery to In Review, `Ticket.delivery`,
  `GET /api/tickets/{id}/rounds` with deliverables, Accept.
- **Every Round had `claim_epoch` 1.** Fencing therefore could not tell
  Round 2 from Round 1 for the same Ticket.
- **The receipt refreshed only while a Round was open.** A Ticket in
  Ready waiting for a claim was never refetched.
- **Receipt layout:** an open Round, then a separate list of delivered
  Rounds.
- **No rework.** An Agent-assigned In Review Ticket had no status change.
- Migrations up to `000016`. Baseline on `dfa695d` (this branch's merge
  base; `origin/main` has since gained #149, a Swiftlet board change,
  and #150, its e2e fix; this branch is now rebased onto `78fa0a1`):
  - Galley: 302 top-level tests, 1021 with subtests.
  - Michelin: 235. Swiftlet: 397 (22 files).
  - Browser suite: 36 specs, 86 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`, regenerated into `api.gen.go` and
both `schema.d.ts`)

- `POST /api/tickets/{id}/rework`, no body, returns the `Ticket`.
- `TicketAcceptAvailability` is renamed `TicketCommandAvailability`.
  `TicketAllowedActions` gains a required `rework` of that type.
- `RunnerClaim.claimEpoch` says a Ticket's Rounds get increasing epochs.

**Galley** (`internal/httpapi`)

`decideRework` is the one decision, used by the command and by
`allowedActions.rework`:

| # | Check | Rejection |
| --- | --- | --- |
| 1 | Archived | `400 rework_not_available` |
| 2 | Not Agent-assigned | `400 rework_not_available` |
| 3 | Status is not In Review | `400 rework_not_available` |
| 4 | Open Round | `400 rework_not_available`, with `roundId` |
| 5 | Readiness as for Ready (M4.2) | `400 agent_readiness_incomplete`, with `missing` |

- **`transitionLockedTicket` / `applyTicketTransition` split.** The
  Decision requires `rework_not_available` for an archived or open-Round
  Ticket, but `applyTicketTransition` rejected those with the generic
  mutation-lock codes before `decide` ran. `transitionLockedTicket` now
  holds the locking and applying, and `decide` owns those two cases.
  `applyTicketTransition` wraps it with the old guard, so every other
  command answers as before.
- **Queue position.** Rework enters Ready through the same move-to-bottom
  as any other entry into Ready.
- **Per-Ticket claim epoch:** the claim inserts `max(claim_epoch) + 1`
  over the Ticket's Rounds, as `sequence` is counted. There is no
  migration and no unique constraint on `(ticket_id, claim_epoch)`.
  Claims already serialise on the Owner's priority lock, and the
  one-open-Round index allows one Round per Owner, so two claims cannot
  compute the same value. A constraint would only guard a path that
  does not exist.
- **Guardrails:** the manual-lifecycle test in
  `no_execution_side_effects_test.go` now includes a rework request and
  still asserts no execution record is created.
  `TestNoTemplateToCapabilityMapping` is untouched.

**Lock order.** Rework takes the Owner's priority lock, then the Ticket
row, like every Status transition. No new lock and no new order.

**Swiftlet**

- **"Request rework" button** (`ticket-detail-rework-button`), shown when
  `allowedActions.rework.available`. `requestTicketRework` in
  `api/tickets.ts`; `parseTicket` validates `rework` with the same
  parser as `accept`.
- **Readiness reason.** An `agent_readiness_incomplete` rejection shows
  its message (`ticket-detail-rework-unavailable`) and points the empty
  fields at it. `rework_not_available` reasons are never shown.
- **`useExecutionRefresh` / `awaitsExecution`** replace
  `useOpenRoundRefresh`. The receipt, board and list refetch while a
  Ticket has an open Round or is queued (`requestingAgentWork`), so a
  reworked Ticket is seen claimed, running and delivered without a reload.
- **`runCommand` adopts the Ticket the command returns.** Without it,
  the receipt stayed In Review until the next poll, and the poll only
  starts once the page knows the Ticket is queued.
- **Stale-poll guard.** `refreshTicket` numbers each request and drops
  its Ticket, error and Rounds reload when a newer request or a resolved
  command has superseded it; `runCommand` advances the number when the
  command resolves. Without it, a poll in flight when the Owner clicked
  returned the older Ticket over the command's result.
- **Round history.** `RoundsSection` renders one list, newest first, as
  Galley returns it. The first entry is open and the rest closed, each
  in the new `ui/Disclosure` (a native `<details>`; React rewrites
  `open` only when `defaultOpen` changes, so the Owner's own toggling
  survives refreshes). Test ids: `ticket-detail-round` (with
  `data-round-id`), `-round-number`, `-round-state`, `-round-summary`,
  `-round-assessment`, `-round-body`, `-round-note`,
  `-round-usage-{cost,input-tokens,output-tokens,active-time}`.

**e2e**

- **New `tests/runner-rework.spec.ts`**, one test against two real
  Michelin processes.
- **`support/tickets.ts`:** `requestReworkDirect` and `rework` on the
  `Ticket` type.
- **Updated specs:** `runner-claims`, `runner-delivery` and
  `runner-engine` for the Round test ids and the required `rework` field.
- **`run.sh`** registers the spec and its exit-code check. It needs no
  database reset: `runner-delivery.spec.ts` ends with every Round
  delivered, so no Owner slot is held and no Ticket waits in Ready.

### Engineering choices inside the Decisions

- **Epoch is `max + 1` per Ticket**, not a global or per-Owner counter.
  The Decision asks only for a new epoch; per Ticket matches `sequence`
  and makes Round 1 and Round 2 of one Ticket always differ.
- **`Ticket.delivery` is unchanged.** It stays set while the reworked
  Ticket waits in Ready and clears when Round 2 is claimed, so the
  receipt keeps loading Rounds while the Ticket is queued.
- **`rework_not_available` reasons are never shown in Swiftlet.** The
  button is absent instead. Galley's wording is for direct callers.
- **The open-Round branch of `decideRework` is unreachable through the
  API** (an open Round implies a Status other than In Review). It is
  kept for the Decision's wording and pinned by the pure test.
- **Board and list also refresh for queued Tickets**, for the same
  reason as the receipt.

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), pgx v5.11.0, golang-migrate v4.20.1,
  oapi-codegen v2.8.0, kin-openapi v0.149.0 (`apps/galley/go.mod`).
- **PostgreSQL 18.1 in Docker** (`ticketit-postgres`, trust auth, port
  5432), not the Homebrew 17.11 of earlier records. `run.sh` needs
  `psql`, which this machine lacks, so a shim on `PATH` forwards to
  `docker exec -i ticketit-postgres psql -U wesley.susanto "$@"`.
- Node v26.9.0.
- Swiftlet: React 19.3.0, Vite 8.3.0, Vitest 5.0.1, TypeScript 7.0.2,
  Tailwind CSS 4.3.3.
- Michelin: Vitest 5.0.1, TypeScript 5.9.3.
- Contracts: openapi-typescript 7.13.0.
- e2e: `@playwright/test` 1.63.0.

All confirmed against `go.mod` and each `package-lock.json`.

## Reproducible commands

```sh
export PATH="$HOME/.nvm/versions/node/v26.9.0/bin:$PATH"
cd apps/galley
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m411?sslmode=disable'
gofmt -l . && go vet ./... && go build ./...
go test ./... -count=1
go test -race -count=1 -run 'Rework|Delivered|RoundEvent|Round|OpenRoundLock|AllowedActions|Claim' ./internal/httpapi
./scripts/check-contract-drift.sh      # with the regenerated api.gen.go staged
cd ../../contracts && npm ci && npm run check:swiftlet-drift && npm run check:michelin-drift
cd ../apps/michelin && npm ci && npm run typecheck && npm test
cd ../swiftlet && npm ci && npm test && npm run build
cd ../../e2e && env -u FORCE_COLOR E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m411?sslmode=disable' ./run.sh
```

## Observed results

- `gofmt -l .` printed nothing. `go vet` and `go build` were clean.
- Galley `go test ./... -count=1`: every package `ok`. 314 top-level
  tests, 1086 with subtests (was 302 and 1021). 0 failed, 0 skipped.
  One base-run observation: on the first baseline run (at `origin/main`,
  before switching to the merge base) `TestRoundEvent_ConcurrentEventsWithDifferentKeysStartTheRoundOnce`
  failed once at 6 s and passed on the next run. It is not touched by
  this slice; the gate should know it can flake under load.
- `go test -race` over the subset: `ok`, no race report. After the
  rebase, `go test -race -count=1 -p 1 ./...` over every package: `ok`.
- Drift checks, generated files staged: all three printed `OK … (no drift)`.
- Michelin: typecheck clean; 235 tests passed (unchanged).
- Swiftlet: 24 files, 436 tests passed (was 22 and 397). The count
  includes #149's own tests after the rebase; this
  slice's share is 33 (429 before the rebase, plus the stale-poll test),
  the other 6 are #149's. 24 consecutive full runs passed. `npm run build`
  succeeded with no chunk-size warning:
  - `index` 391.38 kB (118.05 kB gzipped);
  - `MarkdownRenderer` 116.65 kB (35.45 kB gzipped);
  - CSS 39.88 kB.
- Browser suite: `SUITE PASSED`, twice before the rebase (before and
  after the falsification below) and once after it on `78fa0a1` with the
  stale-poll guard. Each run: 37 specs exited 0, 87 tests passed (was 36
  and 86). `runner-rework.spec.ts` passed in 12.2 s, 12.3 s and 12.2 s.
  `ticket-capture.spec.ts` passed in all three runs (see limitations).
  On `850e768` alone, 35 non-runner tests failed: #149 moved the list
  to `/list` without updating the specs or Back to Backlog. #150 fixed
  both before this rebase.

**New and changed Galley tests**

| Test | What it pins |
| --- | --- |
| `TestDecideRework_AnswersEachCase` | the five rungs in order, including the open-Round rung and its `roundId` |
| `TestRework_ReturnsAnAgentTicketInReviewToReadyAtTheBottomOfTheOrder` | Ready, queued, last in the Owner's order, no Round created |
| `TestRework_TheNextClaimCreatesRound2AndRound1IsRetainedUnchanged` | claim 2: new ID, sequence 2, epoch 2; Round 1's rows unchanged; both delivered results listed newest first |
| `TestRework_Round1EventsCannotAffectRound2` | all four event types to Round 1 → `round_not_open`; Round 1's epoch sent to Round 2 → `stale_claim_epoch`; snapshot unchanged; Round 1's delivery replay still returns its stored result |
| `TestRework_NothingRestartsOrRequeuesADeliveredRound` | repeated claims find no work for a delivered Ticket, nor does reassigning its Agent; only the explicit rework queues it, and Round 2 goes to the reassigned Agent |
| `TestRework_RejectionsChangeNothing` | human-assigned, Backlog, Ready, In Progress, Blocked, Done, a claimed and a running Round, archived, cleared goal: `400` with the right code, and the snapshot unchanged |
| `TestRework_UnknownMalformedAndForeignTicketsAreTheSameNotFoundAndUnauthenticatedIs401` | shared `404` and `401` |
| `TestRework_OnlyPostIsAllowed` | manual 405 registration |
| `TestRework_AllowedActionsEqualTheCommandsAnswer` | `allowedActions.rework` equals the command's answer in every case, with the Ticket locked or archived too |
| `TestRework_ConcurrentRequestsReturnTheTicketToReadyOnce` | concurrent requests: one `200`, the rest rejected |
| `TestRework_RacingAcceptEndsInExactlyOneOutcome` | rework racing Accept: Ready or Done, never both |
| `TestRequestTicketRework_ResponsesMatchContractAndMethod405` | `200`, `400` and `404` validated against the contract |
| `TestTicketCommandAvailability_ResponseContractRejectsInvalidCombinations` (renamed) | the invalid available/reason combinations, for `accept` and `rework` |
| `TestClaim_SequenceCountsRoundsPerTicket` and other `rounds_test.go`, `round_delivery_test.go`, `round_activity_usage_test.go` cases | expect the Ticket's next epoch instead of 1 |
| manual-lifecycle test in `no_execution_side_effects_test.go` | rework creates no execution record |

**New and changed Swiftlet tests** (397 → 429, then 436 with #149)

| Test file | What it pins |
| --- | --- |
| `ui/Disclosure.test.tsx` (4) | open or closed from `defaultOpen`; keyboard-operable summary; Owner's toggle survives re-renders; follows `defaultOpen` when it changes |
| `api/tickets.test.ts` (1) | an unavailable `rework` keeps its missing inputs |
| `TicketDetail.test.tsx` | button only when advertised; click shows the Ready, queued Ticket; Galley's rejection verbatim; disabled while pending; readiness reason beside the empty field; `rework_not_available` never shown |
| `TicketDetailPage.test.tsx` | refresh continues for a queued Ticket and stops once it is neither queued nor claimed; In Review → second delivered Round keeps Round 1 listed and collapsed; each Round's own activity; a refetch started before a command and resolving after it does not replace the command's Ticket |
| `RoundsSection` cases | newest first with the latest open; an earlier Round opens from its summary; a running Round above the delivered one labels usage "so far"; the previous latest collapses when a newer Round arrives while the Owner's toggles survive; records error beside the last list |
| `useExecutionRefresh.test.tsx`, `TicketBoard`, `TicketList` tests | `awaitsExecution`; board and list refetch queued Tickets and stop otherwise |

**Browser spec** (`tests/runner-rework.spec.ts`, Basic Ticket, all data
through Galley's API):

1. Process A delivers Round 1 (note, 100 in / 20 out tokens, $0.0015)
   and is stopped. The API shows In Review, `rework.available`, and one
   delivered Round.
2. A browser opens the receipt and sets a `window` marker. Clicking
   "Request rework" shows Ready and the Queued tag, with no button, and
   Round 1 still listed. The API shows Ready, `requestingAgentWork`,
   `rework` unavailable with `rework_not_available`, and the Round list
   equal to before.
3. Process B delivers Round 2 (note, 300 in / 60 out, $0.0045, a 6 s
   wait). The same receipt turns In Progress and locked, then In Review
   with no reload; the marker survives.
4. The receipt lists Round 2 then Round 1, by `data-round-id` and number.
   Round 2 is open with its summary, assessment, rendered heading, note
   and usage; Round 1 is closed. Opening Round 1 shows its own summary,
   assessment, rendered heading, note and usage, and Round 2's are
   unchanged.
5. The API lists Round 2 and Round 1 (sequences 2 and 1, distinct ids),
   each with its deliverable byte for byte, its own activity and its
   usage. Round 1 equals the response saved before rework. `delivery.roundId` is Round 2.
6. With B running three claim intervals longer, the Ticket is still In
   Review with two Rounds and B logged one `round claimed`. That wait
   is the one fixed sleep: absence of a requeue has no event to wait on.
7. Accept makes the Ticket Done.

**Falsification.** Each change was applied, the named suite run, and the
file restored.

| Layer | Change | Result |
| --- | --- | --- |
| Galley | epoch constant 1 | `TestClaim_SequenceCountsRoundsPerTicket`, `TestRework_TheNextClaimCreatesRound2AndRound1IsRetainedUnchanged`, `TestRework_Round1EventsCannotAffectRound2` |
| Galley | drop the archived check | `TestDecideRework_AnswersEachCase`, `TestRework_RejectionsChangeNothing`, `TestRework_AllowedActionsEqualTheCommandsAnswer` |
| Galley | skip `moveTicketToBottom` | `TestRework_ReturnsAnAgentTicketInReviewToReadyAtTheBottomOfTheOrder`, `TestRework_ConcurrentRequestsReturnTheTicketToReadyOnce` |
| Galley | rework computed after the mutation-lock early return | `TestRework_AllowedActionsEqualTheCommandsAnswer`, `TestRequestTicketRework_ResponsesMatchContractAndMethod405` |
| Galley | remove the In Review check | 6 tests, including `TestDecideRework_AnswersEachCase`, `TestRework_RejectionsChangeNothing`, `TestRework_RacingAcceptEndsInExactlyOneOutcome` |
| Swiftlet | refresh on an open Round only | 5 failed |
| Swiftlet | button regardless of `available` | 3 failed |
| Swiftlet | every Round open | 4 failed |
| Swiftlet | oldest first | 6 failed |
| Swiftlet | show `rework_not_available` | 1 failed |
| Browser | sort Rounds oldest first in `RoundsSection`, rebuild, run only this spec | failed at the order assertion (`["Round 2", "Round 1"]` expected, `["Round 1", "Round 2"]` received). Restored, then the whole suite passed |

The browser run used a temporary copy of `run.sh` with every other spec
replaced by `true`; the copy was deleted.

## Implementation limitations and follow-ups

- **Stop, Failed, Interrupted and recovery** are not implemented; a Round
  ends only by delivery. M5 ([#6](https://github.com/cristoforows/ticketIt/issues/6)).
- **Times on the receipt are raw RFC 3339**, as before. Local formatting
  is M5's visual work.
- **Rework offers no new inputs.** A Ticket whose inputs were cleared
  after delivery is refused with `agent_readiness_incomplete`, as the
  Decision says; the Owner edits the Ticket, then requests rework.
- **A queued Ticket is polled every refresh interval** for as long as it
  waits for an Agent, with no backoff.
- **The open Round's activity and usage come from the separate Rounds
  fetch.** If it fails, the receipt shows the error while the lock banner
  still shows the Round number and Agent.
- **The baseline flake above** (`TestRoundEvent_ConcurrentEventsWithDifferentKeysStartTheRoundOnce`)
  is for the M4.12 gate to route.
- **`ticket-capture.spec.ts` "title alone creates a Ticket"** is a known
  race (it reads `GET /api/tickets` right after clicking submit without
  waiting). It failed once during this slice's work and passed on the
  rerun; the gate should route it.

## Outstanding checks and owning milestone

- Stop, Failed, Interrupted, questions, Permissions and reconciliation of
  a stranded runner, including a late event after recovery: M5 (#6, D5).
- A real engine's Rounds under rework: M6.
- The milestone gate reconciles `docs/evidence/m4/README.md`,
  `docs/open-decisions.md` and the plan documents: M4.12 (#138). This
  slice does not edit them.

## Decision impacts (open-decision IDs)

- **D5** (stranded-runner recovery): an event from an ended Round is
  refused with no change, and the next Round of the Ticket carries a
  different epoch. Recovery is not decided here.
- None of D1–D4 or D6–D9. D3's guardrail
  (`TestNoTemplateToCapabilityMapping`) is unchanged and passes, and
  rework reads only the Ticket's own fields.
