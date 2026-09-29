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

Stage regenerated outputs before drift scripts, which compare to the Git index. This run created fresh `ticketit_test_pr107` and `ticketit_e2e_pr107` databases, since the shared ones may hold a sibling branch's schema.

## Observed results

Galley ran against a fresh migrated database (`GALLEY_TEST_DATABASE_URL=postgres://localhost:5432/ticketit_test_pr107?sslmode=disable`). `go test ./internal/httpapi -run 'TestRestore_EveryStatus/Ready|TestRestore_Archived' -count=1 -v` exercises the real handler and logs each exchange:

```text
=== RUN   TestRestore_EveryStatusPreservesFieldsBadgesAndRecomputesActions/Ready
    ticket_restore_test.go:45: POST /api/tickets/a0f88b50-e350-4460-8b7a-00729bd1e252/restore -> HTTP 200 {"allowedActions":{"accept":{"available":false,"reason":{"code":"invalid_transition","message":"Accept requires the ticket to be In Review (current status Backlog)"}},"statusChanges":["Ready","Blocked"]},"archivedAt":null,"assigneeType":"","badges":[{"id":"51aa2e3d-18a2-41da-958f-3c3f36c4b360","name":"f42fdb47-0d40-4b54-84f4-fed8e7133258"}],"completionCondition":"humanAcceptance","constraints":"","context":"","createdAt":"2026-09-29T14:25:05Z","goal":"Retained goal","id":"a0f88b50-e350-4460-8b7a-00729bd1e252","repository":"","status":"Backlog","successCriteria":"","template":"Basic","title":"29e64c84-6467-4ba9-8f00-909713327115","updatedAt":"2026-09-29T14:25:05Z"}
    ticket_restore_test.go:65: POST /api/tickets/a0f88b50-e350-4460-8b7a-00729bd1e252/restore -> HTTP 400 {"error":{"code":"not_archived","message":"ticket is not archived"}}
    --- PASS: TestRestore_EveryStatusPreservesFieldsBadgesAndRecomputesActions/Ready (0.01s)
=== RUN   TestRestore_ArchivedBadgeFilterIsConjunctiveWithORAndOrdered
    ticket_restore_test.go:96: GET /api/tickets?archived=true&badgeId=de67e65b-b086-45a3-83b4-deae42a11abc&badgeId=280e3a65-b63c-4811-9d84-8c4aba69e39c -> HTTP 200 {"tickets":[{"allowedActions":{"accept":{"available":false,"reason":{"code":"archived_ticket","message":"archived tickets are read-only"}},"statusChanges":[]},"archivedAt":"2026-09-29T14:25:05.053759Z","assigneeType":"","badges":[{"id":"de67e65b-b086-45a3-83b4-deae42a11abc","name":"06327ae3-a9ff-44e9-87d0-a5cabd95e122"},{"id":"280e3a65-b63c-4811-9d84-8c4aba69e39c","name":"fed5d2ee-a7e3-45be-b217-95f562a4cd8b"}],"completionCondition":"humanAcceptance","constraints":"","context":"","createdAt":"2026-09-29T14:25:05Z","goal":"","id":"a34cf8b8-70d9-4d17-863b-b2601affed62","repository":"","status":"Backlog","successCriteria":"","template":"Basic","title":"4cbab3fb-da40-4341-8690-1ff25c5cbc3e","updatedAt":"2026-09-29T14:25:05Z"},{"allowedActions":{"accept":{"available":false,"reason":{"code":"archived_ticket","message":"archived tickets are read-only"}},"statusChanges":[]},"archivedAt":"2026-09-29T14:25:05.051392Z","assigneeType":"","badges":[{"id":"de67e65b-b086-45a3-83b4-deae42a11abc","name":"06327ae3-a9ff-44e9-87d0-a5cabd95e122"}],"completionCondition":"humanAcceptance","constraints":"","context":"","createdAt":"2026-09-29T14:25:05Z","goal":"","id":"c4d8ed4d-d258-48c4-a1a5-353e7475eb99","repository":"","status":"Backlog","successCriteria":"","template":"Basic","title":"9b3a0acf-98ad-4010-aafb-2b241dae6d6f","updatedAt":"2026-09-29T14:25:05Z"}]}
--- PASS: TestRestore_ArchivedBadgeFilterIsConjunctiveWithORAndOrdered (0.02s)
PASS
```

