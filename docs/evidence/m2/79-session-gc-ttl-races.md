# Garbage-collect expired sessions and OAuth state; configurable session TTL; deterministic concurrency races

## Purpose

Fixes three `apps/galley` gaps recorded as implementation limitations
by [#54](54-oauth-session.md) and [#52](52-postgresql-persistence.md):
expired `sessions`/`oauth_states` rows were never deleted, the session
TTL was a fixed Go constant, and neither the concurrent-migration lock
nor the concurrent-Owner-bootstrap retry had a dedicated, deterministic
test. Tracking issue:
[#79](https://github.com/cristoforows/ticketIt/issues/79). Not a
milestone slice -- a follow-up routed from the M2 gate report
([#62](https://github.com/cristoforows/ticketIt/issues/62)).

## What already existed

- `internal/auth.SessionTTL` (`30 * 24 * time.Hour`), used only by
  `CreateSession`. `CreateSessionWithExpiry` already took an explicit
  expiry. The session cookie's `Expires` was already the persisted
  `expires_at` returned by `CreateSession` (`internal/httpapi/cookies.go`,
  `newSessionCookie`), so cookie and row lifetimes could not diverge.
- Every lookup already filtered on `expires_at > now()`; rows were
  deleted only by sign-out (`DeleteSession`) and state consumption
  (`ConsumeState`).
- `postgres.ApplyMigrations` relies on golang-migrate's pgx/v5 driver
  taking `pg_advisory_lock` in both `ensureVersionTable` and `Up`.
- `resolveOwner` retried once on a unique violation from
  `bootstrapOwner` (`owners_singleton_uq`). It was reached only when
  concurrent test packages happened to race on the shared
  `ticketit_test` database.
- All database tests used the shared, never-reset `ticketit_test`, which
  already holds an Owner, so an empty `owners` table or an unmigrated
  database was unavailable to any test.

## What this slice added

### Decision -- opportunistic GC, no background job

`CreateState` deletes every `oauth_states` row with `expires_at <= now()`
before inserting; `CreateSession` does the same for `sessions`. A
scheduler goroutine would add lifecycle, shutdown, and test surface for
tables that grow by one row per sign-in on a single-owner deployment.
Row growth is therefore bounded by the sign-ins within one TTL window.
No index on `expires_at`: at that size a sequential scan is cheaper than
maintaining one. A GC failure fails the sign-in step with the existing
`database_unavailable` response, since it hits the same database as the
insert that follows.

`CreateSessionWithExpiry` does not GC, so tests can still create an
expired row that survives until the next `CreateSession`.

### Decision -- TTL lives in config, passed as a parameter

`GALLEY_SESSION_TTL` (`time.ParseDuration`, must be `> 0`, default
`720h` = `config.DefaultSessionTTL`) becomes `config.Config.SessionTTL`.
`auth.CreateSession` now takes `ttl time.Duration`, and
`CompleteGithubOAuth` passes `s.cfg.SessionTTL`. `auth.SessionTTL` is
removed, so `internal/auth` stays independent of `internal/config`.
Validation runs after every existing setting, so the error order for
existing misconfigurations does not change.

### Decision -- deterministic races

- **Migrations** (`TestApplyMigrations_ConcurrentRunsAgainstEmptyDatabase`):
  for each of three fresh databases, the test holds golang-migrate's own
  advisory lock from a third connection. It releases two goroutines
  through a closed channel, polls `pg_locks` until exactly two
  ungranted advisory locks are waiting in that database, and then
  unlocks. Both runs are therefore always in flight together. The lock
  id comes from `database.GenerateAdvisoryLockId(u.Path, "public",
  "schema_migrations")`, the same inputs as the driver's `Open`. A wrong
  id would never produce two waiters, so the test would fail on its
  30-second context rather than pass without contention. Asserts: both
  calls return `nil`, the version equals the latest embedded migration,
  `dirty = false`, one clean `schema_migrations` row, and every domain
  table exists.
- **Owner bootstrap** (`TestResolveOwner_ConcurrentBootstrapRace`, in
  package `auth`): one unexported hook, `afterEmptyOwnerLookup func()`,
  runs in `resolveOwner` after the empty `owner_identities` lookup and
  login check, just before `bootstrapOwner`. It is `nil` in production.
  The test's hook blocks each goroutine until both have arrived, so both
  must reach `bootstrapOwner` and one must take the unique-violation
  retry. Asserts: both succeed with the same owner id, exactly one
  reports `bootstrapped`, and there is one `owners` row and one
  `owner_identities` row.

Both race tests need an empty database, so they use new
`internal/postgres` helpers. `NewEmptyTestDatabase(t)` runs
`CREATE DATABASE ticketit_test_<16 hex>` on `TestingURL()`'s server and
drops it `WITH (FORCE)` in cleanup. `NewEmptyMigratedTestPool(t)` builds
on that helper and applies migrations. The GC tests use the migrated
helper too, so their row assertions are unaffected by other packages
that share `ticketit_test`.

### Galley (`apps/galley`)

- `internal/config/config.go`: `DefaultSessionTTL`, `Config.SessionTTL`,
  `GALLEY_SESSION_TTL` parsing/validation.
- `internal/auth/auth.go`: removed `SessionTTL` and its stale "not
  configurable" comment.
- `internal/auth/session.go`: `CreateSession(..., ttl)`,
  `deleteExpiredSessions`.
- `internal/auth/state.go`: `deleteExpiredStates`, called from
  `CreateState`.
- `internal/auth/owner.go`: `afterEmptyOwnerLookup` seam.
- `internal/httpapi/auth.go`: passes `s.cfg.SessionTTL`.
- `internal/postgres/testsupport.go`: `NewEmptyTestDatabase`,
  `NewEmptyMigratedTestPool`.
- Tests:
  - `internal/config/config_test.go`: default `720h`, override
    `12h30m`, and `TestLoad_InvalidSessionTTL` (`30`, `thirty days`,
    `30d`, `0`, `0s`, `-1h`).
  - `internal/auth/gc_test.go`: `TestCreateSession_DeletesExpiredSessions`
    and `TestCreateState_DeletesExpiredStates`. The expired row is gone,
    and both a pre-existing live row and the new row remain usable.
  - `internal/auth/owner_test.go` and `internal/postgres/migrate_test.go`:
    the two race tests.
  - `internal/httpapi/auth_test.go`:
    `TestOAuthSignIn_SessionExpiresAfterConfiguredTTL` runs a full
    sign-in with `SessionTTL = 2h` and checks that both the cookie
    `Expires` and the persisted `expires_at` are about now + 2h.
  - `auth_test_support_test.go`: `startTestGalleyWithSessionTTL`.
    `startTestGalley` delegates to it with the default TTL.
  - `contract_test.go`: `mintTestSessionCookie` passes the default TTL.
- `README.md`: `GALLEY_SESSION_TTL` row in "Configuration", sign-in
  step 4 wording, a GC note under the sign-in flow, and the `CREATEDB`
  requirement under "Testing against real PostgreSQL".

`docs/deployment.md` has no environment-variable list and is
unchanged. Following #75's precedent, earlier evidence records are left
untouched. `contracts/openapi.yaml` is unchanged.

## Exact versions and toolchain

- Go `1.27.1` (darwin/arm64).
- PostgreSQL `18.1` (Docker container `ticketit-postgres`,
  `localhost:5432`, trust auth, superuser role). CI uses `postgres:17`
  as superuser `postgres` (`.github/workflows/ci.yml`), so `CREATE
  DATABASE` is available there as well.
- `github.com/golang-migrate/migrate/v4` `v4.20.1`,
  `github.com/jackc/pgx/v5` `v5.11.0`. No new dependency; `go.mod` and
  `go.sum` are unchanged (`migrate/v4/database` is a package of the
  existing module).

## Reproducible commands

```sh
cd apps/galley
gofmt -l .
go vet ./...
go build ./...
go test ./... -count=1
go test -race ./... -count=1
go test -race -count=20 -run 'ConcurrentBootstrapRace|ConcurrentRunsAgainstEmptyDatabase|DeletesExpired' \
  ./internal/auth/ ./internal/postgres/ -v
./scripts/check-contract-drift.sh
```

## Observed results

`gofmt -l .`, `go vet ./...`, and `go build ./...` produced no output.

`go test ./... -count=1` (identical package list under `-race`):

```
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	5.630s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	1.338s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	2.014s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/authtest	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	1.335s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	2.546s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	8.089s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	3.120s
```

`-race -count=20` over the race and GC tests, summarized as `--- PASS`
lines per test (counts summed across durations):

```
20 --- PASS: TestApplyMigrations_ConcurrentRunsAgainstEmptyDatabase
20 --- PASS: TestCreateSession_DeletesExpiredSessions
20 --- PASS: TestCreateState_DeletesExpiredStates
20 --- PASS: TestResolveOwner_ConcurrentBootstrapRace
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	12.268s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	12.113s
```

That is 60 fresh databases for the migration race, and none were left
behind (`SELECT count(*) FROM pg_database WHERE datname LIKE
'ticketit_test_%'` → `0`).

`./scripts/check-contract-drift.sh`:
`OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).`

### Falsification

- `ResolveOwner` was changed to call `resolveOwner(..., false)`, which
  disables the retry. `go test ./internal/auth/ -run Race -count=20`
  then failed 20 of 20 runs:
  `ResolveOwner() error = failed to create the owner: ERROR: duplicate key value violates unique constraint "owners_singleton_uq" (SQLSTATE 23505)`.
- The `deleteExpiredSessions` and `deleteExpiredStates` calls were
  disabled:
  ```
  --- FAIL: TestCreateSession_DeletesExpiredSessions
      gc_test.go:41: expired session row survived CreateSession
  --- FAIL: TestCreateState_DeletesExpiredStates
      gc_test.go:78: expired state row survived CreateState
  ```

Both changes were then reverted, and the suite was green again.

## Implementation limitations and follow-ups

- GC runs only when a state or session is created. A deployment that
  stops signing in keeps whatever expired rows existed at its last
  sign-in. The row count stays bounded by that last TTL window's
  sign-ins, so this does not grow without limit.
- `TestManualLifecycleActionsCreateNoExecutionRecords` (`internal/httpapi`)
  compares `sessions` and `oauth_states` row counts before and after
  on the shared `ticketit_test`. Concurrent packages could already
  change those counts by inserting rows. GC adds deletions as another
  way to change them. It did not flake in any run above. The root
  cause, that database is shared and never reset, predates this fix.
  `NewEmptyMigratedTestPool` is the available remedy if it does flake.

No required behavior in #79 was left unimplemented.

## Outstanding checks and owning milestone

- The race tests need `CREATEDB` on the test role. CI's superuser has
  it, but CI itself has not yet run this branch.
- Behavior under a real long-running deployment (row counts over
  weeks) is part of **M10** operational setup.

## Decision impacts (open-decision IDs)

None. Session lifetime and row housekeeping are operational settings,
and no tracked open decision covers them.
