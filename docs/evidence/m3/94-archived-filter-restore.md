# Archived filter and Restore

## Purpose

[M3.8 #94](https://github.com/cristoforows/ticketIt/issues/94) makes archived Tickets findable in the list and safely restorable. Galley, Swiftlet, contracts and browser tests changed.

## What already existed

#93 provided `archived_at`, an Archive command, a row-locked Galley mutation decision point, a retained read-only direct detail and default list/board exclusion. #92 provided Owner-scoped Badge OR filtering and URL selection. There was no Archived filter or Restore command.

## What this slice added

- Contract-first optional `archived=true` on `GET /api/tickets` selects archived Tickets instead of the default unarchived set. It composes with repeated `badgeId` values through the same Owner-scoped query and preserves one Ticket per match and newest-first ordering. The board intentionally requests only unarchived Tickets even when its URL retains the list's `archived=true`: a board is a current-work view, while preserving the URL lets the Owner return to the same list selection.
- `POST /api/tickets/{id}/restore` locks the Owner's Ticket through `lockTicketForMutation` inside a transaction, verifies it is archived and clears `archived_at`. Ready becomes Backlog; every other Status including Done stays put. The command returns the hydrated Ticket with fields and Badges unchanged and fresh allowed actions. A non-archived Ticket returns `400 not_archived`; unknown, malformed or foreign ids return shared `404`. No execution artefact is created. Concurrent Archive/Restore requests serialize on the row; a real PostgreSQL race test checks both legal outcomes and final state.
- Swiftlet's Archived checkbox uses `archived=true` in the list URL. It composes with Badge selection and survives reload, view switching and modal navigation. Archived detail/modal exposes Restore; Galley's returned Ticket updates the visible Status, including Ready → Backlog. Closing the modal refreshes the Archived collection so the restored Ticket disappears from that view. An unarchived list and the board display it again. No additional migration or storage field was needed.

## Exact versions and toolchain

Go 1.27.1; Node 26.9.0; npm 11.19.1; PostgreSQL 18.1. Pinned: pgx/v5 5.11.0, golang-migrate/v4 4.20.1, oapi-codegen/v2 2.8.0, kin-openapi 0.149.0 (`apps/galley/go.mod`); openapi-typescript 7.13.0 (`contracts/package.json`); TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1 (`apps/swiftlet/package-lock.json`); Playwright 1.63.0 (`e2e/package.json`).

## Reproducible commands

With local PostgreSQL 18, `ticketit_test`, dedicated `ticketit_e2e` and `psql` on PATH:

```sh
(cd contracts && npm ci && npm run generate:swiftlet && npm run check:swiftlet-drift)
(cd apps/galley && go generate ./... && go test ./... && go vet ./... && go build ./... && ./scripts/check-contract-drift.sh)
(cd apps/swiftlet && npm ci && npm test && npm run build)
(cd e2e && ./run.sh)
```

Stage regenerated outputs before drift scripts, which compare to the Git index. This host selected Node 26 via `PATH="$HOME/.nvm/versions/node/v26.9.0/bin:$PATH"` and used a local Docker PostgreSQL client wrapper for `psql`; `ticketit_e2e` already existed.

## Observed results

- `go test ./...` passed all tested packages (`internal/httpapi` 9.999s), including restore from all six Status values, non-archived rejection, cross-Owner access, Archived and Badge filter composition, and five concurrent Archive/Restore races against real PostgreSQL. `go vet ./...` and `go build ./...` exited 0. `TestManualLifecycleActionsCreateNoExecutionRecords` now includes Archive followed by Restore.
- Swiftlet `npm test`: 9 files / 115 tests passed; TypeScript and Vite production build passed.
- Full `e2e/run.sh`: schema version 9; `ticket-restore-before.spec.ts` passed, Galley restarted, `ticket-restore-after.spec.ts` passed, and all other registered browser specs exited 0; `SUITE PASSED`. The before spec used Galley's API to set up Ready and Done, applied both Archived and Badge UI filters, restored both in the modal, checked Ready in Backlog and Done in Done, and confirmed the board ignored the list's Archived selection. The after spec checked the same Ticket fields and Badges across a real process restart.

## Implementation limitations and follow-ups

No required M3.8 behavior left unimplemented. M4 must exclude archived Tickets from claim/eligibility; M5 owns open-Round restrictions. Neither is added by Restore.

## Outstanding checks and owning milestone

M4 owns concurrent archive/claim acceptance and M5 owns open-Round mutation policy; M10 owns real-provider OAuth checks. The local browser suite uses a substitute provider.

## Decision impacts (open-decision IDs)

No open decision resolved. Accepted D3's retained completion condition is unchanged by Restore. D1, D2 and D4–D9 remain open.
