# Badge detach and Ticket filtering

## Purpose

[M3.6 #92](https://github.com/cristoforows/ticketIt/issues/92) adds Owner-scoped Badge detach and shared list/board filtering. Galley, Swiftlet, contracts and browser tests changed.

## What already existed

#91 supplied a reusable Badge library, attachment command, and Badge presentation on Ticket lists, board cards and detail. `GET /api/tickets` had no query filters. #89 and #90 supplied the modal and board navigation. Archived Ticket visibility belongs to #93 and #94.

## What this slice added

- Contract-first `DELETE /api/tickets/{id}/badges/{badgeId}` returns the hydrated Ticket after deleting the link inside a row-locked transaction. An owned but unattached Badge succeeds again on repeat, because desired absence already holds; the Badge definition is retained. Unknown, malformed and foreign Ticket or Badge ids share `404 not_found`. The existing route's `405 Allow` header now names PUT and DELETE.
- Repeated `badgeId` query parameters on `GET /api/tickets` select any match, once per Ticket, via an Owner-scoped `EXISTS` predicate. Existing newest-first ordering is retained. Every requested Badge must belong to the Owner; unknown, empty, malformed and foreign ids receive `400 invalid_request` rather than quietly hiding Tickets. Duplicate ids are collapsed before validation. This is the decision point where #94 adds archived visibility without moving filtering to Swiftlet.
- Swiftlet keeps Badge selection in the URL query string through reload, List/Board navigation, modal open/close, and full-page detail's Back to Backlog link. Both collections request Galley's filtered list; filter changes remount the active collection to avoid showing stale unfiltered rows. An empty result shows a filter-specific state. Detail/modal shows a per-Badge Remove action; its returned Ticket replaces local state, and modal closure refreshes the same filtered collection. Existing Badge browser specs now select the Badge name span within a row that also contains a Remove button.
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

Galley ran against a fresh migrated database (`GALLEY_TEST_DATABASE_URL=postgres://localhost:5432/ticketit_test_pr105?sslmode=disable`); the shared `ticketit_test` held a sibling branch's version 9 schema. `go test ./internal/httpapi -run 'TestBadges_(FilterMatchesAnyWithoutDuplicatesAndKeepsOrder|ActualOwnersAreIsolatedThroughHTTP)' -count=1 -v` exercised the real handler; `badge_test.go` logs each request and response:

```text
=== RUN   TestBadges_ActualOwnersAreIsolatedThroughHTTP
    badge_test.go:224: POST /api/badges {"name":"Evidence Badge"} -> HTTP 201 {"createdAt":"2026-09-29T13:33:49Z","id":"8b033c5b-a79f-4043-b3d4-22ed15458ab8","name":"Evidence Badge"}
    badge_test.go:264: PUT /api/tickets/2c40087b-a6df-490a-9339-bcdf42303212/badges/95eb6bca-e757-4af3-afa8-d00a8816ccb8 -> HTTP 404 {"error":{"code":"not_found","message":"no ticket or badge with that identifier"}}
--- PASS: TestBadges_ActualOwnersAreIsolatedThroughHTTP (0.22s)
=== RUN   TestBadges_FilterMatchesAnyWithoutDuplicatesAndKeepsOrder
    badge_test.go:316: GET /api/tickets?badgeId=6e3390cf-137b-4505-8a6b-a60ed5b2c096&badgeId=741915ea-f161-4d9a-9d07-8807e6ec7515&badgeId=6e3390cf-137b-4505-8a6b-a60ed5b2c096 -> HTTP 200 {"tickets":[{"allowedActions":{"accept":{"available":false,"reason":{"code":"invalid_transition","message":"Accept requires the ticket to be In Review (current status Backlog)"}},"statusChanges":["Ready","Blocked"]},"assigneeType":"","badges":[{"id":"6e3390cf-137b-4505-8a6b-a60ed5b2c096","name":"52ee008e-bcf0-4b85-87e0-3e6bf0f061c8"},{"id":"741915ea-f161-4d9a-9d07-8807e6ec7515","name":"e2d5829e-f8a0-4963-9ad1-e399304c0d16"}],"completionCondition":"humanAcceptance","constraints":"","context":"","createdAt":"2026-09-29T13:34:07Z","goal":"","id":"41628dab-5208-4f9f-a73d-4a3cd7f88150","repository":"","status":"Backlog","successCriteria":"","template":"Basic","title":"both","updatedAt":"2026-09-29T13:34:07Z"},{"allowedActions":{"accept":{"available":false,"reason":{"code":"invalid_transition","message":"Accept requires the ticket to be In Review (current status Backlog)"}},"statusChanges":["Ready","Blocked"]},"assigneeType":"","badges":[{"id":"741915ea-f161-4d9a-9d07-8807e6ec7515","name":"e2d5829e-f8a0-4963-9ad1-e399304c0d16"}],"completionCondition":"humanAcceptance","constraints":"","context":"","createdAt":"2026-09-29T13:34:07Z","goal":"","id":"8c86db1b-030b-4261-807a-51526ef55ce0","repository":"","status":"Backlog","successCriteria":"","template":"Basic","title":"only b","updatedAt":"2026-09-29T13:34:07Z"},{"allowedActions":{"accept":{"available":false,"reason":{"code":"invalid_transition","message":"Accept requires the ticket to be In Review (current status Backlog)"}},"statusChanges":["Ready","Blocked"]},"assigneeType":"","badges":[{"id":"6e3390cf-137b-4505-8a6b-a60ed5b2c096","name":"52ee008e-bcf0-4b85-87e0-3e6bf0f061c8"}],"completionCondition":"humanAcceptance","constraints":"","context":"","createdAt":"2026-09-29T13:34:07Z","goal":"","id":"6e5507a0-fdb5-4c0e-bc84-a5e5dbe1fd12","repository":"","status":"Backlog","successCriteria":"","template":"Basic","title":"only a","updatedAt":"2026-09-29T13:34:07Z"}]}
    badge_test.go:327: GET /api/tickets?badgeId=bad -> HTTP 400 {"error":{"code":"invalid_request","message":"badgeId must identify an owned Badge"}}
    badge_test.go:327: GET /api/tickets?badgeId=cb24afa4-0c17-4542-8243-948104df6b9e -> HTTP 400 {"error":{"code":"invalid_request","message":"badgeId must identify an owned Badge"}}
    badge_test.go:327: GET /api/tickets?badgeId= -> HTTP 400 {"error":{"code":"invalid_request","message":"badgeId must identify an owned Badge"}}
--- PASS: TestBadges_FilterMatchesAnyWithoutDuplicatesAndKeepsOrder (0.07s)
PASS
```

The filtered response returns the Ticket carrying both Badges once, then the two single-Badge Tickets, newest first; the Ticket with no Badge is absent. The same run rejected cross-Owner Badge ids in filter and detach and confirmed repeated detach keeps the library Badge.

`go test ./... -count=1`, `go vet ./...`, `go build ./...` and both drift checks:

```text
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	4.599s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	1.839s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	1.856s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.907s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	2.310s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	7.773s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	3.490s
VET_BUILD_OK
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

Swiftlet `npm test && npm run build`. The full-page return case, `returns to the Backlog with the selected Badge filter`, failed before `TicketDetailPage`'s Back to Backlog link carried the query:

```text
 Test Files  9 passed (9)
      Tests  110 passed (110)
dist/index.html                   0.39 kB │ gzip:   0.26 kB
dist/assets/index-CTKyTK7u.css    7.13 kB │ gzip:   1.92 kB
dist/assets/index-C6FS3MqK.js   339.69 kB │ gzip: 105.88 kB
✓ built in 140ms
```

Full `e2e/run.sh` exited 0; all 23 registered spec invocations passed (55 Chromium tests). `ticket-badge-filter.spec.ts` now also opens a filtered Ticket in full page and returns through Back to Backlog with both Badges still selected:

```text
migrations applied: schema version 8
[run.sh] running tests/ticket-badge-filter.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/ticket-badge-filter.spec.ts:5:1 › Badge OR filter survives reload, board switch and full-page return; detaching in modal removes the matching Ticket (882ms)
  1 passed (1.3s)
[run.sh] ticket-badges-before.spec.ts exit code: 0
[run.sh] ticket-badges-after.spec.ts exit code: 0
[run.sh] ticket-badge-filter.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

## Implementation limitations and follow-ups

No required M3.6 behavior left unimplemented. #93 owns archive/read-only mutation enforcement; #94 owns Archived filter composition and Restore.

## Outstanding checks and owning milestone

The dedicated browser suite exercises a substitute GitHub OAuth provider; real-provider coverage belongs to M10. M4/M5 must extend the #93 mutation decision point for open Rounds and prove their races.

## Decision impacts (open-decision IDs)

No open decision resolved. Accepted D3's separation of Template and execution capability remains intact; D1, D2, D4–D9 remain open.
