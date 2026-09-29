# Badge detach and Ticket filtering

## Purpose

[M3.6 #92](https://github.com/cristoforows/ticketIt/issues/92) adds Owner-scoped Badge detach and shared list/board filtering. Galley, Swiftlet, contracts and browser tests changed.

## What already existed

#91 supplied a reusable Badge library, attachment command, and Badge presentation on Ticket lists, board cards and detail. `GET /api/tickets` had no query filters. #89 and #90 supplied the modal and board navigation. Archived Ticket visibility belongs to #93 and #94.

## What this slice added

- Contract-first `DELETE /api/tickets/{id}/badges/{badgeId}` returns the hydrated Ticket after deleting the link inside a row-locked transaction. An owned but unattached Badge succeeds again on repeat, because desired absence already holds; the Badge definition is retained. Unknown, malformed and foreign Ticket or Badge ids share `404 not_found`. The existing route's `405 Allow` header now names PUT and DELETE.
- Repeated `badgeId` query parameters on `GET /api/tickets` select any match, once per Ticket, via an Owner-scoped `EXISTS` predicate. Existing newest-first ordering is retained. Every requested Badge must belong to the Owner; unknown, empty, malformed and foreign ids receive `400 invalid_request` rather than quietly hiding Tickets. Duplicate ids are collapsed before validation. This is the decision point where #94 adds archived visibility without moving filtering to Swiftlet.
- Swiftlet keeps Badge selection in the URL query string through reload, List/Board navigation and modal open/close. Both collections request Galley's filtered list; filter changes remount the active collection to avoid showing stale unfiltered rows. An empty result shows a filter-specific state. Detail/modal shows a per-Badge Remove action; its returned Ticket replaces local state, and modal closure refreshes the same filtered collection. Existing Badge browser specs now select the Badge name span within a row that also contains a Remove button.
- No migration is needed: #91's link table already supports detach. No Template/capability rule or execution artefact is added. Open-Round mutation restrictions remain M4/M5 work; #93 introduces the common mutation decision point for archived Tickets and later Round locks.

## Exact versions and toolchain

Go 1.27.1; Node 26.9.0; npm 11.19.1; PostgreSQL 18.1. Pinned modules: pgx/v5 5.11.0, golang-migrate/v4 4.20.1, oapi-codegen/v2 2.8.0, kin-openapi 0.149.0 (`apps/galley/go.mod`); openapi-typescript 7.13.0 (`contracts/package.json`); TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1 (`apps/swiftlet/package-lock.json`); Playwright 1.63.0 (`e2e/package.json`).

## Reproducible commands

With local PostgreSQL 18 running and `ticketit_test` and dedicated `ticketit_e2e` databases available:

```sh
(cd contracts && npm ci && npm run generate:swiftlet && npm run check:swiftlet-drift)
(cd apps/galley && go generate ./... && go test ./... && go vet ./... && go build ./... && ./scripts/check-contract-drift.sh)
(cd apps/swiftlet && npm ci && npm test && npm run build)
(cd e2e && ./run.sh)
```

The drift scripts compare with the index; stage regenerated outputs before checking, then unstage if not committing. On this host the browser run selected Node 26 via `PATH="$HOME/.nvm/versions/node/v26.9.0/bin:$PATH"` and used an existing `psql` wrapper to the local `ticketit-postgres` container because no host `psql` was installed. `createdb` may be absent if `ticketit_e2e` already exists. The browser runner resets only its dedicated database.

## Observed results

- `go test ./internal/httpapi -run 'TestBadges_(FilterMatchesAnyWithoutDuplicatesAndKeepsOrder|ActualOwnersAreIsolatedThroughHTTP)' -count=1 -v`: both passed against real PostgreSQL. A direct HTTP `GET /api/tickets?badgeId=<A>&badgeId=<B>&badgeId=<A>` returned HTTP 200 with three matching Tickets in newest-first order, no duplicate. Direct requests from two distinct Owner sessions rejected cross-Owner Badge ids in filter and detach. Repeated detach kept the library Badge and removed the Ticket link.
- `go test ./...` passed for all tested packages (`internal/httpapi` 8.888s); `go vet ./...` and `go build ./...` exited 0. `./apps/galley/scripts/check-contract-drift.sh` and `npm --prefix contracts run check:swiftlet-drift` both reported `OK` after staging their generated outputs.
- Swiftlet `npm test`: 9 files / 109 tests passed; `npm run build`: TypeScript and Vite production build passed after the filter-refresh adjustment.
- Full `e2e/run.sh`: schema version 8, both existing Badge before/after restart specs passed, new `ticket-badge-filter.spec.ts` passed against a restarted Galley, all registered exit codes were 0; `SUITE PASSED`.

## Implementation limitations and follow-ups

No required M3.6 behavior left unimplemented. #93 owns archive/read-only mutation enforcement; #94 owns Archived filter composition and Restore.

## Outstanding checks and owning milestone

The dedicated browser suite exercises a substitute GitHub OAuth provider; real-provider coverage belongs to M10. M4/M5 must extend the #93 mutation decision point for open Rounds and prove their races.

## Decision impacts (open-decision IDs)

No open decision resolved. Accepted D3's separation of Template and execution capability remains intact; D1, D2, D4–D9 remain open.
