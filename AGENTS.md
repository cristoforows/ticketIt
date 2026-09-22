# Agent instructions

## Shared agent configuration

- Keep shared instructions in `AGENTS.md`.
- Keep `CLAUDE.md` as a relative symlink to `AGENTS.md`.
- When either `.agents/` or `.claude/` is first needed, create
  `.agents/` as the canonical directory and `.claude` as a relative
  symlink to `.agents`.
- If either path already exists, inspect its contents and preserve
  existing work before reconciling the layout.

## Paid resources

Never provision a paid resource or create a provider account. This
includes free tiers requiring payment details. Report the blocked task
and name the resource instead. Only the Owner approves, per named
resource, immediately beforehand. See `docs/deployment.md`,
"Provisioning requires explicit Owner approval."

## Comments

Default to no comment. Write one only for what the code cannot
state — a domain rule, an external constraint, or why a non-obvious
choice was made — and only where a reader would otherwise get it
wrong.

Never explain functionality. Signatures, types, control flow, what a
function does, what a test asserts — all of it is in the code already.
Name the function or test and stop; if the name cannot carry it, fix
the name.

Keep what survives dense:

- One fact, stated once. Never restate it in other words, or
  reinforce it with "never", "always", or "exactly".
- One citation, as a bare pointer. Never summarise what the issue,
  ADR, or doc already says.
- No preamble, no scene-setting, no recap of the slice.

Length is not capped — it follows from the non-inferable content and
stops there. Reasoning that outgrows that belongs in an ADR or the
evidence record.

The same limits apply to `description:` in `contracts/openapi.yaml`,
which becomes the comments in `api.gen.go`.

## Pull requests

Title a milestone-slice PR with its issue's `Mx.y` prefix, matching the
issue title: `M2.7 — Swiftlet sign-in, authenticated shell, and sign-out`.
A single-commit PR squashes under the commit subject rather than the PR
title, so give that commit the same prefix — otherwise the milestone is
missing from `git log`.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub repository `cristoforows/ticketIt`.
Use the `cristoforows` account. See `docs/agents/issue-tracker.md`.
For local `gh` commands, use `GH_CONFIG_DIR="$HOME/.config/gh-cristoforows"`.

### Classification labels

Use the five default classification labels.
See `docs/agents/classify-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` and `docs/adr/`.
See `docs/agents/domain.md`.
