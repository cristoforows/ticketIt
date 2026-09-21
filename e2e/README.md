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
directly). `run.sh` sets both.

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

## Signing in (arrives with #54 and #55)

Every spec after sign-in lands needs an authenticated browser. Put one
helper in `e2e/support/sign-in.ts` and have specs call it; do not repeat
the OAuth dance per spec.

Sign-in runs against the **fake OAuth provider** from
[#54](https://github.com/cristoforows/ticketIt/issues/54), never
github.com. `run.sh` will need a phase that starts it and passes its
address to Galley. Whoever lands
[#55](https://github.com/cristoforows/ticketIt/issues/55) owns writing
that helper and documenting it here.

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
