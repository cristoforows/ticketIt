#!/usr/bin/env bash
# Drift check 2 of 2 (see contracts/README.md): regenerate api.gen.go
# and fail on any diff, which means the contract changed without
# regenerating or the generated file was hand-edited. Needs a clean
# working tree for that file, else unrelated edits look like drift.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! git diff --quiet -- internal/httpapi/api.gen.go; then
  echo "error: internal/httpapi/api.gen.go already has uncommitted changes; commit or stash them before running the drift check." >&2
  exit 2
fi

go generate ./...

if git diff --exit-code -- internal/httpapi/api.gen.go; then
  echo "OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift)."
else
  echo >&2
  echo "DRIFT DETECTED: regenerating internal/httpapi/api.gen.go from contracts/openapi.yaml produced the diff above." >&2
  echo "Either the contract changed without regenerating, or the generated file was hand-edited. Run 'go generate ./...' and commit the result, or investigate the diff." >&2
  exit 1
fi
