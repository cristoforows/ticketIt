#!/usr/bin/env bash
set -uo pipefail

STATE_DIR="${TICKETIT_DEV_STATE_DIR:-${TMPDIR:-/tmp}/ticketit-dev}"

for name in swiftlet galley githubfake; do
  pidfile="$STATE_DIR/$name.pid"
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" && echo "[run-dev] stopped $name (pid $pid)"
  fi
  rm -f "$pidfile"
done
