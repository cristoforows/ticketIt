#!/usr/bin/env bash
# The one documented command for issue #53 (extended by #55 with the
# authenticated-browser phases, by #56 with the Ticket-capture and
# persistence phases, by #57 with the Ticket detail page phase, and by
# #58 with the manual refinement phases, below): migrates a dedicated
# database, starts a real Galley, a real substitute GitHub OAuth
# provider, builds and serves a real Swiftlet, runs the browser suite
# (including the failure-mode, authenticated-session, and Ticket specs)
# against them, and tears everything down -- regardless of a
# developer's own already-running servers. See e2e/README.md for the
# full explanation of every step and every environment variable below.
#
# Usage:
#   ./run.sh
#   E2E_DATABASE_URL=postgres://localhost:5432/some_other_db?sslmode=disable ./run.sh
#
# Exit code is non-zero if any phase of the suite fails.
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
GITHUBFAKE_LOG="$ARTIFACTS_DIR/githubfake.log"
GITHUBFAKE_ADDR_FILE="$ARTIFACTS_DIR/githubfake.env"
STORAGE_STATE_PATH="$ARTIFACTS_DIR/auth-storage-state.json"
: > "$GALLEY_LOG"
: > "$SWIFTLET_LOG"
: > "$GITHUBFAKE_LOG"
rm -f "$GITHUBFAKE_ADDR_FILE" "$STORAGE_STATE_PATH"

GALLEY_PID=""
SWIFTLET_PID=""
GITHUBFAKE_PID=""

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
  if [ -n "$GITHUBFAKE_PID" ] && kill -0 "$GITHUBFAKE_PID" 2>/dev/null; then
    log "stopping the substitute GitHub provider (pid $GITHUBFAKE_PID)"
    kill "$GITHUBFAKE_PID" 2>/dev/null || true
    wait "$GITHUBFAKE_PID" 2>/dev/null || true
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

# Same shape as wait_for_http, for a process (the substitute GitHub
# provider) whose address isn't known until it has already started --
# see "githubfake" phase below.
wait_for_file() {
  local path="$1" timeout="${2:-30}" start
  start=$(date +%s)
  until [ -s "$path" ]; do
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      log "timed out after ${timeout}s waiting for $path to appear"
      return 1
    fi
    sleep 0.3
  done
}

# start_galley (used both for the initial start and the restart phase
# below) launches the real galley binary against this run's database,
# with GALLEY_BASE_URL pointed at *Swiftlet's* origin -- see "OAuth
# provider and owner configuration" below for why.
start_galley() {
  log "starting galley (browser-facing origin $SWIFTLET_BASE_URL, bound to $GALLEY_BASE_URL)"
  DATABASE_URL="$E2E_DATABASE_URL" GALLEY_HOST="$GALLEY_HOST_BIND" GALLEY_PORT="$GALLEY_PORT" \
    GALLEY_BASE_URL="$SWIFTLET_BASE_URL" \
    GALLEY_OWNER_GITHUB_LOGIN="$GITHUBFAKE_OWNER_LOGIN" \
    GALLEY_OAUTH_GITHUB_CLIENT_ID="$GITHUBFAKE_CLIENT_ID" \
    GALLEY_OAUTH_GITHUB_CLIENT_SECRET="$GITHUBFAKE_CLIENT_SECRET" \
    GALLEY_OAUTH_GITHUB_BASE_URL="$GITHUBFAKE_URL" \
    GALLEY_OAUTH_GITHUB_API_BASE_URL="$GITHUBFAKE_URL" \
    "$GALLEY_BIN" >>"$GALLEY_LOG" 2>&1 &
  GALLEY_PID=$!

  wait_for_http "$GALLEY_BASE_URL/api/status" 30 \
    || { log "galley did not become ready -- see $GALLEY_LOG"; exit 1; }
  log "galley ready (pid $GALLEY_PID)"
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

# --- 3. Build Galley and the substitute GitHub OAuth/identity provider ---
GALLEY_BIN="$ARTIFACTS_DIR/galley-e2e-bin"
log "building galley"
(cd "$GALLEY_DIR" && go build -o "$GALLEY_BIN" ./cmd/galley)

GITHUBFAKE_BIN="$ARTIFACTS_DIR/githubfake-e2e-bin"
log "building the substitute GitHub OAuth/identity provider (test/development-only -- apps/galley/cmd/githubfake; never real github.com)"
(cd "$GALLEY_DIR" && go build -o "$GITHUBFAKE_BIN" ./cmd/githubfake)

# --- 4. Start the substitute GitHub provider ---
# A real, running process a browser can navigate to -- internal/githubfake's
# testing.TB-based constructor only works inside a Go test binary (see
# apps/galley/cmd/githubfake's own doc comment). Its port is OS-assigned,
# so it reports its own address (and its fixed, non-secret fake
# credentials, and the fake owner's login) via GITHUBFAKE_ADDR_FILE
# rather than this script choosing a port up front.
log "starting the substitute GitHub OAuth/identity provider"
GITHUBFAKE_ADDR_FILE="$GITHUBFAKE_ADDR_FILE" "$GITHUBFAKE_BIN" >>"$GITHUBFAKE_LOG" 2>&1 &
GITHUBFAKE_PID=$!

wait_for_file "$GITHUBFAKE_ADDR_FILE" 30 \
  || { log "substitute GitHub provider did not become ready -- see $GITHUBFAKE_LOG"; exit 1; }
# shellcheck disable=SC1090
source "$GITHUBFAKE_ADDR_FILE"
log "substitute GitHub provider ready at $GITHUBFAKE_URL (pid $GITHUBFAKE_PID, owner login $GITHUBFAKE_OWNER_LOGIN)"

# --- 5. Start Galley ---
# OAuth provider and owner configuration: GALLEY_OAUTH_GITHUB_BASE_URL/
# _API_BASE_URL point at the substitute provider above, never
# github.com (issue #53's own rule); GALLEY_OWNER_GITHUB_LOGIN is the
# substitute's fake owner login, so a fresh sign-in against this run's
# empty database bootstraps that identity as the Owner.
#
# GALLEY_BASE_URL is deliberately Swiftlet's own origin, not Galley's --
# the browser only ever reaches Galley through Swiftlet's proxy
# (apps/galley/README.md, "CORS"), so Swiftlet's origin is "the
# externally-visible origin the browser is on when it reaches Galley"
# (apps/galley/internal/config's own doc for this setting). This is what
# makes the OAuth callback's redirect back to "/" land on Swiftlet's
# signed-in shell instead of on Galley's own bare API root.
start_galley

# --- 6. Build and serve Swiftlet (production build, not the dev server) ---
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

# --- 7. Install the suite's own dependencies and Chromium ---
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  log "installing e2e suite dependencies (npm ci)"
  (cd "$SCRIPT_DIR" && npm ci)
fi
log "ensuring Chromium's headless shell is installed for Playwright (firefox/webkit are never installed; --only-shell skips the ~360MB full Chrome-for-Testing build this suite's headless-only tests never launch -- see README.md, \"Tool choice and disk footprint\")"
(cd "$SCRIPT_DIR" && npx playwright install --only-shell chromium)

# --- 8. Run the happy-path spec against a real, running Galley ---
# Signs in first (via e2e/support/sign-in.ts): since issue #55,
# StatusView only renders inside the authenticated shell.
STATUS_EXIT=0
log "running tests/status.spec.ts against a live galley"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  E2E_GITHUBFAKE_BASE_URL="$GITHUBFAKE_URL" \
  npx playwright test tests/status.spec.ts) || STATUS_EXIT=$?

