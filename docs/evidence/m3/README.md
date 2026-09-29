# M3 evidence index

[M3 — Planning, navigation, and Ticket organization (#4)](https://github.com/cristoforows/ticketIt/issues/4) has eight implementation slices (#87–#94). [M3.9 (#95)](https://github.com/cristoforows/ticketIt/issues/95) records the local gate on branch `m3/95-gate`, stacked on #94. Stacked PRs [#105](https://github.com/cristoforows/ticketIt/pull/105), [#106](https://github.com/cristoforows/ticketIt/pull/106), and [#107](https://github.com/cristoforows/ticketIt/pull/107) remain **open**; their Galley, Swiftlet and Contracts CI jobs passed. The browser suite is not in CI.

## Records

Each row links the slice's commands, results, and outstanding checks.

| File | Issue | Establishes | Headline result |
| --- | --- | --- | --- |
| [87-allowed-actions.md](87-allowed-actions.md) | [#87](https://github.com/cristoforows/ticketIt/issues/87) | Galley-published `allowedActions` from the same Status/Accept decision functions as commands | Exhaustive direct-HTTP action/command comparison across six Statuses and both completion conditions passed; Backlog → Blocked was reconciled with D3. |
| [88-status-board.md](88-status-board.md) | [#88](https://github.com/cristoforows/ticketIt/issues/88) | Six-column board and List/Board navigation over the same Galley collection | Browser compared board sections and list ordering with live `GET /api/tickets`; full suite passed. |
| [89-ticket-detail-modal.md](89-ticket-detail-modal.md) | [#89](https://github.com/cristoforows/ticketIt/issues/89) | Shared Ticket detail in a modal with preserved origin and canonical full-page URL | Browser proved scroll/focus/history, reload/direct full page, and Galley-sourced updates after modal closure; full suite passed. |
| [90-board-moves.md](90-board-moves.md) | [#90](https://github.com/cristoforows/ticketIt/issues/90) | Drag and keyboard board moves through Galley's Status command | Browser proved persisted allowed moves, no Done/plain-disallowed move, and live rejection on a stale move; full suite passed. |
| [91-reusable-badges.md](91-reusable-badges.md) | [#91](https://github.com/cristoforows/ticketIt/issues/91) | Owner-scoped reusable name-only Badges and attachment | Browser proved two Tickets share definitions and links after a real Galley restart; concurrent duplicate create returned one `201` and one `409`. |
| [92-badge-filter-detach.md](92-badge-filter-detach.md) | [#92](https://github.com/cristoforows/ticketIt/issues/92) | Idempotent detach and repeated-Badge OR filter shared by list/board | Direct HTTP returned each matching Ticket once, newest first; browser filter survived navigation and removed a detached Ticket. |
| [93-archive-ticket.md](93-archive-ticket.md) | [#93](https://github.com/cristoforows/ticketIt/issues/93) | Retained archived record, default-view exclusion, row-locked read-only mutation guard | Real-PostgreSQL tests rejected all eight Ticket mutations after Archive; browser retained direct detail and hid archived cards. |
| [94-archived-filter-restore.md](94-archived-filter-restore.md) | [#94](https://github.com/cristoforows/ticketIt/issues/94) | Archived list filter combined with Badges and transactional Restore | Ready restored to Backlog, Done to Done, with fields and Badges retained across a real Galley restart; full suite passed. |

## Clean-worktree gate verification (M3.9, 2026-09-29)

Run on a clean detached worktree of this branch after rebasing onto #107's tip `cfa163d`, which includes #105–#107's post-review fixes. Earlier runs on `9270a25` predate those fixes and are superseded. Go 1.27.1, Node 26.9.0/npm 11.19.1, Homebrew PostgreSQL 17.11. `ticketit_m3_gate3_test` was created fresh with **0 public tables** before Galley's tests applied migrations; `run.sh` dropped/recreated only the dedicated `ticketit_e2e` database's `public` schema. No deployment was part of this gate.

### Galley and Go contract drift

```sh
cd apps/galley
GALLEY_TEST_DATABASE_URL=postgres://localhost:5432/ticketit_m3_gate3_test?sslmode=disable go test ./... -count=1
go vet ./...
go build ./...
gofmt -l .
./scripts/check-contract-drift.sh
```

Observed: every package passed (`internal/httpapi` in `5.941s`); `go vet` and `go build` exited 0; `gofmt -l .` emitted nothing; `OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).`

### TypeScript contract drift

```sh
cd contracts
npm ci
npm run check:swiftlet-drift
```

Observed: `OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`

### Swiftlet

```sh
cd apps/swiftlet
npm ci
npm test
npm run build
```

Observed: `Test Files  9 passed (9)`, `Tests  122 passed (122)`; production build transformed 99 modules.

### Browser-to-backend suite

```sh
cd e2e
./run.sh
```

Observed: `migrations applied: schema version 9`; all 26 registered specs exited `0`, including board, modal, Badge filter, archive, restore and the real Galley restart pairs; `[run.sh] SUITE PASSED`. Chromium headless shell against a real Swiftlet build, Galley, PostgreSQL and the local substitute GitHub OAuth provider. This is a **local** run, not a CI browser job.

## Acceptance criteria verification (#4)

1. **Board, list, modal and full-page show consistent persisted state — Met locally.** #88 compared board and list to live Galley GET; #89 reused the same detail component and tested mutations, close/refresh and reload against that data; #90–#94 exercised Status, Badges, Archive and Restore in the full browser suite above.
2. **Modal preserves board/list position; direct URLs open full page — Met locally.** #89's browser cases checked scroll, focus, history Back/Forward, direct URL/reload, and Open full page. A modal entry from a *previous page load* is intentionally not resurrected after reload then Forward; it opens as the canonical full page.
3. **Custom Badges reusable, attachable, removable and filterable — Met locally.** #91 tested persisted shared definitions/links across restart; #92 proved idempotent detach, retained definitions and OR filtering in both collections. Badges are name-only; rename, delete and colour are not approved v1 behavior.
4. **Archive retains records, excludes from everyday views and execution eligibility, Archived filter finds them — Partially verified.** #93 proved retention, direct read-only detail, default board/list exclusion and Galley rejection of edits, Status, Accept, Assignee and Badge mutations. #94 proved the Archived list filter. **Execution eligibility cannot yet be tested:** M3 has no Agent, claim path or Round. M4 [#5](https://github.com/cristoforows/ticketIt/issues/5) owns `archived_at IS NULL` claim admission and archive/claim races; this part is pending, not a passed check.
5. **Restore Ready → Backlog and Done → Done — Met locally.** #94's Go Status grid, Archive/Restore race test and real-browser before/after-restart checks prove both, including retained fields/Badges. Restoring Ready does not itself request work.
6. **Later execution can extend editing/archive rules to open Rounds under one authority — Extension seam established; future enforcement pending.** #93's `lockTicketForMutation` is one Galley row-locked decision point for archived-state mutation policy; #87's `decidePlainStatusChange`/`decideAccept` feed both the published `allowedActions` and the commands. M4/M5 [#5](https://github.com/cristoforows/ticketIt/issues/5)/[#6](https://github.com/cristoforows/ticketIt/issues/6) must supply persisted open-Round facts, enforce locks/archive restrictions and race-test the claim path. M3 cannot demonstrate future Round behavior.

No M3 browser check was run in CI. #105 (`bf1744c`), #106 (`40a9afb`) and #107 (`cfa163d`) pass all existing CI jobs. Browser CI is routed to #109.

## Scope and routed limitations

M3 is a manual tracker: **no Agents, Rounds, execution, Michelin, active-card treatment, Stop or built-in Stopped Badge; no Booths or sprints; no object storage or hosting.** A Coding Ticket's reviewed-PR-merge Accept is still rejected pending D2/M8 [#9](https://github.com/cristoforows/ticketIt/issues/9); D4's already-merged-PR reopening caveat also belongs to M8. Real GitHub OAuth and production setup belong to M10 [#11](https://github.com/cristoforows/ticketIt/issues/11).

| Observation / limitation | Owner / disposition |
| --- | --- |
| List/board currently use newest-first ordering, not manual priority; whether Owner ordering should affect M4's sequential queue is undecided. | [#108](https://github.com/cristoforows/ticketIt/issues/108), **M4 #5**, ready for Owner decision. Do not infer queue priority from list ordering. |
| Badge rename, delete and colour have no approved v1 behavior. | **Owner / later product scope**; name-only custom Badges are the approved M3 surface. No M3 implementation follow-up. |
| CI [#68](https://github.com/cristoforows/ticketIt/issues/68) is closed with app/drift jobs but no browser job. | [#109](https://github.com/cristoforows/ticketIt/issues/109), **M10 #11**, ready for agent; can land earlier. |
| Open-Round field/Badge locks, archive prohibition and archived/claim race cannot be tested before Rounds/claims exist. | **M4 #5 / M5 #6**; extend #93's mutation guard and #87's action computation; M4 tests claim eligibility/races, M5 enforces Stop/open-Round rules. |
| Built-in Stopped Badge and its lifecycle do not exist; custom Badge attachment remains a separate mechanism. | **M5 #6**; #91 records the `kind` extension seam. |
| Browser auth uses a local GitHub substitute, not real `github.com`; suite is Chromium headless-shell only. | **M10 #11** owns real-provider/operational verification; Chromium-only is the documented browser-harness scope (`e2e/README.md`). |
| Modal history context belongs to its page load; reload then Forward renders full-page detail. | **M3 #89** accepted canonical URL behavior, recorded in its evidence; no unresolved product rule. |
| Dedicated e2e TypeScript typecheck is not a documented runner check; #91's optional attempt found pre-existing spec type errors. | **M10 #11** operational-test hardening; passing `run.sh` does not imply standalone e2e typecheck passed. |
| Strict JSON decoding of case-variant keys and trailing bodies was tracked in [#84](https://github.com/cristoforows/ticketIt/issues/84). | **Closed**; Galley's `decodeStrictJSON` enforces it, including M3 endpoints. No outstanding #84 gap. |
| Large Badge-catalog load/performance remains untested. | **M10 #11**, operational verification; #91 exercised real DB concurrency, not load. |

**Browser sign-in policy from M2:** retain one persisted storage state across before/after real-Galley-restart pairs; independent browser specs sign in afresh for isolation. This is the adopted hybrid, rather than one global authenticated state for all specs (`e2e/run.sh`, [#53](../m2/53-browser-harness.md)). No open D1–D9 product decision is resolved by #95; M3 implements already-approved D3 and records D2/D4 and future-Round observations only.
