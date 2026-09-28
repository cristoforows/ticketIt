# Reusable Badges on Tickets

## Purpose

[M3.5 #91](https://github.com/cristoforows/ticketIt/issues/91): Galley owns reusable name-only Badges and Ticket attachments; Swiftlet shows and submits them. Both apps and `contracts/` changed.

## What already existed

Base `bad7bbe` includes the #89 modal over shared list/board/detail Ticket data, persistent Owner sessions, and Ticket lifecycle commands. PR #101 is pending; this slice uses the reviewed base without assuming it has merged. No Badge table, endpoint or UI existed.

## What this slice added

- `000008_create_badges.up.sql` adds an Owner-scoped `badges` table (internal identity, opaque UUID public id, immutable name, creation time), a `(owner_id, lower(name))` unique index, and `ticket_badges` with composite primary key and Owner-matching foreign keys. The database index arbitrates races; no name pre-check can substitute for it. Go trims and counts Unicode code points against the documented 80-character maximum. PostgreSQL supplies case-insensitive comparison according to its database collation.
- Contract-first `GET/POST /api/badges` and `PUT /api/tickets/{id}/badges/{badgeId}`; `409 duplicate_badge_name`, shared `404` for malformed/unknown/foreign ids, strict JSON body decoding, route-specific `405`. List and Ticket Badge order: `lower(name), public_id` ascending. Ticket responses always carry `badges` (empty array when none). An idempotent attachment does not create a second link or change Ticket columns/`updatedAt`.
- `loadTicketBadges` is the common read path after Ticket creation, lookup, update, list, transition, and Assignee changes. Galley alone makes the attachment decision; Swiftlet's parser rejects a Ticket lacking `badges` and the full-page/modal picker uses Galley's response for both success and rejection. Creation and attachment are two commands: if attach fails after create, the definition remains reusable.
- The known-table guardrail explicitly gains both tables; manual lifecycle actions still cannot create rows in them. Regenerated Go and TypeScript contract clients. Browser before/after specs exercise a real restart, two Tickets, two Badges, duplicate rejection, reuse and list/board/modal/detail. No detach/filter/rename/delete/colour endpoint or placeholder built-in Badge was added.
- M5 extension point: add a `kind` discriminator (existing definitions default to `custom`; a built-in definition has its own kind), then adjust uniqueness to `(owner_id, kind, lower(name))`. This requires no custom Badge data rewrite and preserves opaque ids plus the same Ticket–Badge attachment contract, even if an Owner has a custom Badge named Stopped. The Badge attachment decision is isolated in `attachBadgeForOwner` for later open-Round policy; this slice adds no Round behaviour.

## Exact versions and toolchain

Observed Go 1.27.1, Node 26.9.0, npm 11.19.1 and PostgreSQL server 18.1. Pinned: pgx/v5 5.11.0, golang-migrate/v4 4.20.1, oapi-codegen/v2 2.8.0, kin-openapi 0.149.0 (`apps/galley/go.mod`); openapi-typescript 7.13.0 (`contracts/package-lock.json`); TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1 (`apps/swiftlet/package-lock.json`); Playwright 1.63.0 (`e2e/package-lock.json`). The local PostgreSQL server was reachable on port 5432; the locally available Docker `postgres:18` image supplied client `psql` 18.1 for the browser runner because host `psql`/`createdb` binaries were absent.

## Reproducible commands

From the repository root, with PostgreSQL running, `ticketit_test` available, and `psql`/`createdb` on `PATH` for the e2e runner:

```sh
(cd contracts && npm ci && npm run generate:swiftlet && npm run check:swiftlet-drift)
(cd apps/galley && go generate ./... && go test ./... && go vet ./... && go build ./... && ./scripts/check-contract-drift.sh)
(cd apps/swiftlet && npm ci && npm test && npm run build)
(cd e2e && ./run.sh)
```

Drift scripts require generated files clean relative to the index; run them after staging regenerated output. On this host, Node 26 was selected via `PATH="$HOME/.nvm/versions/node/v26.9.0/bin:$PATH"`; e2e `npm ci` needed `--registry=https://registry.npmjs.org` because the configured company registry returned `E401`. Ignored wrappers under `e2e/.artifacts/bin` used Docker `postgres:18` to provide `psql`/`createdb` for `run.sh`, then passed the host DB through `host.docker.internal`. These local test helpers are not part of the commit.

## Observed results

- `go test ./internal/httpapi -run 'TestBadges_' -count=1`: `ok` (1.208s), including real-PostgreSQL concurrent double create with one `201` and one `409`, plus response-vs-schema and `405` checks.
- `go test ./...`: all tested packages `ok`, including `internal/httpapi` (9.005s); `go vet ./...` and `go build ./...` exited 0.
- Swiftlet `npm test`: 9 files / 91 tests passed; `npm run build`: `tsc` and Vite 8.3.0 production build passed.
- Full `e2e/run.sh`: `migrations applied: schema version 8`; `ticket-badges-before.spec.ts` 1 passed, `ticket-badges-after.spec.ts` 1 passed after a fresh Galley process; all other registered specs exit code 0; `SUITE PASSED`. Browser test observed direct API `POST /api/badges` for a case-changed duplicate return `409 duplicate_badge_name` and displayed the exact returned message, `PUT` idempotently return one Badge, and list/board/detail responses retain both links after restart.
- Initial browser run failed only the new spec because Playwright's non-exact `Close` matched both the dialog and picker buttons; switched the locator to exact matching and reran the whole suite successfully. Initial e2e invocation could not find host `psql`; Docker client wrappers resolved it without changing tracked files.

## Implementation limitations and follow-ups

No required behaviour left unimplemented. Detach/filter belongs to #92 (M3); archive mutation rules to #93 (M3); M5 owns the built-in Stopped Badge and the eventual open-Round attachment rule. Neither rule is guessed here.

## Outstanding checks and owning milestone

Real-provider GitHub OAuth verification remains M10's existing check; this suite uses the local fake provider. M5 must decide and test the built-in Badge's actual lifecycle and kind migration. Future volume/performance checks for very large Badge collections belong to M10; this slice exercises real DB concurrency and browser integration, not load testing. An optional standalone `tsc --noEmit -p e2e/tsconfig.json` was attempted with temporary TypeScript/types installed; it failed in pre-existing `ticket-board.spec.ts` (string vs `TicketStatus`) and `ticket-modal.spec.ts` (missing DOM lib). `e2e/run.sh` and all browser tests passed; a dedicated e2e typecheck is not part of the documented runner.

## Decision impacts (open-decision IDs)

No open decision resolved. D3 remains accepted; this slice adds no Template-to-capability mapping. D1, D2 and D4–D9 remain open and untouched.