# --- 9. Run the authenticated-session specs (sign-in, rejection, sign-out, reload) ---
AUTH_EXIT=0
log "running tests/auth.spec.ts against a live galley and the substitute GitHub provider"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  E2E_GITHUBFAKE_BASE_URL="$GITHUBFAKE_URL" \
  npx playwright test tests/auth.spec.ts) || AUTH_EXIT=$?

# --- 10. Sign in, save browser storage state, then restart Galley ---
# The session must be shown to survive a genuine process restart, not
# just a page reload -- README.md, "Adding a spec": the spec cannot
# restart a process it did not start, so run.sh owns the restart itself,
# split across two `playwright test` invocations with the signed-in
# browser's cookies carried across them via Playwright's storage state.
RESTART_BEFORE_EXIT=0
log "running tests/session-restart-before.spec.ts (signs in, saves storage state)"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  E2E_GITHUBFAKE_BASE_URL="$GITHUBFAKE_URL" E2E_STORAGE_STATE_PATH="$STORAGE_STATE_PATH" \
  npx playwright test tests/session-restart-before.spec.ts) || RESTART_BEFORE_EXIT=$?

# tests/ticket-refinement-before.spec.ts (issue #58) shares the same
# storage state and restart, for the same reason ticket-persistence's
# pair does: refinement fields' persistence across a genuine backend
# restart is an acceptance criterion of its own, not just persistence
# across reload. Runs *before* ticket-persistence-before.spec.ts
# specifically so its own Ticket's created_at sorts older than
# ticket-persistence's two -- ticket-persistence-after.spec.ts asserts
# the exact identity of the newest two list entries, and ordering is by
# created_at (apps/galley/README.md, "Ticket ordering"), not
# updated_at, so this spec's own title *edit* (which only bumps
# updated_at) does not disturb that assertion regardless of run order,
# but the initial capture's created_at would if it ran after.
REFINEMENT_BEFORE_EXIT=0
log "running tests/ticket-refinement-before.spec.ts (edits title and manual refinement fields)"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  E2E_STORAGE_STATE_PATH="$STORAGE_STATE_PATH" \
  npx playwright test tests/ticket-refinement-before.spec.ts) || REFINEMENT_BEFORE_EXIT=$?

# tests/ticket-persistence-before.spec.ts (issue #56) shares the same
# storage state and the same restart below rather than requesting a
# second one -- README.md, "Adding a spec".
TICKET_BEFORE_EXIT=0
log "running tests/ticket-persistence-before.spec.ts (captures two Tickets, newest first)"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  E2E_STORAGE_STATE_PATH="$STORAGE_STATE_PATH" \
  npx playwright test tests/ticket-persistence-before.spec.ts) || TICKET_BEFORE_EXIT=$?

