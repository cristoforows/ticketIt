# experiments/

Bounded, isolated adapter proofs for [M1 — Foundational decisions and
integration proofs (#2)](https://github.com/cristoforows/ticketIt/issues/2).
See [docs/integration-feasibility.md](../docs/integration-feasibility.md)
for the observed S1–S5 results and outstanding checks, and
[docs/implementation-plan.md](../docs/implementation-plan.md) (M1 section)
for how this fits the overall plan.

## What this is, and is not

- This directory holds throwaway integration proofs, not the ticketIt
  application. The planned application lives under `apps/` (`swiftlet`,
  `galley`, `michelin`) per
  [docs/deployment.md](../docs/deployment.md); nothing here creates or
  substitutes for that layout.
- Findings here inform M1 decisions and evidence; they are not
  themselves a shipped feature, a chosen provider, or a chosen model.
- There is no root `package.json` and no npm workspaces. Every
  experiment is a separately managed npm package with its own
  `package.json` and `package-lock.json`. This is deliberate: parallel
  M1 slices add experiment packages without ever touching a shared
  manifest or lockfile. Shared harness changes can still affect their
  consumers.

## Layout

```text
experiments/
├── .nvmrc                # pinned Node version (26.9.0)
├── README.md             # this file
├── shared/                # reusable utilities (FakeClock, evidence helper)
├── _template/             # copy this to start a new experiment
└── <name>/                # one directory per experiment, e.g. tracer-fake-clock/
```

Experiment packages reuse utilities from `experiments/shared/` and harnesses
or fixtures from sibling packages through local `file:../<package>`
dependencies. Examples include `file:../shared`, `file:../opencode-harness`,
`file:../native-harness`, and `file:../openrouter-fidelity`. Keep these
dependencies inside `experiments/`; do not publish the local harnesses or
replace them with registry dependencies.

## Running an experiment

Use the Node version pinned in `experiments/.nvmrc`. Follow the package's
README for prerequisites, including separate `npm ci` runs in required
sibling harnesses and PostgreSQL setup where applicable.

```sh
cd experiments/<name>
npm ci
npm test
```

`npm ci` uses the committed `package-lock.json` in that package. It does
not replace the setup steps for sibling packages consumed through local
`file:` dependencies.

## Adding a new experiment

1. Copy the template: `cp -R experiments/_template experiments/<name>`.
2. Rename the `"name"` field in `experiments/<name>/package.json` and
   update its `"description"`.
3. Write the experiment and its tests. Reuse utilities, harnesses, or
   fixtures through local `file:../<package>` dependencies where useful;
   document their setup prerequisites. Pin direct registry dependencies
   to exact versions (no `^` or `~`).
4. Run `npm install` inside `experiments/<name>/` to generate that
   package's own `package-lock.json`, then commit it.
5. Add exactly one evidence file at
   `docs/evidence/m1/<issue-number>-<short-slug>.md` (e.g.
   `16-opencode-boot.md`), based on
   [docs/evidence/m1/TEMPLATE.md](../docs/evidence/m1/TEMPLATE.md).
6. Verify `npm ci && npm test` passes from a clean `node_modules`.

## Toolchain

- Node: pinned in `experiments/.nvmrc` and every package's
  `engines.node` (`26.9.0`).
- TypeScript + test runner: Node's built-in test runner (`node --test`)
  with `tsx` as the `--import` loader. See "Why this runner" below.
- Direct registry dependencies are pinned to exact versions; local
  dependencies use `file:` references. Lockfiles are committed for every
  package and fix the resolved registry dependency trees.

### Why this runner

Node 26 can already type-strip a narrow, erasable subset of TypeScript
natively, but that subset does not cover everything an experiment might
reasonably need (e.g. `tsconfig.json` path behavior consistent with
`tsc`, enums, or any future non-erasable syntax), and its availability
has shifted across recent Node versions, which is a bad property to
depend on for reproducible M1 evidence. `tsx` is a small, focused
dependency (esbuild-based transform, no bundler, no separate config
format) that gives every package on this pinned Node version the same
TypeScript behavior regardless of what Node's native stripping supports
this month. `vitest` was the other option in scope; it was rejected
here because it pulls in a much larger dependency graph (Vite, Rollup,
its own worker/pool machinery) for capability this workspace does not
need — plain `node:test` plus `node:assert/strict` is enough for
bounded adapter proofs. Each package still verifies with a plain
`npm test`.

## Rules

- **No real credentials.** Never commit or read a real API key, PAT, or
  OAuth secret in this directory. Use synthetic/fixture values only.
- **No calls to real providers or real repositories.** Every experiment
  here uses stubs, fixtures, or fake clocks — no live OpenRouter,
  OpenCode, or GitHub network calls. Narrow real-adapter smoke tests are
  planned separately in later milestones (M7, M8, M10;
  see [docs/implementation-plan.md](../docs/implementation-plan.md)),
  not in this workspace.
- **Never select object storage, hosting, or a model.** Those are open
  product decisions (see
  [open decision D7](../docs/open-decisions.md)) owned by later
  milestones. An experiment may observe that a given option is
  technically feasible; it must not declare it chosen.
- **Classify evidence per the template.** Every evidence record
  distinguishes documentation research (unverified) from fixture/stub
  evidence (observed) from real-provider evidence (observed, or "none
  executed"). Don't blur those categories.
- **Don't edit the evidence index or the feasibility/decision docs.**
  `docs/evidence/m1/README.md` is owned by the gate-report slice
  (issue #29). `docs/integration-feasibility.md` and
  `docs/open-decisions.md` are also out of scope for individual
  experiment slices; an experiment records what it found in its own
  evidence file and lets the gate-report slice reconcile the index and
  those docs.
