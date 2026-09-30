# Runner pairing, authentication, and health

## Purpose

M4.4, [#130](https://github.com/cristoforows/ticketIt/issues/130): the
Owner pairs one Michelin runner per Owner, Michelin authenticates with a
bearer credential, registers and heartbeats, and Swiftlet shows whether
the runner is connected. Touches `contracts/`, `apps/galley`,
`apps/michelin`, `apps/swiftlet` and `e2e/`.

Disconnect changes only the runner's health indicator, never a Ticket
or its Status. From M4.7 onwards the disconnect is overlaid on the
Ticket locked to the runner; reconciliation of work in flight is M5
([#6](https://github.com/cristoforows/ticketIt/issues/6)).

## What already existed

- Galley with session-cookie Owner auth (`requireSession`), the shared
  error shape, dev-only `/api/dev/` routes gated at registration,
  Tickets, Badges, Agents and Agent assignment (M4.1, #127), migrations
  up to `000010`.
- Michelin (M4.3, #129): a status loop polling `GET /api/status`, JSON
  logs, config validation that exits 1. No credential, no writes.
- Swiftlet: the order-rail shell and `/agents` page (#114, #127).
- M4.2 (#128) landed on main while this slice was open, and the branch
  merged it. This slice changes none of its readiness rules.
  `TestRunnerDisconnect_ChangesNoTicket` now fills in the readiness
  fields and moves Status before assigning the Agent, because M4.2 makes
  those moves Galley-owned once an Agent is assigned.

## What this slice added

**Contract** (`contracts/openapi.yaml`), regenerated into
`api.gen.go` and both `schema.d.ts` files:

| Route | Caller | Auth |
| --- | --- | --- |
| `POST /api/runner-credential` → `201 RunnerPairing` | Owner | session cookie |
| `DELETE /api/runner-credential` → `204` | Owner | session cookie |
| `GET /api/runner-health` → `RunnerHealth` | Owner | session cookie |
| `POST /api/runner/register` → `RunnerRegistration` | Michelin | `runnerBearer` |
| `POST /api/runner/heartbeat` → `RunnerHeartbeat`, `409 runner_not_registered` | Michelin | `runnerBearer` |
| `POST /api/dev/clock/advance` → `DevClock` | tests | session cookie, development only |

`runnerBearer` is an HTTP bearer security scheme applied to the two
`/api/runner/` operations. `RunnerHealth` carries `state`
(`connected`/`disconnected`/`not_paired`), Galley's `checkedAt`, and
nullable `pairedAt`, `registeredAt`, `lastSeenAt`, `michelinVersion`,
`hostname`.

**Galley**

- `000011_create_runners.up.sql`: `runners` with `UNIQUE (owner_id)`
  (one credential per Owner), `token_hash BYTEA UNIQUE` with a 32-byte
  check, and a check that registration fields are all set or all null.
- `internal/auth/runner.go`: `tir_` + 32 `crypto/rand` bytes in unpadded
  base64url (43 characters); the stored hash is SHA-256 of the full
  token string. `RunnerTokenHash` rejects anything that is not exactly
  that shape, including non-canonical and padded encodings.
- `internal/httpapi/runner.go`: the five runner handlers, derived
  health and `requireRunner`. `auth.go`: `requireSession` now refuses
  an `Authorization` header with the `Bearer` scheme. `devclock.go`: the dev
  clock. `handler.go`: `NewHandlerWithClock`, 405 registrations.
- `runners` joins `knownPublicTables` in
  `no_execution_side_effects_test.go`.

**Michelin**: `src/credentials.ts` is the only reader of
`MICHELIN_RUNNER_TOKEN` and wraps it in a `RunnerCredential` that
redacts itself in `toString`, `toJSON` and `util.inspect`.
`src/galley/runner.ts` and `src/heartbeatLoop.ts` register, then
heartbeat every `MICHELIN_HEARTBEAT_INTERVAL_MS` (default 10000).
`npm start` loads `.env` if present; `.gitignore` covers `.env` and
`.env.*`; the README gives `umask 077` / `chmod 600` steps.

**Swiftlet**: a `HealthPill` variant in `ui/Tags.tsx` (cva, order-rail
status tokens, no animation), `RunnerHealthPill` in the shell header
(10 s refresh, plus an immediate refresh on pair/revoke), and a Runner
section on `/agents` with pair, pair again, revoke, in-page confirms and
a show-once credential with Copy.

**Browser suite**: `e2e/tests/runner.spec.ts`, registered in `run.sh`
with its exit code checked.

### Engineering choices

- **Owner routes outside `/api/runner/`.** `/api/runner-credential` and
  `/api/runner-health` keep the rule "everything under `/api/runner/` is
  bearer-only" free of exceptions.
- **Pairing locks the Owner row.** `SELECT … FOR UPDATE` on `owners`,
  then delete and insert, in one transaction. `UNIQUE (owner_id)` alone
  makes concurrent pairings fail with a unique violation; the lock makes
  them queue, and the last one wins. Each pairing gets a new row id.
- **Revoke deletes the row**, as sessions do, and is idempotent. A
  revoked token then fails the hash lookup and returns 401.
- **Register before heartbeat.** A heartbeat from a credential that
  never registered is `409 runner_not_registered`, so Galley never holds
  a last-seen time without the version and hostname; Michelin answers it
  by registering again.
- **Health is derived at read time** from `last_seen_at` and the
  injected clock (`< 30 s` → connected), so no background job flips
  state and a Galley restart cannot leave a stale flag. Swiftlet's
  "last seen" is measured against `checkedAt`, not the browser clock.
- **Clock control for the browser suite.** `POST /api/dev/clock/advance`
  moves Galley's clock forward. It exists only when
  `GALLEY_ENVIRONMENT=development`, through the same registration-time
  gating as the other `/api/dev/` routes, requires a session, and is 404
  in production (shown below). The spec therefore crosses the 30 s
  window without a real wait.
- **Heartbeat complements the status loop.** The status loop still
  reports Galley's own database health, which a heartbeat does not.
  The two loops run side by side and stop together on a signal.
- **Michelin keeps running on 401.** It logs `runner credential
  rejected` with the step and a re-pair hint, then retries at the
  heartbeat interval, rather than exiting. A supervisor restart loop
  would not fix a wrong credential, and updating `.env` and restarting
  is the fix either way. A missing or malformed token is a config error
  and exits 1.
- **Only a 409 or 401 sends Michelin back to registering.** A timeout,
  an unreachable Galley, a 5xx or a bad body is retried as a heartbeat.
  Registering again rewrites `registered_at`, so resetting on every
  failure would make the `registeredAt` Galley reports mean "last
  network blip".
- **Auth boundary checks come first.** `requireSession` refuses a
  `Bearer` `Authorization` header, with the scheme matched
  case-insensitively, before reading the cookie. Other schemes pass,
  so a deployment behind a Basic-auth proxy still reaches Owner routes.
  Both guards parse the scheme with one helper, `bearerToken`.
  `requireRunner` refuses a session cookie even beside a valid bearer. Both answer with
  the shared `401 unauthenticated` and never clear the Owner's cookie.

## Exact versions and toolchain

- **Runtimes:** Go 1.27.1, Node 26.9.0, npm 11.19.1, PostgreSQL 17.11 (Homebrew, this host).
- **Galley (`apps/galley/go.mod`):** pgx/v5 5.11.0, golang-migrate/v4 4.20.1, oapi-codegen/v2 2.8.0, kin-openapi 0.149.0.
- **Contracts (`contracts/package.json`):** openapi-typescript 7.13.0.
- **Swiftlet (`apps/swiftlet/package.json`):** React 19.3.0, Tailwind CSS 4.3.3, TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1.
- **Michelin (`apps/michelin/package.json`):** TypeScript 5.9.3, Vitest 5.0.1, `@types/node` 26.6.2; no runtime dependencies.
- **Browser suite (`e2e/package.json`):** Playwright 1.63.0.

## Reproducible commands

```sh
cd apps/galley
gofmt -l . && go vet ./...
GALLEY_TEST_DATABASE_URL=postgres://localhost:5432/ticketit_test_m44?sslmode=disable go test -count=1 ./...
./scripts/check-contract-drift.sh
cd ../../contracts && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh
cd ../apps/swiftlet && npm ci && npm test && npm run build
cd ../michelin && npm ci && npm run typecheck && npm test
cd ../../e2e && E2E_DATABASE_URL=postgres://localhost:5432/ticketit_e2e_m44?sslmode=disable ./run.sh
```

The manual run below used a scratch database `ticketit_scratch_m44`
(migrated with `go run ./cmd/migrate`, dropped afterwards), Galley on
port 18431, and the substitute GitHub provider (`cmd/githubfake`) for
sign-in via `curl -L` with a cookie jar. Tokens are redacted here; the
runs used real ones.

## Observed results

**Checks** (after merging M4.2 and the review fixes). `gofmt -l` printed nothing; `go vet` clean. Galley
`go test ./...`: all packages `ok`, 758 tests and subtests passed, 0
failed. All three drift checks printed `OK … (no drift)`. Swiftlet: 18
files, 258 tests passed; `npm run build` succeeded. Michelin: typecheck
clean; 6 files, 53 tests passed. Browser suite: `SUITE PASSED`, every
spec exit code 0, 78 tests; `runner.spec.ts` passed in 20.7 s.

Runner tests in `internal/httpapi` and `internal/auth`:

```text
--- PASS: TestRunner_ResponsesMatchContractAndMethod405
--- PASS: TestPairRunner_ReturnsTokenOnceAndStoresOnlyItsHash
--- PASS: TestRunnerHealth_TransitionsAtTheThirtySecondBoundary
--- PASS: TestRunnerCredential_WrongMalformedAndRevokedAre401
--- PASS: TestPairRunner_RepairingRevokesThePreviousCredential
--- PASS: TestPairRunner_ConcurrentPairsLeaveExactlyOneActiveCredential
--- PASS: TestRunnerCredentials_OneActiveRowPerOwnerIsEnforcedByTheDatabase
--- PASS: TestRunnerEndpoints_RejectOwnerSessions
--- PASS: TestOwnerEndpoints_RejectRunnerBearerTokens
--- PASS: TestOwnerEndpoints_AcceptNonBearerAuthorizationBesideASession
--- PASS: TestRegisterRunner_ValidatesTheBody
--- PASS: TestRunnerDisconnect_ChangesNoTicket
--- PASS: TestAdvanceDevClock_MovesRunnerHealthInDevelopmentOnly
--- PASS: TestNewRunnerToken_ShapeAndHashOfFullToken
--- PASS: TestRunnerTokenHash_RejectsMalformedTokens
```

`TestOwnerEndpoints_RejectRunnerBearerTokens` walks every contract
operation except the public ones and those under `/api/runner/` (25
operations) with `Bearer`, `bearer` and `BEARER` tokens, with and
without a session, so a new Owner route is covered without editing the
test. `TestOwnerEndpoints_AcceptNonBearerAuthorizationBesideASession`
sends `Authorization: Basic …` and `Digest …` beside a valid session to
every parameterless Owner `GET` and expects 200.

Michelin's `heartbeatLoop.test.ts` checks that an unreachable Galley, a
503, a non-JSON body and a timeout on a heartbeat are each followed by
another heartbeat, not a register.

**Health pill contrast** (`tokens.test.ts`, `healthPillPairs`; text,
dot and border share one colour, and the pill has no fill of its own):

| Pill | Foreground | Surface | Ratio |
| --- | --- | --- | --- |
| Header, connected | `status-done-text` #43aa8b | `header` #1a1816 | 6.21:1 |
| Header, disconnected | `status-blocked-text` #e26161 | `header` | 5.16:1 |
| Header, not paired / unknown | `dim` #a8a29e | `header` | 7.02:1 |
| Ground tone, connected | `status-done-text` | `ground` #23201d | 5.68:1 |
| Ground tone, disconnected | `status-blocked-text` | `ground` | 4.72:1 |
| Ground tone, not paired / unknown | `dim` | `ground` | 6.43:1 |
| Runner section, connected | `status-done-deep` #327e67 | `paper` #fffdf7 | 4.78:1 |
| Runner section, disconnected | `status-blocked-deep` #d62828 | `paper` | 4.92:1 |
| Runner section, not paired / unknown | `muted` #736c66 | `paper` | 5.08:1 |

The header pill sits on `bg-header` (the `AppHeader` element), and the
`ground` rows cover the same tone on the page ground. No token changed.

**Falsification.** Each guard was broken on purpose, the named test
was run, and the file was restored with `git checkout`:

```text
### requireSession skips its Authorization check
--- FAIL: TestOwnerEndpoints_RejectRunnerBearerTokens (0.17s)
        runner_test.go:458: status=200, want 401; body={"tickets":[…]}   (truncated here)
        runner_test.go:458: status=200, want 401; body={"tickets":[…]}   (truncated here)
        runner_test.go:458: status=400, want 401; body={"error":{"code":"invalid_request","message":"\"title\" must be a non-empty string"}}
        runner_test.go:458: status=400, want 401; body={"error":{"code":"invalid_request","message":"\"title\" must be a non-empty string"}}
        runner_test.go:458: status=204, want 401; body=
        runner_test.go:461: a bearer rejection touched the session cookie: ticketit_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax
        runner_test.go:461: a bearer rejection touched the session cookie: ticketit_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax
### requireRunner ignores the session cookie
--- FAIL: TestRunnerEndpoints_RejectOwnerSessions (0.10s)
        runner_test.go:396: status=200, want 401; body={"registeredAt":"2026-10-01T12:00:00Z"}
        runner_test.go:396: status=200, want 401; body={"lastSeenAt":"2026-10-01T12:00:00Z"}
    runner_test.go:401: a rejected runner request changed the runner: {CheckedAt:2026-10-01 12:00:00 +0000 UTC Hostname:0x78d449991550 LastSeenAt:2026-10-01 12:00:00 +0000 UTC MichelinVersion:0x78d449991560 PairedAt:2026-10-01 12:00:00 +0000 UTC RegisteredAt:2026-10-01 12:00:00 +0000 UTC State:connected}
FAIL
FAIL	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.566s
FAIL
### health window uses <=
--- FAIL: TestRunnerHealth_TransitionsAtTheThirtySecondBoundary (0.09s)
    runner_test.go:217: 30s after the last heartbeat: health = {CheckedAt:2026-10-01 12:00:35 +0000 UTC Hostname:0x50823a7137f0 LastSeenAt:2026-10-01 12:00:05 +0000 UTC MichelinVersion:0x50823a713800 PairedAt:2026-10-01 12:00:00 +0000 UTC RegisteredAt:2026-10-01 12:00:05 +0000 UTC State:connected}, want disconnected with lastSeenAt 2026-10-01 12:00:05 +0000 UTC
FAIL
FAIL	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.643s
FAIL
### owner row lock removed
--- FAIL: TestPairRunner_ConcurrentPairsLeaveExactlyOneActiveCredential (0.11s)
    runner_test.go:334: trial 0 pair 2: status=503; body={"error":{"code":"database_unavailable","message":"failed to pair the runner"}}
    runner_test.go:334: trial 0 pair 0: status=503; body={"error":{"code":"database_unavailable","message":"failed to pair the runner"}}
    runner_test.go:334: trial 0 pair 1: status=503; body={"error":{"code":"database_unavailable","message":"failed to pair the runner"}}
    runner_test.go:334: trial 0 pair 4: status=503; body={"error":{"code":"database_unavailable","message":"failed to pair the runner"}}
    runner_test.go:334: trial 0 pair 6: status=503; body={"error":{"code":"database_unavailable","message":"failed to pair the runner"}}
    runner_test.go:334: trial 0 pair 8: status=503; body={"error":{"code":"database_unavailable","message":"failed to pair the runner"}}
FAIL
```

Added after review, with the same procedure:

```text
### requireSession refuses every Authorization header (the first version's rule)
--- FAIL: TestOwnerEndpoints_AcceptNonBearerAuthorizationBesideASession
        runner_test.go:649: GET /api/tickets with Authorization "Basic b3duZXI6cHJveHk=": status=401, want 200; body={"error":{"code":"unauthenticated","message":"sign-in required"}}
### requireSession matches only the exact-case "Bearer " prefix
--- FAIL: TestOwnerEndpoints_RejectRunnerBearerTokens
    --- FAIL: TestOwnerEndpoints_RejectRunnerBearerTokens/listTickets_lowercase_bearer
    --- FAIL: TestOwnerEndpoints_RejectRunnerBearerTokens/listTickets_uppercase_bearer
### heartbeatLoop registers again after every failure
× logs an unreachable Galley distinctly and keeps retrying
× keeps heartbeating, without registering again, after an unreachable Galley
× keeps heartbeating, without registering again, after a server error
× keeps heartbeating, without registering again, after a non-JSON body
× keeps heartbeating, without registering again, after a timeout
Tests  5 failed | 10 passed (15)
```

**Manual run: Galley** (development, scratch database):

```text
$ curl -si -X POST /api/runner-credential (session)
HTTP/1.1 201 Created
Cache-Control: no-store
{"health":{"checkedAt":"2026-09-30T16:28:02.743139Z","hostname":null,"lastSeenAt":null,"michelinVersion":null,"pairedAt":"2026-09-30T16:28:02.743139Z","registeredAt":null,"state":"disconnected"},"token":"tir_<43 chars, redacted>"}
$ psql: SELECT id, octet_length(token_hash), token_hash = sha256(<token>) FROM runners
1|32|t
$ curl /api/runner-health (session)
{"checkedAt":"2026-09-30T16:28:02.801179Z","hostname":null,"lastSeenAt":null,"michelinVersion":null,"pairedAt":"2026-09-30T16:28:02.743139Z","registeredAt":null,"state":"disconnected"}
$ curl -X POST /api/runner/heartbeat (bearer, before register)
{"error":{"code":"runner_not_registered","message":"this runner credential has not registered; call POST /api/runner/register first"}} 409
$ curl -X POST /api/runner/register (bearer)
{"registeredAt":"2026-09-30T16:28:02.811402Z"} 200
$ curl -X POST /api/runner/heartbeat (bearer)
{"lastSeenAt":"2026-09-30T16:28:02.816858Z"} 200
$ curl /api/runner-health (session)
{"checkedAt":"2026-09-30T16:28:02.822419Z","hostname":"manual-host","lastSeenAt":"2026-09-30T16:28:02.816858Z","michelinVersion":"0.1.0","pairedAt":"2026-09-30T16:28:02.743139Z","registeredAt":"2026-09-30T16:28:02.811402Z","state":"connected"}
$ curl -X POST /api/runner/heartbeat (session cookie only)
{"error":{"code":"unauthenticated","message":"sign-in required"}} 401
$ curl -X POST /api/runner/heartbeat (bearer + session cookie)
{"error":{"code":"unauthenticated","message":"sign-in required"}} 401
$ curl -X POST /api/runner/heartbeat (malformed bearer)
{"error":{"code":"unauthenticated","message":"sign-in required"}} 401
$ curl /api/tickets (bearer only)
{"error":{"code":"unauthenticated","message":"sign-in required"}} 401
$ curl /api/runner-health (session + bearer)
{"error":{"code":"unauthenticated","message":"sign-in required"}} 401
$ curl -X GET /api/runner/heartbeat
HTTP/1.1 405 Method Not Allowed
Allow: POST
$ curl -X POST /api/dev/clock/advance {"seconds":30} (session, development)
{"now":"2026-09-30T16:28:32.855481Z"} 200
$ curl /api/runner-health (session)
{"checkedAt":"2026-09-30T16:28:32.860409Z","hostname":"manual-host","lastSeenAt":"2026-09-30T16:28:02.816858Z","michelinVersion":"0.1.0","pairedAt":"2026-09-30T16:28:02.743139Z","registeredAt":"2026-09-30T16:28:02.811402Z","state":"disconnected"}
$ curl -X POST /api/runner-credential (pair again)
201
$ curl -X POST /api/runner/heartbeat (previous bearer)
{"error":{"code":"unauthenticated","message":"sign-in required"}} 401
$ curl -X DELETE /api/runner-credential
204
$ curl /api/runner-health (session)
{"checkedAt":"2026-09-30T16:28:32.882077Z","hostname":null,"lastSeenAt":null,"michelinVersion":null,"pairedAt":null,"registeredAt":null,"state":"not_paired"}
$ grep -c tir_ galley.log
0
```

**Manual run: Michelin** against the same Galley. The token never
appears in any log line:

```text
$ GALLEY_URL=http://127.0.0.1:18431 MICHELIN_RUNNER_TOKEN=<paired> MICHELIN_HEARTBEAT_INTERVAL_MS=500 node src/main.ts   # SIGTERM after ~1.3 s
{"time":"2026-09-30T16:28:20.134Z","level":"info","msg":"michelin starting","galleyUrl":"http://127.0.0.1:18431/","statusIntervalMs":10000,"heartbeatIntervalMs":500,"node":"v26.9.0","michelinVersion":"0.1.0","hostname":"Mac-mini.local"}
{"time":"2026-09-30T16:28:20.175Z","level":"info","msg":"galley status ok","galleyUrl":"http://127.0.0.1:18431/","durationMs":37,"version":"dev","environment":"development","startedAt":"2026-09-30T16:27:30Z","databaseStatus":"ok","migrationVersion":11}
{"time":"2026-09-30T16:28:20.175Z","level":"info","msg":"runner registered","galleyUrl":"http://127.0.0.1:18431/","durationMs":8,"registeredAt":"2026-09-30T16:28:50.1731Z","michelinVersion":"0.1.0","hostname":"Mac-mini.local"}
{"time":"2026-09-30T16:28:20.680Z","level":"info","msg":"runner heartbeat ok","galleyUrl":"http://127.0.0.1:18431/","durationMs":4,"lastSeenAt":"2026-09-30T16:28:50.678102Z"}
{"time":"2026-09-30T16:28:21.184Z","level":"info","msg":"runner heartbeat ok","galleyUrl":"http://127.0.0.1:18431/","durationMs":3,"lastSeenAt":"2026-09-30T16:28:51.182876Z"}
{"time":"2026-09-30T16:28:21.268Z","level":"info","msg":"michelin stopping","signal":"SIGTERM"}
{"time":"2026-09-30T16:28:21.269Z","level":"info","msg":"michelin stopped"}
exit=0
$ curl /api/runner-health
{"checkedAt":"2026-09-30T16:28:51.30156Z","hostname":"Mac-mini.local","lastSeenAt":"2026-09-30T16:28:51.182876Z","michelinVersion":"0.1.0","pairedAt":"2026-09-30T16:28:49.914836Z","registeredAt":"2026-09-30T16:28:50.1731Z","state":"connected"}
$ ... MICHELIN_RUNNER_TOKEN=<well-formed but unknown> node src/main.ts   # SIGTERM after ~0.8 s
{"time":"2026-09-30T16:28:21.394Z","level":"info","msg":"michelin starting","galleyUrl":"http://127.0.0.1:18431/","statusIntervalMs":10000,"heartbeatIntervalMs":500,"node":"v26.9.0","michelinVersion":"0.1.0","hostname":"Mac-mini.local"}
{"time":"2026-09-30T16:28:21.412Z","level":"info","msg":"galley status ok","galleyUrl":"http://127.0.0.1:18431/","durationMs":16,"version":"dev","environment":"development","startedAt":"2026-09-30T16:27:30Z","databaseStatus":"ok","migrationVersion":11}
{"time":"2026-09-30T16:28:21.412Z","level":"error","msg":"runner credential rejected","galleyUrl":"http://127.0.0.1:18431/","step":"register","httpStatus":401,"action":"the credential is wrong or revoked; pair the runner again in Swiftlet and update MICHELIN_RUNNER_TOKEN"}
{"time":"2026-09-30T16:28:21.916Z","level":"error","msg":"runner credential rejected","galleyUrl":"http://127.0.0.1:18431/","step":"register","httpStatus":401,"action":"the credential is wrong or revoked; pair the runner again in Swiftlet and update MICHELIN_RUNNER_TOKEN"}
{"time":"2026-09-30T16:28:22.120Z","level":"info","msg":"michelin stopping","signal":"SIGTERM"}
{"time":"2026-09-30T16:28:22.121Z","level":"info","msg":"michelin stopped"}
exit=0
$ ... GALLEY_URL=http://127.0.0.1:18499 node src/main.ts   # nothing listening, SIGTERM after ~0.8 s
{"time":"2026-09-30T16:28:35.772Z","level":"error","msg":"galley status check failed","galleyUrl":"http://127.0.0.1:18499/","durationMs":23,"reason":"unreachable","error":"connect ECONNREFUSED 127.0.0.1:18499","code":"ECONNREFUSED"}
{"time":"2026-09-30T16:28:35.772Z","level":"error","msg":"runner register failed","galleyUrl":"http://127.0.0.1:18499/","durationMs":3,"reason":"unreachable","error":"connect ECONNREFUSED 127.0.0.1:18499","code":"ECONNREFUSED"}
{"time":"2026-09-30T16:28:36.275Z","level":"error","msg":"runner register failed","galleyUrl":"http://127.0.0.1:18499/","durationMs":2,"reason":"unreachable","error":"connect ECONNREFUSED 127.0.0.1:18499","code":"ECONNREFUSED"}
exit=0
$ GALLEY_URL=... node src/main.ts   # no MICHELIN_RUNNER_TOKEN
{"time":"2026-09-30T16:28:23.067Z","level":"error","msg":"invalid configuration","problems":["MICHELIN_RUNNER_TOKEN is required: pair the runner in Swiftlet (Agents, Runner) and put the credential in Michelin's .env"]}
exit=1
$ grep -c tir_ michelin logs (all runs above)
0
```

**Production gating** (`GALLEY_ENVIRONMENT=production`, same binary):

```text
$ curl -si -X POST /api/dev/clock/advance   # GALLEY_ENVIRONMENT=production
HTTP/1.1 404 Not Found
{"error":{"code":"not_found","message":"no route for POST /api/dev/clock/advance"}}
$ curl -si -X GET /api/dev/clock/advance   # production
HTTP/1.1 404 Not Found
```

## Implementation limitations and follow-ups

None within #130's scope. The runner reports health only: it claims no
work and runs no engine. Overlaying a disconnect on the locked Ticket
starts at M4.7; reconciling in-flight work after a disconnect is M5
(#6).

## Outstanding checks and owning milestone

- The pill and Runner section were checked by unit tests and the
  Chromium browser suite, not a manual screen-reader pass. Contrast
  is asserted per pill colour and surface (table above).
- CI does not run the browser suite; `runner.spec.ts` ran locally
  through `run.sh` only.
- Stranded-runner recovery and reconciliation after disconnect: M5
  (#6, D5).

## Decision impacts (open-decision IDs)

None resolved. D5 (stranded-runner recovery) now has a health signal
and last-seen time to build on; the decision stays with M5 (#6). D1,
D2, D4, D6–D9 are untouched.