log "restarting galley (same database, same origin, new process) to prove the session and Tickets survive"
kill "$GALLEY_PID" 2>/dev/null || true
wait "$GALLEY_PID" 2>/dev/null || true
GALLEY_PID=""
start_galley

RESTART_AFTER_EXIT=0
log "running tests/session-restart-after.spec.ts against the restarted galley"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  E2E_STORAGE_STATE_PATH="$STORAGE_STATE_PATH" \
  npx playwright test tests/session-restart-after.spec.ts) || RESTART_AFTER_EXIT=$?

TICKET_AFTER_EXIT=0
log "running tests/ticket-persistence-after.spec.ts against the restarted galley"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  E2E_STORAGE_STATE_PATH="$STORAGE_STATE_PATH" \
  npx playwright test tests/ticket-persistence-after.spec.ts) || TICKET_AFTER_EXIT=$?

REFINEMENT_AFTER_EXIT=0
log "running tests/ticket-refinement-after.spec.ts against the restarted galley"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  E2E_STORAGE_STATE_PATH="$STORAGE_STATE_PATH" \
  npx playwright test tests/ticket-refinement-after.spec.ts) || REFINEMENT_AFTER_EXIT=$?

# --- 10b. Run the Ticket detail and manual refinement specs (issues #57, #58) ---
# Signs in fresh, like status.spec.ts/auth.spec.ts, rather than reusing
# the restart phase's storage state: no restart is needed here, so
# there is nothing to share it with.
TICKET_DETAIL_EXIT=0
log "running tests/ticket-detail.spec.ts against the restarted galley"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  E2E_GITHUBFAKE_BASE_URL="$GITHUBFAKE_URL" \
  npx playwright test tests/ticket-detail.spec.ts) || TICKET_DETAIL_EXIT=$?

# tests/ticket-refinement.spec.ts (issue #58) signs in fresh, like
# ticket-detail.spec.ts above -- reload, cancel, and validation don't
# need a restart of their own; ticket-refinement-before/after.spec.ts
# above already cover restart persistence.
REFINEMENT_EXIT=0
log "running tests/ticket-refinement.spec.ts against the restarted galley"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" GALLEY_BASE_URL="$GALLEY_BASE_URL" \
  E2E_GITHUBFAKE_BASE_URL="$GITHUBFAKE_URL" \
  npx playwright test tests/ticket-refinement.spec.ts) || REFINEMENT_EXIT=$?

# --- 11. Stop Galley for good, then run the failure-mode spec ---
log "stopping galley to exercise the failure-mode spec (pid $GALLEY_PID)"
kill "$GALLEY_PID" 2>/dev/null || true
wait "$GALLEY_PID" 2>/dev/null || true
GALLEY_PID=""

FAILURE_EXIT=0
log "running tests/backend-failure.spec.ts against a stopped galley"
(cd "$SCRIPT_DIR" && E2E_BASE_URL="$SWIFTLET_BASE_URL" \
  npx playwright test tests/backend-failure.spec.ts) || FAILURE_EXIT=$?

log "status.spec.ts exit code: $STATUS_EXIT"
log "auth.spec.ts exit code: $AUTH_EXIT"
log "session-restart-before.spec.ts exit code: $RESTART_BEFORE_EXIT"
log "ticket-persistence-before.spec.ts exit code: $TICKET_BEFORE_EXIT"
log "ticket-refinement-before.spec.ts exit code: $REFINEMENT_BEFORE_EXIT"
log "session-restart-after.spec.ts exit code: $RESTART_AFTER_EXIT"
log "ticket-persistence-after.spec.ts exit code: $TICKET_AFTER_EXIT"
log "ticket-refinement-after.spec.ts exit code: $REFINEMENT_AFTER_EXIT"
log "ticket-detail.spec.ts exit code: $TICKET_DETAIL_EXIT"
log "ticket-refinement.spec.ts exit code: $REFINEMENT_EXIT"
log "backend-failure.spec.ts exit code: $FAILURE_EXIT"

if [ "$STATUS_EXIT" -ne 0 ] || [ "$AUTH_EXIT" -ne 0 ] || [ "$RESTART_BEFORE_EXIT" -ne 0 ] \
  || [ "$TICKET_BEFORE_EXIT" -ne 0 ] || [ "$REFINEMENT_BEFORE_EXIT" -ne 0 ] || [ "$RESTART_AFTER_EXIT" -ne 0 ] \
  || [ "$TICKET_AFTER_EXIT" -ne 0 ] || [ "$REFINEMENT_AFTER_EXIT" -ne 0 ] || [ "$TICKET_DETAIL_EXIT" -ne 0 ] \
  || [ "$REFINEMENT_EXIT" -ne 0 ] || [ "$FAILURE_EXIT" -ne 0 ]; then
  log "SUITE FAILED"
  exit 1
fi

log "SUITE PASSED"
exit 0
