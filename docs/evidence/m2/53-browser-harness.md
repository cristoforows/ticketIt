# Browser-to-backend smoke path with real PostgreSQL

## Purpose

Establishes the approved primary test seam — a real browser driving a
real Swiftlet production build, against a real Galley, against real
PostgreSQL — and the conventions the six later M2 slices extend. Adds
one happy-path spec and one failure-mode spec. Touches no application
code. Tracking issue:
[#53](https://github.com/cristoforows/ticketIt/issues/53), under
[M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3).

## What already existed

`apps/galley` (#49, #51, #52): Go service, contract-bound `GET
/api/status`, PostgreSQL with embedded forward-only migrations applied
via `cmd/migrate`, and a development-only diagnostic.
`apps/swiftlet` (#50, #51): React app rendering Galley's five status
fields from a generated client, with stubbed-fetch component tests.
`contracts/` (#51): OpenAPI source of truth plus two drift checks.

No browser test of any kind existed. Swiftlet's tests stubbed `fetch`,
so nothing had ever exercised the real proxy, the real network hop, or
the real production build.

## What this slice added

A top-level `e2e/` package, independent of both applications:

- `run.sh` — the single documented command. Chooses free ports, resets
  and migrates a dedicated database, builds and starts Galley, builds
  and serves Swiftlet with `vite preview`, installs Chromium's headless
  shell on first run, runs both specs, tears everything down on exit
  including `Ctrl-C`. Refuses to run against `ticketit_dev`,
  `ticketit_test`, or `ticketit_m1_native`.
- `tests/status.spec.ts` — asserts the rendered page against Galley's
  own live response, fetched independently through Playwright's
  `request` fixture. No hardcoded expected values. Also asserts
  `database.status == "ok"`, proving PostgreSQL was genuinely reachable
  rather than merely that Galley answered.
- `tests/backend-failure.spec.ts` — runs after `run.sh` stops Galley;
  asserts the error state renders and the success state does not.
- `playwright.config.ts` — Chromium only, `workers: 1`,
  `fullyParallel: false`, `retries: 0`.
- `README.md` — conventions for later slices: adding a spec, asserting
  against the backend rather than literals, creating data through the
  API rather than behind Galley's back, the file-order dependency, and
  where the sign-in helper goes once #54/#55 land.

Deliberately **not** included: CI wiring (#68 owns it), any application
code change, any new endpoint or schema change.

## Exact versions and toolchain

Go 1.27.1, Node 26.9.0, npm 11.19.1, PostgreSQL 17.11 (Homebrew),
`@playwright/test` (see `e2e/package-lock.json` for the exact pin),
Chromium headless shell build 1243. macOS 15.6 arm64.

## Reproducible commands

```sh
cd e2e && ./run.sh
```

Falsification (must fail):

```sh
# with Galley running and Swiftlet served against it
cd e2e && E2E_BASE_URL=http://127.0.0.1:<port> \
  npx playwright test tests/backend-failure.spec.ts
```

## Observed results

Full suite, from a clean database:

```
[run.sh] serving swiftlet's build on http://127.0.0.1:49569, proxying /api to http://127.0.0.1:49568
[run.sh] running tests/status.spec.ts against a live galley
  ✓  1 [chromium] › tests/status.spec.ts:19:1 › status page displays the values Galley actually returns (248ms)
[run.sh] stopping galley to exercise the failure-mode spec (pid 21559)
[run.sh] running tests/backend-failure.spec.ts against a stopped galley
  ✓  1 [chromium] › tests/backend-failure.spec.ts:21:1 › status page shows its error state when Galley is stopped (85ms)
[run.sh] SUITE PASSED
```

### Proof the suite can fail

The failure-mode spec run against a **live** Galley, which must go red:

```
  ✘  1 [chromium] › tests/backend-failure.spec.ts:21:1 › status page shows its error state when Galley is stopped (5.2s)
    Error: expect(locator).toBeVisible() failed
    Error: element(s) not found
    > 24 |   await expect(page.getByTestId("status-error")).toBeVisible();
  1 failed
```

A suite that passes in both conditions asserts nothing. This one does
not.

### Disk footprint

`~/Library/Caches/ms-playwright` is **198 MB** — `chromium_headless_shell`
and `ffmpeg` only. Playwright's default (Chromium, Firefox, WebKit)
would be roughly 1 GB. Disk is constrained on the development machine,
so `--only-shell chromium` is deliberate and recorded in
`e2e/README.md`.

## Implementation limitations and follow-ups

- **No CI.** The suite runs only when a human runs it — the same gap
  #51 and #52 recorded. Owned by
  [#68](https://github.com/cristoforows/ticketIt/issues/68).
- **Specs depend on file order.** `backend-failure.spec.ts` requires
  `run.sh` to have stopped Galley first, enforced only by `workers: 1`
  and alphabetical file order. Adding a spec that sorts between them
  would break that silently. A later slice needing more backend states
  should give `run.sh` explicit phases instead.
- **Chromium only.** Cross-browser behaviour is unverified and not a v1
  requirement.
- **No sign-in helper yet.** Written up in `e2e/README.md` as a
  contract for #55, not implemented here — sign-in does not exist until
  #54 lands.
- **`run.sh` assumes local `createdb`/`psql` on the current user's
  PostgreSQL.** A containerised or remote database would need the
  database-reset step reworked.

## Outstanding checks and owning milestone

- Running this suite in CI, against a PostgreSQL service container —
  **#68**.
- Extending it with authenticated specs — **#55**.
- Whether one signed-in storage state should be shared across specs
  rather than signing in per spec — revisit when the suite exceeds a
  handful of authenticated specs, **M3**.

## Decision impacts

None. This slice selects no provider, resolves no open decision, and
changes no application behaviour. Playwright and the Chromium-only
scope are engineering choices within the approved design, recorded
here and in `e2e/README.md`.

## Provenance

The `e2e/` implementation in this slice was written by a subagent that
was terminated mid-task by a spend limit before committing, documenting,
or running the suite to completion. The orchestrating session recovered
the uncommitted work from its worktree, added `.gitignore`, `README.md`,
and this record, and performed every verification reported above
directly.
