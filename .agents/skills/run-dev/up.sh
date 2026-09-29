#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
GALLEY_DIR="$REPO_ROOT/apps/galley"
SWIFTLET_DIR="$REPO_ROOT/apps/swiftlet"
STATE_DIR="${TICKETIT_DEV_STATE_DIR:-${TMPDIR:-/tmp}/ticketit-dev}"
DATABASE_URL="${TICKETIT_DEV_DATABASE_URL:-postgres://localhost:5432/ticketit_dev?sslmode=disable}"
GALLEY_PORT=8080
SWIFTLET_PORT=5173

log() { echo "[run-dev] $*"; }

"$(dirname "${BASH_SOURCE[0]}")/down.sh" >/dev/null
mkdir -p "$STATE_DIR"

for port in "$GALLEY_PORT" "$SWIFTLET_PORT"; do
  if lsof -iTCP:"$port" -sTCP:LISTEN -nP >/dev/null 2>&1; then
    log "port $port is already in use:"; lsof -iTCP:"$port" -sTCP:LISTEN -nP; exit 1
  fi
done

pg_isready -q || { log "PostgreSQL is not accepting connections (brew services start postgresql@17)"; exit 1; }
DB_NAME=$(node -e 'console.log(new URL(process.argv[1]).pathname.slice(1))' "$DATABASE_URL")
createdb "$DB_NAME" 2>/dev/null || true

log "migrating $DB_NAME"
(cd "$GALLEY_DIR" && DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate)

log "building galley and githubfake"
(cd "$GALLEY_DIR" && go build -o "$STATE_DIR/galley" ./cmd/galley && go build -o "$STATE_DIR/githubfake" ./cmd/githubfake)

if ! cmp -s "$SWIFTLET_DIR/package-lock.json" "$STATE_DIR/swiftlet-package-lock.json" \
  || [ ! -d "$SWIFTLET_DIR/node_modules" ]; then
  log "installing swiftlet dependencies (npm ci)"
  (cd "$SWIFTLET_DIR" && npm ci --silent)
  cp "$SWIFTLET_DIR/package-lock.json" "$STATE_DIR/swiftlet-package-lock.json"
fi

# Substitute provider, not github.com: no real OAuth app exists (AGENTS.md, "Paid resources").
rm -f "$STATE_DIR/githubfake.env"
GITHUBFAKE_ADDR_FILE="$STATE_DIR/githubfake.env" nohup "$STATE_DIR/githubfake" >"$STATE_DIR/githubfake.log" 2>&1 &
echo $! >"$STATE_DIR/githubfake.pid"
for _ in $(seq 1 100); do [ -s "$STATE_DIR/githubfake.env" ] && break; sleep 0.3; done
# shellcheck disable=SC1091
source "$STATE_DIR/githubfake.env"

# GALLEY_BASE_URL is Swiftlet's origin so the OAuth callback lands on the signed-in shell (apps/swiftlet/README.md).
DATABASE_URL="$DATABASE_URL" GALLEY_PORT="$GALLEY_PORT" \
  GALLEY_BASE_URL="http://localhost:$SWIFTLET_PORT" \
  GALLEY_OWNER_GITHUB_LOGIN="$GITHUBFAKE_OWNER_LOGIN" \
  GALLEY_OAUTH_GITHUB_CLIENT_ID="$GITHUBFAKE_CLIENT_ID" \
  GALLEY_OAUTH_GITHUB_CLIENT_SECRET="$GITHUBFAKE_CLIENT_SECRET" \
  GALLEY_OAUTH_GITHUB_BASE_URL="$GITHUBFAKE_URL" \
  GALLEY_OAUTH_GITHUB_API_BASE_URL="$GITHUBFAKE_URL" \
  nohup "$STATE_DIR/galley" >"$STATE_DIR/galley.log" 2>&1 &
echo $! >"$STATE_DIR/galley.pid"

(cd "$SWIFTLET_DIR" && exec nohup env GALLEY_PROXY_TARGET="http://localhost:$GALLEY_PORT" \
  node_modules/.bin/vite --port "$SWIFTLET_PORT" --strictPort) >"$STATE_DIR/swiftlet.log" 2>&1 &
echo $! >"$STATE_DIR/swiftlet.pid"

wait_for() {
  for _ in $(seq 1 100); do curl -sf -o /dev/null "$1" && return 0; sleep 0.3; done
  log "$1 did not come up -- see $STATE_DIR/$2.log"; exit 1
}
wait_for "http://localhost:$GALLEY_PORT/api/status" galley
wait_for "http://localhost:$SWIFTLET_PORT/" swiftlet

JAR="$STATE_DIR/smoke.cookies"; rm -f "$JAR"
curl -sf -c "$JAR" -b "$JAR" -L -o /dev/null "http://localhost:$SWIFTLET_PORT/api/auth/github/start"
SESSION=$(curl -sf -b "$JAR" "http://localhost:$SWIFTLET_PORT/api/session") \
  || { log "sign-in smoke test failed -- see $STATE_DIR/galley.log"; exit 1; }

log "commit     $(git -C "$REPO_ROOT" log -1 --format='%h %s')"
log "swiftlet   http://localhost:$SWIFTLET_PORT"
log "galley     http://localhost:$GALLEY_PORT (database $DB_NAME)"
log "githubfake $GITHUBFAKE_URL (sign in as $GITHUBFAKE_OWNER_LOGIN)"
log "session    $SESSION"
log "logs       $STATE_DIR/{galley,swiftlet,githubfake}.log"
