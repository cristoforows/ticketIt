# Domain Docs

## Layout

This project uses a single-context layout:

- `CONTEXT.md` at the repository root: domain language and glossary.
- `docs/adr/`: architectural decision records.

## Before exploring

Read root `CONTEXT.md` and ADRs relevant to the work.

If these files do not exist, proceed silently. Do not flag their
absence or suggest creating them upfront. `/grill-with-docs` creates
them lazily as terms and decisions are resolved.

If the project later introduces root `CONTEXT-MAP.md`, follow it
to relevant context files and read both system-wide ADRs and
context-scoped ADRs, including `src/<context>/docs/adr/`.

## Use the glossary's vocabulary

Use terms defined in `CONTEXT.md` when naming domain concepts in
issues, refactor proposals, hypotheses, and tests. Avoid synonyms
the glossary explicitly rejects.

If a concept is missing, reconsider whether it belongs in the
project's language or note the gap for `/grill-with-docs`.

## Flag ADR conflicts

Explicitly identify any proposal that contradicts an existing ADR
and explain why the decision merits reconsideration.
