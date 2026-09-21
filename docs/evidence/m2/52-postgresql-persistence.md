# PostgreSQL migrations, persistence across restart, and a development-only diagnostic

## Purpose

Give Galley a real PostgreSQL-backed database: versioned forward-only
migrations with one documented apply command, a live database-health
field added additively to `GET /api/status`, and a development-only
diagnostic endpoint that proves data survives a genuine Galley process
restart against the same database. Touches `contracts/`, `apps/galley`,
and (only to keep its build green) `apps/swiftlet`'s generated types
and `src/api/status.ts`. Tracking issue:
[#52 — M2.4 — PostgreSQL migrations, persistence across restart, and a
development-only diagnostic](https://github.com/cristoforows/ticketIt/issues/52),
under [M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3).
Blocked by [#51](https://github.com/cristoforows/ticketIt/issues/51),
merged before this slice began.

## What already existed

- `apps/galley` (issues #49, #51, merged): a standalone Go module
  serving `GET /api/status` (five fixed fields, no database) bound to
  `contracts/openapi.yaml` via generated types (`oapi-codegen`), with
  the shared `ErrorBody`/`ErrorDetail` error shape and
  `net/http.ServeMux`-based routing. No database, no migrations, no
  `internal/postgres` package, no `DATABASE_URL` setting.
- `apps/swiftlet` (issues #50, #51, merged): renders the five status
  fields via generated types (`GalleyStatus`), untouched by this slice
  except where its own build would otherwise break (see below).
- `contracts/openapi.yaml`: described exactly `GET /api/status` and the
  shared error shape, nothing else.
- No `apps/galley/internal/migrations`, no `apps/galley/internal/postgres`,
  no `cmd/migrate`. No PostgreSQL connectivity anywhere in the
  repository's application code (only in the unrelated M1
  `experiments/` workspace, out of this slice's scope).
- Locally: PostgreSQL 17.11 (Homebrew) already running on
  `localhost:5432`; only a leftover M1 database
  (`ticketit_m1_native`) existed, deliberately left untouched.

## What this slice added

### `contracts/openapi.yaml`

- `StatusResponse` gained a sixth, **required** field, `database`
  (`$ref: DatabaseStatus`), appended after `startedAt` — the five
  original fields keep their names, values, and order unchanged.
- `DatabaseStatus`: `status` (`ok`/`error`), `migrationVersion`
  (`integer` or `null`), `error` (optional string, present only on
  `status: error`). `additionalProperties: false`, matching every
  other schema in this contract.
- Two new paths, tagged `dev-diagnostic`: `GET`/`POST
  /api/dev/diagnostic-notes`, backed by new schemas `DiagnosticNote`,
  `DiagnosticNoteList`, `CreateDiagnosticNoteRequest`.

### `apps/galley`

- `internal/migrations`: one embedded (`go:embed`), forward-only SQL
  file, `000001_create_diagnostic_notes.up.sql` (creates
  `diagnostic_notes(id, note, created_at)`). No `.down.sql` files —
  deliberately forward-only, per the issue's own wording.
- `internal/postgres`: `NewPool` (parses/validates `DATABASE_URL`,
  does not connect — see "Data access and startup rationale" below),
  `MigrateURL` (rewrites the scheme to `pgx5` for golang-migrate,
  without altering or logging anything else in the URL),
  `ApplyMigrations` (the migration runner, shared by `cmd/migrate` and
  the test suite), `CheckHealth` (the live reachability +
  migration-version check `GET /api/status` calls on every request),
  and `NewTestPool`/`TestingURL` (the test suite's real-PostgreSQL
  setup helper — see "Reproducible commands" below).
- `cmd/migrate`: the one documented command that applies migrations
  (`DATABASE_URL=... go run ./cmd/migrate`). Not run automatically by
  `cmd/galley` at startup — see "Migration tooling and data-access
  choices" below.
- `internal/config`: `Config` gained `DatabaseURL`. `Load` fails
  startup if `DATABASE_URL` is unset or does not parse as a
  `postgres://`/`postgresql://` URL, checked *after* every other
  setting (preserving issue #49's existing validation-order behavior
  and its tests unmodified for every other field) and never echoing
  the value back.
- `internal/httpapi`:
  - `status.go`: `server` now carries a `*pgxpool.Pool`; `GetStatus`
    computes `database` live via `postgres.CheckHealth` on every
    request (never a boot-time snapshot) and `MarshalJSON` appends it
    as the sixth field.
  - `diagnostic.go` (new): `ListDiagnosticNotes`/`CreateDiagnosticNote`
    against `diagnostic_notes`, hand-written SQL through the pool (no
    ORM). `400 invalid_request` for a missing/empty `note` or
    malformed JSON; `503 database_unavailable` if the query fails —
    both using the existing shared `ErrorBody` shape.
  - `handler.go`: `NewHandler` gains a `*pgxpool.Pool` parameter and a
    `gatedMux` that drops registration of any `/api/dev/`-prefixed
    pattern outside `development` — see "Gating the diagnostic at
    registration" below.
- `cmd/galley/main.go`: constructs the pool at startup
  (`postgres.NewPool`) and passes it to `httpapi.NewHandler`; closes it
  after graceful shutdown.
- Tests: extended `internal/config/config_test.go`,
  `internal/httpapi/handler_test.go`, `internal/httpapi/contract_test.go`,
  `cmd/galley/main_test.go`; new
  `internal/httpapi/diagnostic_test.go`,
  `internal/httpapi/production_gating_test.go`,
  `cmd/galley/restart_durability_test.go`. All use real PostgreSQL —
  see "Reproducible commands."
- `README.md`: new "Database configuration," "Database migrations,"
  "Development diagnostic," "Local PostgreSQL setup," and "Testing
  against real PostgreSQL" sections; updated "Configuration,"
  "`GET /api/status`," "Error shape," "Layout," and "Exact versions."

### `apps/swiftlet` (build-preservation only)

- `src/api/generated/schema.d.ts`: regenerated (`database` and the two
  diagnostic operations now typed).
- `src/api/status.ts`: `parseGalleyStatus` now passes `record.database`
  through (cast, not validated) so its return value keeps satisfying
  the generated `GalleyStatus` type, which requires `database` (it is
  a required contract field). Without this one-line addition, `tsc`
  fails the build (`Property 'database' is missing`) — confirmed by
  reproducing the failure before adding it (see "Observed results").
  **No other Swiftlet file changed**; `StatusView.tsx` still destructures
  only the original five fields and renders nothing new, exactly as
  issue #52 scopes it ("You do not need to change `StatusView.tsx`;
  rendering the new fields is out of scope"). All 6 existing tests pass
  unmodified.

## Migration tooling and data-access choices, and why

**Data access: [`pgx/v5`](https://github.com/jackc/pgx) (`v5.11.0`)**,
via `pgxpool.Pool`, used directly with hand-written SQL — no ORM, no
query builder. The issue recommends `pgx`; this slice adds exactly one
table (`diagnostic_notes`, development-only, no domain tables — those
arrive in #56), so an abstraction layer would have nothing real to
abstract yet.

**Migration tooling: [`golang-migrate/migrate/v4`](https://github.com/golang-migrate/migrate)
(`v4.20.1`)**, used as an ordinary library dependency
(`internal/postgres/migrate.go`), not as its own separate CLI binary.
Two concrete reasons drove this over the alternatives:

1. **Not the official `migrate` CLI, because of build tags.** That
   binary selects its included database drivers via build tags at
   compile time (`go install -tags 'postgres' .../cmd/migrate`). This
   module already pins one dev tool via Go 1.24's `go.mod` `tool`
   directive (`oapi-codegen`, from issue #51); `go tool <name> [args]`
   passes its arguments to the tool, not to the underlying build, so
   there is no way to attach `-tags postgres` to a `go tool migrate`
   invocation short of relying on a `GOFLAGS` environment variable a
   developer would have to remember every time — getting this wrong
   would silently produce a `migrate` binary with **no** PostgreSQL
   driver compiled in. Writing this repository's own ~40-line
   `cmd/migrate/main.go`, importing `golang-migrate/migrate/v4`'s
   `pgx/v5` driver package directly (an ordinary import, no build tag
   involved), sidesteps that failure mode entirely.
2. **`golang-migrate`'s own `pgx/v5` driver
   (`golang-migrate/migrate/v4/database/pgx/v5`) over `lib/pq`**
   (golang-migrate's older default): keeps the whole stack on one
   PostgreSQL driver rather than introducing a second one purely for
   migrations.

Considered and rejected: **a hand-rolled migration runner** (read
`.sql` files, track a version table by hand). Rejected because
"versioned forward-only files, a documented apply command, and a
tracked applied version" is precisely golang-migrate's job, and it is
the most widely used Go migration tool — reinventing it would trade a
well-tested library for bespoke code with the exact same
responsibility. Considered and rejected: **`pressly/goose`** — a
reasonable alternative, but golang-migrate's `iofs` source driver
(reading a `go:embed`-embedded `fs.FS` directly, with no CLI-vs-library
seam to bridge) fit this repository's "small, hand-written `cmd/`
program" pattern slightly more directly for this slice's one-migration
scope; not a decision with a strong reason to prefer one over the
other beyond that.

**Migrations do not run automatically at Galley's own startup.**
`cmd/galley/main.go` never calls `postgres.ApplyMigrations` — only
`cmd/migrate` and the test suite's `internal/postgres.NewTestPool` do.
This is deliberate: applying a schema change is an explicit,
operator-triggered, independently auditable action, and it avoids every
instance in a hypothetical future multi-instance deployment racing to
migrate the same database concurrently on every boot. The cost — one
extra manual step before running Galley against a new migration for the
first time — is made safe rather than silent by `GET /api/status`'s
live `migrationVersion` field, which makes a not-yet-migrated database
immediately visible.

## Gating the diagnostic at registration

The generated `HandlerFromMux` (`api.gen.go`, from oapi-codegen's
`std-http-server` output) registers **every** contract operation
unconditionally onto whatever `ServeMux`-shaped router it is given —
there is no per-operation flag to make one of them conditional. Rather
than add an `if cfg.Environment == production { return 404 }` check
inside the two diagnostic handler methods (a check *inside the
handler*, exactly what issue #52 says not to do), `internal/httpapi/handler.go`
introduces `gatedMux`: a thin wrapper implementing the same `ServeMux`
interface (`HandleFunc` + `http.Handler`) that `api.gen.go` already
defines for exactly this kind of customization. Its `HandleFunc`
silently drops any pattern under the fixed `/api/dev/` prefix instead
of forwarding it to the real `*http.ServeMux`. `NewHandler` passes
`gatedMux` as `HandlerFromMux`'s router in every environment except
`development`; in `development` it passes the real mux directly, so
`HandlerFromMux` registers all three operations (`GetStatus`,
`ListDiagnosticNotes`, `CreateDiagnosticNote`) normally. In any other
environment, the two diagnostic patterns are never added to the mux at
all — an unmatched request to either falls through to the same shared
`/` subtree handler (`notFoundHandler`) that a request to a path this
codebase has never heard of would hit, producing byte-identical `404
not_found` bodies (modulo the path named in the message).
`internal/httpapi/production_gating_test.go` proves this directly by
comparing a request to `/api/dev/diagnostic-notes` in production
against a request to a path with no operation anywhere in the contract,
asserting both hit `not_found` and neither ever returns an `Allow`
header (which would mean the path was known but the method wasn't —
i.e. that the route existed after all).

This required no changes to the generated `api.gen.go` and no
tag-based codegen filtering (`oapi-codegen`'s `include-tags`/`exclude-tags`
was considered and rejected: it would need a second generated Go
package to avoid a `ServerInterface`/`HandlerFromMux` name collision
with the primary one, for no benefit `gatedMux` doesn't already
provide more simply).

## Data access and startup rationale: unreachable vs. unset

`internal/postgres.NewPool` wraps `pgxpool.New`, which **parses and
validates** `DATABASE_URL` synchronously but does **not** connect —
pgxpool establishes connections lazily, on first use. This is exactly
what issue #52's acceptance criteria require read together: "failing
clearly when unset or unreachable" (a config-time property) alongside
"`GET /api/status` ... reports failure honestly when the database is
down" (which requires Galley to still be running to report it). The
resulting split: an **unset or malformed** `DATABASE_URL` fails
`cmd/galley`'s startup immediately (a configuration error, like an
invalid `GALLEY_PORT`); a **syntactically valid but unreachable**
`DATABASE_URL` does not — Galley boots and serves, and `GET
/api/status`'s live `CheckHealth` call reports `database.status:
"error"` on every request until the database comes back. This is
recorded here as this slice's own resolution of that phrasing, not a
silent downgrade: without it, either the required "reports failure
honestly" behavior would be unreachable (if Galley refused to boot on
an unreachable database, there would be no running process left to ask
about it) or "fails clearly when unreachable" would be unenforceable.
`internal/httpapi/handler_test.go:TestGetStatus_DatabaseUnreachable`
and `contract_test.go:TestGetStatus_DatabaseUnreachableResponseMatchesContract`
verify the reporting side against a real `pgxpool.Pool` pointed at
`localhost:1` (a port nothing listens on, refused immediately, no
timeout-related flakiness); "Observed results" below verifies it
manually against a running process too.

## Never logging credentials

`DATABASE_URL` (and the `pgx5://`-scheme string `MigrateURL` derives
from it for golang-migrate) is never logged, printed, or included in
any response body anywhere in this slice's code:

- Configuration errors (unset, wrong scheme) describe *what* is wrong
  without repeating the value (`internal/config/config.go`).
- `internal/postgres.NewPool`'s and `MigrateURL`'s own error paths
  return fixed, generic messages rather than propagating the
  underlying parse error's text, since some parse failures echo back
  the offending input.
- `GET /api/status`'s `database.error` and the diagnostic endpoints'
  `database_unavailable` messages are fixed, generic strings
  (`internal/httpapi/status.go`'s `databaseUnreachableMessage`,
  `diagnostic.go`'s error responses) — never the underlying pgx driver
  error text or any part of the connection string.
- The structured request-access log (`method`, `path`, `status`,
  `duration_ms`, `remote_addr`, unchanged from issue #49) never
  includes configuration values at all.

Verified directly: "Observed results" below `grep`s every log file
this slice's manual verification produced for `DATABASE_URL`,
`sslmode`, and `password`, finding none.

## Exact versions and toolchain

- Go: `go1.27.1 darwin/arm64`.
- `github.com/jackc/pgx/v5` `v5.11.0` — ordinary `require`, linked into
  the built `galley` binary (`internal/postgres`, `internal/httpapi`).
- `github.com/golang-migrate/migrate/v4` `v4.20.1` — ordinary
  `require`, used by `internal/postgres/migrate.go`.
- `github.com/jackc/pgerrcode` `v0.0.0-20220416144525-469b46aa5efa` —
  ordinary `require` (transitively required by golang-migrate's
  `pgx/v5` driver regardless), used directly by
  `internal/postgres/health.go`.
- `github.com/getkin/kin-openapi` `v0.149.0`, `github.com/oapi-codegen/oapi-codegen/v2`
  `v2.8.0` (`tool` dependency) — unchanged from issue #51.
- Node `26.9.0`, npm `11.19.1` — unchanged; `apps/swiftlet` itself
  still added no new dependency (108 packages, same as issues #50/#51).
- PostgreSQL server: `17.11` (Homebrew), `localhost:5432`, already
  running via a launchd agent before this slice began. Databases used:
  `ticketit_dev` (development), `ticketit_test` (default test
  database, overridable via `GALLEY_TEST_DATABASE_URL`). The
  pre-existing `ticketit_m1_native` database was never touched.

## Reproducible commands

**Local PostgreSQL setup** (one-time, against the already-running
local PostgreSQL instance — see `apps/galley/README.md`, "Local
PostgreSQL setup"):

```sh
createdb ticketit_dev
createdb ticketit_test
```

**Apply migrations** (the one documented command; `ticketit_test`
needs this only implicitly, via the test suite's own setup — see
below):

```sh
cd apps/galley
DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable go run ./cmd/migrate
```

**Galley** (from `apps/galley/`, clean checkout):

```sh
go build ./...
go vet ./...
gofmt -l .          # expect no output
go test ./... -v
```

**Swiftlet** (from `apps/swiftlet/`, clean checkout — unaffected
beyond the one-line `status.ts` addition):

```sh
rm -rf node_modules dist
npm ci
npm test
npm run build
```

**Regenerate the contract bindings** (after editing
`contracts/openapi.yaml`):

```sh
cd apps/galley && go generate ./...
cd contracts && npm ci && npm run generate:swiftlet
```

**Drift check** (both halves):

```sh
cd apps/galley && go test ./internal/httpapi/... -run Contract -v
cd apps/galley && ./scripts/check-contract-drift.sh
cd contracts && npm ci && ./check-swiftlet-drift.sh
```

**Run Galley manually:**

```sh
DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable go run ./cmd/galley
curl http://localhost:8080/api/status
curl -X POST http://localhost:8080/api/dev/diagnostic-notes -d '{"note":"hello"}'
curl http://localhost:8080/api/dev/diagnostic-notes
```

## Observed results

### Migrations apply reproducibly from an empty database

```
$ dropdb ticketit_dev; dropdb ticketit_test
$ createdb ticketit_dev
$ createdb ticketit_test
$ psql -h localhost -p 5432 -d ticketit_dev -c "\dt"
Did not find any relations.

$ cd apps/galley
$ DATABASE_URL="postgres://localhost:5432/ticketit_dev?sslmode=disable" go run ./cmd/migrate
migrations applied: schema version 1

$ psql -h localhost -p 5432 -d ticketit_dev -c "\dt"
                 List of relations
 Schema |       Name        | Type  |    Owner
--------+-------------------+-------+--------------
 public | diagnostic_notes  | table | cristoforows
 public | schema_migrations | table | cristoforows
(2 rows)

$ DATABASE_URL="postgres://localhost:5432/ticketit_dev?sslmode=disable" go run ./cmd/migrate
migrations applied: schema version 1
```

The second run (idempotent, `golang-migrate`'s `ErrNoChange`) reports
the same version and changes nothing.

### Galley: build, vet, fmt

```
$ go version
go version go1.27.1 darwin/arm64

$ gofmt -l .
(no output — clean)

$ go vet ./...
(no output — clean)

$ go build ./...
(no output — success)
```

### Galley: `go test ./...` against a genuinely empty `ticketit_test`

Ran immediately after `dropdb ticketit_test; createdb ticketit_test`
above — no migration command was run against `ticketit_test`
separately; `internal/postgres.NewTestPool` applied it as a side
effect of the first test that called it:

```
$ go test ./... -v -count=1
=== RUN   TestRun_ConfigurationFailure
--- PASS: TestRun_ConfigurationFailure (0.00s)
=== RUN   TestRun_ServesStatusThenShutsDownCleanly
--- PASS: TestRun_ServesStatusThenShutsDownCleanly (0.02s)
=== RUN   TestRestartDurability_DiagnosticNoteSurvivesFreshProcess
--- PASS: TestRestartDurability_DiagnosticNoteSurvivesFreshProcess (0.59s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	0.992s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
=== RUN   TestLoad_Defaults
--- PASS: TestLoad_Defaults (0.00s)
=== RUN   TestLoad_ExplicitProductionSettings
--- PASS: TestLoad_ExplicitProductionSettings (0.00s)
=== RUN   TestLoad_InvalidPort
--- PASS: TestLoad_InvalidPort (0.00s)
    --- PASS: TestLoad_InvalidPort/not-a-number (0.00s)
    --- PASS: TestLoad_InvalidPort/-1 (0.00s)
    --- PASS: TestLoad_InvalidPort/65536 (0.00s)
    --- PASS: TestLoad_InvalidPort/8080.5 (0.00s)
    --- PASS: TestLoad_InvalidPort/_ (0.00s)
=== RUN   TestLoad_PortZeroIsValid
--- PASS: TestLoad_PortZeroIsValid (0.00s)
=== RUN   TestLoad_InvalidEnvironment
--- PASS: TestLoad_InvalidEnvironment (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/prod (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/Development (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/staging (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/PRODUCTION (0.00s)
=== RUN   TestLoad_DatabaseURLUnset
--- PASS: TestLoad_DatabaseURLUnset (0.00s)
=== RUN   TestLoad_InvalidDatabaseURL
--- PASS: TestLoad_InvalidDatabaseURL (0.00s)
    --- PASS: TestLoad_InvalidDatabaseURL/not-a-url_at_all_::// (0.00s)
    --- PASS: TestLoad_InvalidDatabaseURL/mysql://localhost:3306/ticketit (0.00s)
    --- PASS: TestLoad_InvalidDatabaseURL/localhost:5432/ticketit (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.149s
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.02s)
=== RUN   TestGetStatus_DatabaseUnreachableResponseMatchesContract
--- PASS: TestGetStatus_DatabaseUnreachableResponseMatchesContract (0.00s)
=== RUN   TestDiagnosticNotes_ResponseMatchesContract
--- PASS: TestDiagnosticNotes_ResponseMatchesContract (0.01s)
=== RUN   TestErrorResponses_MatchContract
--- PASS: TestErrorResponses_MatchContract (0.01s)
    --- PASS: TestErrorResponses_MatchContract/not_found (0.00s)
    --- PASS: TestErrorResponses_MatchContract/method_not_allowed (0.00s)
=== RUN   TestDiagnosticNotes_WriteThenRead
--- PASS: TestDiagnosticNotes_WriteThenRead (0.01s)
=== RUN   TestCreateDiagnosticNote_RejectsEmptyNote
--- PASS: TestCreateDiagnosticNote_RejectsEmptyNote (0.01s)
=== RUN   TestCreateDiagnosticNote_RejectsMalformedJSON
--- PASS: TestCreateDiagnosticNote_RejectsMalformedJSON (0.00s)
=== RUN   TestDiagnosticNotes_DatabaseUnavailable
--- PASS: TestDiagnosticNotes_DatabaseUnavailable (0.00s)
    --- PASS: TestDiagnosticNotes_DatabaseUnavailable/list (0.00s)
    --- PASS: TestDiagnosticNotes_DatabaseUnavailable/create (0.00s)
=== RUN   TestDiagnosticNotes_MethodNotAllowed
--- PASS: TestDiagnosticNotes_MethodNotAllowed (0.00s)
=== RUN   TestStatusHandler_Development
--- PASS: TestStatusHandler_Development (0.01s)
=== RUN   TestStatusHandler_Production
--- PASS: TestStatusHandler_Production (0.01s)
=== RUN   TestGetStatus_DatabaseUnreachable
--- PASS: TestGetStatus_DatabaseUnreachable (0.00s)
=== RUN   TestUnknownRoute_ReturnsSharedErrorShape
--- PASS: TestUnknownRoute_ReturnsSharedErrorShape (0.01s)
=== RUN   TestMethodNotAllowed_ReturnsSharedErrorShape
--- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape (0.01s)
    --- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape/POST (0.00s)
    --- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape/DELETE (0.00s)
    --- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape/PUT (0.00s)
=== RUN   TestDevDiagnosticRoutes_AbsentInProduction
--- PASS: TestDevDiagnosticRoutes_AbsentInProduction (0.01s)
    --- PASS: TestDevDiagnosticRoutes_AbsentInProduction/GET (0.00s)
    --- PASS: TestDevDiagnosticRoutes_AbsentInProduction/POST (0.00s)
    --- PASS: TestDevDiagnosticRoutes_AbsentInProduction/DELETE_(not_even_a_valid_method_on_this_route_in_development) (0.00s)
=== RUN   TestDevDiagnosticRoutes_PresentOutsideProduction
--- PASS: TestDevDiagnosticRoutes_PresentOutsideProduction (0.01s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	1.459s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	[no test files]
```

Every test uses real PostgreSQL — `internal/postgres.NewTestPool`;
none of the above is an in-memory or fake substitute.

### Restart-durability proof (real, separate OS processes)

`TestRestartDurability_DiagnosticNoteSurvivesFreshProcess`
(`apps/galley/cmd/galley/restart_durability_test.go`), included in the
run above, builds the real `galley` binary once and runs it as two
independent OS process invocations: writes a uniquely-generated
diagnostic note through the first, sends it a real `SIGTERM` and waits
for `cmd.Wait()` to confirm full exit (not just socket closure), starts
a second, brand-new process (new PID, new `pgxpool.Pool`, new
`http.Server`, no shared Go memory of any kind with the first) against
the same `DATABASE_URL`, and reads the note back through it. This is
the test issue #52 requires ("not just a new database connection or a
transaction commit") — it deliberately does not call `run()` twice
within one test binary, which would only prove an in-process pool and
server survive.

Manual equivalent, run separately (also proves the migrate-then-start
workflow end to end):

```
$ cd apps/galley
$ go build -o /tmp/galley-bin ./cmd/galley
$ DATABASE_URL="postgres://localhost:5432/ticketit_dev?sslmode=disable" /tmp/galley-bin &
$ curl -s -X POST http://localhost:8080/api/dev/diagnostic-notes -H 'Content-Type: application/json' -d '{"note":"manual verification note"}'
{"createdAt":"2026-09-21T09:13:54Z","id":1,"note":"manual verification note"}
$ curl -s http://localhost:8080/api/dev/diagnostic-notes
{"notes":[{"createdAt":"2026-09-21T09:13:54Z","id":1,"note":"manual verification note"}]}
$ kill -TERM <pid>            # real SIGTERM to the real process, not the test harness
# log:
{"...","msg":"shutdown signal received, draining connections"}
{"...","msg":"galley stopped"}
$ pgrep -fl galley-bin         # no output: process fully exited

$ /tmp/galley-bin &            # second, unrelated process, same binary, same database
$ curl -s http://localhost:8080/api/dev/diagnostic-notes
{"notes":[{"createdAt":"2026-09-21T09:13:54Z","id":1,"note":"manual verification note"}]}
```

The note written by the first process is present, unchanged, through
the second — genuinely fresh process, same database.

### `GET /api/status`: healthy database

```
$ curl -i http://localhost:8080/api/status
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 165

{"application":"galley","status":"ok","version":"dev","environment":"development","startedAt":"2026-09-21T09:13:54Z","database":{"migrationVersion":1,"status":"ok"}}
```

### `GET /api/status`: unreachable database (`DATABASE_URL` pointing at a closed port)

```
$ DATABASE_URL="postgres://localhost:1/ticketit_dev?sslmode=disable" /tmp/galley-bin &
$ curl -i http://localhost:8080/api/status
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 202

{"application":"galley","status":"ok","version":"dev","environment":"development","startedAt":"2026-09-21T09:14:27Z","database":{"error":"database unreachable","migrationVersion":null,"status":"error"}}
```

The process stayed up (`200 OK`, top-level `status: "ok"` unchanged)
and reported the failure honestly in `database.status` — never `"ok"`.

### Development diagnostic: method-not-allowed and production absence

```
$ curl -i -X DELETE http://localhost:8080/api/dev/diagnostic-notes   # development
HTTP/1.1 405 Method Not Allowed
Allow: GET, POST
Content-Type: application/json; charset=utf-8

{"error":{"code":"method_not_allowed","message":"method DELETE not allowed for /api/dev/diagnostic-notes; use GET, POST"}}

$ GALLEY_ENVIRONMENT=production GALLEY_VERSION=0.1.0 DATABASE_URL="postgres://localhost:5432/ticketit_dev?sslmode=disable" /tmp/galley-bin &
$ curl -i http://localhost:8080/api/status
HTTP/1.1 200 OK
{"application":"galley","status":"ok","version":"0.1.0","environment":"production","startedAt":"2026-09-21T09:14:19Z","database":{"migrationVersion":1,"status":"ok"}}

$ curl -i http://localhost:8080/api/dev/diagnostic-notes
HTTP/1.1 404 Not Found
{"error":{"code":"not_found","message":"no route for GET /api/dev/diagnostic-notes"}}

$ curl -i -X POST http://localhost:8080/api/dev/diagnostic-notes -d '{"note":"should not exist"}'
HTTP/1.1 404 Not Found
{"error":{"code":"not_found","message":"no route for POST /api/dev/diagnostic-notes"}}
```

Same `404 not_found` shape a genuinely unknown route gets — no `Allow`
header, confirming the path itself, not just the method, is unknown.

### Configuration failures never echo `DATABASE_URL`

```
$ /tmp/galley-bin
configuration error: DATABASE_URL is not set: a PostgreSQL connection string is required (postgres://user:password@host:port/dbname) -- see apps/galley/README.md, "Database configuration"
$ echo $?
1

$ DATABASE_URL="mysql://user:pass@localhost/db" /tmp/galley-bin
configuration error: invalid DATABASE_URL: must be a postgres:// or postgresql:// connection string (value withheld to avoid logging credentials)
$ echo $?
1
```

### No credentials in logs

```
$ grep -i "DATABASE_URL\|sslmode\|password" /tmp/galley-manual.log /tmp/galley-prod.log /tmp/galley-unreachable.log
no leakage found
```

(checked against every stdout log this slice's manual verification
produced, including the unreachable-database run whose `DATABASE_URL`
value itself contained no password but was still confirmed absent from
every log line, and the structured request/shutdown logs generally).

### Drift check (both halves), and the contract-response validation test

```
$ cd apps/galley && go test ./internal/httpapi/... -run Contract -v
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.02s)
=== RUN   TestGetStatus_DatabaseUnreachableResponseMatchesContract
--- PASS: TestGetStatus_DatabaseUnreachableResponseMatchesContract (0.00s)
=== RUN   TestDiagnosticNotes_ResponseMatchesContract
--- PASS: TestDiagnosticNotes_ResponseMatchesContract (0.01s)
=== RUN   TestErrorResponses_MatchContract
--- PASS: TestErrorResponses_MatchContract (0.01s)
PASS

$ ./scripts/check-contract-drift.sh
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).

$ cd ../../contracts && ./check-swiftlet-drift.sh
> ticketit-contracts@0.0.0 generate:swiftlet
> openapi-typescript openapi.yaml -o ../apps/swiftlet/src/api/generated/schema.d.ts
✨ openapi-typescript 7.13.0
🚀 openapi.yaml → ../apps/swiftlet/src/api/generated/schema.d.ts [15.5ms]
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

Both drift checks were run against the generated files already
committed on this branch (the "commit before running" gotcha the
checks themselves enforce).

### Swiftlet: clean-room install, test, build (unaffected beyond the required `status.ts` fix)

Reproducing the failure first, to confirm the one-line fix in
`src/api/status.ts` was necessary and not incidental — regenerating
`schema.d.ts` alone, without touching `status.ts`:

```
$ npm run build
> tsc -p tsconfig.json --noEmit && vite build
src/api/status.ts(61,3): error TS2741: Property 'database' is missing in type '{ application: ...; startedAt: GalleyStatus["startedAt"]; }' but required in type '{ ...; database: { status: "error" | "ok"; migrationVersion: number | null; error?: string | undefined; }; }'.
```

After adding the one-line `database: record.database as
GalleyStatus["database"]` pass-through:

```
$ rm -rf node_modules dist && npm ci
added 108 packages, and audited 109 packages in 3s
found 0 vulnerabilities

$ npm test
> vitest run
 Test Files  2 passed (2)
      Tests  6 passed (6)
   Duration  534ms

$ npm run build
> tsc -p tsconfig.json --noEmit && vite build
vite v8.3.0 building client environment for production...
✓ 17 modules transformed.
dist/index.html                  0.31 kB │ gzip:  0.22 kB
dist/assets/index-BggGnraW.js  221.67 kB │ gzip: 69.27 kB
✓ built in 48ms
```

**108 packages** — identical to issues #50/#51's own baseline; this
slice added no dependency to `apps/swiftlet` itself. All 6 tests pass
unmodified — no test file was touched.

## Implementation limitations and follow-ups

- **No CI wiring.** Unchanged from issue #51's own recorded limitation
  — no `.github/workflows` exists anywhere in this repository yet. All
  commands above are documented and manually reproducible but nothing
  runs them automatically on push/PR. Same owner as before: the
  gate-report slice ([#62](https://github.com/cristoforows/ticketIt/issues/62))
  or a dedicated CI-setup slice.
- **`golang-migrate`'s advisory lock, not tested under real concurrent
  migration attempts.** `ensureVersionTable`/`Lock`/`Unlock` (the
  `pgx/v5` driver's own `pg_advisory_lock` usage) protects concurrent
  `cmd/migrate` invocations against the same database in principle, but
  this slice did not construct a test that races two migration runs
  against each other — with exactly one migration file and no CI, that
  scenario has no current trigger. No specific follow-up issue exists
  yet; natural owner is whichever milestone first runs migrations from
  more than one process/CI job concurrently (plausibly **M10**,
  deployment).
- **`DatabaseStatus.migrationVersion`'s `null` case is not
  distinguished in the response between "unreachable" and "reachable,
  nothing migrated yet" beyond `status`.** This is by design (see
  "What this slice added" and the README's `GET /api/status` section),
  not a limitation, but is noted here in case a later slice wants a
  third explicit value instead of overloading `null`.
- **No repository/data-access abstraction layer.** Deliberate for this
  slice's scope (one development-only table); #56 (domain/Ticket
  tables) is the natural point to decide whether one is warranted, not
  this slice.

No other required behavior in issue #52 was left unimplemented; every
acceptance criterion is satisfied and verified above.

## Outstanding checks and owning milestone

- **CI automation** of the commands recorded here — no owning issue
  yet; see "Implementation limitations" above.
- **Domain/Ticket tables and a real data-access pattern for them** —
  owned by [#56](https://github.com/cristoforows/ticketIt/issues/56),
  which should follow this slice's contract-first convention and reuse
  `internal/postgres`'s pool/health-check plumbing rather than
  duplicating it.
- **Concurrent-migration locking under real load** — see
  "Implementation limitations" above.
- **Live two-application check of the extended status payload through
  Swiftlet's dev proxy** (mirroring issue #51's own live check) — not
  performed here, since `StatusView.tsx` renders nothing new and the
  five original fields' byte-identical behavior is exactly what issue
  #51's own live check already established; the only change here
  Swiftlet's own build depends on is `status.ts`'s one-line pass-through,
  covered by its unmodified, still-passing test suite. If a future
  slice renders `database` in the UI, that slice should add its own
  live two-application check.

## Decision impacts (open-decision IDs)

None of D1, D2, D4–D9 are resolved or touched by this slice.
[D3](../../decisions/d3-agent-template-compatibility.md) is unrelated —
this slice has no Agent, Round, or execution concept, per M2's scope
rule. **D7** ("Known operational selections awaiting the owner":
object storage and application/PostgreSQL *hosting*) is not touched
either — this slice runs PostgreSQL locally only, provisions nothing,
and creates no provider account, per `AGENTS.md`'s "Paid resources"
rule and `docs/deployment.md`'s "Provisioning requires explicit Owner
approval." This record's decision-relevant content is entirely the
engineering choices issue #52 designates as this slice's own to make
and record: the PostgreSQL driver/data-access approach (`pgx/v5`,
direct SQL), the migration tool and its usage mode (`golang-migrate`,
as a library via a repository-owned `cmd/migrate`, not its own CLI
binary), the migrations-do-not-run-at-startup rule, and the
registration-time gating mechanism for the diagnostic routes
(`gatedMux`) — none of these are open product decisions requiring
D-series resolution.
