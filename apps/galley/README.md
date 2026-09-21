# galley

Galley is ticketIt's Go backend. Per [ADR 0001](../../docs/adr/0001-single-authority-galley.md)
it is the sole authority over authoritative records; Swiftlet (the
React frontend) only submits owner commands and renders what Galley
returns.

This slice ([issue #49](https://github.com/cristoforows/ticketIt/issues/49))
adds an independently buildable, runnable Go module that serves one
unauthenticated application-status endpoint. There was no database, no
authentication, and no Ticket model yet.

[Issue #51](https://github.com/cristoforows/ticketIt/issues/51) then
bound that endpoint to [`contracts/openapi.yaml`](../../contracts/openapi.yaml),
ticketIt's single source of truth for Galley's HTTP API — see
[`contracts/README.md`](../../contracts/README.md) for the contract-
first convention every later slice follows, the regeneration commands,
and the drift check. `GET /api/status`'s observable behavior is
unchanged by that refactor.

[Issue #52](https://github.com/cristoforows/ticketIt/issues/52) added
PostgreSQL: a connection pool (`internal/postgres`), versioned
forward-only migrations, a live database-health field on `GET
/api/status`, and a development-only diagnostic-notes endpoint. There
is still no domain/Ticket table — that arrives in
[#56](https://github.com/cristoforows/ticketIt/issues/56).

[Issue #54](https://github.com/cristoforows/ticketIt/issues/54) added
Galley's only identity/security surface so far: a stable internal
Owner record, GitHub OAuth authorization-code sign-in restricted to
that one configured Owner, a PostgreSQL-persisted session, and the
protected-route boundary (`requireSession`) later slices' routes are
expected to use. See "Owner configuration and GitHub OAuth sign-in"
and "Authenticated routes" below.

[Issue #55](https://github.com/cristoforows/ticketIt/issues/55) added
Swiftlet's own sign-in page and authenticated shell (see
`apps/swiftlet/README.md`) and `cmd/githubfake`, a standalone,
real-port, test/development-only substitute GitHub provider the browser
suite signs in against — see "Owner configuration and GitHub OAuth
sign-in" below and `e2e/README.md`, "Signing in." No Galley HTTP
behavior changed: this slice's own new Go code is entirely the
`internal/githubfake` refactor and `cmd/githubfake` itself.

Galley is a standalone Go module (`go.mod` at this directory) with no
dependency on Node or any frontend toolchain. It does have third-party
Go dependencies as of issue #51 — the generated server types/interface
(`internal/httpapi/api.gen.go`) pull in no runtime dependency of their
own (see below), but the code-generation tool itself
(`oapi-codegen`, pinned via `go.mod`'s `tool` directive) and the
contract-drift test (`kin-openapi`, an ordinary `require`) mean
`go.sum` now exists. Issue #52 added its own real runtime dependencies
on top of that — `pgx/v5` and `golang-migrate` — see "Database
configuration" and "Database migrations" below. Issue #54 added no new
runtime dependency beyond `github.com/oapi-codegen/runtime` (needed
once the contract gained query parameters) — see "Exact versions and
toolchain" below. None of these issues added a Node/frontend
dependency; "no Node required to build Galley" still holds.

## Requirements

- Go `1.27.1` (see "Exact versions" below).
- A local PostgreSQL server (see "Local PostgreSQL setup" below). No
  other toolchain is required.

## Build, test, run

All commands run from this directory (`apps/galley`). `go test ./...`
needs a real, migrated `ticketit_test` database — see "Local
PostgreSQL setup" and "Testing against real PostgreSQL" below; a
one-time `createdb ticketit_test` is the only setup step, since the
test suite applies migrations to it itself.

```sh
createdb ticketit_dev    # one-time, see "Local PostgreSQL setup"
createdb ticketit_test   # one-time, ditto
DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable go run ./cmd/migrate
go build ./...
go test ./...
DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable \
  GALLEY_OWNER_GITHUB_LOGIN=your-github-login \
  GALLEY_OAUTH_GITHUB_CLIENT_ID=... GALLEY_OAUTH_GITHUB_CLIENT_SECRET=... \
  go run ./cmd/galley
```

`go test ./...` itself needs none of the OAuth variables above — every
test either constructs `config.Config` directly or points them at
`internal/githubfake`'s local fixture server, never at real GitHub.

`go vet ./...` and `gofmt -l .` (expect no output) are also part of
this slice's definition of done.

### Running

```sh
DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable \
  GALLEY_OWNER_GITHUB_LOGIN=your-github-login \
  GALLEY_OAUTH_GITHUB_CLIENT_ID=... GALLEY_OAUTH_GITHUB_CLIENT_SECRET=... \
  go run ./cmd/galley
```

`DATABASE_URL`, `GALLEY_OWNER_GITHUB_LOGIN`,
`GALLEY_OAUTH_GITHUB_CLIENT_ID`, and `GALLEY_OAUTH_GITHUB_CLIENT_SECRET`
are all required (see "Database configuration" and "Owner
configuration and GitHub OAuth sign-in" below); every other setting
keeps its previous default. By default this listens on `:8080` (all
interfaces, port 8080) and serves:

```sh
curl http://localhost:8080/api/status
```

Port 8080 is the default specifically so Swiftlet's dev proxy
([issue #50](https://github.com/cristoforows/ticketIt/issues/50)),
which targets `http://localhost:8080` by default, works out of the box
against a locally running Galley.

Stop the process with `Ctrl-C` (`SIGINT`) or `SIGTERM`; Galley drains
in-flight requests and releases the listening socket before exiting
(see "Graceful shutdown" below).

## Configuration

Galley reads configuration from the environment at startup. Every
setting has an explicit default; a value that is present but cannot be
parsed or is not one of the accepted values fails startup immediately
with an actionable error on stderr and a non-zero exit code, rather
than starting in an unknown state.

| Variable             | Default       | Notes                                                                                   |
| -------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `GALLEY_HOST`         | `` (empty)    | Interface to listen on. Empty binds all interfaces.                                      |
| `GALLEY_PORT`         | `8080`        | Integer `0`–`65535`. `0` asks the OS for an ephemeral port (used by this module's own tests). |
| `GALLEY_ENVIRONMENT`  | `development` | Must be exactly `development` or `production`.                                           |
| `GALLEY_VERSION`      | `dev`         | Arbitrary version string reported by `GET /api/status`.                                  |
| `DATABASE_URL`        | *(none — required)* | PostgreSQL connection string, `postgres://user:password@host:port/dbname`. See "Database configuration" below. |
| `GALLEY_OWNER_GITHUB_LOGIN` | *(none — required)* | The configured Owner's GitHub login. See "Owner configuration and GitHub OAuth sign-in" below. |
| `GALLEY_OAUTH_GITHUB_CLIENT_ID` | *(none — required)* | OAuth app client id. Never logged.                        |
| `GALLEY_OAUTH_GITHUB_CLIENT_SECRET` | *(none — required)* | OAuth app client secret. Never logged.                |
| `GALLEY_OAUTH_GITHUB_BASE_URL` | `https://github.com` | Authorize/token endpoint host. Tests point this at a local fixture. |
| `GALLEY_OAUTH_GITHUB_API_BASE_URL` | `https://api.github.com` | Identity (`/user`) endpoint host. Tests point this at a local fixture. |
| `GALLEY_BASE_URL`     | `http://localhost:8080` | The browser-facing origin Galley is reached at; builds the fixed OAuth `redirect_uri`. See below. |

Example of a configuration failure:

```sh
$ GALLEY_ENVIRONMENT=staging go run ./cmd/galley
configuration error: invalid GALLEY_ENVIRONMENT "staging": must be "development" or "production"
$ echo $?
1
```

## Database configuration

`DATABASE_URL` (issue #52) is the one setting above with no default:
there is no sensible fallback for "which database," so an unset value
fails startup immediately, the same way an invalid `GALLEY_PORT` or
`GALLEY_ENVIRONMENT` does:

```sh
$ go run ./cmd/galley
configuration error: DATABASE_URL is not set: a PostgreSQL connection string is required (postgres://user:password@host:port/dbname) -- see apps/galley/README.md, "Database configuration"
$ echo $?
1
```

A value that does not parse as a `postgres://` or `postgresql://`
connection string fails the same way, without ever echoing the value
back (it may contain a password):

```sh
$ DATABASE_URL=mysql://localhost/db go run ./cmd/galley
configuration error: invalid DATABASE_URL: must be a postgres:// or postgresql:// connection string (value withheld to avoid logging credentials)
$ echo $?
1
```

**A syntactically valid `DATABASE_URL` whose target is merely
unreachable does *not* fail startup.** `internal/postgres.NewPool`
(`pgxpool.New`) only parses and validates configuration; it does not
connect. Reachability is instead checked live, on every `GET
/api/status` request (`internal/postgres.CheckHealth`, see below) —
this is what lets Galley boot and keep serving while its database is
temporarily down, and is required by issue #52's acceptance criteria
("reports failure honestly when the database is down").

**Data access: [`pgx/v5`](https://github.com/jackc/pgx)**, via
`pgxpool.Pool` (`internal/postgres`), used directly with hand-written
SQL — no ORM, no query builder, no repository-per-table abstraction.
Chosen because issue #52 recommends it, it is the de facto standard
PostgreSQL driver for Go, and this slice adds exactly one table
(`diagnostic_notes`, development-only); an abstraction layer has
nothing to abstract yet and would be built ahead of the domain model
that #56 actually introduces.

**Nothing in this codebase ever logs or otherwise echoes
`DATABASE_URL`, in whole or in part.** Configuration errors describe
*what* is wrong (unset, wrong scheme, unparseable) without repeating
the value; `GET /api/status`'s `database.error` and the diagnostic
endpoints' error messages are fixed, generic strings, never derived
from the underlying driver error text. See `internal/postgres`'s
package doc for the full rationale.

## Database migrations

Versioned, **forward-only** SQL files live in `internal/migrations`
(embedded via `go:embed`, not read from disk at runtime — see that
package's doc). There are deliberately no `.down.sql` files: this
slice never runs a migration backward, so it does not carry one.

**Applying them is one documented command**, run against whichever
database `DATABASE_URL` names:

```sh
DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable go run ./cmd/migrate
```

This is reproducible from a genuinely empty database (`createdb
ticketit_dev` with nothing else done to it) — confirmed in
[`docs/evidence/m2/52-postgresql-persistence.md`](../../docs/evidence/m2/52-postgresql-persistence.md) —
and idempotent: running it again against an already-migrated database
reports the same version and changes nothing
([golang-migrate](https://github.com/golang-migrate/migrate)'s
`ErrNoChange`).

**Migrations do not run automatically at Galley's own startup
(`cmd/galley`).** `cmd/galley/main.go` never calls
`postgres.ApplyMigrations`; only `cmd/migrate` and the test suite's
setup helper (`internal/postgres.NewTestPool`) do. This is a
deliberate choice, not an oversight: applying schema changes is an
explicit, operator-triggered action, auditable independently of
"a process happened to restart," and avoids every Galley instance in a
future multi-instance deployment racing to migrate the same database
concurrently on every boot. The cost is one extra manual step before
running Galley against a schema change for the first time — documented
above and enforced by `GET /api/status`'s live migration-version field
making a not-yet-migrated database immediately visible rather than
silently wrong.

**Tooling: [`golang-migrate/migrate/v4`](https://github.com/golang-migrate/migrate)**,
used as an ordinary library dependency (`internal/postgres/migrate.go`)
via its `pgx/v5` database driver
(`golang-migrate/migrate/v4/database/pgx/v5`) and its `iofs` source
driver reading the embedded `internal/migrations.FS`. Chosen over
writing a hand-rolled migration runner because "versioned, forward-only
files with a documented apply command and a tracked applied version"
is exactly golang-migrate's job, it is the most widely used Go
migration tool, and its `pgx/v5` driver keeps the whole stack on one
PostgreSQL driver rather than introducing `lib/pq` (golang-migrate's
older default) alongside it. Not used as its own separate CLI binary
(the usual `migrate` command distributed via `go install`): that
binary's included database drivers are selected by build tags at
compile time (`-tags postgres`), which Go's `tool` directive (used
elsewhere in this module for `oapi-codegen`, see `contracts/README.md`)
has no way to pass through, and getting this wrong would silently
produce a `migrate` binary with no PostgreSQL support at all. Writing
the ~15-line `cmd/migrate` program in this repository instead sidesteps
that pitfall entirely and needs no build tags, since it imports exactly
the one driver it needs directly like any other Go code.

`schema_migrations` (the table golang-migrate's `pgx/v5` driver
maintains: one row, `version bigint` + `dirty boolean`) is the same
table `GET /api/status`'s live migration-version check reads —
`internal/postgres/health.go`, not a second, separate bookkeeping
mechanism.

## `GET /api/status`

Described in [`contracts/openapi.yaml`](../../contracts/openapi.yaml)
and bound to it via the generated `ServerInterface`
(`internal/httpapi/api.gen.go`, see "Generated types and the drift
check" below). Returns `200`, unauthenticated and free of secrets:

```json
{
  "application": "galley",
  "status": "ok",
  "version": "dev",
  "environment": "development",
  "startedAt": "2026-09-21T10:00:00Z",
  "database": { "status": "ok", "migrationVersion": 1 }
}
```

- `application` and `status` are constant (`"galley"`, `"ok"`).
- `version` and `environment` come from configuration.
- `startedAt` is the RFC3339 UTC process start time, captured once when
  the process boots and returned unchanged on every request.

**These five fields' names, values, and order are fixed** — Swiftlet's
client (issue #50) validates all five as non-empty strings and treats
a missing one as an error. This is why `database` (issue #52) was
appended after `startedAt` rather than inserted anywhere else, both in
[the contract](../../contracts/openapi.yaml) and in
`StatusResponse.MarshalJSON` (`internal/httpapi/status.go`).

`database` (issue #52) is checked **live, on every request** —
`internal/httpapi/status.go` calls `internal/postgres.CheckHealth`
fresh each time, never a boot-time snapshot cached in memory:

- `status`: `"ok"` or `"error"`. **Never `"ok"` when the database is
  unreachable or a query against it fails** — this is
  `CheckHealth`'s one required property, and
  `internal/httpapi/handler_test.go:TestGetStatus_DatabaseUnreachable`
  asserts it directly against a real pool pointed at a port nothing
  listens on.
- `migrationVersion`: the currently applied migration version
  (`schema_migrations.version`), or `null` if it could not be
  determined — either the database is unreachable (`status: "error"`)
  or it is reachable but nothing has been migrated yet (`status:
  "ok"`, `migrationVersion: null` — a normal state on a freshly
  created database, not a failure).
- `error`: present only when `status` is `"error"`. A fixed, generic
  string (e.g. `"database unreachable"`) — never the underlying
  driver's error text or any part of `DATABASE_URL`.

Unreachable-database example (`DATABASE_URL` pointing at a closed
local port):

```json
{
  "application": "galley",
  "status": "ok",
  "version": "dev",
  "environment": "development",
  "startedAt": "2026-09-21T09:14:27Z",
  "database": { "status": "error", "migrationVersion": null, "error": "database unreachable" }
}
```

Note that the top-level `status` stays `"ok"` — that field means "the
Galley *process* is running and answering requests," which remains
true even while its database is down; `database.status` is where a
database failure is reported.

## Development diagnostic (issue #52)

`GET`/`POST /api/dev/diagnostic-notes` persist and list a tiny
`diagnostic_notes` row (`note`, `createdAt`) — described in
[the contract](../../contracts/openapi.yaml), tagged `dev-diagnostic`.
Not a domain/Ticket concept; exists solely to prove data survives a
Galley restart against the same database
(`docs/evidence/m2/52-postgresql-persistence.md`).

```sh
curl -X POST http://localhost:8080/api/dev/diagnostic-notes -d '{"note":"hello"}'
curl http://localhost:8080/api/dev/diagnostic-notes
```

**Absent entirely in `GALLEY_ENVIRONMENT=production` — not merely
unauthorized, genuinely never registered.** `internal/httpapi/handler.go`'s
`NewHandler` registers every contract operation through the generated
`HandlerFromMux` against a `gatedMux` in any non-development
environment; `gatedMux.HandleFunc` silently drops registration for any
pattern under the fixed `/api/dev/` prefix instead of forwarding it to
the real `*http.ServeMux`. A request to either route in production
therefore falls through to the same shared `404 not_found` handler as
any path that was never described anywhere — proven, not just
asserted, by
`internal/httpapi/production_gating_test.go:TestDevDiagnosticRoutes_AbsentInProduction`,
which compares the response byte-for-byte (modulo the path named in
the message) against a request to a path this codebase has genuinely
never heard of. This gating happens at the one call site where
registration occurs, not as a check inside `diagnostic.go`'s handler
methods — those methods have no notion of "production" at all and do
not need one.

**Also requires a valid session as of issue #54.** A development-only
route is still a non-public one, and "every non-public route requires
a valid session" (see "Authenticated routes" below) makes no exception
for it: sign in first (below), then pass the session cookie.

## Owner configuration and GitHub OAuth sign-in (issue #54)

**Owner model.** A stable internal `owners` row, independent of any
GitHub identifier, plus exactly one linked `owner_identities` row
(`provider`, `provider_account_id`, `login`) — enforced as a true
one-per-deployment singleton at the database level
(`owners_singleton_uq`, `internal/migrations/000002_...up.sql`), not
just by application logic. `GALLEY_OWNER_GITHUB_LOGIN` is consulted
**only at bootstrap**: the very first successful sign-in resolves that
configured login to the identity's immutable numeric GitHub account id
and persists the link keyed on that id. Every sign-in after that
compares the fetched identity's id to the stored link's id, never to
`GALLEY_OWNER_GITHUB_LOGIN` again — so the Owner can rename their
GitHub account later without losing access, and a later edit to
`GALLEY_OWNER_GITHUB_LOGIN` cannot silently redirect access to a
different account once bootstrapped. See
`internal/auth.ResolveOwner`'s doc comment for the exact rule and
`docs/evidence/m2/54-oauth-session.md` for the reasoning.

**Sign-in flow**, all under `/api/auth/github/`:

1. `GET start` issues a fresh, high-entropy `state` (persisted hashed,
   10-minute expiry), binds it to the browser via a short-lived
   HttpOnly `state` cookie, and redirects to
   `GALLEY_OAUTH_GITHUB_BASE_URL/login/oauth/authorize`.
2. `GET callback?code=...&state=...` validates `state` against both
   the cookie and the persisted record **before looking at anything
   else** — a missing, mismatched, expired, or already-used value is
   rejected as `invalid_oauth_state` and the state row is consumed
   (deleted) either way, which is what defeats both replay and
   cross-session use (an attacker's `state` was never set as *this*
   browser's cookie). Only then does it exchange `code` for an access
   token and fetch the identity.
3. A non-owner identity is rejected with the stable `owner_mismatch`
   code (`403`): **no session, Owner record, or link is created or
   modified** on this path, whether or not an Owner already exists.
4. On success, a new session is persisted (opaque, high-entropy,
   stored only as its SHA-256 hash, with a fixed 30-day expiry —
   `internal/auth.SessionTTL`, not externally configurable in this
   slice) and delivered via an `HttpOnly`, `SameSite=Lax` cookie,
   `Secure` when `GALLEY_ENVIRONMENT=production`. `GET /api/session`
   returns the signed-in Owner; `DELETE /api/session` revokes it.

**The GitHub access token is discarded immediately after fetching the
identity in step 2 above — never stored, never logged, never reused
for any further provider call.** Signing in establishes identity only;
it is not authorization to act on the Owner's GitHub account.
Michelin's own local PAT and connected-account authorization for
actual GitHub actions are a separate, later concern (M8) — see
`docs/evidence/m2/54-oauth-session.md`.

**No real GitHub OAuth app exists anywhere in this repository**
(`AGENTS.md`, "Paid resources"): `internal/githubfake` is a local fake
provider server built from fixtures, used by every test in this
module. `GALLEY_OAUTH_GITHUB_BASE_URL`/`_API_BASE_URL` point at it in
tests and at real GitHub by default otherwise. Verifying this slice
against the real provider is an outstanding check owned by **M10**.

**`cmd/githubfake` (issue #55) is the same fixtures on a real port, for
a real browser.** `internal/githubfake.New`'s constructor takes a
`testing.TB` and only works inside a Go test binary; a browser (the
`e2e/` suite) needs an actual running process to navigate to, which is
what this command provides. **It is a test/development substitute
only** — never wired into this `cmd/galley` binary, never reachable
from a production build, and it never talks to real github.com or holds
a real credential. See `cmd/githubfake`'s own doc comment and
`e2e/README.md`, "Signing in," for how `e2e/run.sh` starts and
configures it.

**Owner bootstrap, concretely:** set `GALLEY_OWNER_GITHUB_LOGIN` to the
Owner's GitHub login, provision a real GitHub OAuth app (Owner-approved,
out of this slice's scope — see `AGENTS.md`, "Paid resources") and set
its client id/secret and `GALLEY_BASE_URL` to Galley's real
externally-reachable origin, then sign in once through the browser.
That first sign-in creates the one Owner row; nothing else needs
seeding.

## Authenticated routes (issue #54)

**Convention every later slice adding a Galley route should follow:**
a handler for a non-public route calls `s.requireSession(w, r)` first
and returns immediately if it reports `false` — the `401
unauthenticated` response has already been written in the shared error
shape. See `internal/httpapi/auth.go`. This is a plain per-handler
check, not a global middleware wrapping every generated operation:
`GET /api/status` must stay public and leak no Owner or configuration
detail, so a blanket middleware over the whole generated
`ServerInterface` would be the wrong shape here — see
`internal/httpapi/handler.go`'s `gatedMux` for the same
"registration/dispatch, not implicit," philosophy applied to a
different property (route *existence*, not route *access*).

Every currently non-public route uses it: `GET`/`DELETE /api/session`
(the whole point of those two) and, retrofitted by this slice, both
development-only diagnostic-note operations — a development-only route
is still non-public, and this rule makes no exception for it.

## Error shape

`ErrorBody`/`ErrorDetail` are generated from
[`contracts/openapi.yaml`](../../contracts/openapi.yaml) (see below).
Every error response — currently unknown routes and method mismatches —
uses this shared JSON shape:

```json
{
  "error": {
    "code": "not_found",
    "message": "no route for GET /nope"
  }
}
```

`code` is a short, stable, snake_case machine-readable identifier;
`message` is a human-readable, non-secret explanation. Codes so far:

| Situation                                   | Status | `code`               |
| -------------------------------------------- | ------ | --------------------- |
| No route matches the request path            | `404`  | `not_found`            |
| Route exists, method not allowed on it       | `405`  | `method_not_allowed`   |
| Diagnostic request body fails validation (#52) | `400`  | `invalid_request`   |
| A database query failed (#52, #54)           | `503`  | `database_unavailable` |
| No/invalid/expired session on a protected route (#54) | `401` | `unauthenticated` |
| OAuth `state` missing, mismatched, expired, or replayed (#54) | `400` | `invalid_oauth_state` |
| OAuth callback missing `code` (#54)          | `400`  | `invalid_request`      |
| Provider communication failed, or reported its own error (#54) | `502`/`400` | `oauth_provider_error` |
| Sign-in identity is not the configured Owner (#54) | `403` | `owner_mismatch`      |

A `405` response also carries an `Allow` header naming the accepted
method(s).

**Every later slice that adds a Galley endpoint should reuse this exact
shape** (`internal/httpapi.ErrorBody` / `ErrorDetail`) for its own error
responses, rather than defining a new one.

## Router choice

Routing uses only the standard library's `net/http.ServeMux`, using the
method- and pattern-aware routing added in Go 1.22 (e.g.
`mux.HandleFunc("GET /api/status", ...)`). No third-party router
(`chi`, `gorilla/mux`, `httprouter`, ...) is used.

**Why:** this slice has a handful of fixed routes with per-method
dispatch — exactly what the enhanced `ServeMux` was built for. Pulling
in a third-party router would add a dependency (and a `go.sum`) for
capability the standard library already provides. `ServeMux`'s
documented pattern-specificity rules are used deliberately for
method-mismatch handling: a method-qualified pattern (`"GET
/api/status"`) is strictly more specific than the same path without a
method (`"/api/status"`) and always wins when both could match, so
registering both together yields a 200 for `GET` and routes every other
method to a handler that returns the shared `405` error shape. A
pattern ending in `/` (just `"/"`) is a subtree match that catches every
path neither of the above claims, which becomes the shared `404`
handler. See `internal/httpapi/handler.go` for the implementation and
`internal/httpapi/handler_test.go` for tests confirming this precedence
empirically (not just by reading the documentation). If Galley's routing
needs ever outgrow this (e.g. complex path parameters, per-route
middleware chains), revisit this choice explicitly and record the
change here.

## Generated types and the drift check

`internal/httpapi/api.gen.go` is generated from
[`contracts/openapi.yaml`](../../contracts/openapi.yaml) by
[oapi-codegen](https://github.com/oapi-codegen/oapi-codegen) v2.8.0
(pinned in `go.mod`'s `tool` directive), configured by
[`contracts/galley/oapi-codegen.config.yaml`](../../contracts/galley/oapi-codegen.config.yaml)
to emit both the schema types (`StatusResponse`, `ErrorBody`,
`ErrorDetail`) and a `ServerInterface` for Go 1.22+'s `net/http`
routing style — the same style this package already uses (see "Router
choice" above), so adopting it required no router migration.
**Do not hand-edit `api.gen.go`** — see
[`contracts/README.md`](../../contracts/README.md) for the full
"contract first, then implement" convention.

Regenerate after editing the contract:

```sh
cd apps/galley
go generate ./...
```

Two independent checks guard against the contract and the
implementation disagreeing (see `contracts/README.md`, "The drift
check", for the full explanation and for both checks caught failing on
a deliberate mismatch):

```sh
# 1. The real handler's response validates against the contract's schema.
go test ./internal/httpapi/... -run Contract -v

# 2. Regenerating the contract produces no diff against the committed file.
./scripts/check-contract-drift.sh
```

Two overrides exist solely to keep `GET /api/status`'s response bytes
unchanged by the move to generated types: `startedAt` carries
`x-go-type: string` in the contract (keeping it a plain Go `string`
rather than oapi-codegen's default `time.Time`, whose marshaling could
add fractional seconds Galley never produced), and
`internal/httpapi/status.go` defines `StatusResponse.MarshalJSON` to
hold the field order (oapi-codegen emits struct fields alphabetically by
property name, which `encoding/json` then serializes in that order).
Both are commented at the point of use.

## CORS

No CORS headers are added. The browser reaches Galley only through
Swiftlet's dev proxy (issue #50): the proxy forwards `/api/*`
server-side from Swiftlet's own dev server, so the browser only ever
talks to Swiftlet's origin and CORS is never invoked. This is a narrow,
recorded decision, not an oversight — if a future client ever needs
genuine cross-origin browser access to Galley, that requires its own
explicit, narrowly-scoped CORS decision, not a permissive default added
here.

## Structured logging and graceful shutdown

Every request is logged as one structured JSON line (via `log/slog`) to
stdout with `method`, `path`, `status`, `duration_ms`, and
`remote_addr`.

On `SIGINT` or `SIGTERM`, Galley stops accepting new connections, lets
in-flight requests finish (`http.Server.Shutdown`, bounded by a 10s
timeout), and only then exits — releasing the listening socket. This is
verified by an automated test
(`cmd/galley/main_test.go:TestRun_ServesStatusThenShutsDownCleanly`)
that boots the real server on an OS-assigned port, serves a real
request over it, triggers shutdown, and then proves the socket was
released by successfully re-binding the exact same address — and
manually with a real process and `kill -TERM`/`kill -INT` (see
`docs/evidence/m2/49-galley-boot.md`).

## Local PostgreSQL setup

This repository does not provision any hosted database (see
`AGENTS.md`, "Paid resources") — everything runs against a local
PostgreSQL instance. One-time setup, against any local PostgreSQL
server your user can create databases on:

```sh
createdb ticketit_dev    # for `go run ./cmd/galley`
createdb ticketit_test   # for `go test ./...`, see below
```

Then apply migrations to `ticketit_dev` (see "Database migrations"
above); `ticketit_test` does not need this run manually, since the
test suite applies migrations to it itself (next section). Do not
reuse a database another slice's evidence already occupies (for
example any leftover M1 experiment database) — create ticketIt's own.

## Testing against real PostgreSQL

**`go test ./...` uses real PostgreSQL — no in-memory or fake database
substitute, anywhere in this module.** Every test that needs a
database calls `internal/postgres.NewTestPool(t)`, which:

1. Applies every migration in `internal/migrations` to the test
   database (idempotent — a no-op if already applied), so `go test
   ./...` is reproducible from a genuinely empty `ticketit_test`
   database with the one setup command above and nothing else.
2. Connects and pings it, failing the test immediately with an
   actionable message (naming the database it tried to reach, never
   the full connection string) if that fails.

By default this targets `postgres://localhost:5432/ticketit_test?sslmode=disable`
(`internal/postgres.TestDatabaseURL`); override with
`GALLEY_TEST_DATABASE_URL` for a differently-named or
differently-hosted test database:

```sh
go test ./...
# or, against a non-default test database:
GALLEY_TEST_DATABASE_URL=postgres://localhost:5432/some_other_db?sslmode=disable go test ./...
```

`cmd/galley/restart_durability_test.go`'s
`TestRestartDurability_DiagnosticNoteSurvivesFreshProcess` (issue #52's
required restart-durability test; extended by issue #54 to also sign
in and prove `GET /api/session` resolves through the restart) builds
the real `galley` binary and runs it as two separate OS processes in
sequence against this same database — not two calls to `run()` in one
test binary, which the issue explicitly rules out as insufficient
("not just a new database connection or a transaction commit"). See
`docs/evidence/m2/52-postgresql-persistence.md` and
`docs/evidence/m2/54-oauth-session.md` for how each was verified and
its actual output.

**Shared Owner fixture across every test package (issue #54).** The
Owner is a true database-level singleton
(`owners_singleton_uq`), and every Go test package that needs a valid
sign-in shares this one, real, persistent `ticketit_test` database —
so `internal/githubfake.TestOwnerIdentity` is the one fixture identity
every package's tests sign in as, rather than each inventing its own:
whichever test process bootstraps the Owner first, every other test's
sign-in as that same identity still succeeds by matching the existing
link. `internal/auth.ResolveOwner` also tolerates losing that
first-bootstrap race outright (a unique-constraint violation on
concurrent insert), re-resolving against the winner's row instead of
failing — needed because `go test ./...`'s packages normally run as
concurrent OS processes against this same database.

## Layout

```text
apps/galley/
├── go.mod
├── go.sum
├── README.md               # this file
├── scripts/
│   └── check-contract-drift.sh  # drift check part 2: regeneration produces no diff
├── cmd/
│   ├── galley/             # main package: wiring, config load, graceful shutdown
│   │   └── restart_durability_test.go  # issue #52: real two-process restart test
│   ├── migrate/            # issue #52: the one documented migration-apply command
│   └── githubfake/         # issue #55: standalone substitute GitHub provider on a
│                           #   real port -- test/development only, never cmd/galley
└── internal/
    ├── config/             # environment parsing and validation (incl. DATABASE_URL, #52; owner/OAuth, #54)
    ├── migrations/         # embedded, versioned, forward-only SQL files (#52, #54)
    ├── postgres/           # issue #52: pgxpool wrapper, live health check, migration runner,
    │                       #   and the real-PostgreSQL test-setup helper (NewTestPool)
    ├── auth/                # issue #54: tokens/hashing, sessions, oauth state, Owner
    │                       #   resolution, and the GitHub OAuth client -- no HTTP here
    ├── githubfake/          # issue #54: local fake GitHub OAuth/identity server (fixtures);
    │                       #   issue #55 refactored Start (real-port, no testing.TB) out of
    │                       #   New (Go-test cleanup wrapper) for cmd/githubfake above
    ├── authtest/            # issue #54: browser-simulating sign-in helper shared by tests
    └── httpapi/            # routing, status handler, shared error shape, request logging
        ├── api.gen.go      # generated from contracts/openapi.yaml — DO NOT EDIT
        ├── generate.go     # the //go:generate directive that produces api.gen.go
        ├── contract_test.go  # drift check part 1: response validates against the contract
        ├── diagnostic.go   # issue #52: the two development-only diagnostic-note handlers
        ├── production_gating_test.go  # issue #52: proves those routes absent in production
        ├── auth.go         # issue #54: the four OAuth/session handlers + requireSession
        └── cookies.go      # issue #54: session/state cookie construction
```

## Exact versions and toolchain

- Go: `1.27.1` (darwin/arm64), pinned in `go.mod`'s `go` directive.
- `github.com/getkin/kin-openapi` `v0.149.0` — an ordinary `require`,
  used only by `internal/httpapi/contract_test.go` (the drift check;
  see "Generated types and the drift check" above).
- `github.com/oapi-codegen/oapi-codegen/v2` `v2.8.0` — a `tool`
  dependency (Go 1.24+'s `go.mod` `tool` directive), used only by
  `go generate`. Its own dependency graph (several `github.com/`,
  `golang.org/x/`, and YAML/JSON-Schema packages) is why `go.sum`
  exists now; none of it is linked into the built `galley` binary.
- The generated `api.gen.go` itself imports only the standard library
  (`fmt`, `net/http`) — generating it added no runtime dependency to
  the actual served application, only to the tool that produces it and
  to the test that checks it.
- `github.com/jackc/pgx/v5` `v5.11.0` (issue #52) — an ordinary
  `require`, Galley's PostgreSQL driver and connection pool
  (`pgxpool`), linked into the built `galley` binary.
- `github.com/golang-migrate/migrate/v4` `v4.20.1` (issue #52) — an
  ordinary `require`, used by `internal/postgres/migrate.go` (and thus
  by `cmd/migrate` and by the test suite's `NewTestPool`) via its
  `pgx/v5` database driver and `iofs` source driver. Also linked into
  the built `galley` binary indirectly, via `internal/postgres`, even
  though `cmd/galley` itself never calls `ApplyMigrations` (see
  "Database migrations" above) — `go build` cannot statically prove a
  function is never called at runtime, only that the package is
  imported.
- `github.com/jackc/pgerrcode` `v0.0.0-20220416144525-469b46aa5efa` (issue #52) — a small, fixed constants
  package (SQLSTATE codes), pulled in transitively by
  golang-migrate's `pgx/v5` driver and used directly by
  `internal/postgres/health.go` (unreachable database) and, since
  issue #54, `internal/auth/owner.go` (recognizing a concurrent
  Owner-bootstrap race) to recognize specific SQLSTATE codes without
  hardcoding the raw string.
- `github.com/oapi-codegen/runtime` `v1.7.0` (issue #54) — an ordinary
  `require`, added by regenerating `api.gen.go` once the contract
  gained operations with query parameters (`code`/`state`/`error` on
  the OAuth callback); used by the generated
  `ServerInterfaceWrapper.CompleteGithubOAuth` to bind those parameters.
  Pulls in `github.com/apapsch/go-jsonmerge/v2` and
  `github.com/google/uuid` as its own indirect dependencies.
- Issue #54 added no other runtime dependency: `internal/auth` and
  `internal/githubfake` use only the standard library (`crypto/rand`,
  `crypto/sha256`, `net/http`, `encoding/json`) plus `pgx/v5`, already
  present.

PostgreSQL server: `17.11` (Homebrew, `localhost:5432`) on the machine
this slice's evidence was recorded on — any reasonably recent
PostgreSQL should work; nothing here depends on a specific server
version beyond ordinary SQL and `GENERATED ALWAYS AS IDENTITY`
(PostgreSQL 10+).

See `docs/evidence/m2/49-galley-boot.md` for issue #49's original
verification record, `docs/evidence/m2/52-postgresql-persistence.md`
for issue #52's, and `docs/evidence/m2/54-oauth-session.md` for this
slice's full reproducible verification record (commands and their
actual output).

## Browser-to-backend suite

Galley's own tests stop at its HTTP boundary. The browser suite in
[`e2e/`](../../e2e/README.md) drives a real browser against a real
Swiftlet build proxying to a real Galley on real PostgreSQL:

```sh
cd e2e && ./run.sh
```

It builds and starts Galley itself on a free port against its own
database; it does not use a Galley you already have running.
