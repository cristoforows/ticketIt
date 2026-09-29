# Archive a Ticket

## Purpose

[M3.7 #93](https://github.com/cristoforows/ticketIt/issues/93) retains archived Tickets while hiding them from everyday views and enforcing read-only behavior in Galley. Galley, Swiftlet, contracts and browser tests changed.

## What already existed

#92 provided Owner-scoped Badge filtering and detach; #90 supplied board moves; #89 supplied shared modal and full-page detail. No archived state, archived list filter, Restore, or common mutation guard existed. #94 owns Archived filtering and Restore.

## What this slice added

- Forward-only migration `000009_archive_tickets.up.sql` adds nullable `tickets.archived_at`. The contract requires `Ticket.archivedAt` on all responses (`null` until archived). Archived state is separate from Status. `POST /api/tickets/{id}/archive` locks the Owner's Ticket, sets `archived_at`, returns the hydrated Ticket and rejects a second archive with `400 archived_ticket`; unknown, malformed or foreign identifiers return the shared `404`.
- `lockTicketForMutation` is the sole archived-state decision point, called in each command's own transaction before changing fields, Status, Accept, Assignee or Badge links. It obtains a PostgreSQL row lock, so a concurrent command sees the committed archive state. `writeMutationError` maps its stable reason across commands. Galley's allowed actions have no status targets and publish the archived reason for Accept. Default collection reads exclude archived Tickets even when Badge-filtered; direct detail keeps Status, fields and Badges.
- The archive control in detail/modal asks for confirmation, submits to Galley and returns to the originating view. Direct archived detail renders its timestamp and Galley's read-only reason, with edit, assignment, Badge and Archive controls disabled. `parseTicket` and browser-support Ticket type require `archivedAt`.
- M4's claim/eligibility check must exclude `archived_at IS NOT NULL`. The same Galley guard is the extension point for open-Round locks in M4/M5; no Round or execution placeholder exists in M3.7. Archiving inserts no execution artefact.

## Exact versions and toolchain

Go 1.27.1, Node 26.9.0, npm 11.19.1, PostgreSQL 18.1. Pinned: pgx/v5 5.11.0, golang-migrate/v4 4.20.1, oapi-codegen/v2 2.8.0, kin-openapi 0.149.0 (`apps/galley/go.mod`); openapi-typescript 7.13.0 (`contracts/package.json`); TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1 (`apps/swiftlet/package-lock.json`); Playwright 1.63.0 (`e2e/package.json`).

## Reproducible commands

With local PostgreSQL 18, `ticketit_test`, dedicated `ticketit_e2e` and `psql` on PATH:

```sh
(cd contracts && npm ci && npm run generate:swiftlet && npm run check:swiftlet-drift)
(cd apps/galley && go generate ./... && go test ./... && go vet ./... && go build ./... && ./scripts/check-contract-drift.sh)
(cd apps/swiftlet && npm ci && npm test && npm run build)
(cd e2e && ./run.sh)
```

Stage regenerated outputs before drift scripts, which compare them to the Git index. This host selected Node 26 using `PATH="$HOME/.nvm/versions/node/v26.9.0/bin:$PATH"` and used a local Docker PostgreSQL client wrapper for `psql`; `ticketit_e2e` already existed.

## Observed results

- `go test ./...`: all packages passed, including `internal/httpapi` 8.781s; `go vet ./...` and `go build ./...` exited 0. The table-driven archive test rejects all eight mutating commands with the same code and unchanged Ticket state; archive-from-Status tests cover all six Status values. Concurrent double archive returns one 200 and one 400. A real second Owner on a fresh migrated test database gets shared 404s for foreign, unknown and malformed ids. The manual lifecycle no-execution test now includes Archive.
- Falsification: temporarily removing the shared lock/guard call from `setTicketAssigneeForOwner`, then running `go test ./internal/httpapi -run TestArchive_AllMutationsRejectWithoutChangingTicket -count=1`, failed: `PUT` and `DELETE /assignee` returned 200 instead of 400 for an archived Ticket. Restoring that call made `go test ./internal/httpapi -run 'TestArchive_' -count=1` pass. The temporary change is absent from this slice.
- Swiftlet `npm test`: 9 files / 112 tests passed; `npm run build`: TypeScript and Vite production build passed.
- Full `e2e/run.sh`: applied schema version 9; `ticket-archive.spec.ts` 1 passed after a Galley restart (including board-origin full-page Archive); every other registered browser spec exited 0; `SUITE PASSED`. First run caught an ambiguous Playwright locator matching the Remove button for a Badge named Archive; the test now selects `ticket-detail-archive-button` and the full suite passed.

## Implementation limitations and follow-ups

No M3.7 behavior left unimplemented. Archived list filtering, Restore and Ready → Backlog belong to #94 (M3). Open-Round lock and claim races belong to M4/M5.

## Outstanding checks and owning milestone

M4 must enforce archive exclusion at claim/eligibility and test concurrent archive/claim. M5 must extend the same row-locked decision point for open Rounds. Real-provider OAuth coverage remains M10's check; browser tests use a local substitute.

## Decision impacts (open-decision IDs)

No open decision resolved. D3's retained completion condition is unchanged by Archive; D1, D2, D4–D9 remain open.
