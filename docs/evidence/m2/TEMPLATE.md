# <Short slice title>

Copy this file to `docs/evidence/m2/<issue-number>-<short-slug>.md` (one
file per M2 slice, e.g. `49-galley-boot.md`). Fill in every section
below, in this order. Do not remove a section; write "none" or "not
applicable" if it truly does not apply, and say why.

Adapted from [docs/evidence/m1/TEMPLATE.md](../m1/TEMPLATE.md) for an
application slice: M1's template records bounded, isolated adapter
*experiments* (documentation research vs. fixture/stub evidence vs.
real-provider evidence). M2 slices instead build and run real
application code under `apps/`, so this template asks what already
existed before the slice, what the slice added, and the exact toolchain
and commands needed to build, test, and run it — the same shape used by
[50-swiftlet-boot.md](50-swiftlet-boot.md).

## Purpose

What this slice establishes, which application(s) it touches
(`apps/swiftlet`, `apps/galley`, ...), and which milestone/issue it
belongs to. Link the tracking issue.

## What already existed

The state of the repository immediately before this slice, relevant to
what it built: what code, applications, or infrastructure were already
in place, and what explicitly was not (e.g. "no `apps/` directory yet,"
"Galley's `GET /api/status` had not landed"). Note any dependency on a
sibling slice that may be landing in parallel, and what this slice
assumed about it in that case.

## What this slice added

The concrete files, packages, endpoints, or components this slice
introduced or changed, in enough detail that a later slice can tell
what is now available to build on. Include engineering choices made
inside the approved design (router/HTTP library, data access,
migration tool, frontend tooling, contract format, test runner, etc.)
and the reasoning behind each — this is this slice's own decision to
make and record, not an open product decision.

## Exact versions and toolchain

Every pinned version this record's results depend on: language
runtime/toolchain (Go, Node, ...), package manager, test runner, and
any other dependency whose exact version affects the result. Exact
versions only, no ranges. Confirm pins against the actual lockfile/
`go.mod`/`go.sum`/`package-lock.json` where one exists.

## Reproducible commands

The exact commands to reproduce the results below, runnable from a
clean checkout (e.g. `cd apps/<app> && go build ./... && go test
./...`, or `cd apps/<app> && npm ci && npm test`). Include any setup
beyond that (env vars with placeholder/synthetic values, how to start a
dependency, etc.).

## Observed results

Actual output from running the commands above — build/test output, and
for a slice that serves HTTP, the real request/response (e.g. `curl`
output) proving the documented run command actually serves what the
issue requires. This is evidence you produced by executing the commands
above, not documentation research or an expected/hypothetical result.

## Implementation limitations and follow-ups

Any required behavior this slice could not fully implement, recorded
explicitly with a named follow-up and its owning milestone — never a
silent downgrade or a weakened rule. If nothing was left unimplemented,
say so plainly.

## Outstanding checks and owning milestone

Checks this slice did not cover (e.g. integration with a sibling
application that hadn't landed yet, load/performance, security review),
and which milestone is expected to cover them (cite the milestone and,
if known, its issue).

## Decision impacts (open-decision IDs)

Which open decisions (see `docs/open-decisions.md`, e.g. `D7`) this
slice's evidence informs, and how. Do not resolve the decision here — a
slice observes and records; the gate-report slice (issue #62)
reconciles decisions and the evidence index.
