# Configured-Owner GitHub OAuth sign-in and persisted session

## Purpose

Give Galley its first identity/security surface: a stable internal
Owner record independent of GitHub identifiers, GitHub OAuth
authorization-code sign-in restricted to that one configured Owner, a
PostgreSQL-persisted session, and the protected-route boundary later
slices are expected to reuse. Touches `contracts/`, `apps/galley`, and
(only to keep the drift check green) `apps/swiftlet`'s generated
types — no Swiftlet source change was needed. Tracking issue:
[#54 — M2.6 — Configured-Owner GitHub OAuth sign-in and persisted
session](https://github.com/cristoforows/ticketIt/issues/54), under
[M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3). Blocked
by [#52](https://github.com/cristoforows/ticketIt/issues/52), merged
before this slice began; may run in parallel with
[#53](https://github.com/cristoforows/ticketIt/issues/53) (unmerged,
untouched by this slice) and blocks
[#55](https://github.com/cristoforows/ticketIt/issues/55) (Swiftlet's
sign-in UI, explicitly out of this slice's scope).

## What already existed

- `apps/galley` (issues #49, #51, #52, merged): `GET /api/status` (six
  fields including live database health), a development-only
  `diagnostic_notes` table/endpoint pair, versioned forward-only
  migrations (`internal/migrations`, one file, version 1), and
  `net/http.ServeMux`-based routing bound to a generated
  `ServerInterface`. **No identity, no sessions, no protected routes at
  all** — every route was unauthenticated.
- `contracts/openapi.yaml`: `GET /api/status` and the two
  `dev-diagnostic` operations only.
- `docs/deployment.md`, "Ownership and sign-in": specified the shape
  this slice had to implement (GitHub OAuth restricted to a configured
  owner, an internal identity independent of GitHub identifiers,
  discard-the-token-after-establishing-identity) but left "Owner
  bootstrap, session handling, and future identity-linking behavior"
  as still needing implementation design — this slice is that design.
- No `apps/michelin`, no Agent/Round/execution concept anywhere (out of
  M2's scope, unaffected by this slice).
- Locally: PostgreSQL 17.11 (Homebrew) on `localhost:5432`;
  `ticketit_dev`, `ticketit_test`, `ticketit_e2e` already existed
  (from #52/#53's setup); `ticketit_m1_native` deliberately untouched.

## What this slice added

### `contracts/openapi.yaml`

Four new operations, tagged `auth`:

- `GET /api/auth/github/start` — `302` redirect to the provider's
  authorize endpoint; sets the `state` cookie.
- `GET /api/auth/github/callback` — optional `code`/`state`/`error`
  query parameters; `302` on success (session cookie set, redirect to
  `/`), `default` (`ErrorBody`) otherwise.
- `GET /api/session` — `200 SessionResponse` or `default` (`ErrorBody`,
  `401 unauthenticated`).
- `DELETE /api/session` — `204` or `default`.

Two new schemas: `Owner` (`id`, `login` — `login` documented explicitly
as display-only) and `SessionResponse` (`{owner: Owner}`). All four
operations and both schemas follow the contract's existing
`additionalProperties: false` convention.

### `apps/galley/internal/migrations`

`000002_create_owner_and_session_tables.up.sql` (forward-only, no
`.down.sql`, following #52's pattern exactly): `owners` (with a
`UNIQUE (singleton)` constraint that makes "one Owner per deployment" a
database-enforced invariant, not just an application-logic promise —
this slice's own addition beyond what the issue asked for literally,
recorded here as an engineering choice), `owner_identities`
(`provider`, `provider_account_id` `BIGINT`, `login`, unique on
`(provider, provider_account_id)`), `sessions` (`token_hash BYTEA
UNIQUE`, `expires_at`), `oauth_states` (`state_hash BYTEA UNIQUE`,
`expires_at`).

### `apps/galley/internal/auth` (new package — business logic, no HTTP)

- `auth.go`: `generateOpaqueToken` (32 bytes, `crypto/rand`,
  base64url), `hashToken` (SHA-256) — every session/state token is
  persisted only as this hash, never in the clear. `SessionTTL` (30
  days, fixed — see "Engineering choices" below) and `StateTTL` (10
  minutes).
- `state.go`: `CreateState`/`ConsumeState` — `ConsumeState` deletes the
  matching row in the same statement that finds it, which is what
  makes a second call with the same value (a replay) report "not
  found" regardless of whether it has also expired.
- `session.go`: `CreateSession`/`CreateSessionWithExpiry` (the latter
  factored out so tests can manufacture an already-expired session
  without waiting out a real TTL — production only ever calls the
  former), `LookupSession` (join to `owner_identities` for the display
  login, filtered by `expires_at > now()`), `DeleteSession`
  (idempotent).
- `owner.go`: `ResolveOwner` — the Owner-matching rule (see "Owner
  matching" below), `ErrOwnerMismatch`, and `bootstrapOwner` (the one
  Owner + its identity link, created together in one transaction).
  Also handles losing a concurrent-bootstrap race gracefully (see
  "Concurrent bootstrap" below) — a correctness improvement that also
  turned out to be required for this module's own test suite.
- `github.go`: `GitHubClient` — `AuthorizeURL`, `Exchange` (code ->
  access token, `Accept: application/json` so GitHub's endpoint
  answers in JSON rather than its form-encoded default), `FetchIdentity`
  (access token -> `{id, login}`). Every provider-side failure
  (network, non-2xx, malformed response, or a well-formed
  provider-reported error) collapses to one unexported error type and
  `IsProviderError`, so the HTTP layer never needs to distinguish them
  — they all become the same `oauth_provider_error`.

### `apps/galley/internal/githubfake` (new package — required test substitute)

A local fake GitHub OAuth/identity server (`httptest.Server`, a real
loopback listener, not just an in-process `http.Handler` — needed so a
genuinely separate OS process, like `cmd/galley`'s restart-durability
test, can reach it too) implementing the same three endpoints real
GitHub exposes: `GET /login/oauth/authorize` (skips the consent screen
entirely and immediately redirects with a single-use code, standing in
for "user just approved"), `POST /login/oauth/access_token`, `GET
/user`. **No network call to github.com and no real credentials appear
anywhere in this repository's code or tests.**
`githubfake.TestOwnerIdentity`/`NonOwnerIdentity` are the two fixture
identities every test package shares (see "Shared owner fixture"
below).

### `apps/galley/internal/authtest` (new package — shared test helper)

`SignIn` drives `GET /api/auth/github/start` through to completion
using a real `http.Client` with a cookie jar — following Galley's own
redirect to the fake provider and the fake provider's redirect back —
exactly as a browser would, and fails the test if no session cookie
results. Used by every package's tests that need "a signed-in owner"
without re-deriving the OAuth dance each time.

### `apps/galley/internal/httpapi`

- `auth.go` (new): `StartGithubOAuth`, `CompleteGithubOAuth`,
  `GetSession`, `SignOut`, and `requireSession` — the authenticated-
  route gate every non-public handler calls first (see
  `apps/galley/README.md`, "Authenticated routes," for the full
  convention and why it is a per-handler check rather than a global
  middleware).
- `cookies.go` (new): session/state cookie construction —
  `HttpOnly`, `SameSite=Lax` always, `Secure` only in production
  (`GALLEY_ENVIRONMENT=production`), state cookie scoped to
  `/api/auth/github`.
- `status.go`: `server` gained `cfg` and a `*auth.GitHubClient`,
  constructed once in `newServer`. `StatusResponse` itself is
  completely untouched — no field added, no import even referenced
  from `GetStatus` — which is what makes "leaks no Owner or
  configuration detail" true by construction rather than by a
  separate check (`TestGetStatus_PublicNoSessionRequired` still
  verifies it directly).
- `diagnostic.go`: both development-only operations now call
  `requireSession` first (see "Retrofitting diagnostic-notes" below).
- `handler.go`: registers a `405` handler for each new fixed-method
  path (`/api/auth/github/start`, `/api/auth/github/callback`,
  `/api/session`), matching the existing pattern for `/api/status`.
- `go.mod`/`go.sum`: `github.com/oapi-codegen/runtime` became an
  ordinary (non-indirect) dependency once the contract gained query
  parameters (`code`/`state`/`error` on the callback) — regenerating
  `api.gen.go` pulled it in for the generated parameter-binding code;
  it carries `go-jsonmerge` and `google/uuid` as its own indirect
  dependencies. No other new runtime dependency.
- Tests: `auth_test.go` (new, the primary coverage — see "Reproducible
  commands"/"Observed results"), `auth_test_support_test.go` (new,
  `startTestGalley` — a real `httptest.Server` bound to a *pre-known*
  address, needed because `cfg.BaseURL`, baked into the OAuth
  `redirect_uri`, must be known before the handler is constructed, not
  after `httptest.NewServer` assigns a port), extended
  `contract_test.go` (three new tests), extended `diagnostic_test.go`
  (every case now signs in first or attaches a session cookie).

### `apps/galley/internal/config`

Six new settings. `GALLEY_OWNER_GITHUB_LOGIN`,
`GALLEY_OAUTH_GITHUB_CLIENT_ID`, `GALLEY_OAUTH_GITHUB_CLIENT_SECRET`
are required with no default (same pattern and same reasoning as
`DATABASE_URL`: no sensible fallback for "who is allowed to sign in").
`GALLEY_OAUTH_GITHUB_BASE_URL`/`_API_BASE_URL` default to real GitHub's
two hosts; `GALLEY_BASE_URL` defaults to `http://localhost:8080`
(matching `GALLEY_PORT`'s own default). All three URLs are validated as
absolute URLs at startup. Checked after `DATABASE_URL` in `Load`, which
is why every pre-existing test that supplies a `DATABASE_URL` unrelated
to owner/OAuth validation needed the three new required values added
to keep passing (`internal/config/config_test.go`'s `validAuthEnv`),
while every test exercising an *earlier* validation failure
(`GALLEY_PORT`, `GALLEY_ENVIRONMENT`, `DATABASE_URL` itself) needed no
change at all, since `Load` still fails at that earlier check first.

### `apps/galley/cmd/galley`

`restart_durability_test.go` extended (not replaced): the existing
`TestRestartDurability_DiagnosticNoteSurvivesFreshProcess` now signs in
first (diagnostic-notes is non-public as of this slice) and, after the
second process starts, additionally asserts `GET /api/session` against
it resolves to the same owner login — proving the *session itself*,
not just the data it happens to unlock, survived the restart. `main_test.go`
gained the three required env vars in its one config that expects
`run()` to succeed.

### `apps/swiftlet` (build-preservation only)

`src/api/generated/schema.d.ts` regenerated (new paths/schemas typed).
**No Swiftlet source file changed** — `StatusResponse`'s shape is
untouched by this slice, so nothing that consumes it needed a
pass-through this time (unlike #52's one-line addition). `npm ci && npm
test && npm run build` all pass unmodified; #55 builds the actual
sign-in UI against these generated types.

## Owner matching, and why (issue #54's core design decision)

`internal/auth.ResolveOwner` (`owner.go`):

- **No Owner exists yet** (first sign-in ever): the fetched identity's
  `login` must equal `GALLEY_OWNER_GITHUB_LOGIN`, compared
  case-insensitively (GitHub logins are case-insensitive but
  case-preserving). On a match, this bootstraps the one Owner row and
  its identity link — from this point on, keyed by the fetched
  identity's **immutable numeric account id**, never by the login
  again. On a mismatch: `ErrOwnerMismatch`, nothing created.
- **An Owner already exists**: the fetched identity's numeric id must
  equal the linked identity's stored `provider_account_id`.
  `GALLEY_OWNER_GITHUB_LOGIN` is **not consulted at all** past
  bootstrap. On a match, only the display `login` (and `updated_at`)
  is refreshed — the account may have been renamed on GitHub since the
  last sign-in, and this keeps the display value current without
  re-verifying anything security-relevant by it. On a mismatch:
  `ErrOwnerMismatch`, the existing link is left **completely
  untouched** — no update, no new row.

This is directly "prefer matching the immutable GitHub numeric account
id, and document how the configured value resolves to it" from the
issue: the configured value (a human-typed login) is resolved to an
immutable id exactly once, at bootstrap, and the id is what every later
sign-in actually checks. Consequence: the Owner can rename their GitHub
account later without losing access (the id is unchanged); a later
edit to `GALLEY_OWNER_GITHUB_LOGIN` cannot silently redirect access to
a different account once bootstrapped, since it is never read again.

**Concurrent bootstrap.** `owners_singleton_uq` makes "one Owner per
deployment" a real database constraint, which means two processes that
both observe "no Owner yet" and both attempt to bootstrap will have
exactly one `INSERT` succeed and the other fail with a unique-violation.
`ResolveOwner` catches specifically that (`isUniqueViolation`, checking
the PostgreSQL SQLSTATE via `pgerrcode.UniqueViolation`, not any
error) and re-resolves against the winner's row instead of failing
outright — the loser ends up on the ordinary "Owner already exists"
path. Production sign-ins are effectively never concurrent (one
browser); this exists because `go test ./...`'s packages normally run
as separate, concurrent OS processes against the one shared
`ticketit_test` database (see "Shared owner fixture" below), so without
it the test suite itself would be flaky depending on scheduling.

## Retrofitting diagnostic-notes, and why

Issue #54 states "every non-public route requires a valid session ...
`/api/status` stays public" — this is deliberately read as "every
route that is not `/api/status`," which includes the pre-existing
development-only diagnostic-notes routes, not only the routes this
slice itself introduces. A development-only route is still non-public;
the rule states no exception for it, and "a required behavior you
cannot implement is an explicit limitation, never a silent downgrade"
argues against quietly leaving it out. `diagnostic.go`'s two handlers
now call `s.requireSession(w, r)` first, exactly like `GetSession`/
`SignOut`. Cost: every existing diagnostic-notes test
(`diagnostic_test.go`, `contract_test.go`,
`restart_durability_test.go`) needed a valid session attached — done
by signing in through the real fake-provider flow
(`devServerWithSession` in `diagnostic_test.go`,
`authtest.SignIn`/`githubfake` in `restart_durability_test.go`) or, for
`contract_test.go`, minting a session directly via `internal/auth`
where only response-shape validation, not the OAuth flow itself, was
being tested.

## Shared owner fixture across the whole test suite

Because the Owner is a genuine database singleton and `go test ./...`'s
packages share one real, persistent `ticketit_test` database (this
module's existing, deliberate "no fake database" policy —
`apps/galley/README.md`, "Testing against real PostgreSQL"),
`internal/githubfake.TestOwnerIdentity` is the *one* fixture identity
every package's tests sign in as, rather than each package inventing
its own. Whichever test process bootstraps the Owner first, every
other test's sign-in as that same identity still succeeds by matching
the existing link (the "Owner already exists" path above) instead of
every package racing to bootstrap a different "owner" and losing. This
is recorded here because it is this slice's own resolution of a
tension the issue does not mention (a database-level singleton
interacting with a shared, non-reset test database), not a downgrade
of anything the issue requires.

## Login is not account-action authorization

`CompleteGithubOAuth` (`auth.go`) receives the access token from
`GitHubClient.Exchange`, passes it exactly once to
`GitHubClient.FetchIdentity`, and never refers to it again — it is not
assigned to any field, not logged, not included in any response, and
goes out of scope (eligible for garbage collection) the moment
`CompleteGithubOAuth` returns. No table this slice adds has a column
capable of holding it. This is a deliberate, minimal implementation of
issue #54's "Login is not account-action authorization": establishing
identity is this slice's entire job. Michelin's own local PAT and
connected-account authorization for actually acting on the Owner's
GitHub account are explicitly a separate, later concern — M8, per both
this issue and `docs/deployment.md` ("The OpenRouter model-provider
credential and a fine-grained GitHub personal access token are
configured locally on the runner").

## Exact versions and toolchain

- Go: `go1.27.1 darwin/arm64` (unchanged).
- `github.com/oapi-codegen/runtime` `v1.7.0` — new ordinary `require`
  (see "What this slice added" above).
- `github.com/apapsch/go-jsonmerge/v2` `v2.0.0`,
  `github.com/google/uuid` `v1.6.0` — new indirect dependencies, pulled
  in transitively by `oapi-codegen/runtime`.
- Everything else unchanged from #52: `github.com/jackc/pgx/v5`
  `v5.11.0`, `github.com/golang-migrate/migrate/v4` `v4.20.1`,
  `github.com/jackc/pgerrcode` `v0.0.0-20220416144525-469b46aa5efa`
  (now also used directly by `internal/auth/owner.go`),
  `github.com/getkin/kin-openapi` `v0.149.0`,
  `github.com/oapi-codegen/oapi-codegen/v2` `v2.8.0` (`tool`).
- Node `26.9.0`, npm `11.19.1` — unchanged; `apps/swiftlet` added no
  new dependency (108 packages, same baseline as #50–#52).
- PostgreSQL server: `17.11` (Homebrew), `localhost:5432`. Databases:
  `ticketit_dev`, `ticketit_test` (both dropped and recreated from
  empty for this record's verification below); `ticketit_e2e` and
  `ticketit_m1_native` untouched.

## Reproducible commands

**Local PostgreSQL setup** (from a genuinely empty state, to prove
migrations apply reproducibly):

```sh
dropdb ticketit_dev && dropdb ticketit_test
createdb ticketit_dev && createdb ticketit_test
```

**Apply migrations:**

```sh
cd apps/galley
DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable go run ./cmd/migrate
```

**Build, vet, fmt, full test suite** (from `apps/galley/`, real
PostgreSQL, no OAuth env needed — every test uses `internal/githubfake`
or constructs `config.Config` directly):

```sh
go build ./...
go vet ./...
gofmt -l .          # expect no output
go test ./... -v -count=1
```

**Contract-response validation and both drift checks** (gotcha:
commit `api.gen.go`/`schema.d.ts` before running — both scripts refuse
otherwise):

```sh
cd apps/galley
go test ./internal/httpapi/... -run Contract -v
./scripts/check-contract-drift.sh
cd ../../contracts
npm ci
./check-swiftlet-drift.sh
```

**Swiftlet** (from `apps/swiftlet/`, clean checkout — unaffected):

```sh
rm -rf node_modules dist
npm ci
npm test
npm run build
```

**Manual end-to-end verification** (real, separate OS processes — the
real compiled `galley` binary plus a standalone throwaway fake
provider implementing the same three endpoints as
`internal/githubfake`, not `go test`; see "Observed results" for the
actual transcript):

```sh
go build -o /tmp/galley-oauth-bin ./cmd/galley
# (a standalone fake-provider process on 127.0.0.1:8089, not part of
# this repository -- internal/githubfake is the committed, real test
# substitute; this one exists solely so a real curl session against
# the real compiled binary could be captured below)
DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable \
  GALLEY_OWNER_GITHUB_LOGIN=manual-verify-owner \
  GALLEY_OAUTH_GITHUB_CLIENT_ID=manual-verify-client-id \
  GALLEY_OAUTH_GITHUB_CLIENT_SECRET=manual-verify-client-secret \
  GALLEY_OAUTH_GITHUB_BASE_URL=http://127.0.0.1:8089 \
  GALLEY_OAUTH_GITHUB_API_BASE_URL=http://127.0.0.1:8089 \
  GALLEY_BASE_URL=http://localhost:8080 \
  /tmp/galley-oauth-bin

curl -s -i http://localhost:8080/api/status                       # public
curl -s -i http://localhost:8080/api/session                      # 401, no cookie
curl -c cookies.txt -L http://localhost:8080/api/auth/github/start # full sign-in
curl -s -i -b cookies.txt http://localhost:8080/api/session        # 200, signed in
curl -s -i -b cookies.txt -X DELETE http://localhost:8080/api/session  # sign out
```

## Observed results

### Migrations apply reproducibly from an empty database

```
$ dropdb ticketit_dev && dropdb ticketit_test
$ createdb ticketit_dev && createdb ticketit_test
$ psql -h localhost -p 5432 -d ticketit_dev -c "\dt"
Did not find any relations.

$ cd apps/galley
$ DATABASE_URL="postgres://localhost:5432/ticketit_dev?sslmode=disable" go run ./cmd/migrate
migrations applied: schema version 2

$ psql -h localhost -p 5432 -d ticketit_dev -c "\dt"
                 List of relations
 Schema |       Name        | Type  |    Owner
--------+-------------------+-------+--------------
 public | diagnostic_notes  | table | cristoforows
 public | oauth_states      | table | cristoforows
 public | owner_identities  | table | cristoforows
 public | owners            | table | cristoforows
 public | schema_migrations | table | cristoforows
 public | sessions          | table | cristoforows
(6 rows)

$ DATABASE_URL="postgres://localhost:5432/ticketit_dev?sslmode=disable" go run ./cmd/migrate
migrations applied: schema version 2
```

The second run (idempotent) reports the same version and changes
nothing.

### Build, vet, fmt

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

### `go test ./...` against a genuinely empty `ticketit_test` — 42 tests, all passing

```
$ go test ./... -v -count=1
=== RUN   TestRun_ConfigurationFailure
--- PASS: TestRun_ConfigurationFailure (0.00s)
=== RUN   TestRun_ServesStatusThenShutsDownCleanly
--- PASS: TestRun_ServesStatusThenShutsDownCleanly (0.04s)
=== RUN   TestRestartDurability_DiagnosticNoteSurvivesFreshProcess
--- PASS: TestRestartDurability_DiagnosticNoteSurvivesFreshProcess (0.64s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	1.003s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/auth	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/authtest	[no test files]
=== RUN   TestLoad_Defaults
--- PASS: TestLoad_Defaults (0.00s)
=== RUN   TestLoad_ExplicitProductionSettings
--- PASS: TestLoad_ExplicitProductionSettings (0.00s)
=== RUN   TestLoad_InvalidPort (0.00s) [+5 subtests, all PASS]
=== RUN   TestLoad_PortZeroIsValid
--- PASS: TestLoad_PortZeroIsValid (0.00s)
=== RUN   TestLoad_InvalidEnvironment (0.00s) [+4 subtests, all PASS]
=== RUN   TestLoad_DatabaseURLUnset
--- PASS: TestLoad_DatabaseURLUnset (0.00s)
=== RUN   TestLoad_InvalidDatabaseURL (0.00s) [+3 subtests, all PASS]
=== RUN   TestLoad_OwnerGitHubLoginUnset
--- PASS: TestLoad_OwnerGitHubLoginUnset (0.00s)
=== RUN   TestLoad_OAuthClientCredentialsUnset (0.00s) [+2 subtests, all PASS]
=== RUN   TestLoad_InvalidProviderURLs (0.00s) [+3 subtests, all PASS]
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.136s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	[no test files]
=== RUN   TestOAuthSignIn_HappyPath
--- PASS: TestOAuthSignIn_HappyPath (0.02s)
=== RUN   TestOAuthSignIn_NonOwnerRejected
--- PASS: TestOAuthSignIn_NonOwnerRejected (0.01s)
=== RUN   TestOAuthCallback_MissingOrInvalidState (0.01s) [+5 subtests, all PASS]
=== RUN   TestOAuthCallback_ReplayedState
--- PASS: TestOAuthCallback_ReplayedState (0.01s)
=== RUN   TestSession_Expired
--- PASS: TestSession_Expired (0.01s)
=== RUN   TestSession_SignOutRevokes
--- PASS: TestSession_SignOutRevokes (0.01s)
=== RUN   TestProtectedRoute_NoSession (0.00s) [+4 subtests, all PASS]
=== RUN   TestGetStatus_PublicNoSessionRequired
--- PASS: TestGetStatus_PublicNoSessionRequired (0.00s)
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.01s)
=== RUN   TestGetStatus_DatabaseUnreachableResponseMatchesContract
--- PASS: TestGetStatus_DatabaseUnreachableResponseMatchesContract (0.00s)
=== RUN   TestDiagnosticNotes_ResponseMatchesContract
--- PASS: TestDiagnosticNotes_ResponseMatchesContract (0.01s)
=== RUN   TestGetSession_ResponseMatchesContract
--- PASS: TestGetSession_ResponseMatchesContract (0.01s)
=== RUN   TestErrorResponses_MatchContract (0.01s) [+2 subtests, all PASS]
=== RUN   TestAuthErrorResponses_MatchContract (0.01s) [+2 subtests, all PASS]
=== RUN   TestDiagnosticNotes_WriteThenRead
--- PASS: TestDiagnosticNotes_WriteThenRead (0.01s)
=== RUN   TestCreateDiagnosticNote_RejectsEmptyNote
--- PASS: TestCreateDiagnosticNote_RejectsEmptyNote (0.01s)
=== RUN   TestCreateDiagnosticNote_RejectsMalformedJSON
--- PASS: TestCreateDiagnosticNote_RejectsMalformedJSON (0.01s)
=== RUN   TestDiagnosticNotes_DatabaseUnavailable (0.00s) [+2 subtests, all PASS]
=== RUN   TestDiagnosticNotes_MethodNotAllowed
--- PASS: TestDiagnosticNotes_MethodNotAllowed (0.00s)
=== RUN   TestStatusHandler_Development
--- PASS: TestStatusHandler_Development (0.00s)
=== RUN   TestStatusHandler_Production
--- PASS: TestStatusHandler_Production (0.01s)
=== RUN   TestGetStatus_DatabaseUnreachable
--- PASS: TestGetStatus_DatabaseUnreachable (0.00s)
=== RUN   TestUnknownRoute_ReturnsSharedErrorShape
--- PASS: TestUnknownRoute_ReturnsSharedErrorShape (0.00s)
=== RUN   TestMethodNotAllowed_ReturnsSharedErrorShape (0.00s) [+3 subtests, all PASS]
=== RUN   TestDevDiagnosticRoutes_AbsentInProduction (0.00s) [+3 subtests, all PASS]
=== RUN   TestDevDiagnosticRoutes_PresentOutsideProduction
--- PASS: TestDevDiagnosticRoutes_PresentOutsideProduction (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.566s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	[no test files]
```

(Trimmed to one line per subtest group for length; every individual
subtest — 25 of them — printed its own `--- PASS`, none failed. Full
untrimmed transcript is reproducible with the command above.)

Coverage against the issue's required list: **happy path**
(`TestOAuthSignIn_HappyPath`), **non-owner rejection**
(`TestOAuthSignIn_NonOwnerRejected`, both fresh and against an
already-bootstrapped Owner — the shared-fixture design in "Shared owner
fixture" above means every run of this test exercises the
already-bootstrapped path in practice), **missing/invalid `state`**
(`TestOAuthCallback_MissingOrInvalidState`, 5 subtests), **replayed
`state`** (`TestOAuthCallback_ReplayedState`), **expired session**
(`TestSession_Expired`), **sign-out** (`TestSession_SignOutRevokes`),
**a protected route without a session**
(`TestProtectedRoute_NoSession`, covering all four non-public routes),
**session surviving a restart**
(`TestRestartDurability_DiagnosticNoteSurvivesFreshProcess`, extended).

### Restart-durability proof (real, separate OS processes)

`TestRestartDurability_DiagnosticNoteSurvivesFreshProcess`
(`cmd/galley/restart_durability_test.go`), included in the run above,
signs in against a real fake-provider server, writes a diagnostic note
through a first `galley` OS process, sends it a real `SIGTERM` and
waits for full exit, starts a second, brand-new process (new PID, new
`pgxpool.Pool`, new `http.Server`, same pre-reserved listen address, no
shared Go memory of any kind with the first), and — new in this slice —
first asserts `GET /api/session` against the second process resolves
the exact same session token back to the same signed-in owner login,
*then* reads the diagnostic note back through it. The session cookie
jar is the same one used against the first process; PostgreSQL is the
only thing carrying the session across the restart.

### Manual end-to-end verification (real compiled binary, real curl, real cookies)

Config-failure example (no `GALLEY_OWNER_GITHUB_LOGIN`):

```
$ DATABASE_URL="postgres://localhost:5432/ticketit_dev?sslmode=disable" /tmp/galley-oauth-bin
configuration error: GALLEY_OWNER_GITHUB_LOGIN is not set: the configured owner's GitHub login is required to restrict sign-in -- see apps/galley/README.md, "Owner configuration"
$ echo $?
1
```

`/api/status` public, protected routes reject with no cookie:

```
$ curl -s -i http://localhost:8080/api/status
HTTP/1.1 200 OK
{"application":"galley","status":"ok","version":"dev","environment":"development","startedAt":"2026-09-21T13:31:47Z","database":{"migrationVersion":2,"status":"ok"}}

$ curl -s -i http://localhost:8080/api/session
HTTP/1.1 401 Unauthorized
{"error":{"code":"unauthenticated","message":"sign-in required"}}

$ curl -s -i http://localhost:8080/api/dev/diagnostic-notes
HTTP/1.1 401 Unauthorized
{"error":{"code":"unauthenticated","message":"sign-in required"}}
```

Full sign-in, following every redirect, real `Set-Cookie` headers:

```
$ curl -s -v -c cookies.txt -L http://localhost:8080/api/auth/github/start
> GET /api/auth/github/start HTTP/1.1
< HTTP/1.1 302 Found
< Location: http://127.0.0.1:8089/login/oauth/authorize?client_id=manual-verify-client-id&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fapi%2Fauth%2Fgithub%2Fcallback&scope=read%3Auser&state=ajSQNbbxFEBk-Juw1cFWHTGr2CI4_1a-ijT-lHq8qD0
< Set-Cookie: ticketit_oauth_state=ajSQNbbxFEBk-Juw1cFWHTGr2CI4_1a-ijT-lHq8qD0; Path=/api/auth/github; Max-Age=600; HttpOnly; SameSite=Lax
> GET /login/oauth/authorize?...&state=ajSQNbbxFEBk-Juw1cFWHTGr2CI4_1a-ijT-lHq8qD0 HTTP/1.1
< HTTP/1.1 302 Found
< Location: http://localhost:8080/api/auth/github/callback?code=WiEGTvRmxjUMfqlsSCBAhQ&state=ajSQNbbxFEBk-Juw1cFWHTGr2CI4_1a-ijT-lHq8qD0
> GET /api/auth/github/callback?code=WiEGTvRmxjUMfqlsSCBAhQ&state=ajSQNbbxFEBk-Juw1cFWHTGr2CI4_1a-ijT-lHq8qD0 HTTP/1.1
< HTTP/1.1 302 Found
< Location: /
< Set-Cookie: ticketit_oauth_state=; Path=/api/auth/github; Max-Age=0; HttpOnly; SameSite=Lax
< Set-Cookie: ticketit_session=t3lWRg3JzolxkCU5XHSOqwHfJyUAiHLA3GUIxsdLkW4; Path=/; Expires=Wed, 21 Oct 2026 13:32:02 GMT; HttpOnly; SameSite=Lax
```

Session works, protected routes now succeed:

```
$ curl -s -i -b cookies.txt http://localhost:8080/api/session
HTTP/1.1 200 OK
{"owner":{"id":1,"login":"manual-verify-owner"}}

$ curl -s -i -b cookies.txt http://localhost:8080/api/dev/diagnostic-notes
HTTP/1.1 200 OK
{"notes":[]}

$ curl -s -i -b cookies.txt -X POST http://localhost:8080/api/dev/diagnostic-notes -H 'Content-Type: application/json' -d '{"note":"manual oauth verification"}'
HTTP/1.1 201 Created
{"createdAt":"2026-09-21T13:32:11Z","id":1,"note":"manual oauth verification"}
```

Replayed and missing `state`:

```
$ curl -s -i "http://localhost:8080/api/auth/github/callback?code=WiEGTvRmxjUMfqlsSCBAhQ&state=ajSQNbbxFEBk-Juw1cFWHTGr2CI4_1a-ijT-lHq8qD0" \
    -H "Cookie: ticketit_oauth_state=ajSQNbbxFEBk-Juw1cFWHTGr2CI4_1a-ijT-lHq8qD0"
HTTP/1.1 400 Bad Request
{"error":{"code":"invalid_oauth_state","message":"state is invalid, expired, or already used"}}

$ curl -s -i "http://localhost:8080/api/auth/github/callback?code=whatever"
HTTP/1.1 400 Bad Request
{"error":{"code":"invalid_oauth_state","message":"state is missing or does not match this browser"}}
```

Sign-out:

```
$ curl -s -i -b cookies.txt -c cookies.txt -X DELETE http://localhost:8080/api/session
HTTP/1.1 204 No Content
Set-Cookie: ticketit_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax

$ curl -s -i -b cookies.txt http://localhost:8080/api/session
HTTP/1.1 401 Unauthorized
{"error":{"code":"unauthenticated","message":"sign-in required"}}
```

Non-owner rejection, against a second fake-provider instance answering
with a different identity (`id=999999`, `login=someone-else`) while
Galley's configured owner remains `manual-verify-owner`:

```
$ curl -s -L http://localhost:8080/api/auth/github/start
{"error":{"code":"owner_mismatch","message":"this GitHub account is not the configured owner"}}
```

No cookie was set (`cookies.txt` empty of any `ticketit_session` line),
and the persisted link was unchanged before and after:

```
$ psql -h localhost -p 5432 -d ticketit_dev -c "SELECT * FROM owner_identities;"
 id | owner_id | provider | provider_account_id |        login        | ...
----+----------+----------+---------------------+----------------------
  1 |        1 | github   |               555001 | manual-verify-owner | ...
```

(still the original `manual-verify-owner`/`555001` — the rejected
`someone-else`/`999999` attempt never touched it.)

No credentials in any log produced by this manual session:

```
$ grep -i "DATABASE_URL\|CLIENT_SECRET\|manual-verify-client-secret\|password\|sslmode" \
    /tmp/galley-manual-oauth.log /tmp/fakegithub.log /tmp/fakegithub-nonowner.log
(no matches)
```

Structured request log for the whole session (statuses only, redacted
of nothing since there is nothing to redact — no request/response body
or header here ever carries a credential):

```
{"msg":"request","method":"GET","path":"/api/status","status":200,...}
{"msg":"request","method":"GET","path":"/api/session","status":401,...}
{"msg":"request","method":"GET","path":"/api/dev/diagnostic-notes","status":401,...}
{"msg":"request","method":"GET","path":"/api/auth/github/start","status":302,...}
{"msg":"request","method":"GET","path":"/api/auth/github/callback","status":302,...}
{"msg":"request","method":"GET","path":"/","status":404,...}
{"msg":"request","method":"GET","path":"/api/session","status":200,...}
{"msg":"request","method":"GET","path":"/api/dev/diagnostic-notes","status":200,...}
{"msg":"request","method":"POST","path":"/api/dev/diagnostic-notes","status":201,...}
{"msg":"request","method":"GET","path":"/api/auth/github/callback","status":400,...}
{"msg":"request","method":"GET","path":"/api/auth/github/callback","status":400,...}
{"msg":"request","method":"DELETE","path":"/api/session","status":204,...}
{"msg":"request","method":"GET","path":"/api/session","status":401,...}
{"msg":"request","method":"GET","path":"/api/auth/github/start","status":302,...}
{"msg":"request","method":"GET","path":"/api/auth/github/callback","status":403,...}
{"msg":"shutdown signal received, draining connections"}
{"msg":"galley stopped"}
```

### Drift checks and contract-response validation

```
$ cd apps/galley && go test ./internal/httpapi/... -run Contract -v
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.01s)
=== RUN   TestGetStatus_DatabaseUnreachableResponseMatchesContract
--- PASS: TestGetStatus_DatabaseUnreachableResponseMatchesContract (0.00s)
=== RUN   TestDiagnosticNotes_ResponseMatchesContract
--- PASS: TestDiagnosticNotes_ResponseMatchesContract (0.01s)
=== RUN   TestGetSession_ResponseMatchesContract
--- PASS: TestGetSession_ResponseMatchesContract (0.01s)
=== RUN   TestErrorResponses_MatchContract
--- PASS: TestErrorResponses_MatchContract (0.01s)
=== RUN   TestAuthErrorResponses_MatchContract
--- PASS: TestAuthErrorResponses_MatchContract (0.01s)
PASS

$ ./scripts/check-contract-drift.sh
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).

$ cd ../../contracts && npm ci && ./check-swiftlet-drift.sh
> ticketit-contracts@0.0.0 generate:swiftlet
> openapi-typescript openapi.yaml -o ../apps/swiftlet/src/api/generated/schema.d.ts
✨ openapi-typescript 7.13.0
🚀 openapi.yaml → ../apps/swiftlet/src/api/generated/schema.d.ts [14.8ms]
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

Both checks were run against the generated files already committed on
this branch (the "commit before running" gotcha both checks enforce).

### Swiftlet: clean-room install, test, build (unaffected)

```
$ rm -rf node_modules dist && npm ci
added 108 packages, and audited 109 packages in 635ms
found 0 vulnerabilities

$ npm test
 Test Files  2 passed (2)
      Tests  6 passed (6)

$ npm run build
✓ 17 modules transformed.
dist/index.html                  0.31 kB │ gzip:  0.22 kB
dist/assets/index-BggGnraW.js  221.67 kB │ gzip: 69.27 kB
✓ built in 47ms
```

108 packages — identical to the existing baseline; no new dependency,
no source file changed.

## Implementation limitations and follow-ups

- **Real-provider verification is out of scope, as the issue states
  explicitly.** Every test and the manual verification above use a
  local fake provider (`internal/githubfake` and, for the manual
  transcript, an equivalent standalone process) — no real GitHub OAuth
  app exists anywhere (`AGENTS.md`, "Paid resources"; no account was
  created). **Owning milestone: M10.**
- **`SessionTTL` (30 days) is a fixed constant, not configurable via
  the environment.** The issue does not require configurability; this
  is recorded as this slice's own engineering choice (a reasonable
  default for a single-owner personal deployment) rather than a gap.
  If a future slice wants it configurable, `internal/auth.SessionTTL`
  is the one place to change, and `CreateSessionWithExpiry` already
  supports an arbitrary expiry.
- **No proactive cleanup of expired `sessions`/`oauth_states` rows.**
  Both are correctly excluded from every lookup by their `expires_at`
  filter (an expired row is inert, never usable to authenticate or
  complete a callback), but rows are never deleted merely for having
  expired — only a session's real sign-out, or a state's real
  consumption, deletes a row. Not a security gap; a housekeeping item.
  No specific follow-up issue exists yet; natural owner is whichever
  milestone first cares about table growth in a long-running
  deployment (plausibly **M10**).
- **No CI wiring**, unchanged from every prior M2 slice's own recorded
  limitation — still no `.github/workflows` in this repository. Same
  owner as before: the gate-report slice
  ([#62](https://github.com/cristoforows/ticketIt/issues/62)) or a
  dedicated CI-setup slice.
- **Concurrent-bootstrap handling is exercised by this module's own
  test suite running as concurrent OS processes (see "Concurrent
  bootstrap" above) but not by a test that deliberately races two
  sign-in attempts against a literally empty database.** The retry
  path is reached in practice every time `go test ./...` runs with its
  default parallelism, which is the evidence recorded here, but there
  is no dedicated, deterministic race test for it. No specific
  follow-up issue; natural owner is the same milestone as the
  concurrent-migration-locking limitation #52 already recorded
  (plausibly **M10**).
- No other required behavior in issue #54 was left unimplemented;
  every acceptance criterion is satisfied and verified above.

## Outstanding checks and owning milestone

- **Real-provider (github.com) verification** — **M10**, per the issue
  itself.
- **Swiftlet sign-in UI and its own live, two-application check** —
  [#55](https://github.com/cristoforows/ticketIt/issues/55), explicitly
  named by the issue as the next slice.
- **CI automation** of the commands recorded here — no owning issue
  yet; see "Implementation limitations" above.
- **Expired-row housekeeping and a deterministic concurrent-bootstrap
  race test** — see "Implementation limitations" above; no owning
  issue yet, plausibly **M10**.
- **Domain/Ticket routes actually adopting the `requireSession`
  convention this slice establishes** —
  [#56](https://github.com/cristoforows/ticketIt/issues/56) is the
  first slice expected to add a real protected route beyond this one's
  own and the retrofitted diagnostic-notes.

## Decision impacts (open-decision IDs)

None of D1, D2, D4–D9 are resolved or touched by this slice. D3 is
unrelated — this slice has no Agent, Round, or execution concept, per
M2's scope rule. This record's decision-relevant content is entirely
the engineering choices issue #54 designates as this slice's own to
make and record: the Owner-matching rule (immutable id after
bootstrap, not login), the database-enforced Owner singleton, the
session/state token design (opaque, hashed, TTL-bound), the
authenticated-route convention (`requireSession`, a per-handler check
rather than middleware), and retrofitting that convention onto the
pre-existing diagnostic-notes routes — none of these are open product
decisions requiring D-series resolution. This slice provisions no paid
resource and creates no provider account, per `AGENTS.md`'s "Paid
resources" rule; the real-GitHub-OAuth-app step named in
"Owner configuration and GitHub OAuth sign-in" (`apps/galley/README.md`)
remains an Owner-approved, out-of-scope action for whenever M10
actually deploys this.
