# Restore browser coverage for StatusView's own error state

## Purpose

Gives the browser suite (`e2e/`) a scenario that reaches `StatusView`'s
own `status-error` state again. Touches `e2e/` only; no change to
`apps/galley` or `apps/swiftlet`. Tracking issue:
[#80 — Restore browser coverage for StatusView's own error
state](https://github.com/cristoforows/ticketIt/issues/80). Not a
milestone slice -- a follow-up routed from the M2 gate report
([#62](https://github.com/cristoforows/ticketIt/issues/62)), recorded
as a limitation in [55-swiftlet-sign-in.md](55-swiftlet-sign-in.md).

## What already existed

- Since [#55](https://github.com/cristoforows/ticketIt/issues/55),
  `App.tsx` checks `GET /api/session` before rendering anything, and
  `StatusView` mounts only inside the authenticated shell
  (`AppShell.tsx`, backlog route).
- `tests/backend-failure.spec.ts` runs after `run.sh` stops Galley, so
  the session check fails first and the page shows `session-error`.
  `status-error` was reached only by `StatusView.test.tsx`, which stubs
  `fetch`.
- No arrangement of the real backend reaches `status-error` with a
  signed-in session:
  - Galley stopped: the session check fails first (above).
  - PostgreSQL stopped: `GET /api/status` still answers `200`, reporting
    `database.status: "error"` (`apps/galley/internal/httpapi/handler_test.go`,
    the unreachable-database test), so `StatusView` renders success --
    and the session lookup needs PostgreSQL anyway.
  - Galley has no switch that fails only `GET /api/status`.

## What this slice added

### Decision -- intercept the browser's `GET /api/status`, not a Galley failure mode

**Chosen:** `e2e/tests/status-failure.spec.ts` signs in for real
through the running Galley and substitute GitHub provider
(`e2e/support/sign-in.ts`), confirms the real `status-success` renders,
then installs `page.route` matching only the pathname `/api/status` and
reloads. The reload's `GET /api/session` reaches the real Galley and is
asserted `200`; only the status response is replaced.

**Why not a Galley flag or fixture** (the issue's first option): it
would put a test-only failure path into the `cmd/galley` binary. The
suite's one existing substitute, `cmd/githubfake`, is a separate
command never wired into `cmd/galley` or a production build
(`e2e/README.md`, "Signing in"); a status-failure switch would be the
first test-only path inside Galley itself. Interception needs no
production code, no new environment variable, and no extra Galley
process or restart in `run.sh`.

**Why not accept the gap** (the issue's second option): the component
test proves `StatusView` renders its error from a rejected `fetch`, but
not that the built app, after a real session check, mounts `StatusView`
inside the shell and shows that state there. That composition is what
#55 changed.

**ADR 0001:** [ADR 0001](../../adr/0001-single-authority-galley.md)
makes Galley the sole owner and mutator of authoritative records, with
Swiftlet rendering what Galley returns. The interception writes no
record and introduces no second writer: `GET /api/status` is a read,
and the substituted response exists only inside the test browser. The
one authority-bearing decision on this path -- whether the session is
valid -- is still Galley's, from the real response.

### Failure shapes covered

Two of the three that `apps/swiftlet/src/api/status.ts` treats as
errors, mirroring `StatusView.test.tsx`:

- non-2xx: `route.fulfill({ status: 503 })`; message contains `503`.
- network failure: `route.abort("connectionrefused")`; message contains
  `unreachable`.

Off-contract `200` bodies are left to the component test: in a browser
they exercise the same parse path with no additional composition.

Each case asserts `app-shell` visible, `status-error` visible with the
expected message, and both `session-error` and `status-success` absent.

### Files

- `e2e/tests/status-failure.spec.ts` (new).
- `e2e/run.sh`: phase `10c`, after `ticket-lifecycle.spec.ts` and
  before phase 11 stops Galley; `STATUS_FAILURE_EXIT` added to the
  summary and the final aggregation.
- `e2e/README.md`: "The failure-mode spec" now names the new spec and
  links this record.
- `tests/backend-failure.spec.ts` unchanged: its comment already states
  it asserts `session-error`, and does not describe the gap as open.
- `55-swiftlet-sign-in.md` unchanged, the same way
  [75-unknown-request-properties.md](75-unknown-request-properties.md)
  left earlier records as written.

## Exact versions and toolchain

- Go `1.27.1` (darwin/arm64) -- unchanged.
- Node `v26.9.0` -- unchanged.
- PostgreSQL `18.1` (Docker `postgres:18`, `localhost:5432`).
  `run.sh` reset `ticketit_e2e` from empty on every run; no other
  database was touched.
- `e2e`: `@playwright/test` `1.63.0`, Chromium headless shell only
  (`--only-shell`) -- unchanged. No new dependency; `page.route` is
  part of `@playwright/test`.
- `apps/swiftlet`: `vite` `8.3.0` -- unchanged, not modified.

## Reproducible commands

```sh
cd e2e
./run.sh
```

Repeat check (temporary local edit, not committed): phase `10c`'s
command with `--repeat-each=5` appended, then `./run.sh`.

Falsification (temporary local edit, not committed): both handlers in
`tests/status-failure.spec.ts` replaced with `route.continue()`, then
`./run.sh`.

## Observed results

### `e2e/run.sh`

```
[run.sh] running tests/status-failure.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/status-failure.spec.ts:30:3 › StatusView inside the signed-in shell › shows its error state when GET /api/status returns non-2xx (305ms)
  ✓  2 [chromium] › tests/status-failure.spec.ts:36:3 › StatusView inside the signed-in shell › shows its error state when GET /api/status fails at the network level (301ms)
  2 passed (1.1s)
...
[run.sh] status.spec.ts exit code: 0
[run.sh] auth.spec.ts exit code: 0
[run.sh] session-restart-before.spec.ts exit code: 0
[run.sh] ticket-lifecycle-before.spec.ts exit code: 0
[run.sh] ticket-persistence-before.spec.ts exit code: 0
[run.sh] ticket-refinement-before.spec.ts exit code: 0
[run.sh] session-restart-after.spec.ts exit code: 0
[run.sh] ticket-persistence-after.spec.ts exit code: 0
[run.sh] ticket-refinement-after.spec.ts exit code: 0
[run.sh] ticket-lifecycle-after.spec.ts exit code: 0
[run.sh] ticket-detail.spec.ts exit code: 0
[run.sh] ticket-refinement.spec.ts exit code: 0
[run.sh] ticket-templates.spec.ts exit code: 0
[run.sh] ticket-lifecycle.spec.ts exit code: 0
[run.sh] status-failure.spec.ts exit code: 0
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

### Repeat check (`--repeat-each=5`)

```
  ✓   1 [chromium] › tests/status-failure.spec.ts:30:3 › ... returns non-2xx (326ms)
  ✓   2 [chromium] › tests/status-failure.spec.ts:36:3 › ... fails at the network level (287ms)
  ...
  ✓   9 [chromium] › tests/status-failure.spec.ts:30:3 › ... returns non-2xx (628ms)
  ✓  10 [chromium] › tests/status-failure.spec.ts:36:3 › ... fails at the network level (592ms)
  10 passed (6.3s)
...
[run.sh] status-failure.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

Seven passes of each case across three full runs (1 + 5 + a final run
on the committed files), none failed.

### Falsification

With the real `GET /api/status` passed through, both cases fail on
`status-error`, and `run.sh` reports the suite failed:

```
  ✘  1 [chromium] › tests/status-failure.spec.ts:30:3 › ... returns non-2xx (5.4s)
  ✘  2 [chromium] › tests/status-failure.spec.ts:36:3 › ... fails at the network level (5.3s)

    Error: expect(locator).toBeVisible() failed

    Locator: getByTestId('status-error')
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found
...
[run.sh] status-failure.spec.ts exit code: 1
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE FAILED
```

Every other phase stayed `0`. The handlers were then restored.

## Implementation limitations and follow-ups

- The substituted failure is produced in the browser, before Swiftlet's
  preview-mode proxy, so this spec does not exercise how the proxy
  relays an upstream `503` or refusal for `/api/status`. The real proxy
  against a genuinely gone upstream stays covered by
  `backend-failure.spec.ts`. No follow-up: a Galley that serves the
  session but fails its own status handler is not a state it can reach
  today (see "What already existed").

Otherwise none; #80's gap is closed.

## Outstanding checks and owning milestone

None specific to this fix.

## Decision impacts (open-decision IDs)

None. Test-harness change only; no product behaviour or tracked open
decision is affected.
