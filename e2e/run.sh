#!/usr/bin/env bash
# The one documented command for issue #53: migrates a dedicated database,
# starts a real Galley, builds and serves a real Swiftlet, runs the
# browser suite (including the failure-mode spec) against them, and tears
# everything down -- regardless of a developer's own already-running
# servers. See e2e/README.md for the full explanation of every step and
# every environment variable below.
#
# Usage:
#   ./run.sh
#   E2E_DATABASE_URL=postgres://localhost:5432/some_other_db?sslmode=disable ./run.sh
#
# Exit code is non-zero if either phase of the suite fails.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GALLEY_DIR="$REPO_ROOT/apps/galley"
SWIFTLET_DIR="$REPO_ROOT/apps/swiftlet"
ARTIFACTS_DIR="$SCRIPT_DIR/.artifacts"

# --- Configuration (all overridable; see README.md, "Environment variables") ---
E2E_DATABASE_URL="${E2E_DATABASE_URL:-postgres://localhost:5432/ticketit_e2e?sslmode=disable}"
GALLEY_HOST_BIND="${E2E_GALLEY_HOST:-127.0.0.1}"

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()});'
}

GALLEY_PORT="${E2E_GALLEY_PORT:-$(free_port)}"
SWIFTLET_PORT="${E2E_SWIFTLET_PORT:-$(free_port)}"

GALLEY_BASE_URL="http://${GALLEY_HOST_BIND}:${GALLEY_PORT}"
SWIFTLET_BASE_URL="http://127.0.0.1:${SWIFTLET_PORT}"

mkdir -p "$ARTIFACTS_DIR"
GALLEY_LOG="$ARTIFACTS_DIR/galley.log"
SWIFTLET_LOG="$ARTIFACTS_DIR/swiftlet.log"
: > "$GALLEY_LOG"
: > "$SWIFTLET_LOG"

GALLEY_PID=""
SWIFTLET_PID=""

log() { echo "[run.sh] $*"; }

