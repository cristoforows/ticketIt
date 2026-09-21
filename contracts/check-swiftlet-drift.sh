#!/usr/bin/env bash
# Drift check (part 2 of 2 — see README.md): regenerates
# apps/swiftlet/src/api/generated/schema.d.ts from openapi.yaml and
# fails if that produces any diff against the committed file. A diff
# here means either the contract changed without regenerating, or the
# generated file was hand-edited — both are drift between the
# contract and what Swiftlet actually builds against.
#
# Run from contracts/ (after `npm ci`). Requires a clean git working
# tree for the generated file (uncommitted, unrelated changes to it
# would otherwise be indistinguishable from generator drift).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

TARGET=../apps/swiftlet/src/api/generated/schema.d.ts

if ! git diff --quiet -- "$TARGET"; then
  echo "error: $TARGET already has uncommitted changes; commit or stash them before running the drift check." >&2
  exit 2
fi

npm run generate:swiftlet

if git diff --exit-code -- "$TARGET"; then
  echo "OK: $TARGET matches openapi.yaml (no drift)."
else
  echo >&2
  echo "DRIFT DETECTED: regenerating $TARGET from openapi.yaml produced the diff above." >&2
  echo "Either the contract changed without regenerating, or the generated file was hand-edited. Run 'npm run generate:swiftlet' and commit the result, or investigate the diff." >&2
  exit 1
fi
