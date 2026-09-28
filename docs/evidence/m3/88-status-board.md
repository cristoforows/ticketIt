# Read-only Ticket Status board

## Purpose

[M3.2, #88](https://github.com/cristoforows/ticketIt/issues/88): add a board and List / Board navigation in `apps/swiftlet`, and prove both views render the same persisted Tickets through `e2e/`.

## What already existed

Galley served Owner-scoped Tickets, sorted by `created_at DESC, id DESC`, through `GET /api/tickets`, including persisted Status and Template. M3.1 (#87) published allowed actions on those Tickets. Swiftlet had a capture/list view at `/`, a full-page detail view at `/tickets/:id`, and a small path-based router. The browser runner built both apps, signed in through a substitute GitHub provider, and created Tickets via Galley's API. There was no board or CSS styling mechanism.

## What this slice added

- `TicketBoard` reads `fetchTickets()` (the list's existing `GET /api/tickets` client) and filters the returned order into Backlog, Ready, In Progress, Blocked, In Review, and Done. All six sections remain visible when empty. Cards show title and Template and link to the full Ticket page. An unknown Status fails visibly instead of silently omitting a Ticket. No Galley, database, or contract change was required: Galley already owns Status and ordering.
- `/board` is an explicit router case; the authenticated shell retains a List / Board navigation switch on both views and the full page. The hand-rolled router remains proportionate to three fixed paths: no nested routes, guards, or route loaders. Revisit with #89 if preserving modal background navigation requires more complex history state.
- One plain CSS grid in `src/board.css` is linked by `index.html` and bundled by Vite. Side-by-side sections scroll horizontally at narrow widths; no UI library or TypeScript configuration change is needed.
- Unit tests exercise section order, empty states, cards, Galley ordering, failure and unauthenticated handling, direct route parsing, and view switching. `e2e/tests/ticket-board.spec.ts` creates and moves Tickets through Galley's HTTP API, reads back `GET /api/tickets`, compares all board sections and the list against that response, checks direct load/reload and the shared session, and follows a card to the full page. `e2e/run.sh` runs and checks its exit code. App and browser READMEs record navigation, ordering, styling, and verification.

Future open-Round rules belong in Galley's existing `decidePlainStatusChange` and `decideAccept` decision points (M4/M5), not in board presentation.

## Exact versions and toolchain

Pinned in `apps/galley/go.mod`: Go 1.27.1. Pinned in `apps/swiftlet/package-lock.json` and `package.json`: React 19.3.0, TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1. Pinned in `e2e/package-lock.json`: Playwright 1.63.0. Both Node apps declare Node 26.9.0. Executed locally with Go 1.27.1, Node 22.13.1, npm 10.9.2, PostgreSQL 18.1 (Docker), and Playwright's Chromium headless shell. `npm ci` for `e2e/` emitted `EBADENGINE` for Node 22, then completed; no config was changed.

## Reproducible commands

From a clean checkout with Go, Node 26.9.0, and local PostgreSQL with `createdb` and `psql` available, using only the runner's dedicated `ticketit_e2e` database:

```sh
cd apps/swiftlet && npm ci && npm test && npm run build
cd e2e && npm ci && ./run.sh
```

Run each line from the repository root independently. The browser runner builds Galley, migrates and resets only `ticketit_e2e`, builds/serves Swiftlet, installs the headless Chromium shell, and stops its processes after testing. Locally, the actual runner command was `PATH="/var/folders/5q/00sd8m8x1ydbzf8zsvq9np440000gp/T/opencode/pgshim:$PATH" NPM_CONFIG_USERCONFIG=/dev/null ./run.sh` from `e2e/`: PostgreSQL CLI tools were absent on the host, so temporary wrappers outside the worktree called `psql` and `createdb` in the already-running `ticketit-postgres` container. `NPM_CONFIG_USERCONFIG=/dev/null` used public npm without local credentials. `apps/swiftlet/node_modules` was already installed in this worktree; `e2e/npm ci` ran on the first browser attempt. No Galley code changed, so Galley's existing tests were not rerun separately; the browser runner built and exercised the live Galley binary.

## Observed results

`apps/swiftlet $ npm test && npm run build` exited 0:

```text
 Test Files  9 passed (9)
      Tests  88 passed (88)
vite v8.3.0 building client environment for production...
✓ 28 modules transformed.
✓ built in 104ms
```

The first full browser attempt caught a spec-only locator ambiguity: an existing Ticket titled "opened from the list" also matched the unscoped `List` link locator. After scoping navigation clicks to `navigation[aria-label="Ticket views"]`, the full `e2e/run.sh` run exited 0:

```text
[run.sh] applying migrations to 'ticketit_e2e'
migrations applied: schema version 7
[run.sh] running tests/ticket-board.spec.ts against the restarted galley
  1 passed (1.6s)
[run.sh] ticket-board.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

All 18 registered spec invocations returned exit code 0 (35 browser tests total), including Galley restart and stopped-backend phases. A separate production-preview HTTP request to `/board` after `npm run build` returned `HTTP/1.1 200 OK`, `Content-Type: text/html`, and the built HTML linked both `/assets/index-DxJ2onIQ.js` and `/assets/index-DrdR9v8Y.css`. The live browser assertion verified that `/board` rendered the six Status sections and their API-sourced cards after direct navigation and reload, not merely that the preview returned HTML.

## Implementation limitations and follow-ups

No required #88 behavior remains unimplemented. #89 (M3) owns the board/list detail modal, #90 (M3) owns moving cards, #91 (M3) owns Badges, and #93 (M3) owns archive. M5 owns active-Round card treatment and controls. Coding Tickets with `reviewedPrMerge` still cannot reach Done pending D2/M8; the Done fixture uses Galley's supported human Accept path.

## Outstanding checks and owning milestone

The M3 gate-report slice owns reconciliation of the evidence index and gate-owned docs. The modal/background navigation choice is for #89 (M3). Node 26.9.0 was not available locally; the passing build and browser run used Node 22.13.1 despite engine warnings.

## Decision impacts (open-decision IDs)

D3's accepted human workflow remains Galley's responsibility: the board displays persisted Status and offers no execution or alternative transition rule. D1, D2, D4–D9 are not resolved or changed by a read-only view.
