#!/usr/bin/env bash
# Drift check 2 of 2 (see README.md): regenerate Swiftlet's schema.d.ts
# and fail on any diff, which means the contract changed without
# regenerating or the generated file was hand-edited. Run after
# `npm ci`. Needs a clean working tree for that file, else unrelated
# edits look like drift.
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
