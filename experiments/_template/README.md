# Template experiment package

Copy this directory to start a new M1 experiment. Do not edit it in place.

## Steps to start a new experiment

1. Copy: `cp -R experiments/_template experiments/<name>`
2. In `experiments/<name>/package.json`, change `"name"` to `<name>` and
   update `"description"` to say what the experiment proves.
3. Replace `src/index.ts` and `test/sample.test.ts` with the real
   experiment code and tests.
4. From `experiments/<name>/`, run `npm install` to generate that
   package's own `package-lock.json`, then commit both.
5. Add exactly one evidence file at
   `docs/evidence/m1/<issue-number>-<slug>.md`, based on
   `docs/evidence/m1/TEMPLATE.md`. Do not edit
   `docs/evidence/m1/README.md` (the gate-report slice, issue #29, owns
   that index).
6. Verify with `npm ci && npm test` from a clean `node_modules`.

## What this template pins

- `engines.node`: `26.9.0`, matching `experiments/.nvmrc`.
- `typescript`, `tsx`, `@types/node`: exact versions, no `^`/`~`. Match the
  versions already used by `experiments/shared` unless the experiment has
  a documented reason to diverge (record that reason in its evidence file).
- `dependencies.shared`: `file:../shared`, for the shared `FakeClock` and
  evidence helpers.

See `experiments/README.md` for the full workspace rules (no real
credentials or providers, fixtures/fake clocks only, etc.).