cleanup() {
  local exit_code=$?
  if [ -n "$SWIFTLET_PID" ] && kill -0 "$SWIFTLET_PID" 2>/dev/null; then
    log "stopping swiftlet preview server (pid $SWIFTLET_PID)"
    kill "$SWIFTLET_PID" 2>/dev/null || true
    wait "$SWIFTLET_PID" 2>/dev/null || true
  fi
  if [ -n "$GALLEY_PID" ] && kill -0 "$GALLEY_PID" 2>/dev/null; then
    log "stopping galley (pid $GALLEY_PID)"
    kill "$GALLEY_PID" 2>/dev/null || true
    wait "$GALLEY_PID" 2>/dev/null || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

wait_for_http() {
  local url="$1" timeout="${2:-30}" start
  start=$(date +%s)
  until curl -sf -o /dev/null "$url"; do
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      log "timed out after ${timeout}s waiting for $url"
      return 1
    fi
    sleep 0.3
  done
}

# --- 1. Reset the dedicated e2e database to a known, empty state ---
# A database name/user this connects to must already exist as a role the
# current user can connect with; the schema itself is reset every run so
# each run starts from a known state (README.md, "Determinism and state
# reset") -- this suite never reuses ticketit_dev or ticketit_test (#52)
# and must never touch ticketit_m1_native.
DB_NAME=$(node -e 'const u=new URL(process.argv[1]); console.log(u.pathname.replace(/^\//, ""));' "$E2E_DATABASE_URL")
if [ "$DB_NAME" = "ticketit_dev" ] || [ "$DB_NAME" = "ticketit_test" ] || [ "$DB_NAME" = "ticketit_m1_native" ]; then
  log "refusing to run against '$DB_NAME' -- E2E_DATABASE_URL must name a database dedicated to this suite (default: ticketit_e2e)"
  exit 1
fi

log "ensuring database '$DB_NAME' exists"
createdb "$DB_NAME" 2>/dev/null || true
log "resetting '$DB_NAME' schema to a known empty state"
psql "$E2E_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null

# --- 2. Migrate ---
log "applying migrations to '$DB_NAME'"
(cd "$GALLEY_DIR" && DATABASE_URL="$E2E_DATABASE_URL" go run ./cmd/migrate)

# --- 3. Build and start Galley ---
GALLEY_BIN="$ARTIFACTS_DIR/galley-e2e-bin"
log "building galley"
(cd "$GALLEY_DIR" && go build -o "$GALLEY_BIN" ./cmd/galley)

log "starting galley on $GALLEY_BASE_URL"
DATABASE_URL="$E2E_DATABASE_URL" GALLEY_HOST="$GALLEY_HOST_BIND" GALLEY_PORT="$GALLEY_PORT" \
  "$GALLEY_BIN" >>"$GALLEY_LOG" 2>&1 &
GALLEY_PID=$!

wait_for_http "$GALLEY_BASE_URL/api/status" 30 \
  || { log "galley did not become ready -- see $GALLEY_LOG"; exit 1; }
log "galley ready (pid $GALLEY_PID)"

# --- 4. Build and serve Swiftlet (production build, not the dev server) ---
if [ ! -d "$SWIFTLET_DIR/node_modules" ]; then
  log "installing swiftlet dependencies (npm ci)"
  (cd "$SWIFTLET_DIR" && npm ci)
fi
log "building swiftlet"
(cd "$SWIFTLET_DIR" && npm run build)

log "serving swiftlet's build on $SWIFTLET_BASE_URL, proxying /api to $GALLEY_BASE_URL"
# `exec env ... vite` (rather than `npx vite`) so the backgrounded
# subshell's PID *is* vite's real PID -- npx interposes a wrapper process
# that would otherwise survive `kill "$SWIFTLET_PID"` in cleanup/teardown.
(cd "$SWIFTLET_DIR" && exec env GALLEY_PROXY_TARGET="$GALLEY_BASE_URL" \
  node_modules/.bin/vite preview --host 127.0.0.1 --port "$SWIFTLET_PORT" --strictPort) >>"$SWIFTLET_LOG" 2>&1 &
SWIFTLET_PID=$!

wait_for_http "$SWIFTLET_BASE_URL/" 30 \
  || { log "swiftlet did not become ready -- see $SWIFTLET_LOG"; exit 1; }
log "swiftlet ready (pid $SWIFTLET_PID)"

# --- 5. Install the suite's own dependencies and Chromium ---
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  log "installing e2e suite dependencies (npm ci)"
  (cd "$SCRIPT_DIR" && npm ci)
fi
log "ensuring Chromium's headless shell is installed for Playwright (firefox/webkit are never installed; --only-shell skips the ~360MB full Chrome-for-Testing build this suite's headless-only tests never launch -- see README.md, \"Tool choice and disk footprint\")"
(cd "$SCRIPT_DIR" && npx playwright install --only-shell chromium)

# --- 6. Run the happy-path spec against a real, running Galley ---
STATUS_EXIT=0
log "running tests/status.spec.ts against a live galley"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  npx playwright test tests/status.spec.ts) || STATUS_EXIT=$?

# --- 7. Stop Galley, then run the failure-mode spec ---
log "stopping galley to exercise the failure-mode spec (pid $GALLEY_PID)"
kill "$GALLEY_PID" 2>/dev/null || true
wait "$GALLEY_PID" 2>/dev/null || true
GALLEY_PID=""

FAILURE_EXIT=0
log "running tests/backend-failure.spec.ts against a stopped galley"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" \
  npx playwright test tests/backend-failure.spec.ts) || FAILURE_EXIT=$?

log "status.spec.ts exit code: $STATUS_EXIT"
log "backend-failure.spec.ts exit code: $FAILURE_EXIT"

if [ "$STATUS_EXIT" -ne 0 ] || [ "$FAILURE_EXIT" -ne 0 ]; then
  log "SUITE FAILED"
  exit 1
fi

log "SUITE PASSED"
exit 0
