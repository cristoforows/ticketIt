#!/usr/bin/env bash
# Idempotent local database setup for the native-harness tracer (M1.11,
# issue #22). Creates the dedicated database (default
# `ticketit_m1_native`, overridable via NATIVE_HARNESS_DATABASE_URL) and
# runs the LangGraph PostgreSQL checkpointer's setup() plus the Round
# registry's setup(), so a fresh clone can run `npm run db:setup && npm
# test`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DATABASE_URL="${NATIVE_HARNESS_DATABASE_URL:-postgresql://localhost:5432/ticketit_m1_native}"

# Extract the database name (last path segment) from the connection string.
DB_NAME="${DATABASE_URL##*/}"
DB_NAME="${DB_NAME%%\?*}"

echo "native-harness: ensuring database '${DB_NAME}' exists..."
if createdb "${DB_NAME}" 2>/tmp/native-harness-createdb.err; then
  echo "native-harness: created database '${DB_NAME}'."
else
  if grep -qi "already exists" /tmp/native-harness-createdb.err; then
    echo "native-harness: database '${DB_NAME}' already exists, continuing."
  else
    echo "native-harness: createdb failed:" >&2
    cat /tmp/native-harness-createdb.err >&2
    rm -f /tmp/native-harness-createdb.err
    exit 1
  fi
fi
rm -f /tmp/native-harness-createdb.err

echo "native-harness: running checkpointer + Round registry setup()..."
NATIVE_HARNESS_DATABASE_URL="${DATABASE_URL}" node --import tsx scripts/db-setup.ts

echo "native-harness: database setup complete (${DATABASE_URL})."
