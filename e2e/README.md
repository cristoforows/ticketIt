# e2e — browser-to-backend suite

The approved primary test seam: a real browser against a real Swiftlet
production build, a real Galley, and real PostgreSQL. Established by
[#53](https://github.com/cristoforows/ticketIt/issues/53) for
[M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3).

## One command

```sh
cd e2e && ./run.sh
```

It resets a dedicated database, applies migrations, builds and starts
Galley, builds and serves Swiftlet, installs Chromium's headless shell
on first run, runs the registered specs, and tears everything down.
Exit code is non-zero if any spec fails.

It never uses servers you already have running: every port is chosen
free at startup, and both processes are killed on exit, including on
`Ctrl-C`.

`ticket-badges-before.spec.ts` creates and attaches two custom Badges
through the shared modal/full-page picker, verifies list and board
names, API responses, idempotent reuse, and Galley's duplicate rejection.
`ticket-badges-after.spec.ts` reads the same definitions and links after
`run.sh`'s real Galley restart. Both use the saved Owner session from
the restart phase and create background Tickets through Galley's API.
Displayed names are compared to live `GET /api/tickets`; Badge ids are
checked against the Badge catalog and per-Ticket GET on both sides of
the restart.

## Prerequisites

Go 1.27+, Node 26.9.0, and a running PostgreSQL your user can
`createdb` with. Nothing else — the first run installs what it needs.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `E2E_DATABASE_URL` | `postgres://localhost:5432/ticketit_e2e?sslmode=disable` | The suite's own database |
| `E2E_GALLEY_PORT` | a free port | Pin Galley's port |
| `E2E_SWIFTLET_PORT` | a free port | Pin Swiftlet's port |
| `E2E_GALLEY_HOST` | `127.0.0.1` | Galley's bind address |

Specs read `E2E_BASE_URL` (Swiftlet's origin, Playwright's `baseURL`)
and `GALLEY_BASE_URL` (Galley's own origin, for querying the backend
directly). `run.sh` sets both. Specs using `e2e/support/sign-in.ts` also
read `E2E_GITHUBFAKE_BASE_URL` (the substitute GitHub provider's own
address); the Galley-restart specs additionally read
`E2E_STORAGE_STATE_PATH` (where the signed-in browser's storage state is
saved and reloaded across the restart). See "Signing in" below.

## Determinism and state reset

Every run drops and recreates the `public` schema, then migrates. A run
never inherits the previous run's rows.

`run.sh` refuses to start against `ticketit_dev`, `ticketit_test`, or
`ticketit_m1_native`. Point `E2E_DATABASE_URL` at a database dedicated
to this suite.

`workers: 1`, `fullyParallel: false`, `retries: 0`. Specs run in file
order, which is what lets `run.sh` stop Galley between the happy-path
spec and the failure-mode spec. A spec that needs a different backend
state must arrange it itself, or `run.sh` must grow an explicit phase
for it.

## Adding a spec

1. Put it in `e2e/tests/<area>.spec.ts` — one file per behaviour area,
   named for the behaviour, not the issue number.
2. **Assert against what the backend actually returned**, not literals.
   Query Galley through Playwright's `request` fixture and compare the
   page to that response. A spec full of hardcoded strings passes while
   the integration is broken.
3. Create the data your spec needs through the application's own API,
   not by writing to PostgreSQL behind Galley's back. Galley owns its
   records ([ADR 0001](../docs/adr/0001-single-authority-galley.md)).
4. Keep specs independent of each other's leftovers, except for the
   documented file-order dependency above.
5. If your spec needs Galley in an unusual state (stopped, misconfigured,
   a different environment), add a phase to `run.sh` rather than
   arranging it inside the spec — the spec cannot restart a process it
   did not start.

### Creating test data: through Galley's API, never straight into Postgres

[Issue #56](https://github.com/cristoforows/ticketIt/issues/56) ("M2.8")
was the first slice to need real domain test data (Tickets), and
establishes this suite's one convention for it, rather than leaving
each later spec to improvise its own:

- **A shared helper that calls Galley's HTTP API lives in
  `e2e/support/`**, beside `sign-in.ts` — see
  [`e2e/support/tickets.ts`](support/tickets.ts)'s `createTicket(page,
  title)`. It posts through `page.request`, which shares cookie storage
  and `baseURL` with the signed-in `page`'s own browser context, so it
  reaches Galley exactly as that browser would, with no separate
  sign-in and no direct database access of any kind
  ([ADR 0001](../docs/adr/0001-single-authority-galley.md)).
- **Use the API-direct helper for background data** — Tickets your spec
  needs to already exist but is not itself testing the creation of.
  **Drive the real UI instead when the spec is testing that UI** — see
  [`tests/ticket-persistence-before.spec.ts`](tests/ticket-persistence-before.spec.ts):
  it calls `createTicket` once for an unrelated, pre-existing Ticket
  (so its ordering assertion proves "newest first" against a
  non-empty list, not one that merely happens to be empty), then fills
  and submits the real quick-capture form twice — the behavior issue
  #56's acceptance criteria actually require proof of.
- **A spec needing Galley in an unusual state around this data still
  follows point 5 above.** `tests/ticket-persistence-before.spec.ts`
  and `tests/ticket-persistence-after.spec.ts` prove Ticket persistence
  across a Galley restart the same way
  `tests/session-restart-before.spec.ts` /
  `session-restart-after.spec.ts` prove it for the session: reusing one
  signed-in storage state and one restart `run.sh` already performs,
  split across two `playwright test` invocations, rather than either
  spec requesting a restart of its own. The two pairs share the exact
  same restart in `run.sh` — see its "10." phase — since nothing about
  Ticket persistence needs a second one. The two halves duplicate their
  two fixed Ticket titles as local constants instead of importing them
  from one another (each half is its own OS process invocation), the
  same way the session-restart pair each hardcodes the fixture owner's
  login rather than sharing it.

## Signing in

Every spec after sign-in needs an authenticated browser. Use the helper
in [`e2e/support/sign-in.ts`](support/sign-in.ts); do not repeat the
OAuth dance per spec.

Sign-in runs against a **substitute GitHub OAuth/identity provider**,
never github.com: [`apps/galley/cmd/githubfake`](../apps/galley/cmd/githubfake),
a standalone command wrapping `internal/githubfake`'s fixtures behind a
real port. `internal/githubfake.New`'s own constructor takes a
`testing.TB` and only works inside a Go test binary — a real browser
needs something it can actually navigate to, which is the one thing
`cmd/githubfake` exists to provide. **It is a test/development
substitute only**: never wired into `cmd/galley`, never reachable from
a production build, and never talking to real GitHub. See its own doc
comment and `apps/galley/README.md`, "Owner configuration and GitHub
OAuth sign-in."

`run.sh` builds and starts it before Galley (its port is OS-assigned,
so it reports its own address and its fixed, non-secret fake
credentials via a small env file `run.sh` sources), then passes that
address to Galley as `GALLEY_OAUTH_GITHUB_BASE_URL` /
`GALLEY_OAUTH_GITHUB_API_BASE_URL`, and sets
`GALLEY_OWNER_GITHUB_LOGIN` to the fake owner's login
(`internal/githubfake.TestOwnerIdentity.Login`, `ticketit-test-owner`)
so a fresh sign-in against this run's empty database bootstraps that
identity as the Owner. It is torn down on exit exactly like Galley and
Swiftlet.

`run.sh` also sets Galley's `GALLEY_BASE_URL` to **Swiftlet's own
origin**, not Galley's — the browser only ever reaches Galley through
Swiftlet's proxy (`apps/galley/README.md`, "CORS"), so Swiftlet's
origin is "the externally-visible origin the browser is on when it
reaches Galley." This is what makes the OAuth callback's redirect back
to `/` land on Swiftlet's signed-in shell instead of on Galley's own
bare API root. Running Galley and Swiftlet's dev server separately by
hand needs the same care — see `apps/swiftlet/README.md`, "Galley
address configuration."

### The helper

```ts
import { signIn, setFakeIdentity } from "../support/sign-in";

// Signs in as the configured Owner (the default) and leaves the page on
// the authenticated shell, or on Galley's own rejection response for a
// non-owner identity.
await signIn(page, request, "owner");     // or "non-owner"

// Lower-level: only switches which fixture identity the fake provider's
// /user endpoint reports for the next completed exchange, without
// driving any UI. signIn calls this itself.
await setFakeIdentity(request, "non-owner");
```

The fake-provider process is shared by the whole suite, so a spec that
needs a specific identity selects it explicitly (`signIn`'s `preset`
argument) rather than assuming whichever identity the previous spec
left behind.

A spec needing Galley in an unusual state around sign-in (a restart, in
particular) still follows the existing rule below: `run.sh` owns that
restart in a phase of its own, with the signed-in browser's cookies
carried across the two `playwright test` invocations via Playwright's
storage state (`page.context().storageState({ path })` /
`test.use({ storageState })`) — see `tests/session-restart-before.spec.ts`
and `tests/session-restart-after.spec.ts` for the pattern.

Prefer reusing one signed-in storage state over signing in per spec once
there is more than a handful.

## Published Ticket actions

`tests/ticket-allowed-actions.spec.ts` reads each Ticket's live
`allowedActions` from Galley and compares full-page status and Accept
controls for Backlog, human In Review, and Coding In Review. The
unavailable reasons are also compared to direct Accept responses.
`run.sh` runs it while Galley is available and checks its exit code.

## Status board

`tests/ticket-board.spec.ts` creates Tickets and moves them through
Galley's API, then compares every board card's identity, Status,
Template, and within-Status order with live `GET /api/tickets`. It
compares the list's full order to that same response, checks direct
`/board` load and reload, and switches views without losing the signed-in
session. `run.sh` registers and checks its exit code after the restart
phase, while Galley is running.

`tests/ticket-board-moves.spec.ts` drives native drag and the detail modal's
Status buttons (there is no per-slip `Move to…` menu on desktop), checks persisted Status and returned allowed
actions after reload, proves disallowed and Done drops send no command, and
compares a stale move's visible rejection with Galley's live error,
including focus returning to the card's title link after a rejected move. It
also defers the Status request to check that plain detail entry is
unavailable until the move settles, and holds a modal-close GET
containing another Ticket's edit while a card moves: the board must
retain both Galley's returned move and the other Ticket's edit. It is
registered in `run.sh` while Galley is running.

## Ticket detail modal

`tests/ticket-modal.spec.ts` opens Tickets below the fold from both list
and board, checks canonical URL, retained scroll/focus after Escape,
Close and Back, Forward reopening, `aria-hidden` background, direct/reloaded
full-page detail, and Open full page. Edits, assignment, Accept, and a
board Status move use the real modal controls; after close the
underlying view is checked against live Galley `GET /api/tickets` data.
Deferred Save/Status requests cover completion after Close/Back; a
failed refresh retains rows, scroll and focus in both views. View
switching must not refocus a Ticket from the previous collection, and
Open full page preserves an edited Goal and Assignee controls.
`run.sh` registers this spec and checks its exit code.

`tests/ticket-badge-filter.spec.ts` selects two Badges from the list,
reloads, switches to the board, and detaches one in the modal. It compares
Galley's filtered response with rendered Tickets, then verifies the
detached Ticket leaves the view on close, keeps the filter through Open
full page and Back to Backlog, and returns after clearing the filter.
`run.sh` checks its exit code.

`tests/ticket-archive.spec.ts` archives Ready and Done Tickets from the
modal while filtered by Badge, verifies both leave everyday views, then
loads direct detail to assert retained Status, Badge, read-only controls,
and Galley's direct API rejection. It then archives from full-page detail
opened from the filtered Board, both in place and in a new tab, and
expects to land on that filtered Board. `run.sh` checks its exit code.

`tests/ticket-restore-before.spec.ts` combines Archived and Badge filters
in the list, restores Ready and Done in the modal, and sees them return
to their Galley Status columns on the board. `ticket-restore-after.spec.ts`
checks the same Status, Badge and fields after a real Galley restart.
Both are registered in `run.sh` with their exit codes checked.

`tests/agents.spec.ts` creates an Agent on the Agents page, sees Galley's
duplicate-name rejection, and renames it. It assigns that Agent on a Basic
Ticket from the Board modal and another Agent on a Coding Ticket from
full-page detail, then replaces the second with the Owner. Each step is
checked against Galley's live response, the Ticket list and the slip.
`run.sh` checks its exit code.

`tests/runner.spec.ts` pairs a runner on the Agents page, reads the
credential from the page, and spawns a real Michelin
(`apps/michelin/src/main.ts`, no install needed) against `GALLEY_BASE_URL`.
It waits for **Runner connected** in the header, stops Michelin, then
calls the development-only `POST /api/dev/clock/advance` for 30 s so
Galley's health window passes without a real wait, and waits for
**Runner disconnected**. The Ticket list must be unchanged, and it
stays unchanged after **Revoke**. `run.sh` checks its exit code.

## The failure-mode spec

`tests/backend-failure.spec.ts` runs *after* `run.sh` stops Galley, and
asserts the page shows its error state rather than a partial or
fabricated render.

It exists so the suite can prove it is capable of failing. Run it
against a live Galley and it must go red; if it ever passes in both
conditions, it is asserting nothing. See
[docs/evidence/m2/53-browser-harness.md](../docs/evidence/m2/53-browser-harness.md)
for a captured red run.

With Galley stopped, the session check fails first, so that spec
reaches App.tsx's `session-error`, never `StatusView`'s `status-error`.
`tests/status-failure.spec.ts` covers the latter: it signs in against
the live Galley, then fails only the browser's `GET /api/status` with
`page.route` (a 503, and a refused connection). It runs in its own
`run.sh` phase while Galley is still up. See
[docs/evidence/m2/80-statusview-browser-error.md](../docs/evidence/m2/80-statusview-browser-error.md)
for why this is interception rather than a Galley failure mode.

## Tool choice and disk footprint

Playwright, Chromium only, and only its **headless shell**
(`playwright install --only-shell chromium`) — 198 MB, versus roughly
1 GB for Playwright's default three browsers. Disk is constrained on the
development machine.

Do not add the `firefox` or `webkit` projects, or drop `--only-shell`,
without a reason recorded here. Cross-browser coverage is not a v1
requirement.

## CI

Not wired yet — [#68](https://github.com/cristoforows/ticketIt/issues/68)
added the app and drift jobs only; the browser job is
[#109](https://github.com/cristoforows/ticketIt/issues/109). `run.sh` is a plain command with configurable ports and
database URL so CI can call it unchanged.
