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
was still no domain/Ticket table at that point.

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

[Issue #56](https://github.com/cristoforows/ticketIt/issues/56) added
Galley's first domain record: the `tickets` table and the
`GET`/`POST /api/tickets` operations. See "Tickets" below.

[Issue #57](https://github.com/cristoforows/ticketIt/issues/57) added
`GET /api/tickets/{id}` and the `public_id` column every Ticket
operation now returns instead of the internal sequential id. See
"Tickets", "Public identifier" and "Getting one Ticket" below.

[Issue #58](https://github.com/cristoforows/ticketIt/issues/58) added
manual refinement: `goal`, `context`, `successCriteria`, and
`constraints` columns, and `PATCH /api/tickets/{id}` -- a genuine
partial update, not a replace-whole-resource PUT. See "Manual
refinement fields" below.

[Issue #59](https://github.com/cristoforows/ticketIt/issues/59) added
the two built-in Ticket Templates (`Basic`, `Coding`), a Ticket's own
retained `completionCondition` (derived from the Template's default
exactly once, at creation, per the accepted D3 decision), and one
`repository` reference column available on either Template. See
"Ticket Templates and the retained completion condition" below.

[Issue #60](https://github.com/cristoforows/ticketIt/issues/60) added
an Assignee (Owner-only in M2), the authoritative Status state machine
implementing D3 S2's human-assigned workflow table, and the explicit
Accept command -- `POST /api/tickets/{id}/status`,
`POST /api/tickets/{id}/accept`, and `PUT`/`DELETE /api/tickets/{id}/assignee`.
See "Human-assigned lifecycle transitions and the Assignee" below.

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
are required (see "Database configuration" and "Owner configuration and
GitHub OAuth sign-in" below). `GALLEY_BASE_URL` is also required in
production; development defaults to `http://localhost:8080`. By
default Galley listens on `:8080` (all interfaces, port 8080) and serves:

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

Galley reads configuration from the environment at startup. Optional
settings have explicit defaults; a value that is present but cannot be
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
| `GALLEY_BASE_URL`     | `http://localhost:8080` in development; required in production | Browser-facing HTTP(S) origin with host and no path, query, or fragment; builds the fixed OAuth `redirect_uri`. See below. |
| `GALLEY_SESSION_TTL`  | `720h`        | Session lifetime (database expiry and cookie `Expires`), a positive Go duration (`time.ParseDuration`, e.g. `12h`, `168h`). |

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
   stored only as its SHA-256 hash, expiring after `GALLEY_SESSION_TTL`,
   default 30 days) and delivered via an `HttpOnly`, `SameSite=Lax` cookie,
   `Secure` when `GALLEY_ENVIRONMENT=production`. `GET /api/session`
   returns the signed-in Owner; `DELETE /api/session` revokes it.

Expired rows are garbage-collected opportunistically, with no
background job: step 1 deletes every expired `oauth_states` row, and
step 4 every expired `sessions` row, before inserting its own.

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
[Issue #56](https://github.com/cristoforows/ticketIt/issues/56)'s
`GET`/`POST /api/tickets` (below) follow the same convention.

## Tickets (issue #56)

Galley's first domain record. `internal/httpapi/ticket.go` implements
the generated `ListTickets`/`CreateTicket` operations against the
`tickets` table (`internal/migrations/000003_create_tickets.up.sql`),
hand-rolled against the pool like `diagnostic.go` — one new table does
not yet justify a repository layer.

**No work-type or category column.** Tickets stay a generic unit of
work — see `docs/ticket-creation.md`, "Flexible ticket structure." The
table holds only an internal id, an `owner_id` reference, `title`,
`status`, and `created_at`/`updated_at`.

**`POST /api/tickets` only ever produces Backlog.** Per
`docs/ticket-creation.md`, "Quick capture," a title alone is sufficient
to capture a Ticket; there is no transition endpoint yet (that is
[#60](https://github.com/cristoforows/ticketIt/issues/60)). `status` is
stored as plain `TEXT`, not a `CHECK`-constrained column: this slice's
Galley code is the only writer of this table (ADR 0001) and only ever
writes `'Backlog'`, so a `CHECK` enumerating every `CONTEXT.md` Status
name today would duplicate that enforcement now and need its own
migration the moment #60 adds real transitions.

**Title validation:** required, trimmed of leading/trailing whitespace,
and non-empty and at most 200 characters after trimming — violations
return `invalid_request` in the shared error shape. 200 was chosen as a
round number comfortably longer than a real one-line title while
staying under the title limits GitHub (256) and Jira (255) use for the
same kind of field; enforced in `CreateTicket`, not merely documented
in the contract's `minLength`/`maxLength` (those are hints for
generated-client consumers, not runtime validation for this
hand-rolled handler). Length is counted in characters (code points,
`utf8.RuneCountInString`), matching what JSON Schema's `maxLength`
means — a byte count would reject a contract-valid CJK or emoji title
at roughly a third of the documented limit.

**Ticket ordering: the Owner's priority order, `priority_rank, id`.**
Issue #131 replaced the original newest-first order; see "Priority
order (issue #131)" below. The Archived filter orders by
`archived_at DESC, id DESC`.

**Ownership.** Both operations call `requireSession` first: an
unauthenticated request is rejected with `401 unauthenticated` before
either query runs. Every Ticket is created with `owner_id` set to the
resolved session's Owner, and `ListTickets` scopes its query to
`WHERE owner_id = $1`. Today there can only ever be one Owner
(`owners_singleton_uq`), so a second real Owner can never exist to
prove that scoping against; `TestListTicketsForOwner_ScopedToOwner`
instead queries with a synthetic owner id that can never belong to any
real Owner (ids are small, sequential integers; this one is offset far
outside that range) and asserts a ticket belonging to the real Owner is
never returned for it — a regression to an unscoped `SELECT * FROM
tickets` would fail this immediately. See that test's own comment for
why it does not instead construct a second real Owner row (doing so
would break `auth_test.go`'s `TestOAuthSignIn_HappyPath`, which asserts
exactly one `owners` row exists in this same shared database).

### Public identifier (issue #57)

**Every Ticket operation returns `public_id` as `id` — the internal
sequential `BIGINT` primary key is never exposed by any Galley
endpoint, and no consumer of `id` outside this package should ever see
it change meaning back.** Before this slice, `id` was the sequential
database primary key; a client could enumerate every Ticket by
incrementing an integer, and the issue's own instruction is to "prefer
a non-guessable, non-sequential public identifier" for URLs. Two shapes
were available: add a second, separate `publicId` field alongside the
existing sequential `id`, or replace what `id` means everywhere. This
slice replaces it — keeping two identifiers on the wire (one of them
still sequential) would still let a client observe insertion order,
which is exactly what a non-guessable identifier is meant to prevent,
and the issue is explicit that whichever shape is chosen must be
applied "consistently across the contract," not left exposing a
sequential id in one response and an opaque one in another.

**Column:** `internal/migrations/000004_add_ticket_public_id.up.sql`
adds `tickets.public_id UUID NOT NULL UNIQUE`, backfilled for
pre-existing rows via PostgreSQL's built-in `gen_random_uuid()` (core
since PostgreSQL 13, confirmed against this deployment's 17.11 — no
`pgcrypto` or other extension needed). Backfilling was required, not
optional: this project's migrations are forward-only
(`apps/galley/README.md` — this file — "Database migrations"), and
`ticketit_dev`/`ticketit_test` already held Tickets from #56 before
this slice ran. New rows generate their own `public_id` in Go
(`insertTicket`'s `uuid.NewString()`, [`github.com/google/uuid`](https://github.com/google/uuid),
already an indirect dependency via `oapi-codegen/runtime` before this
slice promoted it to direct) rather than relying on the column's
`DEFAULT` — matching how every other identifier in this codebase
(session tokens, OAuth `state`) is generated in application code. The
internal `id` column is untouched and remains every foreign key's
target (`docs/adr/0001-single-authority-galley.md`'s single-authority
model has nothing to do with which id a client sees); only what the
HTTP API exposes changed.

**Contract:** `Ticket.id`'s schema changed from `type: integer` to
`type: string, format: uuid`. `format: uuid` is documentation only —
`x-go-type: string` keeps the generated Go field (and the
`GET /api/tickets/{id}` path parameter) a plain `string`, exactly like
`startedAt`'s own override (see "Generated types and the drift check"
below) and matching this contract's existing convention that a
format/length constraint documents intent for generated-client
consumers without oapi-codegen enforcing it at bind time
(`CreateTicketRequest.title`'s `maxLength` is the precedent). This was
deliberate, not a shortcut: oapi-codegen's default for `format: uuid`
would bind through `github.com/oapi-codegen/runtime/types.UUID`
(itself `google/uuid.UUID`), which rejects a malformed value **before**
the handler ever runs — via the generated wrapper's own error path,
which answers with a bare `http.Error` in a different shape than this
contract's shared `ErrorBody`. Keeping the Go type a plain string
means every identifier this endpoint might see (well-formed, malformed,
unknown, or belonging to another Owner) reaches `GetTicket` itself,
which folds all but the well-formed-and-owned case into the exact same
`404 not_found` — see "Getting one Ticket" below.

### Getting one Ticket (issue #57)

`GET /api/tickets/{id}` (`internal/httpapi/ticket.go`'s `GetTicket`)
returns one Ticket by its public identifier, scoped to the signed-in
Owner exactly like `ListTickets`. **A malformed identifier, an unknown
identifier, and an identifier belonging to another Owner all produce
the exact same `404 not_found` response** — this is the issue's own
requirement ("never reveal that a record exists but belongs to someone
else"), proven byte-for-byte, not just asserted, by
`TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable`
(compares the two response bodies directly, the same technique
`production_gating_test.go` uses to prove two responses are identical
rather than merely similar).

Concretely: ticket handlers parse the identifier and pass its canonical
UUID string to PostgreSQL (including when a caller supplies a UUID URN).
A value that fails to parse is rejected as `404 not_found` before ever
reaching the database. This is not only a privacy choice; it is also
required for correctness. `getTicketForOwner`'s query filters with
`public_id = $2::uuid`, and PostgreSQL has **no cast at all** (checked
directly against `pg_cast`, not assumed) from `text` to `uuid` — a
malformed value would otherwise fail the query itself with a syntax
error, which this handler would then have to distinguish from "no
rows" to avoid mis-reporting a malformed identifier as
`503 database_unavailable`. Validating first avoids that distinction
being needed at all.

**Owner-scoping proof, singleton limitation.** Exactly like
`TestListTicketsForOwner_ScopedToOwner` (see "Ownership" above),
`owners` being a true one-row-per-deployment singleton means a second
real Owner cannot be constructed to prove "another Owner's Ticket
returns 404" by actually creating one. `TestGetTicket_ScopedToOwner`
follows the same technique: it calls `getTicketForOwner` directly with
a bogus owner id that can never belong to any real Owner, for a Ticket
that does exist under the real Owner, and asserts it is not found —
proving the same `WHERE owner_id = $1 AND public_id = $2::uuid` filter
that also backs `ListTickets`'s scoping is what stands between any
non-owning caller and a Ticket that exists.

### Manual refinement fields (issue #58)

`POST /api/tickets` also accepts the optional `goal`, `context`,
`successCriteria`, `constraints`, and `repository`, validated by the
same `validateRefinementFields` as `PATCH` and stored in the same
`INSERT` as the Ticket. Omitted, `""`, and whitespace-only values are
stored as `NULL` (unset); a value over its limit is rejected with
`invalid_request` and nothing is created.

`PATCH /api/tickets/{id}` (`internal/httpapi/ticket.go`'s
`UpdateTicket`) edits a Ticket's `title`, `goal`, `context`,
`successCriteria`, and `constraints` by hand
(docs/ticket-creation.md, "Manual guidance"). The four new columns are
added by
`internal/migrations/000005_add_ticket_refinement_fields.up.sql`,
nullable `TEXT`, backing every existing row with `NULL` ("never set")
— no backfill was needed, unlike issue #57's `public_id`, since `NULL`
is itself a valid, meaningful value here. No AI of any kind is
involved and this triggers nothing else. Identifier handling mirrors
`GetTicket` exactly: `requireSession` first, then `uuid.Parse`, with a
malformed value folded into the same `404 not_found` an unknown or
cross-owner identifier produces.

**This is a genuine partial update, not a replace-whole-resource
PUT.** Every property on `UpdateTicketRequest` is optional at the
schema level (none are in `required`), which is what makes the three
required cases distinguishable on the wire and in Go:

1. **Absent** from the request body → `encoding/json` leaves the
   generated Go field `nil` (`*string`, `json:"...,omitempty"`) →
   `updateTicketForOwner`'s `SET column = COALESCE($n, column)` sees a
   SQL `NULL` parameter and keeps the existing value.
2. **Present, set to `""`** (or a value that trims to `""` --
   whitespace-only is treated the same as an explicit `""`, a
   deliberate conflation) → a non-nil pointer to `""` → `COALESCE`
   receives a genuine non-NULL empty string, which wins, clearing the
   field.
3. **Present with text** → trimmed, validated against its documented
   maximum length (below), and stored.

Explicit JSON `null` is rejected for every request property; it cannot
stand in for an absent PATCH field. `{}` remains a valid PATCH body.

A bare (non-pointer) `string` field cannot distinguish case 1 from
case 2 — this is exactly the trap issue #58 itself names (a title-only
PATCH must never wipe the other four fields), and is why
`ticketUpdate`'s fields and `updateTicketForOwner`'s SQL are pointer-
based end to end. See `docs/evidence/m2/58-refinement-fields.md`,
"Decision 1," for the full reasoning and a captured red run of the
regression this guards against.

**`title` is the one exception: it can be set or left absent, but
never cleared.** A `title` that trims to `""` is rejected with
`invalid_request` — every Ticket must keep a title — while the same
trimmed-to-`""` value on any of the other four fields is a valid
"clear this field" request.

**Field length limits**, applied after trimming, in characters
(`utf8.RuneCountInString`, matching `ticketTitleMaxLength`'s existing
rule — not bytes; see "Title validation" above for why byte-counting
would reject a contract-valid non-ASCII value):

| Field | Max length |
| --- | --- |
| `title` | 200 |
| `goal` | 2000 |
| `context` | 10000 |
| `successCriteria` | 2000 |
| `constraints` | 2000 |

`context` gets a larger limit because docs/ticket-creation.md's own
prompt for it ("Supply relevant background, links, repositories, or
examples") anticipates pasted reproduction steps and multiple links,
not a short statement. None of these columns carry a database `CHECK`
constraint — matching `tickets.status`'s existing rationale, this
slice's Galley code is the only writer (ADR 0001) and enforces the
limit itself, so a `CHECK` would duplicate that enforcement and need
its own migration if a limit ever changed.

**Concurrent-edit rule: last-write-wins, with no optimistic
concurrency check.** There is no version token, `ETag`, or `If-Match`
precondition anywhere in this operation — `updateTicketForOwner`'s
`UPDATE ... WHERE owner_id = $1 AND public_id = $2::uuid` always
applies unconditionally. Two PATCH requests naming disjoint fields
both apply (each only ever touches the columns it names via
`COALESCE`); two PATCH requests naming the *same* field apply in
whichever order the database serializes them, and the later one's
value silently overwrites the earlier one's with no error or merge.
This is deliberate and explicitly permitted by issue #58, not an
oversight — a future milestone needing conflict detection would add a
version column and a precondition check explicitly.

**Every PATCH bumps `updated_at`, even one whose body names no field
at all.** There is no "did anything actually change" check — a PATCH
request is itself an explicit Owner action worth recording as "last
touched now." `createdAt` never changes; it is a Ticket's immutable
capture time.

**Storage: plain text, never Markdown.** All four fields are stored
and returned as plain `TEXT` with no parsing of any kind. If a future
slice ever renders them as Markdown, that must be stated explicitly
and handled safely at render time (Swiftlet or a later report-
rendering surface) — Galley itself performs no interpretation beyond
trimming and length-checking. Report rendering is M7's, per issue
#58's own scope statement.

**Owner-scoping and 404-parity proof, singleton limitation.** Same
inherited limitation as `GetTicket`/`ListTickets` above:
`TestUpdateTicket_ScopedToOwner` calls `updateTicketForOwner` directly
with a bogus owner id that can never belong to any real Owner, since
`owners`'s true one-row-per-deployment singleton means a second real
Owner cannot be constructed to prove this end to end.

### Ticket Templates and the retained completion condition (issue #59)

Follows the accepted [D3 decision](../../docs/decisions/d3-agent-template-compatibility.md):
a Ticket's Template supplies presentation, required information, and a
**default** completion condition only — it never restricts which
Agent or execution engine may be assigned. M2 has no Agent, Assignee,
Round, or engine concept at all (`AGENTS.md`, "No AI, Agents, Rounds,
or Michelin in M2"), so this slice's only obligation is to prove no
such mapping exists yet, and to derive and then permanently retain a
Ticket's completion condition.

**Two new columns, one repository reference**, added by
`internal/migrations/000006_add_ticket_template_and_completion_condition.up.sql`:
`template` (`TEXT NOT NULL DEFAULT 'Basic'`) and `completion_condition`
(`TEXT NOT NULL DEFAULT 'humanAcceptance'`) — backfilled correctly by
their own `DEFAULT`, not a data migration, since every Ticket captured
before this migration went through the Basic-only `CreateTicket` path
with human acceptance as its completion condition. `repository`
(nullable `TEXT`, no `DEFAULT`) is the **one** Ticket repository
reference D3 §1 check 3 requires, available on either Template — not a
competing Basic-only concept, and not required by anything in M2.
None of the three carries a `CHECK` constraint, matching
`tickets.status`'s existing rationale (this slice's Galley code is the
only writer, ADR 0001, and enforces the two-value enums itself via the
generated `TicketTemplate`/`TicketCompletionCondition` types' `Valid()`
methods).

**`template` is chosen at capture, `completionCondition` is derived
from it exactly once.** `POST /api/tickets`'s optional `template`
(`Basic` or `Coding`, defaulting to `Basic` when absent) is validated
with the generated enum's own `Valid()` method, then passed to
`insertTicket`, whose **one and only call anywhere in this codebase**
to `defaultCompletionCondition` computes the stored
`completion_condition` (`Coding` → `reviewedPrMerge`, everything else →
`humanAcceptance`). No other function in this module ever calls
`defaultCompletionCondition` or otherwise writes to
`completion_condition` — `updateTicketForOwner`'s `SET` clause does not
name that column at all, not merely leave it at its `COALESCE`
default, which is what makes "retained independently of later edits"
true by construction rather than by a check that could be bypassed.

**Changing a Ticket's Template after creation is out of scope for M2
(D4, owned by M8) — enforced explicitly, not by silent omission.**
`UpdateTicketRequest.template` exists in the contract precisely so a
request naming it can be told apart from one that does not: `UpdateTicket`
rejects any PATCH naming `template` at all — even the Ticket's own
current value — with `invalid_request`, before validating any other
field or touching the database. `completionCondition` has no
corresponding request field anywhere in this contract; there is no
path, rejected or otherwise, that could set it directly.

**The guardrail test with real teeth**
(`internal/httpapi/template_capability_guardrail_test.go`'s
`TestNoTemplateToCapabilityMapping`) parses every non-generated,
non-test `.go` file in this module with `go/parser`, finds every
syntactic reference to a Template/completion-condition identifier
(`TicketTemplate`, `Basic`, `Coding`, `TicketCompletionCondition`,
`HumanAcceptance`, `ReviewedPrMerge`), attributes each to its enclosing
top-level function (or to package scope, for a reference outside any
function), and fails unless that attribution set is exactly the
closed, reviewed allowlist (`CreateTicket`, `UpdateTicket`,
`insertTicket`, `scanTicketRow`, `updateTicketForOwner`,
`defaultCompletionCondition`). A future change that makes an Agent,
Assignee, or engine depend on a Ticket's Template — anywhere in this
module — adds a reference this test does not already know about and
fails immediately. See
[`docs/evidence/m2/59-ticket-templates.md`](../../docs/evidence/m2/59-ticket-templates.md)
for a captured run proving this (a deliberately added mapping function,
and separately a mapping variable, both caught and reverted), and for
the retained-completion-condition proof across a genuine Galley
restart (`cmd/galley`'s
`TestRestartDurability_CompletionConditionSurvivesFreshProcess`) and
against a deliberately mismatched fixture row
(`TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate`) that
a naive "never changes across the same-pairing tests I happen to run"
test would not catch.

### Human-assigned lifecycle transitions and the Assignee (issue #60)

Implements the accepted [D3 decision](../../docs/decisions/d3-agent-template-compatibility.md)
S2's human-assigned workflow table and S4's rejections: an Assignee
(`internal/migrations/000007_add_ticket_assignee.up.sql`'s nullable
`assignee_type TEXT` -- `"owner"` or unassigned in M2; #127 adds
`"agent"`, see "Agents and Agent assignment"), a Status state machine
(`internal/httpapi/ticket_lifecycle.go`), and the four commands that
change either: `POST /api/tickets/{id}/status`,
`POST /api/tickets/{id}/accept`, and
`PUT`/`DELETE /api/tickets/{id}/assignee`.

**The D3 S2 table is inverted by target Status**, not inferred or generalised
(`allowedSourceStatusesForTarget`): ten allowed (from, to) pairs,
including Owner-approved `Backlog -> Blocked` ([#87](https://github.com/cristoforows/ticketIt/issues/87)),
plus `Blocked -> Ready` for an Agent-assigned Ticket only
(`agentRecoveryFromBlocked`, #161: the Owner's explicit recovery after a
Failed or Interrupted Round; a human Ticket resumes only through
`Blocked -> InProgress`), and excluding `Done` as a target entirely -- `Done` is
reachable only through `POST /api/tickets/{id}/accept`
(`decideAccept`), never a plain status write, whatever the Ticket's
current Status or retained completion condition.

Every Ticket response, including the list, carries `allowedActions`:
`statusChanges` contains the plain status-command targets, and `accept`
contains `available` plus the command's exact `reason` code and message
when unavailable. `scanTicketRow` computes this on every read/return
using `decidePlainStatusChange` and `decideAccept`; it is not persisted.
`TestTicketAllowedActions_MatchCommands` compares advertised actions
with actual HTTP commands for all six Statuses and both retained
completion conditions. `TestTicketCommands_ResponseMatchesContract`
validates status, Accept, assign, and unassign responses against OpenAPI.

**Accept's two checks are ordered and separately coded.** A Ticket not
currently `InReview` is rejected with the generic `invalid_transition`
code, regardless of its completion condition. Only a Ticket that *is*
`InReview` reaches the completion-condition check, which rejects
`reviewedPrMerge` with the distinct `reviewed_pr_merge_not_implemented`
code -- an explicit current-implementation limitation naming **D2**
(unresolved) and **M8** (owning milestone), never a silent downgrade to
`humanAcceptance`. Only `humanAcceptance` Tickets can complete in M2.

**Concurrency: one transaction, one row lock
(`applyTicketTransition`).** `SELECT ... FOR UPDATE` inside a single
transaction holds a lock on the Ticket's row for the transaction's
whole lifetime; a concurrent call against the same Ticket blocks on its
own `SELECT ... FOR UPDATE` until the first commits, then evaluates its
own requested transition against the now-current row. This is what
makes two concurrent conflicting transitions unable to both apply --
proven against real PostgreSQL by
`TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies`,
including a captured red run against a deliberately un-locked,
read-then-write version of the same function
(`docs/evidence/m2/60-lifecycle-transitions.md`).

**Assignee changes are unconditional.** D3 S1's "no open Round"
precondition on assignment is vacuously true throughout M2 (no Round
concept exists anywhere), so `AssignTicketOwner`/`UnassignTicket` apply
via a plain, idempotent `UPDATE` from every Status, with no transaction
of their own -- there is nothing for them to race against. (#93 later
put both behind the archive row lock; #127 renamed `AssignTicketOwner`
to `AssignTicket`, gave it a request body and enumerated
`assigneeType`; #133 refuses both while a Round is open.)

**The no-execution-artifact guardrail
(`internal/httpapi/no_execution_side_effects_test.go`) is a database-level
trip wire, not a vacuous negative.** `TestManualLifecycleActionsCreateNoExecutionRecords`
drives every command this slice adds through the real API, then
asserts the complete set of tables in the schema is unchanged from a
fixed, confirmed allowlist and that every table other than `tickets`
has an unchanged row count. See
[`docs/evidence/m2/60-lifecycle-transitions.md`](../../docs/evidence/m2/60-lifecycle-transitions.md),
"Proof the suite can fail," for exactly what would make this fail (a
future migration adding an execution-shaped table, or a future manual
command inserting into an existing table) and a captured red run
proving it.

**Guardrail allowlist extended (issue #59's
`TestNoTemplateToCapabilityMapping`).** `AcceptTicket`, `decideAccept`,
`applyTicketTransition`, and `ChangeTicketStatus` all reference
`TicketCompletionCondition` -- Accept must read a Ticket's own already-
retained condition to decide whether it can complete at all, which is
not a Template-to-Agent/engine mapping (the one thing D3 forbids). This
was caught by the guardrail on the first real test run, not merely
described afterward; see the evidence record for the captured failure
and the deliberate allowlist extension that resolved it.

**Out of scope, explicitly:** Agent Assignee and an agent-assignment
endpoint (added by #127), Agent-readiness validation (M4); open-Round field locks
(M4, vacuously satisfied in M2); D4's `Done -> Ready` "already-merged
PR" caveat (unresolved, still M8); reviewed-merge evidence transport
(D2, M8); archive and Badges (M3). See
[`docs/evidence/m2/60-lifecycle-transitions.md`](../../docs/evidence/m2/60-lifecycle-transitions.md)
for the full reasoning and every captured command/result.

## Badges (issue #91)

`000008_create_badges.up.sql` adds Owner-scoped `badges` with opaque UUID
public ids, names and creation timestamps, plus `ticket_badges` with a
composite primary key and Owner-matching foreign keys to both tables.
Run the migration before starting Galley with this schema:

```sh
DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable go run ./cmd/migrate
```

`GET /api/badges` lists names case-insensitively ascending, public id
ascending for ties; `POST /api/badges` accepts only `name`. Names are
trimmed, non-empty, at most 80 Unicode code points after trimming and
immutable. PostgreSQL's `(owner_id, lower(name))` unique index arbitrates
concurrent creates. A duplicate returns `409 duplicate_badge_name`, not
the existing Badge. `PUT /api/tickets/{id}/badges/{badgeId}` attaches an
existing Badge idempotently and returns the Ticket. Both identifiers
must resolve under the session Owner; malformed, unknown, or foreign
ones return shared `404 not_found`. All Ticket responses, including
capture, list, detail, edit, Status and Assignee commands, contain
`badges: [{id, name}]`, ordered like the Badge list (empty array when
none). Attachment does not change the Ticket's `updatedAt` because
no Ticket column changes. No rename or delete endpoint exists. Check with
`go test ./...`, `go vet ./...`, and
`./scripts/check-contract-drift.sh` from this directory.

The two added tables are included in the fixed known-table guardrail;
the lifecycle actions still leave both row counts unchanged.

Every Ticket-returning storage path except creation enriches its scanned
row with `loadTicketBadges`; a new Ticket starts with an empty `badges`
array. Mutations hydrate inside their transaction before commit, so a
hydration failure rolls the change back rather than reporting `503` for
a committed write. The list closes its cursor and loads all its Tickets'
Badges in one query. `scanTicketRow` cannot do this without a query per
row and a nested database read while list rows remain open. A new Ticket
return path must perform the same enrichment before writing JSON.
`TestBadges_ActualOwnersAreIsolatedThroughHTTP` exercises foreign ids
and same-name Badge definitions through real sessions for two Owners in
an isolated test database (the second row uses `singleton=false`, not a
production sign-in path).

## Badge detach and Ticket filtering (issue #92)

`DELETE /api/tickets/{id}/badges/{badgeId}` removes the link and returns
the updated Ticket. It is idempotent for an owned Badge absent from an
owned Ticket; the Badge definition remains available in `GET /api/badges`.
Unknown, malformed, and foreign identifiers return the same `404` as
attachment. The command runs in a transaction and locks the Ticket row
before removing the link and reading the updated response.

`GET /api/tickets?badgeId=<uuid>&badgeId=<uuid>` selects Tickets carrying
any of the Owner's selected Badges. Omit the parameter for all Tickets;
repeating an id does not duplicate a Ticket. Galley validates that every
selected id belongs to the Owner; an empty, malformed, unknown, or
foreign id returns `400 invalid_request`. The `EXISTS` predicate keeps
one Ticket row per match and keeps the list's order ("Ticket
ordering"). Later visibility filters can join this same query.

## Archiving Tickets (issue #93)

Migration `000009_archive_tickets.up.sql` adds nullable `tickets.archived_at`.
`POST /api/tickets/{id}/archive` records a timestamp while retaining Status,
fields, Badge links and the Ticket itself. Default `GET /api/tickets`,
including Badge-filtered results, excludes archived Tickets; a direct
`GET /api/tickets/{id}` still returns them, with `archivedAt` set. Another
archive is rejected with `400 archived_ticket`. Unknown or foreign ids
return the shared `404`.

`lockTicketForMutation` is the one row-locked decision point consulted
inside every Ticket mutation: fields, Status, Accept, Assignee, Badge
attach/detach and archive. Once archived, every command rejects with
`archived_ticket`, leaving the row unchanged. Published allowed actions
contain no Status targets and an unavailable Accept carrying that reason.
The `archived_at` field is the eligibility check M4's claim path must
exclude. While the Ticket has an open Round, archive and every other
mutation is `400 round_open` (issues #132 and #133, below). Archive does not insert execution
artefacts.
Run `go test ./...`, `go vet ./...`, `go build ./...` and
`./scripts/check-contract-drift.sh` here after generating/staging types.

## Archived filtering and Restore (issue #94)

`GET /api/tickets?archived=true` selects archived Tickets instead of
unarchived Tickets. Repeated `badgeId` parameters still match any Badge;
Archived and Badge filtering compose, most recently archived first
(`archived_at DESC, id DESC`, since #131), with no duplicate Tickets. `archived=false` or omission selects active Tickets.
The board always requests the active collection, regardless of the
list's Archived URL parameter.

`POST /api/tickets/{id}/restore` runs in a row-locked transaction using
the same mutation decision point as Archive. A retained Ready Ticket
returns to Backlog; all other Status values, including Done, stay put.
Badges, refinement fields and completion condition are unchanged. A
Ticket that is not archived returns `400 not_archived`, and unknown,
malformed or foreign ids return the shared `404`. Restore does not create
execution artefacts or request work. The tests cover the Status grid,
owner scope, a concurrent Archive/Restore race against PostgreSQL and
persistence after a process restart. Run `go test ./...`, `go vet ./...`,
`go build ./...` and `./scripts/check-contract-drift.sh` here.

## Agents and Agent assignment (issue #127)

Migration `000010_create_agents.up.sql` adds the Owner-scoped `agents`
table: a public UUID, a name of 1-80 characters after trimming, unique
per Owner ignoring case (`agents_owner_name_ci_unique` on
`lower(name)`), and an immutable kind, `research` or `coding`.
`GET /api/agents` lists them ordered by name ignoring case;
`POST /api/agents` creates one (`201`); `PATCH /api/agents/{id}` renames
one and rejects any other property. A duplicate name, including one
created concurrently, is `409 duplicate_agent_name`.

The same migration adds nullable `tickets.assignee_agent_id`. A composite
foreign key to `agents (owner_id, id)` keeps the Agent in the Ticket's
Owner, and `tickets_assignee_agent_iff_agent_type` requires the Agent id
exactly when `assignee_type` is `agent`. `PUT /api/tickets/{id}/assignee`
now takes `{"type":"owner"}` or `{"type":"agent","agentId":"<uuid>"}`
and replaces any previous Assignee; `DELETE` clears both columns. Every
Ticket response carries `assigneeAgent` (`{id,name,kind}` or `null`),
read live from `agents`, so a rename shows on every Ticket. An unknown,
malformed or foreign Agent id returns the shared `404` with
`no ticket or agent with that identifier`, leaving the Ticket unchanged.

Assignment is allowed on both Templates and in every Status, and never
reads the Template. #128 adds one exception: assigning an Agent to a Ready
Ticket must pass Agent readiness (below). It creates no
execution record and requests no work: `agents` joins the
no-execution-artefact allowlist, and the trip wire expects exactly one
new Agent and one new Ticket. Run `go test ./...`, `go vet ./...`,
`go build ./...` and `./scripts/check-contract-drift.sh` here.

## Agent readiness and Galley-owned moves (issue #128)

`internal/httpapi/agent_readiness.go` holds the rules. A Ticket assigned
to an Agent may be Ready only with a non-blank goal and Success Criteria,
plus a repository when the Agent's kind is `coding`. The Agent's kind
decides this, never the Template. A human-assigned or unassigned Ticket
keeps title-only Ready.

Every path into, or through, Ready with an Agent is checked on the locked
row. All three are rejected with `400 agent_readiness_incomplete`, whose
`error.missing` lists `goal`, `successCriteria` and `repository` in that
order:

- `POST /status` to Ready (`decidePlainStatusChange`);
- `PUT /assignee` of an Agent while Ready (`decideAssignment`);
- a `PATCH` that leaves a named required field blank while Ready
  (`decideTicketUpdate`). A `PATCH` that names none of the missing fields
  still applies, so an older incomplete Ticket can be filled in.

`POST /status` to In Progress, In Review or Blocked on an Agent-assigned
Ticket is `400 agent_owned_transition`. These moves belong to execution
(D3 S2).

`decidePlainStatusChange` runs both rules after the D3 table, so
`allowedActions` stays equal to what the command does. Moves the table
allows but these rules refuse are omitted from `statusChanges`. They are
listed in `statusChangeRejections` with the command's exact error.

Every Ticket response carries `requestingAgentWork`. It is
`decideAgentWorkRequest`: not archived, Ready, Agent-assigned and
complete. The claim in #132 must use the same function.

Tests:

- `TestAgentReadiness_EitherOrderGrid`: both orderings × both Templates ×
  both kinds × every missing subset;
- `TestTicketAllowedActions_MatchCommandsForEveryAssignee`: advertised
  against actual moves for every Status × assignee;
- `TestAgentReadiness_ConcurrentClearAndReadinessNeverBothApply`: the race
  against real PostgreSQL;
- `TestAgentReadiness_ResponsesMatchContract`.

Checking out the repository reference is M8 #9. See
[`docs/evidence/m4/128-agent-readiness.md`](../../docs/evidence/m4/128-agent-readiness.md).

## Runner pairing, bearer authentication, and health (issue #130)

Migration `000011_create_runners.up.sql` adds `runners`: one row per
Owner (`runners_one_per_owner`), holding only the SHA-256 of the runner
credential (`runners_token_hash_sha256` requires 32 bytes), when it was
paired, and what Michelin last registered (version, hostname, first
registration and last heartbeat, set together or not at all).

| Route | Caller | Auth |
| --- | --- | --- |
| `POST /api/runner-credential` | Owner | session cookie |
| `DELETE /api/runner-credential` | Owner | session cookie |
| `GET /api/runner-health` | Owner | session cookie |
| `POST /api/runner/register` | Michelin | `Authorization: Bearer tir_…` |
| `POST /api/runner/heartbeat` | Michelin | `Authorization: Bearer tir_…` |
| `POST /api/runner/claims` | Michelin | `Authorization: Bearer tir_…` (issue #132) |
| `POST /api/runner/rounds/{roundId}/events` | Michelin | `Authorization: Bearer tir_…` (issue #134) |
| `GET /api/tickets/{id}/rounds` | Owner | session cookie (issue #134) |
| `POST /api/dev/clock/advance` | tests | session cookie, development only |

**Pairing** returns `201` with `tir_` plus 32 random bytes in unpadded
base64url, sent once with `Cache-Control: no-store`. Pairing again
revokes the previous credential in the same transaction; the Owner row
lock makes concurrent pairings leave exactly one. **Revoke** deletes the
row and is `204` whether or not one existed.

**The auth boundary runs both ways.** Everything under `/api/runner/`
requires one well-formed, current bearer credential and refuses a
session cookie, even beside a valid token. `requireSession` refuses an
`Authorization` header with the `Bearer` scheme in any casing, so a
runner credential opens no Owner route. Other schemes pass, so a proxy
that forwards `Authorization: Basic …` does not lock the Owner out. Every refusal, including a malformed or revoked token,
is the shared `401 unauthenticated`. Neither Galley nor its logs ever
see the raw token after issuance.

**Register** records `michelinVersion` (1–64 characters) and `hostname`
(1–253), counts as a heartbeat, and may repeat. **Heartbeat** updates the
last-seen time; before any register it is `409 runner_not_registered`,
which Michelin answers by registering again.

**Health** is derived at read time, never stored: `connected` while the
last heartbeat is less than 30 s old by Galley's clock, `disconnected`
with `lastSeenAt` otherwise, and `not_paired` without a credential.
`checkedAt` is that clock's reading, so clients measure "last seen"
against it rather than their own clock. Disconnecting changes no Ticket;
M4.7+ overlays it on the locked Ticket, and reconciliation is M5 (#6).

**Clock.** Handlers read `s.now`. `NewHandlerWithClock` injects it for
tests. In development only, `NewHandler` wraps `time.Now` so
`POST /api/dev/clock/advance {"seconds":1..86400}` can move it forward,
which the browser suite uses to cross the health window; the route is
gated like the other `/api/dev/` routes and is `404` in production.

`runners` joins the no-execution-artefact allowlist. Run
`go test ./...`, `go vet ./...` and `./scripts/check-contract-drift.sh`.

## Priority order (issue #131)

Migration `000012_add_ticket_priority_rank.up.sql` adds
`tickets.priority_rank BIGINT NOT NULL`, lower first. It backfills each
Owner's Tickets 1024 apart in the old newest-first order, so the list
looks the same right after the upgrade. It adds `UNIQUE (owner_id,
priority_rank) DEFERRABLE INITIALLY IMMEDIATE` and drops the unused
`(owner_id, created_at, id)` index.

Placement:

| Event | Rank |
| --- | --- |
| Capture | top: Owner's minimum − 1024, or 1024 for the first Ticket |
| Entering Ready from another Status | bottom: Owner's maximum + 1024 |
| Any other Status change, Accept, archive, restore | kept |

`POST /api/tickets/{id}/position` takes exactly one of `{"before":
"<ticketId>"}` or `{"after": "<ticketId>"}` and returns the moved Ticket.
Order is exposed only as list order; `Ticket` has no rank field. The move
takes the midpoint of the gap between the anchor and its neighbour in the
Owner's whole order, excluding the moved Ticket. Nothing lies between
the two, so the Ticket also lands beside the anchor within its stage. A
Ticket already in that gap keeps its rank, so repeating a move changes
nothing. With no neighbour it takes the anchor's rank ± 1024. When the
gap is gone, the whole collection, archived Tickets included, is
renumbered 1024 apart in its current order in the same transaction, and
the midpoint is taken again. Only the moved Ticket's `updated_at`
changes.

| Request | Response |
| --- | --- |
| Both or neither of `before`/`after`, extra fields | `400 invalid_request` |
| Unknown, malformed or foreign Ticket id | shared `404` |
| Archived Ticket | `400 archived_ticket` |
| Anchor unknown, malformed, foreign, itself, archived, or in another Status | `400 reorder_anchor_invalid` |

**Lock order.** Capture, reorder and every Status transition (Status
change and Accept, since any transition may enter Ready) first take `pg_advisory_xact_lock(0x7072696f,
int32(owner id))`, then the Ticket row lock through
`lockTicketForMutation`, then the anchor row `FOR UPDATE`. The two-int4
key space cannot collide with golang-migrate's single-bigint lock.
Taking it unconditionally in `applyTicketTransition` keeps the order
uniform for every caller that can reach Ready. Field edits, Badges,
archive and restore hold only one Ticket row lock and skip it.

Tests: `internal/httpapi/ticket_priority_test.go` covers placement, both
directions across interleaved stages, every rejection leaving the order
unchanged, renumbering, and three concurrency tests (16 concurrent
reorders over 5 seeded rounds; 24 concurrent reorders, captures and
Ready entries; 18 concurrent Accepts and Status changes on different
Tickets), each asserting a strict total order afterwards.
`internal/postgres/migrate_priority_rank_test.go` checks the backfill.
Evidence: `docs/evidence/m4/131-priority-order.md`.

## Work claims and Rounds (issue #132)

Migration `000013_create_rounds.up.sql` adds `rounds`: a Galley-issued
`public_id` (UUID v4), the Ticket and the Agent assigned at claim time
(both owner-scoped foreign keys), `sequence` (1, 2, … per Ticket,
unique), `state`, `claim_epoch`, and `claimed_at`, `started_at` and
`ended_at`. It holds no engine reference. CHECKs allow M4's states
(`claimed`, `running`, `delivered`) with the timestamps each one
requires; M5 (#6) replaces them. The partial unique index
`rounds_one_open_per_owner` on `owner_id WHERE state IN ('claimed',
'running', 'waiting_for_input')` is the sequential slot: one open Round
per Owner. Its predicate is the open states' SQL definition, and
`openRoundStatesSQL` in `rounds.go` is the Go one;
`TestOpenRoundStates_MatchTheSlotIndexPredicate` compares the two.

`POST /api/runner/claims` takes no body.

| Case | Response |
| --- | --- |
| A Ticket is requesting Agent work and the slot is free | `201` `RunnerClaim`: `roundId`, `sequence`, `claimEpoch` (the Ticket's next, from 1), the Ticket's inputs, the Agent |
| Nothing requesting work, a Round already open, or the runner not Connected (never registered, or last heartbeat 30 s old or more) | `204`, no body |
| Missing, malformed or revoked credential, or a session cookie | shared `401 unauthenticated` |

A claim is not a heartbeat. It picks the Owner's highest-priority
Ticket for which `decideAgentWorkRequest` holds, the same function that
publishes `requestingAgentWork`. The Ticket keeps its Status, rank,
Assignee and `updated_at`; Galley then reports it with `openRound` set
and `requestingAgentWork` false. `Ticket.openRound` is `null` or the open
Round's `id`, `sequence`, `state`, `agent`, `claimedAt` and `startedAt`.

**Lock order.** The claim takes the Owner's priority advisory lock, then
checks the slot, then locks candidate Ticket rows one at a time in
priority order through `lockTicketForMutation`, rechecks each locked row
and skips it when it is no longer eligible, then inserts the Round. This
is the same order as capture, reorder and transitions (priority lock,
then rows). Field edits, assignment, Badges and archive take only their
one row lock and then read `rounds`, so they cannot form a cycle with
the claim. A unique violation on the slot index maps to `204`.

A claimed Round starts with an `execution_started` event (M4.8, #134,
below) and ends with `delivered` (M4.10, #136, below). Stranded claims
are D5.

`rounds` joins the no-execution-artefact allowlist, which also checks
that no manual action creates a Round. Tests:
`internal/httpapi/rounds_test.go`, with `TestClaim_ResponsesMatchContractAndMethod405`
in `contract_test.go`. Evidence: `docs/evidence/m4/132-claims.md`.

## Open-Round lock (issue #133)

`lockTicketForMutation` returns a `ticketLock`: the row's archived state
and its open Round's public id, read in a second statement after the
`FOR UPDATE` so it sees a Round committed by a claim that held the row
first. `decideTicketMutation` turns that into the one rejection:
`archived_ticket`, or `400 round_open` with `error.roundId` set to the
open Round. Every Owner mutation of a Ticket goes through
`lockMutableTicket` (the lock plus that decision) before its own rule:

| Command | Path |
| --- | --- |
| Edit title, goal, context, Success Criteria, constraints, repository | `PATCH /api/tickets/{id}` |
| Assign the Owner, assign or reassign an Agent, unassign | `PUT`/`DELETE /api/tickets/{id}/assignee` |
| Attach or detach a Badge | `PUT`/`DELETE /api/tickets/{id}/badges/{badgeId}` |
| Plain Status change, Accept | `POST /api/tickets/{id}/status`, `/accept` |
| Reorder | `POST /api/tickets/{id}/position` |
| Archive | `POST /api/tickets/{id}/archive` |

`allowedActionsForTicket` consults the same `decideTicketMutation` on
`workflowStateOf(ticket)`, whose `ticketLock` comes from the Ticket's
`openRound`. A locked Ticket therefore advertises no Status targets, no
Status rejections, and Accept unavailable with the identical
`round_open` detail. The rule applies while the Round is claimed or
running (the open states, `openRoundStatesSQL`).

Not changed by the lock:

- `template` in a PATCH is still `invalid_request` before any lookup:
  it has no write path at all (D4, M8).
- Restore keeps its rules. An archived Ticket cannot hold an open Round
  (archive refuses one, and a claim skips archived Tickets), and an
  unarchived one gets `not_archived`.
- Another Ticket may be reordered or moved beside a locked one. That
  changes the other Ticket's rank, not the locked Ticket's row.
- Agent rename, Badge creation and pairing are not Ticket mutations.

Tests: `internal/httpapi/ticket_open_round_lock_test.go`. Evidence:
`docs/evidence/m4/133-open-round-lock.md`.

## Execution started and event ingestion (issue #134)

Migration `000014_create_round_events_and_engine_references.up.sql`
adds `rounds_owner_id_id_unique` (so child tables can carry the
owner-scoped composite key `rounds` itself uses) and two tables:

- `round_events`: one row per accepted event, `UNIQUE (round_id,
  idempotency_key)`, with `type`, `claim_epoch`, the runner's
  `occurred_at`, Galley's `received_at`, a SHA-256 `payload_hash` and
  the `result` it answered with as JSONB. `round_events_type_m4` allowed
  `execution_started` only; M4.9 (#135) and M4.10 (#136) widen it.
- `round_engine_references`: the engine's execution reference, kept
  apart from the Round id (ADR 0002). The partial unique index
  `round_engine_references_one_current_per_round` allows one
  `is_current` row per Round; `attachEngineReference` retires the
  current one before inserting the next and never deletes.

`POST /api/runner/rounds/{roundId}/events` takes `{type,
idempotencyKey, claimEpoch, occurredAt, data}`. For `execution_started`,
`data` is exactly `{"engineReference": "<1-200 characters>"}`.
`idempotencyKey` is 1-200 characters without control characters and is
used as sent, never trimmed. The response is `RoundEventResult`
(`roundId`, `type`, `state`, `startedAt`).

The decision ladder, in order. Steps 1-3 run before any lock; 4-9 run
in one transaction.

| # | Check | Outcome |
| --- | --- | --- |
| 1 | Bearer credential (`requireRunner`); a session cookie is refused beside a valid bearer | `401 unauthenticated` |
| 2 | `{roundId}` is a UUID | shared `404 not_found` |
| 3 | Strict body: known `type`, key, positive int32 `claimEpoch`, RFC 3339 `occurredAt`, `data` for the type | `400 invalid_request` |
| 4 | Lock the Owner's priority lock, the Ticket row, then the Round row `FOR UPDATE`; the Round must be this Owner's | unknown, foreign, or a Ticket's id: `404 not_found` |
| 5 | `(round, idempotencyKey)` already recorded | same payload hash: `200` with the stored result; different: `409 idempotency_key_conflict` |
| 6 | `claimEpoch` is the Round's | else `409 stale_claim_epoch` |
| 7 | Round is open | else `409 round_not_open` |
| 8 | The type suits the Round's state (`execution_started` needs `claimed`) | else `409 event_out_of_order` |
| 9 | Apply | `201` |

Step 5 precedes 6 and 7 so a retry of an applied event is answered the
same way after the Round has moved on. No rejection changes state or
records a row. The runner need not be Connected, and an event is not a
heartbeat: events are facts, and refusing a late one would strand a
claimed Round.

Applying `execution_started`, in the one transaction: the Round becomes
`running` with `started_at` set from Galley's clock (never the runner's
`occurredAt`, which is kept in `round_events`, so runner clock skew
cannot break `rounds_timestamps_ordered`; it never precedes
`claimed_at`); the engine reference becomes current; the Ticket moves
`Ready` → `In Progress`, guarded by `AND status = 'Ready'`; and the
`round_events` row stores the result. If the guard matches no row an
invariant broke: nothing is recorded and the answer is `500
internal_error`, logged with the Round id.

`payload_hash` is SHA-256 of the canonical JSON of `{claimEpoch, data,
occurredAt, type}`: object keys sorted bytewise at every depth, array
order kept, numbers kept as written, `occurredAt` as the UTC instant in
RFC 3339 with nanoseconds and trailing zeros trimmed. The key and the
Round id are not hashed. A replay re-encodes the stored result into
`RoundEventResult`, which gives the bytes the first answer had.

This path never calls `lockMutableTicket` or `decideTicketMutation`:
they reject because of the open Round. It is the one writer that
changes a Ticket under its own Round, and only that Round's Ticket. The
lock order is the priority lock, the Ticket row, then the Round row,
which is the order every other Ticket-mutating path uses for its first
two.

`GET /api/tickets/{id}/rounds` returns `{"rounds": [...]}`, newest
first by `sequence`, for any of the Owner's Tickets including an
archived one. `RoundState` is `claimed`, `running`, `delivered`,
`stopped` (#160), `failed` or `interrupted` (#161); `Ticket.openRound.state` uses `OpenRoundState`
(`claimed`, `running`), since an ended Round is never open.

Tests: `round_events_test.go`, `round_event_hash_test.go`,
`ticket_rounds_test.go`, and `TestRoundEvents_ResponsesMatchContractAndMethod405`
in `contract_test.go`. `round_events` and `round_engine_references`
join the no-execution-artefact allowlist, which checks that no manual
action creates either. Evidence: `docs/evidence/m4/134-controlled-engine.md`.

## Round activity and usage observations (issue #135)

Migration `000015_create_round_activity_and_usage_observations.up.sql`
widens `round_events_type_m4` to `execution_started`, `progress` and
`usage_observed`, and adds two append-only tables. Both are Owner-scoped
through a composite foreign key to `rounds (owner_id, id)`.

- `round_activity (round_id, seq, note, occurred_at)`: `UNIQUE (round_id,
  seq)`, `seq >= 1`, `char_length(note) BETWEEN 1 AND 2000`, not blank.
- `usage_observations`: `id` is the runner's `observationId` UUID. It
  holds `provider`, `model`, the nullable `input_tokens`, `output_tokens`,
  `cost_usd NUMERIC(12,6)` and `active_ms` (`null` is unknown), `basis`
  (`reported` or `estimated`), a nullable, non-unique
  `provider_generation_id`, and `occurred_at`. Rows are never merged or
  updated; enrichment is M9 (#10).

Both events use the endpoint and ladder above. Additions:

- **Validation (`400`).**
  - `progress` `data` is exactly `{note}`. The note is 1 to 2000 Unicode
    code points, not blank, with no control character but tab and line
    feed.
  - `usage_observed` `data` has exactly nine keys, `null` for an unknown
    figure:
    - `observationId`: a non-nil lowercase canonical UUID;
    - `provider` and `model`: 1 to 200 characters;
    - `inputTokens`, `outputTokens` and `activeMs`: integers from 0 to
      2^53−1;
    - `costUsd`: a decimal string from `"0"` to `"999999.999999"` with at
      most 6 places, never a JSON number;
    - `basis` and `providerGenerationId`.
  - For `usage_observed`, `idempotencyKey` must equal
    `data.observationId`.
- **State (`409 event_out_of_order`).** Both need a `running` Round. A
  claimed Round rejects them and stores nothing, so the same key is
  accepted once `execution_started` is recorded.
- **Apply (`201`).**
  - A note gets the next `seq`. It is `max + 1` inside the transaction
    while the Round's Ticket row lock is held, so `seq` is gap-free per
    Round. The result carries it.
  - An observation is inserted with `ON CONFLICT (id) DO NOTHING`. An id
    already recorded for another Round is `409
    observation_id_conflict`; this Round's own replay is answered at the
    lookup step first.
  - Neither changes the Ticket or the Round.

`GET /api/tickets/{id}/rounds` adds, per Round:

- `activity`: the latest 50 notes, oldest first.
- `usage`: `observations`, plus `costUsd`, the text of
  `sum(cost_usd)` at scale 6, or `null` when no cost is known. Then:
  - `complete`: at least one observation and every cost known;
  - `estimated`: a known cost is estimated;
  - `inputTokens`, `outputTokens` and `activeMs`: `{sum, complete,
    estimated}` with the same meanings.

The Rounds, notes and sums are read in one `REPEATABLE READ` read-only
transaction.

Tests: `round_activity_usage_test.go`, additions to `round_events_test.go`
and `TestRoundEvents_ResponsesMatchContractAndMethod405`. Both tables
join the no-execution-artefact allowlist. Evidence:
`docs/evidence/m4/135-activity-usage.md`.

## Delivery to In Review (issue #136)

Migration `000016_create_round_deliverables.up.sql` widens
`round_events_type_m4` with `delivered` and adds `round_deliverables
(owner_id, round_id, body_markdown, summary, criteria_assessment)`:
`UNIQUE (round_id)`, a composite foreign key to `rounds (owner_id, id)`,
`octet_length(body_markdown) BETWEEN 1 AND 1048576`, `char_length`
bounds of 2000 (`summary`) and 10000 (`criteria_assessment`), and an
ASCII-whitespace not-blank check on each. Reports stay in PostgreSQL
until object storage (D7) is selected; they move in M7 (#8).

`delivered` uses the endpoint and ladder above. Additions:

- **Body cap (`413 request_too_large`).** The events endpoint reads at
  most 8 MiB before decoding, after the credential and Round-id checks.
  Any JSON spelling of a maximal deliverable fits: `\u`-escaping every
  byte of a 1 MiB body takes 6 MiB. No other endpoint is capped yet.
- **Validation (`400`).** `data` is exactly `{bodyMarkdown, summary,
  criteriaAssessment}`, all strings, each not blank (`unicode.IsSpace`)
  and with no control character but tab and line feed. `bodyMarkdown`
  is 1 to 1048576 bytes of UTF-8 after JSON decoding; `summary` 1 to
  2000 and `criteriaAssessment` 1 to 10000 code points.
- **State (`409 event_out_of_order`).** Needs a `running` Round.
- **Apply (`201`)**, in the one transaction (`deliverRound`): insert the
  deliverable; set the Round `delivered` with `ended_at` from Galley's
  clock, never before `started_at`; move the Ticket `In Progress` → `In
  Review`, guarded by `AND status = 'InProgress'` (no match is the `500`
  invariant failure, logged with the Round id); store the result
  `{roundId, type, state: delivered, startedAt, endedAt}`, which never
  echoes the body. The slot frees and the open-Round lock lifts with no
  further write, because both derive from the Round's open state
  (`openRoundStatesSQL`, `rounds_one_open_per_owner`).

Afterwards the Ticket is `In Review` with no open Round. `In Review` is
agent-owned for an Agent-assigned Ticket, so there is no Status change;
Accept follows the retained completion condition: available for
`humanAcceptance` (Basic), refused with `reviewed_pr_merge_not_implemented`
for `reviewedPrMerge` (Coding). Done → Ready queues the Ticket for a new
Round. Rework from In Review is `POST /api/tickets/{id}/rework`
("Explicit rework (issue #137)" below).

`Ticket.delivery` is `{roundId, sequence, agent, deliveredAt}` of the
Ticket's latest Round when that Round is `delivered`, else `null`.
`GET /api/tickets/{id}/rounds` adds `deliverable`, set exactly when
`state` is `delivered`.

Tests: `round_delivery_test.go`, additions to `round_events_test.go`,
`ticket_rounds_test.go` and `contract_test.go`. Most tests now close a
Round through the API (`deliverThroughAPI`); `closeRoundDirect` remains
only where a test first moved the Ticket out of In Progress by SQL,
which real delivery refuses. `round_deliverables` joins the
no-execution-artefact allowlist. Evidence:
`docs/evidence/m4/136-delivery.md`.

## Explicit rework (issue #137)

`POST /api/tickets/{id}/rework` takes no body and returns the Ticket in
Ready, at the bottom of the Owner's order like any entry into Ready. It
is the only way a delivered Ticket returns to Ready for another Round;
no event, timer or reassignment does it. `decideRework` is the one
decision, shared by the command and by `allowedActions.rework`:

| Check, in order | Rejection |
| --- | --- |
| Archived | `400 rework_not_available` |
| Not Agent-assigned | `400 rework_not_available` |
| Status is not In Review | `400 rework_not_available` |
| Open Round (unreachable through the API: an open Round implies a Status other than In Review) | `400 rework_not_available` with `roundId` |
| Readiness as for Ready (M4.2) | `400 agent_readiness_incomplete` with `missing` |

`transitionLockedTicket` takes the Owner's priority lock and the Ticket
row lock, in that order, and leaves the archived and open-Round cases to
`decide`, so rework can answer them with `rework_not_available`.
`applyTicketTransition` wraps it and keeps the generic guard for the
other commands.

`claim_epoch` is per Ticket: a claim inserts `max(claim_epoch) + 1` over
the Ticket's Rounds, as `sequence` is counted. There is no migration or
unique constraint: claims serialise on the Owner's priority lock and
the one-open-Round index. An event carrying Round 1's id or epoch is
refused by the existing ladder (`409 round_not_open` for Round 1's id,
`409 stale_claim_epoch` for Round 1's epoch sent to Round 2) and changes
nothing; a replay of Round 1's delivery still returns its stored result. `Ticket.delivery` stays
set while the reworked Ticket waits in Ready and clears when Round 2 is
claimed.

Tests: `ticket_rework_test.go`, plus `contract_test.go`. Evidence:
`docs/evidence/m4/137-rework.md`.

## Stop request and pulled commands (issue #159)

`POST /api/tickets/{id}/stop` takes no body and records one `stop` row
in `round_commands` (migration 000017) for the open Round, carrying the
Round's current `claim_epoch` and Galley's clock as `issued_at`. The
row's `public_id` is the command's idempotency key. A `stop` row is the
whole of "Stop requested": `openRound.stopRequestedAt` is its
`issued_at`. Stopping is not a Status: the Ticket's Status, the Round's
state, the open-Round lock and the slot are unchanged. `decideStop` is
the one decision, shared by the command and by `allowedActions.stop`:

| Check, in order | Command | `allowedActions.stop` |
| --- | --- | --- |
| No open Round (archived Tickets included) | `400 stop_not_available` | unavailable, same reason |
| A `stop` row exists | `200`, the unchanged Ticket, no new row | unavailable, `stop_already_requested` |
| Otherwise | `200`, the Ticket with `stopRequestedAt` | available |

The insert runs under the Ticket row lock (`lockTicketForMutation`, which
now also reads whether the open Round has a `stop` row). A unique
violation on `round_commands_one_stop_per_round` is answered as
`stop_already_requested`.

The runner pulls commands with its bearer credential:

- `GET /api/runner/rounds/{roundId}/commands` returns the Round's
  unacknowledged commands, oldest `issued_at` first, and `[]` once the
  Round is no longer open. An unknown, malformed or foreign Round is
  the shared `404`.
- `POST /api/runner/rounds/{roundId}/commands/{commandId}/ack` takes
  `{"outcome": "applied" | "ignored"}` (strict decode). The first ack
  records `acknowledged_at` from Galley's clock and the outcome. A
  repeat with the same outcome returns the stored values; another
  outcome is `409 command_already_acknowledged` and changes nothing. A
  command of another Round is the shared `404`. The row is locked
  `FOR UPDATE` while it is read, so concurrent acks record one outcome.
  An ack never changes the Round or the Ticket.

Galley does not reject an ack by epoch: Michelin compares the command's
`claimEpoch` with its own claim and acknowledges a mismatch `ignored`.
Ending a stopped Round (`stop_confirmed`) is below.

Tests: `round_commands_test.go` (decision table, Stop on claimed and
running Rounds, concurrent and lock-adjacent duplicates, the listing,
ack replay and conflict, concurrent acks, a stale-epoch Stop), the
"while Stopping" cases in `ticket_open_round_lock_test.go`, and
`contract_test.go`. Evidence: `docs/evidence/m5/159-stop-request.md`.

## Confirmed Stop and the Stopped Badge (issue #160)

Migration `000018_stop_rounds.up.sql` replaces `rounds_state_m4` with
`rounds_state_m5` (adding `stopped`), lets a `stopped` Round have no
`started_at` (a claimed Round can be stopped) but requires `ended_at`,
adds `rounds.outcome_note` (set exactly when `stopped`, 1 to 2000
characters), replaces `round_events_type_m4` with `round_events_type_m5`
(adding `stop_confirmed`), and adds `badges.system_key` (only
`stopped`, at most one per Owner, `badges_owner_system_key_unique`).

`stop_confirmed` uses the event endpoint and ladder above with
`data: {"evidence": "..."}` (1 to 2000 characters, the progress note's
text rules). The ladder takes it on a `claimed` or `running` Round, and
after the state check rejects it with `409 stop_not_requested` unless
the Round has a `stop` command; an unacknowledged Stop is enough. The
Round lock query reads that as an `EXISTS` in the same `FOR UPDATE`.
In the event's transaction (`endRound`, `round_endings.go`, since #161):

- the Round becomes `stopped` with the evidence as `outcome_note` and
  `ended_at = GREATEST(now, COALESCE(started_at, claimed_at))`, which
  frees the slot and lifts the open-Round lock;
- the Ticket moves to Backlog from Ready (claimed) or In Progress (running), keeping its
  priority position; any other Status is a broken invariant, rolled
  back, logged and answered `500`;
- `ensureStoppedBadge` finds the Owner's `system_key = 'stopped'` Badge,
  else adopts the Owner's Badge named "stopped" in any case, else
  creates "Stopped", and the Badge is attached (`ON CONFLICT DO NOTHING`).

The result is `{roundId, type, state: stopped, startedAt, endedAt}`;
`startedAt` is `null` for a Round stopped while claimed, the one case
`RoundEventResult.startedAt` is null. `TicketRound.outcomeNote` carries
the evidence for a `stopped` Round and is `null` otherwise.

Stopped is terminal: every later event is `409 round_not_open`, Stop is
`stop_not_available`, the command list is empty, and only an explicit
Ready queues a new Round (new id, `sequence + 1`, `claimEpoch + 1`). No
other signal (disconnect, time, an unacknowledged or acknowledged
command) ends a Round as stopped. The Stopped Badge is an ordinary
Badge: listed, filterable, attachable and detachable through the Badge
endpoints, and detaching it never changes the Round.

Tests: `round_endings_test.go` (outcome, ladder rejections, replay,
concurrency, the three `ensureStoppedBadge` branches and racing Badge
creation, rollback, terminal regression, constraints),
`TestDecideRoundEvent`, the lock-order test in `round_events_test.go`,
`TestStopConfirmed_ResponsesMatchContract` in `contract_test.go`, and the
Badge assertions in `no_execution_side_effects_test.go`. Evidence:
`docs/evidence/m5/160-confirmed-stop.md`.

## Failed and Interrupted Rounds, and recovery from Blocked (issue #161)

Migration `000019_fail_and_interrupt_rounds.up.sql` replaces
`rounds_state_m5` and `round_events_type_m5` adding `failed` and
`interrupted`, requires `started_at` and `ended_at` for both, and sets
`outcome_note` exactly when the state is `stopped`, `failed` or
`interrupted`.

`failed` takes `data: {"explanation": "..."}` and `interrupted`
`data: {"evidence": "..."}`, each 1 to 2000 characters with the progress
note's text rules. The ladder takes both only on a `running` Round
(`409 event_out_of_order` while `claimed`). Interrupted is only ever the
runner's own report; nothing in Galley infers it from lost contact, time
or a stale epoch.

Every ending but delivery goes through `endRound` (`round_endings.go`),
with a `roundEnding` from the `roundEndings` table keyed by event type:
`stop_confirmed` → `stopped`, Backlog, Stopped Badge; `failed` →
`failed`, Blocked; `interrupted` → `interrupted`, Blocked. In one
transaction the Round ends with the note as `outcome_note` (freeing the
slot and lifting the lock) and the Ticket moves from Ready (a claimed
Round) or In Progress (a running one); any other Status is a broken
invariant, rolled back, logged and answered `500`. Activity and usage
stay listed under the Round; no Report is kept.

No Round starts automatically: a claim answers `204` until the Owner
moves the Agent-assigned Ticket from Blocked to Ready through
`POST /api/tickets/{id}/status`. That move needs no open Round
(`round_open`), passes the readiness check (`agent_readiness_incomplete`),
enters Ready at the bottom of the order and is advertised in
`allowedActions.statusChanges` by the same `decidePlainStatusChange`.
The next claim is a new Round (`sequence + 1`, `claimEpoch + 1`); the
ended Round is unchanged.

Tests: `round_blocked_endings_test.go` (outcome, ladder rejections,
replay, concurrency, racing endings and recovery, rollback, guard,
terminal regression, recovery rules, constraints), `TestDecideRoundEvent`
and the lock-order test in `round_events_test.go`,
`TestFailedAndInterrupted_ResponsesMatchContract`,
`TestRoundEndings_OnlyTheEndingCodeNamesTheEndedStates`, the recovery
race in `agent_readiness_test.go` and the recovery step in
`no_execution_side_effects_test.go`. Evidence:
`docs/evidence/m5/161-failed-interrupted.md`.

## Waiting reason and activity paging (issue #162)

Every `openRound` carries `waitingReason`, which `decideWaitingReason`
(`round_waiting.go`) computes on each read from the Round's state, its
Stop request and the Owner's runner health. The health is the same
`runnerConnected` check as `GET /api/runner-health`, on the same clock.
Precedence, highest first:

| `waitingReason` | When |
| --- | --- |
| `runner_disconnected` | the runner is not connected: not paired, never registered, or no heartbeat for 30 s |
| `stopping` | `stopRequestedAt` is set |
| `starting` | the Round is `claimed` |
| `working` | otherwise (`running`) |

The reason is derived on read and never stored. Later slices add values
to the same enum.

`GET /api/tickets/{id}/rounds` adds `earlierActivityCursor` per Round:
opaque, and `null` once `activity` holds the Round's first note.
`GET /api/tickets/{id}/rounds/{roundId}/activity?before=<cursor>`
answers `{activity, earlierActivityCursor}` with up to 50 notes before
the cursor, oldest first. Without `before` it answers the same latest
page the Round list embeds. Notes have gap-free `seq` and are never
removed, so a page is stable while new notes are appended. A `before`
that is not a cursor is `400 invalid_cursor`. An unknown, malformed or
foreign Ticket or Round, or a Round of another Ticket, is the shared
Round `404`.

Tests: `round_waiting_test.go` (decision table, the lifecycle, the
health window boundary, revoke and re-pair, Owner scoping, no writes),
`round_activity_paging_test.go` (0/1/50/51/100/101 notes, appends while
paging, malformed cursors, the shared `404`) and
`TestWaitingReasonAndActivityPaging_ResponsesMatchContractAndMethod405`.
Evidence: `docs/evidence/m5/162-active-order-slip.md`.

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
| A Status transition is not on D3 S2's table (#60)  | `400` | `invalid_transition`   |
| Accept attempted on a `reviewedPrMerge` Ticket (#60, D2/M8 limitation) | `400` | `reviewed_pr_merge_not_implemented` |
| Badge name already exists for the Owner (#91) | `409` | `duplicate_badge_name` |
| Ready with an Agent lacks a required input (#128); carries `missing` | `400` | `agent_readiness_incomplete` |
| Manual In Progress, In Review or Blocked on an Agent-assigned Ticket (#128) | `400` | `agent_owned_transition` |

A `405` response also carries an `Allow` header naming the accepted
method(s).

**Every later slice that adds a Galley endpoint should reuse this exact
shape** (`internal/httpapi.ErrorBody` / `ErrorDetail`) for its own error
responses, rather than defining a new one.

## Request-body decoding

All four request-body endpoints use `internal/httpapi/json.go`'s
`decodeStrictJSON`. It accepts one JSON value followed only by whitespace
and rejects property names that do not exactly match the contract's
spelling, returning `400 invalid_request` before any write. Unknown
properties are named in the error message.

The decoder checks raw object keys against the destination's generated
`json` tags rather than keeping a separate list of allowed properties:
`encoding/json`'s struct decoder matches names case-insensitively even
with `DisallowUnknownFields`, while the generated tags already track
`contracts/openapi.yaml`. A second decode of the request stream must
reach EOF so an appended JSON value or malformed suffix cannot be
silently ignored.

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

Tests that need an empty database (the concurrent-migration and
concurrent-Owner-bootstrap races, #79) call
`internal/postgres.NewEmptyTestDatabase(t)` or `NewEmptyMigratedTestPool(t)`
instead, which create a uniquely named `ticketit_test_<hex>` database on
the same server and drop it when the test ends — so the test database's
role needs `CREATEDB`.

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
│   │   ├── restart_durability_test.go  # issue #52: real two-process restart test
│   │   └── ticket_template_restart_test.go  # issue #59: completionCondition survives a restart
│   ├── migrate/            # issue #52: the one documented migration-apply command
│   └── githubfake/         # issue #55: standalone substitute GitHub provider on a
│                           #   real port -- test/development only, never cmd/galley
└── internal/
    ├── config/             # environment parsing and validation (incl. DATABASE_URL, #52; owner/OAuth, #54)
    ├── migrations/         # embedded, versioned, forward-only SQL files (#52, #54, #56, #57, #59, #60, #134)
    ├── postgres/           # issue #52: pgxpool wrapper, live health check, migration runner,
    │                       #   and the real-PostgreSQL test-setup helper (NewTestPool)
    ├── auth/                # issue #54: tokens/hashing, sessions, oauth state, Owner
    │                       #   resolution, and the GitHub OAuth client -- no HTTP here;
    │                       #   issue #130 added runner credentials (runner.go)
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
        ├── cookies.go      # issue #54: session/state cookie construction
        ├── ticket.go       # issue #56: ListTickets/CreateTicket; issue #57 added GetTicket;
        │                   #   issue #58 added UpdateTicket (manual refinement); issue #59
        │                   #   added Templates and the retained completion condition
        ├── ticket_template_test.go            # issue #59: Templates and completion-condition tests
        ├── template_capability_guardrail_test.go  # issue #59 (extended #60): the no-mapping guardrail test
        ├── ticket_lifecycle.go                 # issue #60: Status transitions, Accept, Assignee
        ├── ticket_lifecycle_test.go            # issue #60: transition-table, Accept, and concurrency tests
        ├── runner.go       # issue #130: pairing, revoke, register, heartbeat, derived health, requireRunner
        ├── rounds.go       # issue #132: atomic claims, the sequential slot, the open-state definition
        ├── round_events.go # issue #134: event ingestion, the decision ladder, engine references
        ├── round_event_hash.go  # issue #134: canonical JSON and the payload hash
        ├── ticket_rounds.go     # issue #134: GET /api/tickets/{id}/rounds
        ├── round_activity.go    # issue #135: progress notes, seq, the 50-note window; issue #162: activity paging
        ├── usage_observations.go  # issue #135: usage observations and the Round summary
        ├── round_commands.go      # issue #159: Stop request, the runner's command list and acks
        ├── round_waiting.go       # issue #162: decideWaitingReason
        ├── round_endings.go       # issues #160, #161: endRound for stop_confirmed, failed and interrupted; the Stopped Badge
        ├── devclock.go     # issue #130: development-only clock advance for the browser suite
        └── no_execution_side_effects_test.go   # issue #60: the no-Round/queue/work-request guardrail
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
- `github.com/google/uuid` `v1.6.0` (issue #57) — promoted from an
  indirect dependency (pulled in transitively by
  `oapi-codegen/runtime` since issue #54, see above) to an ordinary
  direct `require`: `internal/httpapi/ticket.go` now imports it
  directly (`uuid.NewString()`, `uuid.Parse()`) for Tickets' public
  identifier. No new module was downloaded; `go mod tidy` only moved
  the existing entry from the indirect block to the direct one.
- Issue #58 added no new dependency: `internal/httpapi/ticket.go` uses
  only the standard library's `database/sql` (for `sql.NullString`,
  scanning the four newly-nullable columns) alongside the existing
  `pgx/v5` driver, which supports it directly.
- Issue #59 added no new dependency: `ticket.go`'s Template/completion-condition
  plumbing reuses the existing `pgx/v5`/`database/sql` pattern, and
  `template_capability_guardrail_test.go`'s AST scan uses only the
  standard library (`go/ast`, `go/parser`, `go/token`, `path/filepath`,
  `sort`).
- Issue #60 added no new dependency: `ticket_lifecycle.go`'s
  transaction handling reuses the existing `pgx/v5` `pool.Begin`
  pattern already established by `internal/auth/owner.go`'s
  `bootstrapOwner`, and `no_execution_side_effects_test.go` queries
  `information_schema.tables` directly through the existing pool.

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
