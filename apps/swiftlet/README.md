# Swiftlet

ticketIt's frontend: React + TypeScript, built with Vite. This slice
(issue #50, "M2.2 — Swiftlet boots and displays Galley-provided
status") adds a single page that fetches `GET /api/status` from Galley
and renders `application`, `status`, `version`, `environment`, and
`startedAt` exactly as Galley returns them. There is no routing, no
authentication, and no Tickets yet — see
[docs/deployment.md](../../docs/deployment.md) and
[docs/adr/0001-single-authority-galley.md](../../docs/adr/0001-single-authority-galley.md):
Swiftlet renders what Galley returns and never owns a workflow rule.

This app builds, tests, and runs entirely independently of the Go
toolchain. Galley does not exist yet (issue #49, in parallel); this app
is built and tested against the documented `/api/status` shape with a
stubbed `fetch`, not a live backend.

[Issue #51](https://github.com/cristoforows/ticketIt/issues/51) later
bound this app's status types to
[`contracts/openapi.yaml`](../../contracts/openapi.yaml), ticketIt's
single source of truth for Galley's HTTP API — see
[`contracts/README.md`](../../contracts/README.md) for the contract-
first convention every later slice follows, the regeneration command,
and the drift check. `src/api/status.ts`'s runtime behavior (its
fetch, its own shape validation, its error messages) is unchanged by
that refactor; only its types now come from the generated schema. This
app's own `npm ci`/`npm test`/`npm run build` still never install or
run anything Go- or codegen-toolchain-shaped — the generated schema is
committed (`src/api/generated/schema.d.ts`).

## Prerequisites

- Node **26.9.0** (pinned in `package.json`'s `engines.node`, matching
  `experiments/.nvmrc`). Use npm.

## Install

```sh
cd apps/swiftlet
npm ci
```

## Dev server

```sh
npm run dev
```

Starts the Vite dev server (default `http://localhost:5173`). The page
fetches `/api/status`, which the dev server proxies to Galley — see
"Galley address configuration" below.

### Galley address configuration

**Single documented place:** `vite.config.ts`'s `server.proxy` block.
It reads the `GALLEY_PROXY_TARGET` environment variable and proxies all
`/api/*` requests there, falling back to `http://localhost:8080`
(Galley's planned local address) when the variable is unset:

```sh
GALLEY_PROXY_TARGET=http://localhost:9090 npm run dev
```

You can also put `GALLEY_PROXY_TARGET=...` in a `.env` or `.env.local`
file in this directory (loaded via Vite's `loadEnv`, which is not
restricted to the `VITE_`-prefixed convention since it only affects the
dev/build-time proxy, not client bundle code); `.env.local` is
gitignored. The same variable applies to `npm run preview`.

## Build

```sh
npm run build
```

Type-checks the whole program with `tsc -p tsconfig.json --noEmit`,
then produces a production build with `vite build` into `dist/`.

## Test

```sh
npm test
```

Runs `vitest run` (a single non-watch pass, suitable for CI and the
`npm ci && npm test && npm run build` verification sequence). Use
`npm run test:watch` for local iteration. See
[docs/evidence/m2/50-swiftlet-boot.md](../../docs/evidence/m2/50-swiftlet-boot.md)
for the tooling rationale (Vite/Vitest over the M1 `experiments/`
convention of `node --test` + `tsx`).

Tests stub `global.fetch` (`vi.stubGlobal`) and cover:

- a successful response — every rendered field matches the stub's data,
  and only those fields;
- a non-2xx response (e.g. `503`) — an explicit error state, no
  placeholder values;
- an unreachable backend (`fetch` rejects) — an explicit error state;
- a malformed/schema-mismatched response — an explicit error state,
  since a value that doesn't match the documented shape must not be
  guessed at or partially rendered.

No browser/end-to-end tests are included here; issue #53 establishes
that harness.

## Regenerating types from the contract

`src/api/generated/schema.d.ts` is generated from
[`contracts/openapi.yaml`](../../contracts/openapi.yaml) and committed
(never hand-edited). After editing the contract, regenerate it via
`contracts`' own, separate toolchain — not this app's:

```sh
cd contracts
npm ci
npm run generate:swiftlet
```

See [`contracts/README.md`](../../contracts/README.md) ("Why a
separate `contracts/package.json` for codegen") for why this isn't an
`npm run generate` script in this `package.json`: the generator
(`openapi-typescript`) needs a different major version of TypeScript
than this app is pinned to, purely for its own code-generation
internals, and isolating that in `contracts/` keeps that version
conflict from ever touching this app's own dependency tree.

## What this app renders, and where from

`src/api/status.ts` fetches `/api/status`, typed against the generated
`components["schemas"]["StatusResponse"]` (`GalleyStatus`), and
validates the response matches the documented shape:

```json
{
  "application": "galley",
  "status": "ok",
  "version": "dev",
  "environment": "development",
  "startedAt": "2026-09-21T10:00:00Z"
}
```

`src/components/StatusView.tsx` renders exactly those five fields, and
nothing else. Every rendered value is sourced from the parsed response
object; there is no local fallback, default, or hardcoded status string
that could be mistaken for backend data. Any fetch failure, non-2xx
response, or shape mismatch renders an explicit error state
(`role="alert"`, `data-testid="status-error"`) instead.

## Browser-to-backend suite

The tests above stub `fetch`, so they never exercise the real proxy or
a real backend. The browser suite in [`e2e/`](../../e2e/README.md) does:

```sh
cd e2e && ./run.sh
```

It builds this app and serves the production build with `vite preview`,
proxying `/api` to a Galley it starts itself.
