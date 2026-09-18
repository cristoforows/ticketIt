# <Short experiment title>

Copy this file to `docs/evidence/m1/<issue-number>-<short-slug>.md` (one
file per experiment issue, e.g. `16-opencode-boot.md`). Fill in every
section below, in this order. Do not remove a section; write "none" or
"not applicable" if it truly does not apply, and say why.

## Purpose

What this experiment is trying to establish, and which planned
feasibility experiment (S1–S5) or open decision it belongs to. Link the
tracking issue.

## Exact versions

Every pinned version this record's results depend on: Node, npm, the
test runner/loader (`tsx` or `vitest`), `typescript`, and any other
package whose exact version affects the result (SDKs, adapters,
executables). Exact versions only, no ranges.

## Reproducible commands

The exact commands to reproduce the results below, runnable from a
clean checkout (e.g. `cd experiments/<name> && npm ci && npm test`).
Include any setup beyond that (env vars with placeholder/synthetic
values, fixture files, etc.).

## Documentation research (unverified)

Findings drawn from reading documentation or source, not yet executed.
Cite the source. Label clearly as unverified; do not present this as an
observed result.

## Fixture/stub evidence (observed)

Actual results from running fixtures, stubs, or fake clocks in this
repository. This is evidence you produced by executing the commands
above, not documentation research.

## Real-provider evidence (observed, or "none executed")

Actual results from a real provider/network call, if one was executed
under the workspace rules (see `experiments/README.md` — this should be
rare inside M1 and is normally deferred to later milestones). If none
was executed, write exactly: "none executed" and say why.

## Observed limitations

What this experiment could not prove, what surprised you relative to
`docs/integration-feasibility.md`, and any behavior that looked
unsupported or fragile.

## Outstanding checks and owning milestone

Checks this experiment did not cover, and which milestone is expected
to cover them (cite the milestone and, if known, its issue).

## Decision impacts (open-decision IDs)

Which open decisions (see `docs/open-decisions.md`, e.g. `D7`) this
evidence informs, and how. Do not resolve the decision here — an
experiment observes and records; the gate-report slice (issue #29)
reconciles decisions and the evidence index.
