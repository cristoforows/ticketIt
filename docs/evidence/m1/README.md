# M1 evidence index

Evidence records for [M1 — Foundational decisions and integration
proofs (#2)](https://github.com/cristoforows/ticketIt/issues/2), backing
the bounded experiments in
[docs/integration-feasibility.md](../../integration-feasibility.md)
("Planned feasibility experiments").

## Ownership

**Only the gate-report slice ([M1.18 — M1 gate report and decision
routing, issue #29](https://github.com/cristoforows/ticketIt/issues/29))
edits this index.** Every other M1 experiment slice adds exactly one new
evidence file to this directory and leaves this file alone. This keeps
parallel experiment slices from conflicting with each other over a
shared index file, the same reason `experiments/` has no root
`package.json`.

## Conventions

- One file per experiment issue: `docs/evidence/m1/<issue-number>-<short-slug>.md`
  (e.g. `16-opencode-boot.md`).
- Every file follows [TEMPLATE.md](TEMPLATE.md): Purpose; Exact
  versions; Reproducible commands; Documentation research (unverified);
  Fixture/stub evidence (observed); Real-provider evidence (observed, or
  "none executed"); Observed limitations; Outstanding checks and owning
  milestone; Decision impacts (open-decision IDs).
- Evidence files are records of what was actually run and observed, not
  a substitute for `docs/integration-feasibility.md` or
  `docs/open-decisions.md`. Neither of those documents, nor this index,
  is updated by an individual experiment slice.

## Records

| File | Experiment | Issue |
| --- | --- | --- |
| [14-experiment-workspace.md](14-experiment-workspace.md) | M1.3 — Experiment workspace and evidence conventions (tracer: `tracer-fake-clock`) | [#14](https://github.com/cristoforows/ticketIt/issues/14) |

The gate-report slice (#29) will extend this table as further M1
experiment evidence files land.