The restored Ready Ticket is Backlog with its goal and Badge intact and Backlog's status changes. A second restore is `400 not_archived`. The Archived+Badge query returns the two archived matches once each, newest first; the unarchived and unbadged archived Tickets are absent.

Falsification: changing `next = Backlog` to `next = Ready` in `restoreTicketForOwner` turned both the Status table and the race test red:

```text
--- FAIL: TestRestore_EveryStatusPreservesFieldsBadgesAndRecomputesActions (0.07s)
    --- FAIL: TestRestore_EveryStatusPreservesFieldsBadgesAndRecomputesActions/Ready (0.01s)
        ticket_restore_test.go:48: restored Ticket lost data: map[...]
--- FAIL: TestRestore_ConcurrentArchiveAndRestoreConsistent (0.02s)
    ticket_restore_test.go:152: restore succeeded but final Ticket = map[... archivedAt:<nil> ... status:Ready ...]
FAIL
FAIL	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.659s
```

Reverting printed `ok  github.com/cristoforows/ticketIt/apps/galley/internal/httpapi 0.467s`. This slice does not include the temporary change.

`go test ./... -count=1`, `go vet ./...`, `go build ./...` and both drift checks:

```text
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	4.033s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	0.929s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	1.941s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	2.223s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	1.805s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	5.303s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	3.591s
VET_BUILD_OK
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

Swiftlet `npm test && npm run build`. #93's `collectionQuery` forwards only `badgeId` (to drop `from`), so this slice adds `archived`. Removing that line fails the two router tests that keep Archived through a modal and a full-page return:

```text
 FAIL  src/router.test.tsx > router > returns a full-page Archived detail to the Archived list with its Badges
 FAIL  src/router.test.tsx > router > preserves Badge selection when toggling Archived and keeps it across a modal
      Tests  2 failed | 14 passed (16)
```

With it:

```text
 Test Files  9 passed (9)
      Tests  122 passed (122)
dist/index.html                   0.39 kB │ gzip:   0.26 kB
dist/assets/index-CTKyTK7u.css    7.13 kB │ gzip:   1.92 kB
dist/assets/index-BANPfX6u.js   342.30 kB │ gzip: 106.52 kB
✓ built in 329ms
```

Full `e2e/run.sh` (`E2E_DATABASE_URL=postgres://localhost:5432/ticketit_e2e_pr107?sslmode=disable`) exited 0: all 26 registered spec invocations passed (58 Chromium tests). The before spec sets up Ready and Done through Galley's API, applies the Archived and Badge UI filters, restores both in the modal, checks Ready in Backlog and Done in Done, and confirms the board ignores the list's Archived selection. The after spec rechecks the same fields and Badges across a real Galley restart:

```text
migrations applied: schema version 9
[run.sh] running tests/ticket-restore-before.spec.ts (restores archived Ready and Done Tickets)
  ✓  1 [chromium] › tests/ticket-restore-before.spec.ts:12:1 › Archived list combines Badge filter, restores Ready to Backlog and Done unchanged (853ms)
[run.sh] running tests/ticket-restore-after.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/ticket-restore-after.spec.ts:8:1 › restored Ready and Done retain status, Badge and fields after Galley restart (119ms)
[run.sh] running tests/ticket-archive.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/ticket-archive.spec.ts:5:1 › archive Ready and Done from modal; retain direct read-only detail and exclude filtered collections (1.3s)
[run.sh] ticket-restore-before.spec.ts exit code: 0
[run.sh] ticket-restore-after.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

## Implementation limitations and follow-ups

No required M3.8 behavior left unimplemented. M4 must exclude archived Tickets from claim/eligibility; M5 owns open-Round restrictions. Neither is added by Restore.

## Outstanding checks and owning milestone

M4 owns concurrent archive/claim acceptance and M5 owns open-Round mutation policy; M10 owns real-provider OAuth checks. The local browser suite uses a substitute provider.

## Decision impacts (open-decision IDs)

No open decision resolved. Accepted D3's retained completion condition is unchanged by Restore. D1, D2 and D4–D9 remain open.
