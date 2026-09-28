# Ticket detail modal with preserved list and board position

## Purpose

[M3.3, #89](https://github.com/cristoforows/ticketIt/issues/89): open Ticket details over the list or board in `apps/swiftlet` while keeping canonical URLs, browser history, focus, scroll, and Galley-backed collection consistency; prove it in `e2e/`.

## What already existed

The reviewed M3.2 branch at `fee6df8` had `/` and `/board` over the same Galley `GET /api/tickets` collection, a full-page `/tickets/:id`, the `TicketDetail` presentation with fetch and owner commands in `TicketDetailPage`, path-based navigation, and a browser runner with a live Galley, PostgreSQL, and substitute GitHub provider. Ticket links replaced their originating collection with the full page. M3.2 PR #100 awaits external approval; this slice assumes its reviewed work and changes only branch `m3/89-modal`.

## What this slice added

- Both collection links open `TicketDetailModal` with a canonical `/tickets/:id` address. The modal renders `TicketDetailPage` in modal mode, which uses the same `TicketDetail` and the same fetch/save/status/Accept/assign/unassign command callbacks as the full page; only the surrounding navigation chrome differs. No Galley workflow or API rule changed.
- `router.ts` carries `{ ticketModal: { background, pageLoadId } }` in the pushed history entry. `useRoute()` observes both path and that state; Back/Forward retain the mounted collection and reopen the modal. A page load creates a new `pageLoadId`, so reloads, bookmarks and new tabs discard stale modal context and show the full page. Open full page replaces the modal entry's state while keeping its URL. Standard modified link clicks remain browser navigation.
- Native `showModal()` provides top-layer focus/inert background and Escape cancellation. The close control receives focus on opening. The dialog cleanup restores body scrolling and browser focus; the collection's refreshed Ticket link is refocused even when a Status move relocates its board card. Collections stay mounted during the modal and retain rows during re-fetch on return, keeping scroll position stable. A failed re-fetch exposes its existing error state; no optimistic list/card mutation is used.
- `e2e/tests/ticket-modal.spec.ts` covers below-fold list/board entry, scroll/focus, inert background, Escape/Close/Back/Forward, reload/direct full-page presentation, Open full page, edit/assignment/Accept and board Status move against Galley API data. `e2e/run.sh` registers and checks it. Existing board/detail browser assertions now expect modal entry. Swiftlet and e2e READMEs describe behavior and commands.

Future open-Round Status rules extend Galley's `decidePlainStatusChange` / `decideAccept` decision points in M4/M5; this view introduces no rule.

## Exact versions and toolchain

`apps/galley/go.mod`: Go 1.27.1 (local 1.27.1). `apps/swiftlet/package-lock.json` / `package.json`: React 19.3.0, TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1. `e2e/package-lock.json` / `package.json`: Playwright 1.63.0. Both Node apps declare Node 26.9.0; final checks used Node 26.9.0 and npm 11.19.1. Local PostgreSQL was 18.1 (Docker container) with Playwright's Chromium headless shell.

## Reproducible commands

From repository root with Go 1.27.1, Node 26.9.0, npm, a running PostgreSQL, and host `psql`/`createdb` available for the dedicated `ticketit_e2e` database:

```sh
cd apps/swiftlet && npm ci && npm test && npm run build
cd e2e && ./run.sh
```

Run each line independently from root. `e2e/run.sh` resets only `ticketit_e2e`, applies migrations, builds/starts Galley, serves Swiftlet's production build and runs Chromium, then tears down its processes. On this machine host PostgreSQL CLI commands were unavailable; the actual second command used `PATH="/var/folders/5q/00sd8m8x1ydbzf8zsvq9np440000gp/T/opencode/pgshim:$HOME/.nvm/versions/node/v26.9.0/bin:$PATH" ./run.sh` from `e2e/`. Existing temporary wrappers outside the worktree call `psql` and `createdb` in the running `ticketit-postgres` container. Swiftlet's pinned-runtime check used `PATH="$HOME/.nvm/versions/node/v26.9.0/bin:$PATH" npm test` and `PATH="$HOME/.nvm/versions/node/v26.9.0/bin:$PATH" npm run build` after `npm ci`; `e2e/run.sh` installed its dependencies on its first run.

## Observed results

Swiftlet's final pinned-runtime test and build exited 0:

```text
Test Files  9 passed (9)
     Tests  89 passed (89)
vite v8.3.0 building client environment for production...
✓ 29 modules transformed.
✓ built in 90ms
```

The first full browser run caught a test fixture whose selected list row was above the fold (`scrollY = 0`); the fixture now selects the bottom row. The next full run exited 0:

```text
[run.sh] applying migrations to 'ticketit_e2e'
migrations applied: schema version 7
[run.sh] running tests/ticket-modal.spec.ts against the restarted galley
  4 passed (3.4s)
[run.sh] ticket-modal.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

All 19 registered spec invocations returned 0 (39 Chromium tests), including restart and stopped-backend phases. The four modal tests opened real Tickets from both views and asserted Galley-sourced changes to list rows and board Status sections after closing. No new HTTP endpoint is served by this slice; the existing `GET /api/tickets` and Ticket commands were exercised against live Galley by the browser suite.

## Implementation limitations and follow-ups

No required #89 behavior remains unimplemented. M5 owns active-Round locking/presentation, and M8 owns `reviewedPrMerge` completion under open D2; the modal shares the full page's existing controls without introducing either feature.

## Outstanding checks and owning milestone

The M3 gate-report slice owns evidence-index and gate-doc reconciliation. Cross-browser behavior beyond Chromium is not in this browser harness; M3 browser coverage uses its documented Chromium-only runner. PR #100's external approval and merge are outside this branch's work.

## Decision impacts (open-decision IDs)

D3's accepted human workflow remains enforced by Galley, unchanged by modal presentation. D2's reviewed-PR completion remains unresolved and unchanged; D1 and D4–D9 are not resolved or altered by this UI slice.
