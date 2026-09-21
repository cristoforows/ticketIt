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
on first run, runs both specs, and tears everything down. Exit code is
non-zero if either spec fails.

It never uses servers you already have running: every port is chosen
free at startup, and both processes are killed on exit, including on
`Ctrl-C`.

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

## The failure-mode spec

`tests/backend-failure.spec.ts` runs *after* `run.sh` stops Galley, and
asserts the page shows its error state rather than a partial or
fabricated render.

It exists so the suite can prove it is capable of failing. Run it
against a live Galley and it must go red; if it ever passes in both
conditions, it is asserting nothing. See
[docs/evidence/m2/53-browser-harness.md](../docs/evidence/m2/53-browser-harness.md)
for a captured red run.

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
owns that. `run.sh` is a plain command with configurable ports and
database URL so CI can call it unchanged.
