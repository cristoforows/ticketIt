# Michelin application boot

## Purpose

Add `apps/michelin`, the runner application skeleton: a Node process that
reads Galley's address from configuration, calls `GET /api/status` on
start and on an interval, logs each result, and exits cleanly on
`SIGINT`/`SIGTERM`. Tracking issue:
[#129 — M4.3 — Michelin application boot](https://github.com/cristoforows/ticketIt/issues/129),
under [M4 (#5)](https://github.com/cristoforows/ticketIt/issues/5).

## What already existed

Galley and Swiftlet with their CI jobs, and `contracts/openapi.yaml` with
generated Go and TypeScript (Swiftlet) clients. No runner application.

## What this slice added

- `apps/michelin`: `package.json`, `tsconfig.json`, committed
  `package-lock.json`, and `src/`: `main.ts`, `config.ts`, `logger.ts`,
  `statusLoop.ts`, `galley/client.ts`, with unit tests beside each.
- `contracts/package.json`: `generate:michelin` and
  `check:michelin-drift`; `contracts/check-michelin-drift.sh`, written like
  `check-swiftlet-drift.sh`; generated
  `apps/michelin/src/api/generated/schema.d.ts`.
- `.github/workflows/ci.yml`: a `michelin` job (`npm ci`, `npm run typecheck`,
  `npm test`) and a `Michelin contract drift` step in the `contracts` job.
- `apps/michelin/README.md`; `contracts/README.md` and the `run-dev` skill
  mention Michelin.

Engineering choices inside the settled Decisions:

- **No lint step.** The issue asks to mirror Swiftlet's lint if it has one;
  Swiftlet has no ESLint, so Michelin has none. The CI job runs typecheck
  and tests.
- **TypeScript 5.9.3, not Swiftlet's 7.0.2.** The issue's Decisions name
  5.9.3 (also what `contracts/` pins); Swiftlet's pin is 7.0.2. The named
  version was used.
- **Response body validated at runtime.** `fetchStatus` checks every field
  of the generated `StatusResponse` before returning it; there is no cast
  of the parsed body.
- **Checks are sequential.** The next check starts `MICHELIN_STATUS_INTERVAL_MS`
  after the previous one finishes, which makes overlap impossible.
- **Fixed 5 second request timeout**, covering the response body read. Not
  configurable: no second setting was asked for.
- **Failure taxonomy in logs.** `reason` is one of `unreachable` (with the OS
  `code`), `timeout`, `http_status`, `invalid_body`. An abort caused by
  shutdown is not logged as a failure. A reachable Galley whose database
  reports `error` logs at `warn`.
- **Config errors go through the same JSON logger** on stdout and set exit
  code 1. Process exit after a signal is natural (no `process.exit`), so a
  leaked timer or request would keep the process alive and fail the spawn
  test.
- **Injection.** `startStatusLoop` takes `fetch` and a logger; timers are
  the globals, controlled with vitest fake timers.
- **Real-run finding.** `localhost` resolves to `::1` and `127.0.0.1`, so
  Node's connection error is an `AggregateError` with an empty message. The
  first real run logged `"error":""`; `unreachable` in
  `src/galley/client.ts` now falls back to the nested error's message, and
  a test covers it.

## Exact versions and toolchain

Confirmed against `apps/michelin/package-lock.json` after `npm ci`:

- Node `26.9.0` (`engines.node`; also the CI `setup-node` version); npm
  `11.19.1`.
- `typescript` `5.9.3`, `vitest` `5.0.1`, `@types/node` `26.6.2`. No runtime
  dependencies.
- Codegen in `contracts/`: `openapi-typescript` `7.13.0`.
- Go is used only for the local Galley in the run below, not by Michelin.

## Reproducible commands

```sh
cd apps/michelin && npm ci && npm run typecheck && npm test
cd contracts && npm ci && npm run check:michelin-drift && npm run check:swiftlet-drift
```

Local run against Galley (scratch database, free port):

```sh
createdb ticketit_m43
cd apps/galley
DATABASE_URL=postgres://localhost:5432/ticketit_m43?sslmode=disable go run ./cmd/migrate
DATABASE_URL=postgres://localhost:5432/ticketit_m43?sslmode=disable GALLEY_PORT=18129 \
  GALLEY_OWNER_GITHUB_LOGIN=m43-owner GALLEY_OAUTH_GITHUB_CLIENT_ID=x \
  GALLEY_OAUTH_GITHUB_CLIENT_SECRET=x go run ./cmd/galley
cd apps/michelin
GALLEY_URL=http://localhost:18129 MICHELIN_STATUS_INTERVAL_MS=1000 npm start
# stop Galley, wait, then Ctrl-C Michelin
dropdb ticketit_m43
```

## Observed results

Unit and process tests: 30 tests in 4 files, all
passing (`config`, `logger`, `statusLoop` with fake timers and injected
`fetch`, and `main.test.ts`, which spawns `node src/main.ts` against a
local HTTP server, sends `SIGTERM`, and asserts exit code 0 and the exact
log sequence; a second case asserts exit code 1 on bad configuration).
Drift checks for Michelin and Swiftlet print `OK: ... (no drift)`.

Local run (Galley on port 18129 against `ticketit_m43`, stopped after the
third check; then `SIGINT` to Michelin). Galley's own `curl` answer for
reference: `{"application":"galley","status":"ok","version":"dev","environment":"development","startedAt":"2026-09-30T15:22:47Z","database":{"migrationVersion":9,"status":"ok"}}`.
Michelin's stdout:

```json
{"time":"2026-09-30T15:23:15.432Z","level":"info","msg":"michelin starting","galleyUrl":"http://localhost:18129/","statusIntervalMs":1000,"node":"v26.9.0"}
{"time":"2026-09-30T15:23:15.467Z","level":"info","msg":"galley status ok","galleyUrl":"http://localhost:18129/","durationMs":33,"version":"dev","environment":"development","startedAt":"2026-09-30T15:23:13Z","databaseStatus":"ok","migrationVersion":9}
{"time":"2026-09-30T15:23:16.470Z","level":"info","msg":"galley status ok","galleyUrl":"http://localhost:18129/","durationMs":3,"version":"dev","environment":"development","startedAt":"2026-09-30T15:23:13Z","databaseStatus":"ok","migrationVersion":9}
{"time":"2026-09-30T15:23:17.475Z","level":"info","msg":"galley status ok","galleyUrl":"http://localhost:18129/","durationMs":4,"version":"dev","environment":"development","startedAt":"2026-09-30T15:23:13Z","databaseStatus":"ok","migrationVersion":9}
{"time":"2026-09-30T15:23:18.480Z","level":"error","msg":"galley status check failed","galleyUrl":"http://localhost:18129/","durationMs":4,"reason":"unreachable","error":"connect ECONNREFUSED ::1:18129","code":"ECONNREFUSED"}
{"time":"2026-09-30T15:23:19.484Z","level":"error","msg":"galley status check failed","galleyUrl":"http://localhost:18129/","durationMs":2,"reason":"unreachable","error":"connect ECONNREFUSED ::1:18129","code":"ECONNREFUSED"}
{"time":"2026-09-30T15:23:20.357Z","level":"info","msg":"michelin stopping","signal":"SIGINT"}
{"time":"2026-09-30T15:23:20.358Z","level":"info","msg":"michelin stopped"}
```

After the `SIGINT` the Michelin process was gone; an earlier manual run
(`GALLEY_URL=http://127.0.0.1:1`, `kill -INT`, `wait`) printed `exit=0`.
Bad configuration (`GALLEY_URL=ftp://x MICHELIN_STATUS_INTERVAL_MS=0`):

```json
{"time":"2026-09-30T15:23:21.473Z","level":"error","msg":"invalid configuration","problems":["GALLEY_URL must use http or https, got \"ftp://x\"","MICHELIN_STATUS_INTERVAL_MS must be a positive integer, got \"0\""]}
```

exit code 1. Galley and Michelin were stopped and `ticketit_m43` dropped.

## Implementation limitations and follow-ups

None against this slice's scope. Pairing, credentials, heartbeat, claims
and the controlled engine are M4.4 onwards (#130 and later). Michelin
does not retry with backoff; it checks at a fixed interval, which is all
this slice needs.

## Outstanding checks and owning milestone

- A check failure only logs; no Round is closed or unlocked by it. The
  distinction between lost contact, unknown execution, stale reports and
  confirmed cessation arrives with heartbeat and reporting (M4.4 onwards)
  and stranded-runner recovery (D5, M5 #6).
- Not run in `e2e/`: no Swiftlet → Galley → Michelin path exists yet.

## Decision impacts (open-decision IDs)

None. D1, D2, D4–D9 are untouched.
