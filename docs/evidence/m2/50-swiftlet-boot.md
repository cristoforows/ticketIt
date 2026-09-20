# Swiftlet boots and displays Galley-provided status

`docs/evidence/m2/TEMPLATE.md` does not exist yet at the time of this
slice (it is created by issue #49, which may land in parallel per issue
#50's instructions). This record follows the structure of
[docs/evidence/m1/TEMPLATE.md](../m1/TEMPLATE.md), adapted to an
application slice, as issue #50 directs.

## Purpose

Establish that `apps/swiftlet` — the ticketIt React frontend — boots
independently of the Go toolchain, fetches Galley's `GET /api/status`
payload, and renders exactly the fields Galley returns, with an
explicit error state when Galley is unreachable or returns a non-2xx
response. Tracking issue:
[#50 — M2.2 — Swiftlet boots and displays Galley-provided status](https://github.com/cristoforows/ticketIt/issues/50),
under [M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3).

## What already existed

Nothing under `apps/`. No monorepo scaffold, no frontend, no backend.
Issue #49 (Galley's `GET /api/status` payload) had not landed at the
time this slice was implemented; Galley does not exist on this machine
(Go is not installed) and was never run. This slice was built entirely
against the exact JSON shape fixed in issue #50's body:

```json
{
  "application": "galley",
  "status": "ok",
  "version": "dev",
  "environment": "development",
  "startedAt": "2026-09-21T10:00:00Z"
}
```

## What this slice added

- `apps/swiftlet`: a Vite + React + TypeScript application with its own
  `package.json`, exact-pinned dependencies, and committed
  `package-lock.json` — independent of every other application and of
  `experiments/`.
- `src/api/status.ts`: `fetchGalleyStatus()`, which calls `/api/status`,
  throws on a network failure or non-2xx response, and validates the
  parsed JSON has all five required string fields before returning it
  (throwing, rather than rendering, on a shape mismatch).
- `src/components/StatusView.tsx`: a `loading` / `success` / `error`
  state machine that renders `application`, `status`, `version`,
  `environment`, and `startedAt` from the fetched response — and only
  those five fields, with no local fallback or default value — or an
  explicit `role="alert"` error state.
- `src/App.tsx`, `src/main.tsx`: the single page hosting `StatusView`.
  No router, no auth, no Tickets, per this slice's scope.
- `vite.config.ts`: a `server.proxy` block forwarding `/api/*` to
  Galley, target configurable through one documented place
  (`GALLEY_PROXY_TARGET`, defaulting to `http://localhost:8080`).
- Component tests (`src/components/StatusView.test.tsx`,
  `src/App.test.tsx`) using a stubbed `global.fetch`, covering: a
  successful response, a non-2xx response, an unreachable backend
  (rejected fetch), a malformed/schema-mismatched response, and the
  loading state.
- `apps/swiftlet/README.md`: install/dev/build/test commands and the
  Galley address configuration.

## Exact versions and toolchain

- Node: `26.9.0` (matches `experiments/.nvmrc`; also pinned in
  `apps/swiftlet/package.json`'s `engines.node`).
- npm: `11.19.1`.
- Direct dependencies (all exact-pinned, no `^`/`~`, confirmed against
  `package-lock.json`'s resolved tree after `npm ci`):
  - `react` `19.3.0`, `react-dom` `19.3.0`
  - `typescript` `7.0.2` (same version already used by
    `experiments/_template`)
  - `vite` `8.3.0`, `@vitejs/plugin-react` `6.1.1`
  - `vitest` `5.0.1`, `jsdom` `30.1.0`
  - `@testing-library/react` `16.3.3`, `@testing-library/jest-dom`
    `7.0.1`
  - `@types/node` `26.6.2`, `@types/react` `19.3.0`, `@types/react-dom`
    `19.3.0`

### Tooling and test-runner choice, and why

**Vite + React + TypeScript**, as recommended by issue #50. Vite is the
natural fit: it is already the transform/build tool of choice for a
React SPA in this ecosystem, needs no separate bundler config, and its
dev server's `server.proxy` option directly satisfies the "proxy
`/api/*` to Galley, configurable in one place" requirement without a
second tool.

**Vitest**, not `node --test` + `tsx` (the pattern
`experiments/README.md` established for M1). That choice was explicit
and reasoned in `experiments/README.md`: M1's packages are bounded,
non-DOM adapter proofs where plain `node:test` was "enough," and
`vitest` was rejected there for pulling in Vite's dependency graph "for
capability this workspace does not need." Swiftlet is the opposite
case: it is a Vite project, and its tests are DOM component tests
(`render`, `screen`, DOM assertions via `@testing-library/react` and
`@testing-library/jest-dom`) that need a browser-like environment
(`jsdom`). Vitest reuses the project's actual `vite.config.ts` — same
`@vitejs/plugin-react` JSX transform, same module resolution — so
component tests exercise the identical transform pipeline as `npm run
build` and `npm run dev`, and needs no second config file (the `test`
block lives in `vite.config.ts` via `defineConfig` from
`vitest/config`). Reaching for `node --test` here would mean manually
wiring `jsdom` and a DOM-matcher library against a transform pipeline
that doesn't match Vite's, for no offsetting benefit. `npm test` runs
`vitest run` — a single non-watch pass, matching M1's "one `npm test`
verification command" convention.

**No router, no state library** — explicitly out of scope for this
slice per issue #50.

## Reproducible commands

All commands below run from `apps/swiftlet/` on a clean `node_modules`,
reproducing this record's exact results:

```sh
cd apps/swiftlet
rm -rf node_modules dist
npm ci
npm test
npm run build
```

## Observed results

```
$ npm ci
added 108 packages, and audited 109 packages in 732ms
found 0 vulnerabilities

$ npm test

> swiftlet@0.1.0 test
> vitest run

 RUN  v5.0.1 /apps/swiftlet

 Test Files  2 passed (2)
      Tests  6 passed (6)
   Start at  04:17:43
   Duration  441ms

$ npm run build

> swiftlet@0.1.0 build
> tsc -p tsconfig.json --noEmit && vite build

vite v8.3.0 building client environment for production...
transforming...
✓ 17 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                  0.31 kB │ gzip:  0.23 kB
dist/assets/index-_IoWTHEq.js  221.65 kB │ gzip: 69.26 kB
✓ built in 51ms
```

All six tests passed: successful-response rendering (every field:
`application`, `status`, `version`, `environment`, `startedAt`),
non-2xx error state, unreachable-backend error state, malformed-shape
error state, loading state, and the `App` smoke test. `tsc --noEmit`
reported zero type errors across `src/` and `vite.config.ts`.

Additionally verified: the production bundle (`dist/assets/*.js`)
contains none of the literal fixture values used only in tests or docs
(`"ok"`, `"galley"`, `"development"`, `localhost:8080`) — confirming
the dev-proxy target is a build/dev-time server concern only and never
reaches the client bundle, and that no status value is hardcoded into
the shipped frontend code.

No live Galley backend exists on this machine (Go is not installed;
issue #49 had not landed). No dev-server-to-real-Galley integration
check (`npm run dev` against a running Galley in a browser) was
performed or is claimed; see "Outstanding checks" below.

## Implementation limitations and follow-ups

- **No live two-server verification.** Issue #50's "Stops when" clause
  includes "running both dev servers shows live Galley-provided status
  in a browser." That could not be performed on this machine: Go is not
  installed, Galley does not exist yet, and browser/e2e tooling is
  explicitly out of scope here (issue #53). This slice substitutes
  component tests with a stubbed `fetch` covering success, non-2xx, and
  unreachable states, exactly as issue #50's acceptance criteria
  require, plus a manual code/bundle inspection proving no hardcoded
  status data. Named follow-up: a live dev-server-to-Galley smoke check
  once #49 lands, owned by **M2** (no specific follow-up issue number
  exists yet; the gate-report slice, #62, is the natural place to
  confirm or open one).
- **Response-shape validation beyond the stated acceptance criteria.**
  Issue #50 requires an explicit error state only for "unreachable or
  returns a non-2xx response." This implementation additionally treats
  a 2xx response missing a required string field as an error rather
  than rendering `undefined`/partial data, since silently rendering a
  partial value could itself be "mistaken for backend data." This is a
  stricter behavior than the stated minimum, not a weakening; flagged
  here for visibility in case a future slice wants looser/stricter
  handling as Galley's real contract solidifies (owning milestone:
  **M2**, wherever `contracts/` schemas for `/api/status` are formally
  established).

No other required behavior in issue #50 was left unimplemented.

## Outstanding checks and owning milestone

- Live Galley integration (`npm run dev` in `apps/swiftlet` against a
  running Galley `npm run dev`-equivalent, viewed in a browser) —
  **M2**, once issue #49 lands.
- Browser/end-to-end test harness — **M2**, issue #53 (explicitly
  deferred by issue #50).
- Formal `contracts/` schema for `/api/status` (if one is introduced)
  reconciled against this implementation's `GalleyStatus` type — **M2**
  or later, wherever `contracts/` is first populated per
  `docs/deployment.md`.

## Decision impacts (open-decision IDs)

None of D1, D2, D4–D9 are touched or resolved by this slice.
[D3](../../decisions/d3-agent-template-compatibility.md) is unrelated
to this frontend-only slice (no Agent, Round, or execution concept is
present in M2 per this slice's own scope rule). This record makes no
decision-impact claim beyond noting that Swiftlet's engineering choices
here — Vite, Vitest, no router/state library — are the kind of
"engineering choices inside the approved design" issue #50 designates
as this slice's own to make and record, not an open product decision.
