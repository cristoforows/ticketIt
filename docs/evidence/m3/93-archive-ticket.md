# Archive a Ticket

## Purpose

[M3.7 #93](https://github.com/cristoforows/ticketIt/issues/93) retains archived Tickets while hiding them from everyday views and enforcing read-only behavior in Galley. Galley, Swiftlet, contracts and browser tests changed.

## What already existed

#92 provided Owner-scoped Badge filtering and detach; #90 supplied board moves; #89 supplied shared modal and full-page detail. No archived state, archived list filter, Restore, or common mutation guard existed. #94 owns Archived filtering and Restore.

## What this slice added

- Forward-only migration `000009_archive_tickets.up.sql` adds nullable `tickets.archived_at`. The contract requires `Ticket.archivedAt` on all responses (`null` until archived). Archived state is separate from Status. `POST /api/tickets/{id}/archive` locks the Owner's Ticket, sets `archived_at`, returns the hydrated Ticket and rejects a second archive with `400 archived_ticket`; unknown, malformed or foreign identifiers return the shared `404`.
- `lockTicketForMutation` is the sole archived-state decision point, called in each command's own transaction before changing fields, Status, Accept, Assignee or Badge links. It obtains a PostgreSQL row lock, so a concurrent command sees the committed archive state. `writeMutationError` maps its stable reason across commands. Galley's allowed actions have no status targets and publish the archived reason for Accept. Default collection reads exclude archived Tickets even when Badge-filtered; direct detail keeps Status, fields and Badges.
- The archive control in detail/modal asks for confirmation, submits to Galley and returns to the originating view. The modal closes to its background. Full-page detail reads its origin from the URL: `ticketDetailPath` adds `from=board` to every Board Ticket link, modal URL and Open full page link, and `fullPageReturnPath` maps it back to `/board` with the Badge filter. History state was rejected because a new tab or reload has none, which sent Board-origin archives to the List. A detail URL without `from` returns to the List, and `collectionQuery` carries only `badgeId`, so List/Board and Back to Backlog links never inherit `from`. Direct archived detail renders its timestamp and Galley's read-only reason, with edit, assignment, Badge and Archive controls disabled. `parseTicket` and browser-support Ticket type require `archivedAt`.
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

Galley ran against a fresh migrated database (`GALLEY_TEST_DATABASE_URL=postgres://localhost:5432/ticketit_test_pr106?sslmode=disable`); the shared `ticketit_test` may hold a sibling branch's schema. `go test ./internal/httpapi -run TestArchive_AllMutationsRejectWithoutChangingTicket -count=1 -v` exercises the real handler; the test logs the archive exchange and every rejected mutation:

```text
=== RUN   TestArchive_AllMutationsRejectWithoutChangingTicket
    ticket_archive_test.go:81: POST /api/tickets/14ec3eb4-b76a-4a2d-afce-c47b5dc0dd37/archive -> HTTP 200 {"allowedActions":{"accept":{"available":false,"reason":{"code":"archived_ticket","message":"archived tickets are read-only"}},"statusChanges":[]},"archivedAt":"2026-09-29T13:42:48.8999Z","assigneeType":"","badges":[{"id":"5593b073-bdf3-40f4-8052-2868cc401a4d","name":"3368a33d-4406-4a8d-b327-30dff94d1e73"}],"completionCondition":"humanAcceptance","constraints":"","context":"","createdAt":"2026-09-29T13:42:48Z","goal":"","id":"14ec3eb4-b76a-4a2d-afce-c47b5dc0dd37","repository":"","status":"Backlog","successCriteria":"","template":"Basic","title":"archive guard","updatedAt":"2026-09-29T13:42:48Z"}
    ticket_archive_test.go:94: PATCH /api/tickets/14ec3eb4-b76a-4a2d-afce-c47b5dc0dd37 {"title":"changed"} -> HTTP 400 {"error":{"code":"archived_ticket","message":"archived tickets are read-only"}}
    ticket_archive_test.go:94: POST /api/tickets/14ec3eb4-b76a-4a2d-afce-c47b5dc0dd37/status {"status":"Ready"} -> HTTP 400 {"error":{"code":"archived_ticket","message":"archived tickets are read-only"}}
    ticket_archive_test.go:94: POST /api/tickets/14ec3eb4-b76a-4a2d-afce-c47b5dc0dd37/accept  -> HTTP 400 {"error":{"code":"archived_ticket","message":"archived tickets are read-only"}}
    ticket_archive_test.go:94: PUT /api/tickets/14ec3eb4-b76a-4a2d-afce-c47b5dc0dd37/assignee  -> HTTP 400 {"error":{"code":"archived_ticket","message":"archived tickets are read-only"}}
    ticket_archive_test.go:94: DELETE /api/tickets/14ec3eb4-b76a-4a2d-afce-c47b5dc0dd37/assignee  -> HTTP 400 {"error":{"code":"archived_ticket","message":"archived tickets are read-only"}}
    ticket_archive_test.go:94: PUT /api/tickets/14ec3eb4-b76a-4a2d-afce-c47b5dc0dd37/badges/5593b073-bdf3-40f4-8052-2868cc401a4d  -> HTTP 400 {"error":{"code":"archived_ticket","message":"archived tickets are read-only"}}
    ticket_archive_test.go:94: DELETE /api/tickets/14ec3eb4-b76a-4a2d-afce-c47b5dc0dd37/badges/5593b073-bdf3-40f4-8052-2868cc401a4d  -> HTTP 400 {"error":{"code":"archived_ticket","message":"archived tickets are read-only"}}
    ticket_archive_test.go:94: POST /api/tickets/14ec3eb4-b76a-4a2d-afce-c47b5dc0dd37/archive  -> HTTP 400 {"error":{"code":"archived_ticket","message":"archived tickets are read-only"}}
--- PASS: TestArchive_AllMutationsRejectWithoutChangingTicket (0.13s)
PASS
```

The archived Ticket keeps its Status and Badge and advertises no status change or Accept. Each rejection leaves the Ticket identical to the archive response. Other `TestArchive_` tests cover archive from all six Status values, exclusion from unfiltered and Badge-filtered lists, a concurrent double archive (one 200, one 400), and shared 404s for a second Owner's, unknown and malformed ids. The manual lifecycle no-execution test includes Archive.

Falsification: removing the `lockTicketForMutation` call from `setTicketAssigneeForOwner` turned the table test red:

```text
--- FAIL: TestArchive_AllMutationsRejectWithoutChangingTicket (0.08s)
    --- FAIL: TestArchive_AllMutationsRejectWithoutChangingTicket/assign (0.00s)
        ticket_archive_test.go:93: PUT /api/tickets/7be80898-bc7b-4bdd-a089-b7f13c1f6114/assignee: status=200, want 400; body={...,"archivedAt":"2026-09-29T13:43:01.473521Z","assigneeType":"owner",...}
    --- FAIL: TestArchive_AllMutationsRejectWithoutChangingTicket/unassign (0.00s)
        ticket_archive_test.go:93: DELETE /api/tickets/7be80898-bc7b-4bdd-a089-b7f13c1f6114/assignee: status=200, want 400; body={...,"archivedAt":"2026-09-29T13:43:01.473521Z","assigneeType":"",...}
FAIL
FAIL	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	1.131s
```

Restoring the call: `go test ./internal/httpapi -run 'TestArchive_' -count=1` printed `ok  github.com/cristoforows/ticketIt/apps/galley/internal/httpapi 0.761s`. This slice does not include the temporary change.

`go test ./... -count=1`, `go vet ./...`, `go build ./...` and both drift checks:

```text
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	6.912s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	1.599s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	2.267s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	1.303s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	0.495s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	10.627s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	4.530s
VET_BUILD_OK
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

Swiftlet `npm test && npm run build`. `returns an archive from a Board detail URL opened in a new tab to the filtered Board` failed while the origin was only in history state and passes with the URL origin:

```text
 Test Files  9 passed (9)
      Tests  118 passed (118)
dist/index.html                   0.39 kB │ gzip:   0.26 kB
dist/assets/index-CTKyTK7u.css    7.13 kB │ gzip:   1.92 kB
dist/assets/index-BJ5QefKw.js   341.34 kB │ gzip: 106.20 kB
✓ built in 171ms
```

Full `e2e/run.sh` (`E2E_DATABASE_URL=postgres://localhost:5432/ticketit_e2e_pr106?sslmode=disable`) exited 0. All 24 registered spec invocations passed (56 Chromium tests). `ticket-archive.spec.ts` covers the modal archives, direct read-only detail, the API rejection, and full-page archives from the filtered Board, in place and from a Ctrl/Cmd-click new tab. `ticket-board.spec.ts` asserts the `from=board` link href:

```text
migrations applied: schema version 9
[run.sh] running tests/ticket-board.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/ticket-board.spec.ts:19:1 › board and list render the same live Tickets in Galley order, with reloadable columns and one session (834ms)
[run.sh] running tests/ticket-archive.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/ticket-archive.spec.ts:5:1 › archive Ready and Done from modal; retain direct read-only detail and exclude filtered collections (1.2s)
  1 passed (1.6s)
[run.sh] ticket-board.spec.ts exit code: 0
[run.sh] ticket-archive.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

## Implementation limitations and follow-ups

No M3.7 behavior left unimplemented. Archived list filtering, Restore and Ready → Backlog belong to #94 (M3). Open-Round lock and claim races belong to M4/M5.

## Outstanding checks and owning milestone

M4 must enforce archive exclusion at claim/eligibility and test concurrent archive/claim. M5 must extend the same row-locked decision point for open Rounds. Real-provider OAuth coverage remains M10's check; browser tests use a local substitute.

## Decision impacts (open-decision IDs)

No open decision resolved. D3's retained completion condition is unchanged by Archive; D1, D2, D4–D9 remain open.
