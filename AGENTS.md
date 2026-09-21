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
