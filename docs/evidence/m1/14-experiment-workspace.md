# M1.3 — Experiment workspace and evidence conventions

## Purpose

Prove the `experiments/` workspace path end to end for
[M1.3 — Experiment workspace and evidence conventions
(#14)](https://github.com/cristoforows/ticketIt/issues/14): a fresh
clone can run `npm ci && npm test` in an independent experiment
package, that package consumes `experiments/shared/` through a local
`file:../shared` dependency, and the result is recorded following
`docs/evidence/m1/TEMPLATE.md`. This is workspace scaffolding, not one
of the S1–S5 feasibility experiments in
`docs/integration-feasibility.md`; it establishes the mechanism those
experiments will use.

## Exact versions

- Node: `v26.9.0` (matches `experiments/.nvmrc` and every package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- `typescript`: `7.0.2` (devDependency, pinned exact, all three packages)
- `tsx`: `4.23.13` (devDependency, pinned exact, all three packages)
- `@types/node`: `26.6.1` (devDependency, pinned exact, all three
  packages)
- Test runner: Node's built-in `node --test`, loaded via
  `node --import tsx --test`. No `vitest` involved. See
  `experiments/README.md` ("Why this runner") for the choice and
  reasoning.

## Reproducible commands

Run from a clean checkout, for each of the three packages exercised by
this slice:

```sh
cd experiments/shared
rm -rf node_modules
npm ci
npm test

cd ../_template
rm -rf node_modules
npm ci
npm test

cd ../tracer-fake-clock
rm -rf node_modules
npm ci
npm test
```

## Documentation research (unverified)

None. This slice is workspace scaffolding based on the requirements in
issue #14 and the shared instructions in `docs/implementation-plan.md`
and `docs/integration-feasibility.md`; it does not depend on external
provider documentation.

## Fixture/stub evidence (observed)

All three packages pass `npm ci && npm test` from a clean
`node_modules`, on the machine/version combination above:

- `experiments/shared`: `npm ci` → `added 8 packages, and audited 9
  packages`, 0 vulnerabilities. `npm test` → 11/11 tests passed
  (`FakeClock` behavior: epoch default, ISO-string start, `advance()`
  forward/backward, `set()`, `now()` returns a `Date`, invalid-input
  rejection; plus the `evidence` helper's section ordering and skeleton
  rendering).
- `experiments/_template`: `npm ci` → `added 9 packages, and audited 11
  packages`, 0 vulnerabilities. `npm test` → 1/1 test passed, importing
  `FakeClock` from `shared` through `dependencies: { "shared":
  "file:../shared" }` and confirming elapsed-time math uses the fake
  clock rather than wall time.
- `experiments/tracer-fake-clock`: `npm ci` → `added 9 packages, and
  audited 11 packages`, 0 vulnerabilities. `npm test` → 2/2 tests
  passed: deterministic behavior across `advance()`/`set()`, and two
  independently-seeded `FakeClock` instances never observing real
  wall-clock time (`FakeClock`'s value stays independent of
  `Date.now()`).

`tsc -p tsconfig.json --noEmit` (the `typecheck` script) also passed
with no errors in all three packages.

`git add -n experiments docs/evidence .gitignore` was used to confirm
exactly one `package-lock.json` per package is staged and no
`node_modules/` directory is staged.

## Real-provider evidence (observed, or "none executed")

None executed. This slice touches no model provider, no OpenCode
process, and no GitHub API/network calls — only local npm packages,
`node --test`, and `FakeClock`, per the workspace rules in
`experiments/README.md` (no real credentials, no real-provider calls).

## Observed limitations

- `npm install`/`npm ci` on npm 11.19.1 prints an `install-scripts`
  warning that `esbuild`'s postinstall script (and, once a
  `package-lock.json` exists, `fsevents`'s macOS-only install script)
  are "not yet covered by allowScripts" and were skipped. This did not
  break anything observed here: `esbuild`'s platform binary
  (`@esbuild/darwin-arm64`) is installed as a normal optional
  dependency and `tsx` transpiled and ran every test file correctly.
  This is worth re-checking if a future experiment depends on a package
  whose postinstall script is load-bearing (e.g. compiles a native
  addon) rather than fetching a platform binary that ships as its own
  optional dependency.
- Node 26.9.0 can already run a narrow, erasable subset of TypeScript
  natively (`node --test` on a plain `.ts` file with only type
  annotations passed without `tsx`, confirmed manually outside these
  packages). This workspace still uses `tsx` deliberately, since that
  native subset is narrower and has been a moving target across recent
  Node versions; see `experiments/README.md` for the reasoning. Not
  treated as a limitation of the chosen approach, but recorded since it
  was directly observed.
- `typescript@7.0.2` is a new major version (the native/Go-based
  compiler) at the pinned-version resolution time (`npm view typescript
  dist-tags` on this machine showed `latest: 7.0.2`); `tsc --noEmit`
  behaved as expected for the small surface exercised here, but this
  slice did not exercise advanced type-checking behavior that might
  differ from TypeScript 5.x.

## Outstanding checks and owning milestone

- The actual S1–S5 feasibility experiments (OpenCode lifecycle, live
  permission/disconnect admission, fixed inputs/durable human input,
  OpenRouter payload fidelity, GitHub delivery/identity) are separate
  M1 issues that will copy `experiments/_template/` and are not covered
  by this slice.
- The gate-report slice
  ([#29](https://github.com/cristoforows/ticketIt/issues/29)) owns
  reconciling `docs/evidence/m1/README.md`,
  `docs/integration-feasibility.md`, and `docs/open-decisions.md` once
  further experiment evidence exists.
- The admission ledger mentioned in issue #14's scope is explicitly
  deferred to a later slice; `experiments/shared/src/evidence.ts` only
  documents the template path and section order, and does not implement
  ledger storage.

## Decision impacts (open-decision IDs)

None. This slice does not touch any open decision; in particular it
selects no object storage, hosting, or model, per
[open decision D7](../../open-decisions.md). It only establishes the
package-per-experiment mechanism and evidence conventions that later,
decision-relevant experiments will use.
