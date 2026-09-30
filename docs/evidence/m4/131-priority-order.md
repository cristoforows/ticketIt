# Owner priority order for Tickets

## Purpose

M4.5, [#131](https://github.com/cristoforows/ticketIt/issues/131): each
Owner gets a persisted priority order across their Tickets, and a
reorder command. Under the Owner decision in
[#108](https://github.com/cristoforows/ticketIt/issues/108), M4.6's claims
follow this order. This slice does no claiming. Touches `contracts/`,
`apps/galley`, `apps/swiftlet`, `e2e/` and `docs/ticket-views.md`.

## What already existed

- List and board ordered Tickets newest first (`ORDER BY created_at DESC,
  id DESC`), backed by `tickets_owner_id_created_at_id_idx`. The Archived
  filter used the same order. `docs/ticket-views.md` said priority
  ordering did not exist yet.
- `lockTicketForMutation`: the row-locked decision point for every Ticket
  mutation, rejecting archived Tickets with `archived_ticket`.
- Migrations up to `000010` when the branch started. M4.4
  ([#130](https://github.com/cristoforows/ticketIt/issues/130)) landed
  `000011_create_runners` on main while this slice was open. The branch
  merged it, and this slice's migration was renumbered from `000011` to
  `000012`.
- Swiftlet's order-rail board (#114) with desktop drag for Status moves
  and a phone slip action panel.

## What this slice added

**Contract** (`contracts/openapi.yaml`), regenerated into `api.gen.go`
and both `schema.d.ts` files:

- `POST /api/tickets/{id}/position` (`reorderTicket`) with
  `ReorderTicketRequest`, which has exactly one of `before` or `after`
  (`minProperties`/`maxProperties: 1`, no extra fields). Returns the
  moved `Ticket`. Error code `reorder_anchor_invalid`.
- Descriptions of `listTickets`, `createTicket`, `changeTicketStatus` and
  `restoreTicket` state the order and placement.

**Galley**

- `000012_add_ticket_priority_rank.up.sql`: `priority_rank BIGINT NOT
  NULL`, backfilled per Owner as `row_number() * 1024` over `created_at
  DESC, id DESC`; `UNIQUE (owner_id, priority_rank) DEFERRABLE INITIALLY
  IMMEDIATE`; drops `tickets_owner_id_created_at_id_idx`.
- `internal/httpapi/ticket_priority.go`: the advisory lock, placement SQL,
  gap and midpoint, renumbering, the anchor decision, and the
  `ReorderTicket` handler.
- `ticket.go`: capture runs in a transaction under the advisory lock and
  takes the top rank. The active list sorts by `priority_rank, id`, and
  the Archived filter by `archived_at DESC, id DESC`.
- `ticket_lifecycle.go`: a Status change to Ready takes the advisory lock
  before the row lock, and entering Ready from another Status takes the
  bottom rank. Accept and other targets are unchanged.
- `handler.go`: 405 with `Allow: POST` on the new route.

**Swiftlet**

- `src/api/tickets.ts`: `reorderTicket(id, placement)`.
- `src/components/ReorderButtons.tsx`: Move up and Move down, anchored on
  the same-Status neighbour, disabled at the stage's ends with the reason
  as the title. Used in `TicketList` (hidden in the archived list) and in
  the phone slip panel (`SlipActions`).
- `TicketBoard` / `TicketSlip` / `ui/SlipCard`: on desktop, dropping onto
  another slip in the same stage places the Ticket before that slip on its
  upper half and after it on its lower half. A line (`data-drop-position`)
  marks the landing spot, and the origin stage's hint reads "↕ Reorder".
  Dropping on another stage is still a Status move.
- After every reorder, successful or rejected, the view refetches and
  renders Galley's order.

**Browser suite**: `e2e/tests/ticket-priority-order.spec.ts`, registered
in `run.sh` with its exit code checked, and `reorderTicketDirect` in
`e2e/support/tickets.ts`.

**Docs**: `docs/ticket-views.md` ("Priority order"), and both app READMEs
and `e2e/README.md`.

### Engineering choices

- **Deferrable unique constraint.** `UNIQUE (owner_id, priority_rank)`
  makes a duplicate rank impossible, not just unlikely. A non-deferrable
  constraint is checked row by row, so a single `UPDATE` that shifts
  ranks fails whenever a row moves onto a rank another row has not left
  yet. `INITIALLY IMMEDIATE` still checks at the end of every statement,
  so it does not relax any other write. Demonstrated below.
- **Lock namespace and order.** `pg_advisory_xact_lock(0x7072696f,
  int32(uint32(owner_id)))`. The two-int4 form has a separate key space
  from golang-migrate's single-bigint lock. Owners whose ids share the low
  32 bits would share a lock, which only serializes them. Order: advisory
  lock, then the moved Ticket's row lock (`lockTicketForMutation`), then
  the anchor row `FOR UPDATE`. Writers that do not take the advisory lock
  (Accept, non-Ready Status changes, field edits, Badges, archive,
  restore) hold only one Ticket row lock. So a renumber waiting on one of
  those rows cannot form a cycle.
- **Neighbour rule.** For `before X`, the gap is X's predecessor in the
  Owner's whole order, excluding the moved Ticket, up to X. For `after X`,
  it runs from X to X's successor. Nothing lies between X and that
  neighbour in the whole order, so the Ticket also lands beside X within
  the stage, even when other stages' Tickets are interleaved. With no
  neighbour, the rank is X's rank ± 1024.
- **Repeated moves are no-ops.** If the moved Ticket's rank is already in
  the gap, nothing is written. A retried or double-clicked move then uses
  up no gap and does not bump `updated_at`.
- **Renumber includes archived Tickets.** They keep a rank so Restore
  returns them to where they were. Renumbering 1024 apart in the current
  `priority_rank, id` order preserves every relative position. The
  midpoint is then taken once more, and a second missing gap is an error
  rather than a loop.
- **Ranks are unbounded.** Captures walk down from the minimum and Ready
  entries walk up from the maximum, each by 1024. `BIGINT` leaves about
  9·10^15 such steps each way, so no rebalancing job was added.
- **Anchor validation.** An anchor equal to the moved Ticket is
  `reorder_anchor_invalid` rather than a no-op, because "before itself" has
  no meaning. A malformed anchor id is treated like an unknown one,
  `reorder_anchor_invalid`. An unknown, malformed or foreign moved Ticket is
  checked first and gets the shared `404`, so an anchor error never reveals
  whether another Owner's Ticket exists. Unknown and foreign anchors share
  one message for the same reason.
- **No rank in the API.** `Ticket` has no rank field. The order is the
  list's order, so clients cannot compute positions and drift from
  Galley's.
- **`updated_at`** changes only on the moved Ticket. Renumbering is
  bookkeeping and does not touch other Tickets' timestamps.
- **Archived filter order.** The decision says the Archived filter orders
  by `archived_at DESC`. The code before this slice actually used
  `created_at DESC`. It now uses `archived_at DESC, id DESC`, as decided.
- **Dropped the `(owner_id, created_at, id)` index.** No query sorts by
  `created_at` any more. The unique constraint's index on `(owner_id,
  priority_rank)` serves the list.
- **Badge-filtered list.** Move up and Move down anchor on the neighbour
  visible in the current view. With a Badge filter, a Ticket moves past
  its visible neighbour, and any hidden Tickets between them keep their
  places relative to that neighbour.
- **Desktop drop placement.** Pointer above or below the slip's vertical
  midpoint. A slip-level `dragover` handler calls `stopPropagation`, so a
  same-stage drop never reaches the stage's Status-move handler.
- **Phone slip switching.** Tapping another slip's toggle while a panel is
  open now switches on click rather than on `pointerdown`. The browser
  suite caught that the taller panel (with the reorder buttons) collapsed
  on `pointerdown` and moved the next toggle out from under the tap.
- **Drop hint fits one line.** The first hint text, "↕ Drop on a slip to
  reorder", wrapped in a desktop column when a drag started. That pushed
  the slips down under the pointer and lost the drop. It is now "↕
  Reorder", the same length as the other hints.

## Exact versions and toolchain

- **Runtimes:** Go 1.27.1, Node 26.9.0, npm 11.19.1, PostgreSQL 17.11 (Homebrew, this host).
- **Galley (`apps/galley/go.mod`):** pgx/v5 5.11.0, golang-migrate/v4 4.20.1, oapi-codegen/v2 2.8.0, kin-openapi 0.149.0.
- **Contracts (`contracts/package.json`):** openapi-typescript 7.13.0.
- **Swiftlet (`apps/swiftlet/package.json`):** React 19.3.0, Tailwind CSS 4.3.3, TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1.
- **Michelin (`apps/michelin/package.json`):** unchanged by this slice; TypeScript 5.9.3, Vitest 5.0.1.
- **Browser suite (`e2e/package.json`):** Playwright 1.63.0.

## Reproducible commands

```sh
cd apps/galley
gofmt -l . && go vet ./...
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m45?sslmode=disable' go test -count=1 ./...
./scripts/check-contract-drift.sh
cd ../../contracts && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh
cd ../apps/swiftlet && npm ci && npm test && npm run build
cd ../michelin && npm ci && npm run typecheck && npm test
cd ../../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m45?sslmode=disable' ./run.sh
```

The manual run used a scratch database `ticketit_scratch_m45`, migrated
with `go run ./cmd/migrate` and dropped afterwards. Galley ran on port
18451 in development, and sign-in went through the substitute GitHub
provider (`cmd/githubfake`) with `curl -L` and a cookie jar.

## Observed results

**Checks.** `gofmt -l` printed nothing, and `go vet` was clean.

| Check | Result |
| --- | --- |
| Galley `go test ./...` | every package `ok` (3 with no test files); 818 tests and subtests passed, 0 failed |
| Drift checks | all three printed `OK … (no drift)` |
| Swiftlet `npm test` | 19 files, 273 tests passed |
| Swiftlet `npm run build` | succeeded |
| Michelin | typecheck clean; 6 files, 53 tests passed |
| Browser suite | `SUITE PASSED`, all 32 spec runs exit 0, 80 tests; `ticket-priority-order.spec.ts` 2 tests |

Priority tests:

```text
--- PASS: TestMigration12_BackfillsPriorityRankNewestFirstPerOwner (0.11s)
--- PASS: TestReorder_ResponsesMatchContractAndMethod405 (0.02s)
--- PASS: TestPriorityGap_Midpoint (0.00s)
--- PASS: TestPriorityPlacement_CaptureTopReadyBottomOtherwiseKept (0.11s)
--- PASS: TestReorder_BeforeAndAfterWithinStageWithInterleavedStages (0.09s)
--- PASS: TestReorder_RepeatingAMoveKeepsTheRank (0.07s)
--- PASS: TestReorder_RejectionsLeaveTheOrderUnchanged (0.08s)
--- PASS: TestReorder_NoGapRenumbersTheWholeCollectionInOrder (0.08s)
--- PASS: TestReorder_RepeatedMovesIntoOneGapRenumberAndKeepOrder (0.10s)
    ticket_priority_test.go:527: seed 1790787852039893000
--- PASS: TestReorder_ConcurrentReordersKeepAStrictTotalOrder (0.15s)
--- PASS: TestPriority_ConcurrentReorderCaptureAndReadyEntry (0.11s)
```

What the tests cover:

- Placement (15 cases): capture at the top; entering Ready at the bottom
  from Backlog, In Progress and Done; other Status changes, Accept,
  archive and restore (including a Ready Ticket restored to Backlog) keep
  the rank.
- The migration test migrates to 11, inserts two Owners' rows (including
  a `created_at` tie and an archived row), migrates to 12 and checks the
  backfilled ranks.
- The first concurrency test runs 16 concurrent random reorders in each
  of 5 seeded rounds.
- The second runs 24 concurrent reorders, captures and Ready entries.
- Both concurrency tests require every request to succeed. Afterwards
  they require a strictly increasing, duplicate-free rank per Ticket.

**Falsification.** With `lockOwnerPriority` changed to return `nil`, both
concurrency tests failed. Without the lock, concurrent writers compute
the same rank and one fails the unique constraint. The change was
reverted before committing.

```text
--- FAIL: TestReorder_ConcurrentReordersKeepAStrictTotalOrder (1.20s)
    ticket_priority_test.go:527: seed 1790787882446274000
    ticket_priority_test.go:544: round 0: 2 of 16 reorders failed: [POST /api/tickets/5ca549fe-…/position {"after":"cb27b574-…"}: 503 {"error":{"code":"database_unavailable","message":"failed to reorder the ticket"}} …]
--- FAIL: TestPriority_ConcurrentReorderCaptureAndReadyEntry (4.48s)
    ticket_priority_test.go:580: 8 of 24 requests failed: [POST /api/tickets/d4ecf851-…/status {"status":"Ready"}: 503 … POST /api/tickets {"title":"captured 1"}: 503 {"error":{"code":"database_unavailable","message":"failed to create the ticket"}} …]
FAIL	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	6.589s
```

**Deferrable constraint** (scratch database, rolled back). The same
rank-shifting `UPDATE` fails under a non-deferrable constraint and
succeeds under the migration's `DEFERRABLE INITIALLY IMMEDIATE` one:

```text
 E | 1024
 D | 2048
 A | 3072
 C | 3584
 B | 4096
BEGIN
ALTER TABLE   -- drop tickets_owner_priority_rank_unique
ALTER TABLE   -- re-add as UNIQUE (owner_id, priority_rank), not deferrable
UPDATE tickets SET priority_rank = priority_rank - 1024 WHERE owner_id = 1 AND title IN ('E', 'D', 'A');
ERROR:  duplicate key value violates unique constraint "tickets_owner_priority_rank_unique"
DETAIL:  Key (owner_id, priority_rank)=(1, 2048) already exists.
ROLLBACK
BEGIN         -- the migration's constraint
UPDATE tickets SET priority_rank = priority_rank - 1024 WHERE owner_id = 1 AND title IN ('E', 'D', 'A');
UPDATE 3
ROLLBACK
```

**Manual run: Galley** (development, scratch database). The Ticket order
is printed from `GET /api/tickets`, first to last:

```text
$ capture A, B, C, D
D(Backlog) < C(Backlog) < B(Backlog) < A(Backlog)
$ A, B, C enter Ready in that order
D(Backlog) < A(Ready) < B(Ready) < C(Ready)
$ POST /api/tickets/{C}/position {"before": A}
{"title":"C","status":"Ready","updatedAt":"2026-09-30T17:05:36Z"}
D(Backlog) < C(Ready) < A(Ready) < B(Ready)
$ POST /api/tickets/{C}/position {"after": B}
200
D(Backlog) < A(Ready) < B(Ready) < C(Ready)
$ psql: SELECT title, status, priority_rank ORDER BY priority_rank, id
D|Backlog|-2048
A|Ready|2048
B|Ready|3072
C|Ready|4096
$ same move again
200
C|4096
$ C before D (Backlog)
{"error":{"code":"reorder_anchor_invalid","message":"the anchor must be in the same Status (Ready), not Backlog"}} 400
$ C before C
{"error":{"code":"reorder_anchor_invalid","message":"a Ticket cannot be placed relative to itself"}} 400
$ C before not-a-uuid
{"error":{"code":"reorder_anchor_invalid","message":"the anchor must identify one of your Tickets"}} 400
$ C before unknown uuid
{"error":{"code":"reorder_anchor_invalid","message":"the anchor must identify one of your Tickets"}} 400
$ {} and both
{"error":{"code":"invalid_request","message":"request body must be JSON matching {\"before\": \"<ticketId>\"} or {\"after\": \"<ticketId>\"}"}} 400
{"error":{"code":"invalid_request","message":"request body must be JSON matching {\"before\": \"<ticketId>\"} or {\"after\": \"<ticketId>\"}"}} 400
$ unknown moved Ticket
{"error":{"code":"not_found","message":"no ticket with that identifier"}} 404
$ GET position
HTTP/1.1 405 Method Not Allowed
Allow: POST
$ no session
{"error":{"code":"unauthenticated","message":"sign-in required"}} 401
```

Renumbering, with an archived Ticket E and the gap between A and B
closed by hand:

```text
$ psql: title, status, archived, priority_rank, updated_at
E|Backlog|t|-3072|2026-10-01 01:05:51.234467+08
D|Backlog|f|-2048|2026-10-01 01:05:36.61838+08
A|Ready|f|2048|2026-10-01 01:05:36.640327+08
B|Ready|f|2049|2026-10-01 01:05:36.654453+08
C|Ready|f|4096|2026-10-01 01:05:36.721663+08
$ POST /api/tickets/{C}/position {"before": B}
200
E|Backlog|t|1024|2026-10-01 01:05:51.234467+08
D|Backlog|f|2048|2026-10-01 01:05:36.61838+08
A|Ready|f|3072|2026-10-01 01:05:36.640327+08
C|Ready|f|3584|2026-10-01 01:05:51.284809+08
B|Ready|f|4096|2026-10-01 01:05:36.654453+08
$ move archived E
{"error":{"code":"archived_ticket","message":"archived tickets are read-only"}} 400
$ A before archived E
{"error":{"code":"reorder_anchor_invalid","message":"the anchor must not be archived"}} 400
```

The whole collection, archived E included, was renumbered 1024 apart in
the same order, and C took the midpoint 3584. Only C's `updated_at`
changed.

**Browser suite.** In the first spec, three Ready Tickets are dragged
onto the upper half of one slip and the lower half of another. The
Galley request bodies are checked (`{"before": A}`, `{"after": B}`). Move
up and Move down are then used in the list. After each step, the board
or list order is compared with live `GET /api/tickets`. After a reload,
the list and the board show the same order. The second spec makes the
list stale and checks that the Move up rejection shows Galley's
`reorder_anchor_invalid` message and that the order is unchanged.

```text
  ✓  1 [chromium] › tests/ticket-priority-order.spec.ts:42:1 › reorder a Ready stage by drag on the board and Move up/down in the list; the order persists and matches Galley (891ms)
  ✓  2 [chromium] › tests/ticket-priority-order.spec.ts:97:1 › a stale Move up shows Galley's anchor rejection verbatim and the order stays put (392ms)
[run.sh] ticket-priority-order.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

## Implementation limitations and follow-ups

None. Claims that follow this order are M4.6 by design, not a
limitation of this slice.

## Outstanding checks and owning milestone

- **Claim order.** M4.6 must claim the first eligible Ready Ticket by
  `priority_rank, id` and should take the same advisory lock, so a claim
  sees a settled order.
- **Scale.** Renumbering updates every one of the Owner's Tickets in one
  statement. It was exercised at test sizes only. v1 has a single Owner
  with a personal backlog, so no load check was run.

## Decision impacts (open-decision IDs)

None of D1–D9. This slice implements the Owner decision in
[#108](https://github.com/cristoforows/ticketIt/issues/108) that manual
ordering drives claim order, as fixed in #131's Decisions.
