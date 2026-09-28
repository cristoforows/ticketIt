# Board moves through Galley's Status command

## Purpose

[M3.4, #90](https://github.com/cristoforows/ticketIt/issues/90): move Tickets between board Status sections by drag or keyboard in `apps/swiftlet`, verified against live Galley through `e2e/`.

## What already existed

Reviewed M3.3 base `bad7bbe` provided the board, modal detail, Galley's `POST /api/tickets/{id}/status`, and per-Ticket `allowedActions.statusChanges`. The board only displayed Tickets; the modal and full-page detail already submitted Galley commands. Galley's direct-API tests `TestTicketAllowedActions_MatchCommands` and `TestChangeTicketStatus_D3S2Table` cover advertised transitions, forbidden plain Status changes to Done, and persistence of rejected requests. The browser runner built both apps against PostgreSQL and a substitute GitHub provider.

## What this slice added

- `TicketBoard` now offers native HTML5 card dragging and a keyboard-operable `Move to…` disclosure. Both call the existing `changeTicketStatus` client and use the Ticket's Galley-advertised `allowedActions.statusChanges`; Done is excluded as a target. Native dragging needs no dependency and Playwright drives it with `dragTo`. CSS highlights only advertised drop sections during a drag. Target buttons carry their Status value for API-to-UI browser assertions; the existing Status list supplies display names, not transition rules.
- A move awaits Galley's returned Ticket before changing board placement or offered controls; a rejection retains the previous card and shows Galley's error message. A successful keyboard move focuses the relocated card's disclosure. A completed command invalidates in-flight collection reads so an older response cannot undo its returned Ticket, then re-fetches Galley's collection to include concurrent modal changes to other Tickets. A pending card exposes busy/disabled link state and prevents an unmodified click from opening a modal against its previous Status; the link works again after the move settles.
- Unit coverage checks target highlighting, Done exclusion even if erroneously advertised, non-optimistic updates, returned actions, keyboard focus, and rejected moves. `e2e/tests/ticket-board-moves.spec.ts` covers allowed drag Backlog → Ready, keyboard In Progress → In Review, reload persistence, disallowed/Done drops without browser commands, stale drag rejection compared with Galley's live response, a deferred pending move, and an overlapping modal-close GET carrying another Ticket's edit. Drops in the browser spec target section headings: a tall section's midpoint can scroll the source card out of the drag start position in Playwright. `e2e/run.sh` registers and checks this spec. Swiftlet and browser READMEs describe use and verification.
- Review follow-up after `ee54fea`: both new browser cases failed against the original commit. A pending move exposed no `aria-busy`, and the board kept an unrelated Ticket's old title after the command discarded its modal-close GET. After the fixes, both passed. `eligibleTargets` is computed once per card; the explicit Done exclusion remains in both rendered targets and drag command guard. The browser helper is now `getCardInStatus`.
- No contract, Galley, or persistence change was needed. Open-Round behavior later extends Galley's `decidePlainStatusChange` decision point in M4/M5, not this board.

## Exact versions and toolchain

Pinned: `apps/galley/go.mod` Go 1.27.1; `apps/swiftlet/package-lock.json` React 19.3.0, TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1; `e2e/package-lock.json` Playwright 1.63.0. Both Node apps declare Node 26.9.0. Final runs used Go 1.27.1, Node 26.9.0, npm 11.19.1, PostgreSQL 18.1 in the existing Docker container, and Playwright Chromium headless shell.

## Reproducible commands

From repository root, with Go 1.27.1, Node 26.9.0, PostgreSQL running, and `psql`/`createdb` available for the dedicated `ticketit_e2e` database:

```sh
cd apps/swiftlet && npm ci && npm test && npm run build
cd e2e && ./run.sh
```

Run each line independently from root. The runner resets only `ticketit_e2e`, applies migrations, builds/starts Galley and the fake provider, serves Swiftlet's production build, runs Chromium, and tears down its processes. On this host, the actual commands used `PATH="$HOME/.nvm/versions/node/v26.9.0/bin:$PATH" NPM_CONFIG_USERCONFIG=/dev/null npm ci`, `npm test`, and `npm run build` in `apps/swiftlet`; `e2e/` used `PATH="/var/folders/5q/00sd8m8x1ydbzf8zsvq9np440000gp/T/opencode/pgshim:$HOME/.nvm/versions/node/v26.9.0/bin:$PATH" NPM_CONFIG_USERCONFIG=/dev/null ./run.sh`. The existing temporary wrappers outside the worktree invoke `psql` and `createdb` in the running `ticketit-postgres` container. `e2e/run.sh` installed its npm dependencies on first use.

## Observed results

Final `npm test && npm run build` in `apps/swiftlet` exited 0:

```text
 Test Files  9 passed (9)
      Tests  92 passed (92)
vite v8.3.0 building client environment for production...
✓ 29 modules transformed.
✓ built in 121ms
```

Final full `e2e/run.sh` exited 0: all 20 registered spec invocations passed (51 Chromium tests), including restart and stopped-backend phases.

```text
[run.sh] applying migrations to 'ticketit_e2e'
migrations applied: schema version 7
[run.sh] running tests/ticket-board-moves.spec.ts against the restarted galley
  6 passed (3.5s)
[run.sh] ticket-board-moves.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

The live Galley request log in the initial #90 run included `POST /api/tickets/a68c2d3b-0e53-444f-a0b2-a32da57affd2/status` → `200` for drag, and `POST /api/tickets/435ebeda-f3a6-466e-bfb0-c89971ca27f9/status` → `400` for the stale move. The browser spec compared the rejected response's `error.message` to the rendered alert and confirmed the original card remained visible; Galley's response for Ready → Ready was `the transition Ready -> Ready is not permitted`. No command was observed for disallowed or Done drops. In the review run against `ee54fea`, the pending-detail regression failed on missing `aria-busy`, and the overlapping-GET regression failed because the other Ticket's edited title remained stale. The fixed run passed all six board-move cases, including both deferred-network paths. An initial run timed out waiting for the fake provider to start; direct launch succeeded and subsequent full runs reached the browser tests. During test iteration, dragging to a tall section's midpoint hit another card; using its heading exercised the intended drop.

## Implementation limitations and follow-ups

No required #90 behavior remains unimplemented. The board cannot start execution or Stop a Ticket. M5 owns open-Round interaction rules; M8 owns reviewed-PR completion under open D2.

## Outstanding checks and owning milestone

The M3 gate-report slice owns evidence-index and gate-doc reconciliation. Cross-browser coverage beyond Chromium is outside this suite; the M3 browser runner specifies Chromium only. Galley's Go source did not change, so Go tests were not run separately for this slice; the full browser runner built Galley and exercised its real Status command.

## Decision impacts (open-decision IDs)

D3's accepted human Status workflow remains enforced by Galley, including Done through Accept. D2's reviewed-PR path remains open for M8. D1 and D4–D9 are unchanged.
