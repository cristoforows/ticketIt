# Ticket fields locked while a Round is open

## Purpose

M4.7, [#133](https://github.com/cristoforows/ticketIt/issues/133).
While a Ticket has an open Round (claimed or running), Galley refuses
every Owner mutation of that Ticket with `400 round_open`, and the body
carries the Round's `roundId`. `allowedActions` advertises nothing for a
locked Ticket. Swiftlet renders a read-only receipt with
"Locked while <Agent> works on Round <n>" and a lock glyph on the slip
and row. Touches `contracts/`, `apps/galley`, `apps/swiftlet`, the
regenerated `apps/michelin` types, and `e2e/`.

## What already existed

- Rounds are created at claim (M4.6,
  [#132](https://github.com/cristoforows/ticketIt/issues/132)). There is
  one open Round per Owner (`rounds_one_open_per_owner`), and
  `Ticket.openRound` is on every Ticket response.
- Archive alone refused an open Round. It did so through
  `ticketHasOpenRound` and an `errRoundOpen` sentinel, checked after
  `lockTicketForMutation`. The M4.6 manual run showed unassign and
  Ready → Backlog succeeding on a claimed Ticket. That record handed
  every other mutation to this slice.
- `lockTicketForMutation` (#93) was the row-locked decision point. It
  returned only the archived flag, as an `errArchivedTicket` sentinel
  that each handler mapped through `writeMutationError`.
- `allowedActionsForTicket` (#87) took a `ticketWorkflowState` that
  already carried `archived` and an `openRound bool`. The bool was used
  only by `decideAgentWorkRequest`.
- The rule-rejection shape (`transitionRejection` → `ErrorDetail`, with
  `missing` for readiness).
- Guardrails: `TestManualLifecycleActionsCreateNoExecutionRecords`,
  `TestNoTemplateToCapabilityMapping`.

## What this slice added

**Contract** (`contracts/openapi.yaml`). It is regenerated into
`api.gen.go` and both `schema.d.ts` files.

- `ErrorDetail.roundId` (uuid). It is present only with `round_open`.
- `Ticket.openRound`'s description now states the lock.
- `round_open` is listed on status, Accept and reorder, and named in
  the assign and unassign descriptions.

**Galley** (`internal/httpapi`)

- `ticket_archive.go`:
  - `lockTicketForMutation` returns a `ticketLock{archived,
    openRoundID}`.
  - `decideTicketMutation(lock, restoring)` is the one decision. An
    archived Ticket gives `archived_ticket`, unless the command is
    restore. An open Round gives `round_open` with `roundID`.
  - `lockMutableTicket` combines the two for ordinary mutations.
  - `errArchivedTicket`, `errTicketNotArchived` and
    `writeMutationError` are gone. Every mutation handler now writes
    rejections through `writeTransitionRejection`.
- `ticketWorkflowState` embeds the same `ticketLock`, built from
  `ticket.OpenRound`. `allowedActionsForTicket` starts by calling
  `decideTicketMutation(state.ticketLock, false)`. On a rejection it
  advertises no status changes and no status-change rejections, and
  Accept carries that rejection as its reason. This is the archived
  shape, with `round_open` in place of `archived_ticket`.
  `decideAgentWorkRequest` reads `openRoundID`.
- `rounds.go`: `ticketHasOpenRound` and `errRoundOpen` are removed. The
  claim loop calls `lockTicketForMutation` for its row lock.
  `roundOpenMessage` is "this Ticket has an open Round; it can be
  changed once the Round ends".

Locked commands, all through `lockMutableTicket` (or, for archive,
`lockTicketForMutation` + `decideTicketMutation`):

| Command | Endpoint | Code path |
| --- | --- | --- |
| Edit title, goal, context, Success Criteria, constraints, repository | `PATCH /api/tickets/{id}` | `updateTicketForOwner` |
| Assign Owner / Agent, reassign | `PUT /api/tickets/{id}/assignee` | `setTicketAssigneeForOwner` |
| Unassign | `DELETE /api/tickets/{id}/assignee` | `setTicketAssigneeForOwner` |
| Attach / detach Badge | `PUT` / `DELETE /api/tickets/{id}/badges/{badgeId}` | `badge.go` attach and detach |
| Status change | `POST /api/tickets/{id}/status` | `applyTicketTransition` |
| Accept | `POST /api/tickets/{id}/accept` | `applyTicketTransition` |
| Reorder | `POST /api/tickets/{id}/position` | `reorderTicketForOwner` |
| Archive | `POST /api/tickets/{id}/archive` | `archiveTicketForOwner` |

**Swiftlet**

- `ui/Glyphs.tsx` adds `LockGlyph` to the shared set. It is an SVG in
  `currentColor`. With a `label` it has `role="img"` and an accessible
  name; without one it is `aria-hidden`.
- `components/roundLock.ts`: `lockedLabel(round)`.
- `TicketDetail`: `readOnly` is archived or `openRound !== null`.
  `ticket-detail-locked` shows the glyph and copy. Every control is
  disabled and titled with Galley's `allowedActions.accept.reason`
  message, so there is no client-side copy of the rule. Edit requested
  from the board is ignored while locked.
- `TicketSlip`: a labelled glyph (`board-locked`) sits in the serial
  line, and the slip is not draggable. `SlipActions` disables Edit with
  Galley's reason and hides reorder. `TicketList` shows the glyph
  (`ticket-locked`) and hides reorder.
- `tokens.test.ts` adds "lock notice and lock glyph: ink on paper".

**e2e**

- `tests/runner-claims.spec.ts` asserts the lock inside its existing
  test, on the Round its real Michelin just claimed and before Michelin
  stops. No new spec and no `run.sh` change. It asserts:
  - `allowedActions`: nothing offered, Accept refused with `round_open`
    and the Round's id
  - the slip glyph, by its accessible name, and that the slip is not
    draggable
  - the read-only receipt: copy, and disabled controls titled with
    Galley's reason
  - nine direct API mutations, each `400 round_open` with `roundId` and
    Galley's message
  - the Ticket equal to its state at claim afterwards
- It no longer clicks Archive on the locked receipt, because Archive is
  now disabled. It asserts the disabled button, and archives via the
  API instead.

**Engineering choices inside the Decisions**

- **The open-Round read is a second statement after `FOR UPDATE`.**
  Under READ COMMITTED, a subquery in the locking statement keeps the
  statement's snapshot. A mutation that queued behind a claim's row
  lock would then miss the Round the claim just committed. Falsified
  below.
- **Template stays `invalid_request`.** Template has no write path:
  the M2 contract rejects any request naming it before the database is
  read. Answering `round_open` there would mean reading the lock for a
  request that can never succeed.
  `TestOpenRoundLock_TemplateStaysUnchangeable` pins it unchanged.
- **Restore keeps its own rules.** An archived Ticket cannot gain a
  Round (the claim skips archived Tickets), and an open Round blocks
  archive. So restore checks `not_archived` first, and then only
  status. D3 §4: "Archive/restore retain their existing rules."
- **Other Tickets may be anchored next to a locked one.** Reordering
  Ticket B after locked Ticket A changes B's rank, not A's.
  `TestOpenRoundLock_OtherTicketsMayStillBeMovedAroundIt`.
- **`UnassignTicket` previously dropped the rejection** from
  `setTicketAssigneeForOwner`. That was harmless while only archive
  rejected. With the lock it would have returned a zero `Ticket` as
  `200`. It now writes the rejection. Falsified below.
- **Slip Edit's title comes only from Galley.** `SlipActions` dropped
  its "Archived Tickets are read-only." fallback, which would have been
  wrong for a lock. Galley supplies `allowedActions.accept.reason` for
  both read-only cases.
- **Copy:** the issue body says "works on this Ticket" and its
  Decisions say "works on Round <n>". The Decisions are settled, so the
  receipt uses "Round <n>".
- **Glyph and `ClaimedTag`:** the glyph marks the lock (any open
  Round), and the tag names the Round state ("Claimed by runner").
  Both stay, because M4.8 adds `running` with a lock and no claimed
  tag.
- **The browser lock assertions live in `runner-claims.spec.ts`.**
  There is one slot per Owner, nothing closes a Round before M4.10, and
  e2e data comes only through the API. A separate spec would have
  needed the Round that `runner-claims` leaves open, which couples spec
  order.

**Owner actions during a lock (D3 §4)**

| Owner action | During an open Round | Where |
| --- | --- | --- |
| View the Ticket (receipt, slip, row) | Available | Now (M4.7) |
| Answer a question / approve a Permission | Available once they exist | M5 [#6](https://github.com/cristoforows/ticketIt/issues/6) |
| Request Stop | Available once it exists | M5 [#6](https://github.com/cristoforows/ticketIt/issues/6) |
| Ready / Backlog change | Rejected (`round_open`); allowed when no Round is open | Now |
| Explicit rework (return to Ready) | Rejected; allowed when no Round is open | Now |
| Accept (human-acceptance Tickets) | Rejected; allowed when no Round is open | Now |
| Reassign / unassign | Rejected; allowed when no Round is open (D3 §3) | Now |
| Edit fields, Badges | Rejected; allowed when no Round is open | Now |
| Archive | Rejected; allowed when no Round is open | M4.6, now `roundId` |
| Restore | Unaffected (an archived Ticket has no open Round) | Existing rules |

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), pgx v5.11.0, oapi-codegen v2.8.0,
  kin-openapi v0.149.0.
- PostgreSQL: local server, the same as earlier M4 slices.
- Node v26.9.0. Swiftlet: Vitest 5.0.1, TypeScript 7.0.2. Michelin:
  TypeScript 5.9.3, Vitest 5.0.1. e2e: `@playwright/test` 1.63.0.

## Reproducible commands

```sh
cd apps/galley
gofmt -l . && go vet ./...
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test?sslmode=disable' go test ./... -count=1
./scripts/check-contract-drift.sh
cd ../../contracts && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh
cd ../apps/swiftlet && npm ci && npm test && npm run build
cd ../michelin && npm ci && npm run typecheck && npm test
cd ../../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e?sslmode=disable' ./run.sh
```

## Observed results

- Galley: `gofmt -l .` printed nothing, and `go vet ./...` was clean.
  `go test ./... -count=1` passed 7 packages, 220 top-level tests (876
  including subtests), with 0 failures and 0 skips.
- Drift checks, run on the committed tree:
  - `OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).`
  - `OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`
  - `OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`
- Swiftlet: 19 files, 291 tests passed. `npm run build` succeeded.
- Michelin (regenerated types only): typecheck was clean, and 7 files,
  68 tests passed.
- e2e: `SUITE PASSED`, 33 specs, 81 tests, all exit codes 0.

New and guardrail Galley tests (`go test -v`, excerpt):

```text
--- PASS: TestOpenRoundLock_EveryMutationRejectedWhileOpenAndAcceptedOnceClosed (1.84s)
--- PASS: TestOpenRoundLock_TemplateStaysUnchangeable (0.10s)
--- PASS: TestOpenRoundLock_RestoreIsUnaffected (0.10s)
--- PASS: TestOpenRoundLock_OtherTicketsMayStillBeMovedAroundIt (0.11s)
--- PASS: TestTicketAllowedActions_MatchCommandsWhileARoundIsOpen (0.14s)
    ticket_open_round_lock_test.go:289: outcomes: map[claim won:96 unassign won:10]
--- PASS: TestClaimAndUnassign_RaceEitherOrder (0.33s)
--- PASS: TestClaim_EditWaitingOnTheClaimSeesItsRound (0.10s)
    rounds_test.go:429: outcomes: map[archive won:10 claim won:84]
--- PASS: TestClaimAndArchive_RaceEitherOrder (0.30s)
--- PASS: TestTicketAllowedActions_MatchCommands (0.06s)
--- PASS: TestTicketAllowedActions_MatchCommandsForEveryAssignee (0.43s)
--- PASS: TestArchive_AllMutationsRejectWithoutChangingTicket (0.01s)
--- PASS: TestManualLifecycleActionsCreateNoExecutionRecords (0.08s)
--- PASS: TestNoTemplateToCapabilityMapping (0.01s)
```

What the Galley tests cover, on real PostgreSQL:

- **Every mutation.** There are 15 cases: six fields, assign Owner,
  reassign Agent, unassign, Badge attach, Badge detach, status, Accept
  (the Ticket is set to In Review directly first), reorder and archive.
  - Each is refused with an exact `ErrorDetail` (`round_open`, message,
    `roundId`), validated against the contract.
  - The Ticket, its row facts and its Round rows are DeepEqual before
    and after the refusal.
  - After `deliverRoundDirect`, the same request returns `200`.
- **The advertised-versus-actual grid** covers Basic and Coding × six
  statuses with an open Round. Nothing is advertised, and every status
  command and Accept returns exactly the advertised reason.
- **Races.**
  - Claim vs unassign, with random jitter until each side has won at
    least 10 times. Exactly one wins in every trial. When the claim
    wins, unassign is `round_open` and the Ticket keeps its Agent.
  - An edit queued on the claim's row lock is deterministically
    refused with that claim's `roundId`.

e2e (real Michelin claim, live Galley, built Swiftlet):

```text
[run.sh] running tests/runner-claims.spec.ts (a real michelin claims a queued Ticket) against the restarted galley
  ✓  1 [chromium] › tests/runner-claims.spec.ts:19:1 › a paired Michelin claims the top queued Ticket; it stays Ready, shows Claimed by runner, is locked against every mutation, and keeps its Round after Michelin stops (1.4s)
[run.sh] SUITE PASSED
```

**Falsification.** Each source change was applied, run, and reverted.

| Change | Failing tests |
| --- | --- |
| `decideTicketMutation` ignores `openRoundID` | `EveryMutationRejected…` (all cases `200`), `TestArchive_RejectedWhileARoundIsOpen…`, `TestClaimAndArchive_RaceEitherOrder`, `TestClaim_ResponsesMatchContract…` |
| Open-Round read moved into the `FOR UPDATE` statement | `TestClaim_EditWaitingOnTheClaimSeesItsRound` (`200`), `TestClaimAndUnassign_RaceEitherOrder` (both won), `TestClaimAndArchive_RaceEitherOrder` |
| `allowedActions` given only the archived flag | `TestTicketAllowedActions_MatchCommandsWhileARoundIsOpen` (all 12 cells) |
| `UnassignTicket` drops the rejection again | `EveryMutationRejected…` (zero Ticket fails the contract), `TestClaimAndUnassign_RaceEitherOrder`, `TestArchive_AllMutationsRejectWithoutChangingTicket` |

## Implementation limitations and follow-ups

- **Rounds do not close in M4.** Delivery is M4.10
  ([#136](https://github.com/cristoforows/ticketIt/issues/136)).
  "Accepted once closed" is proven with `deliverRoundDirect` (direct
  SQL in test setup), as the issue allows. The e2e spec cannot show
  unlocking in a browser until then.
- **Removing the Stopped Badge** during or after a lock is M5
  ([#6](https://github.com/cristoforows/ticketIt/issues/6)). That Badge
  does not exist yet, so every Badge is locked.
- **Stranded locks:** a claimed Round whose runner is gone keeps the
  Ticket locked indefinitely. Recovery is D5, in M5 (#6). No override
  was added.
- **Not built (M5 #6):** the greyed active card, the delivery
  animation, View/Stop controls, answer and Permission approval.
- **Recipe links** (D3 §4, "including … Recipe links") do not exist
  yet. When they are added, they must go through `lockMutableTicket`.
- **Agent rename** stays allowed during a lock. It changes the Agent,
  not the Ticket. The receipt's copy follows the new name.

## Outstanding checks and owning milestone

- Lock while `running`. The lock reads `openRoundStatesSQL`, which
  already includes `running`, but no Round reaches that state until
  M4.8 ([#134](https://github.com/cristoforows/ticketIt/issues/134)).
  The Galley tests cover `claimed`.
- Unlocking after real delivery, in the browser: M4.10 (#136).
- `waiting_for_input` locks through the same states list: M5 (#6).

## Decision impacts (open-decision IDs)

- **D5** (stranded-runner recovery): the lock makes a stranded claim
  more costly, because the whole Ticket is frozen and not only its
  slot. Nothing recovers it, and this slice does not decide how.
- Implements D3 §3 (no reassignment during an open Round) and §4 (field
  edits rejected during an open Round). D3 is settled; this slice
  resolves nothing.
- None of D1, D2, D4, D6–D9.
