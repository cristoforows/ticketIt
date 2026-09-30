# Michelin

ticketIt's runner: a long-lived TypeScript/Node process. It checks
Galley's `GET /api/status` on an interval
([#129](https://github.com/cristoforows/ticketIt/issues/129)), and
registers and heartbeats with its runner credential
([#130](https://github.com/cristoforows/ticketIt/issues/130)). No
claims or engine yet. Every connection is outbound; Michelin opens no
listening socket. See
[ADR 0001](../../docs/adr/0001-single-authority-galley.md): Michelin
reports facts to Galley and owns no workflow rule.

Builds, typechecks, and tests with Node alone; no Go.

## Commands

Node `26.9.0` (`engines`). Run from this directory.

```sh
npm ci
npm start           # node --env-file-if-exists=.env src/main.ts
npm run typecheck   # tsc --noEmit
npm test
```

Node runs the TypeScript directly through its built-in type stripping,
so `tsconfig.json` sets `erasableSyntaxOnly` and relative imports carry
their `.ts` extension. There is no build step or emitted output.

## Configuration

Environment variables only. `npm start` also loads `apps/michelin/.env`
when it exists.

| Variable | Default | Meaning |
|---|---|---|
| `GALLEY_URL` | `http://localhost:8080` | Galley's base URL, `http` or `https`. |
| `MICHELIN_RUNNER_TOKEN` | none (required) | The runner credential from **Pair runner**: `tir_` and 43 base64url characters. |
| `MICHELIN_HEARTBEAT_INTERVAL_MS` | `10000` | Wait between the end of one register/heartbeat request and the start of the next. Positive integer. |
| `MICHELIN_STATUS_INTERVAL_MS` | `10000` | Wait between the end of one status check and the start of the next. Positive integer. |

A missing or invalid value logs an `invalid configuration` error
naming every problem and exits with code 1. A malformed token is
reported without echoing it.

### Runner credential

1. In Swiftlet, open **Agents**, then **Runner**, and choose **Pair
   runner**. The credential is shown once.
2. Put it in `apps/michelin/.env`, which `.gitignore` excludes, and
   make the file readable only by you:

   ```sh
   cd apps/michelin
   umask 077
   printf 'MICHELIN_RUNNER_TOKEN=%s\n' 'tir_...' > .env
   chmod 600 .env
   ```

3. `npm start`.

There is no OS keychain in v1. `src/credentials.ts` is the only module
that reads `MICHELIN_RUNNER_TOKEN`; the credential object redacts
itself when stringified, serialised, or inspected, so no log line
carries it. Pairing again or **Revoke** in Swiftlet revokes the
credential immediately; Michelin then logs `runner credential rejected`.

## Behaviour

Two independent loops run side by side:

- **Status:** `GET /api/status` at start, then again
  `MICHELIN_STATUS_INTERVAL_MS` after each check finishes. It reports
  Galley's own health, including its database.
- **Runner:** `POST /api/runner/register` (Michelin's version and the
  host name) at start, then `POST /api/runner/heartbeat` every
  `MICHELIN_HEARTBEAT_INTERVAL_MS`. Galley shows the runner Connected
  while the last one is under 30 seconds old. Until a registration
  succeeds, every attempt is a registration. After that, only a `409`
  or `401` leads back to registering; a timeout, an unreachable Galley
  or another failed heartbeat is retried as a heartbeat, so Galley's
  `registeredAt` does not move on a network blip.

Requests in one loop never overlap. Each request times out after 5
seconds. Logs are one JSON object per line on stdout: `time`, `level`,
`msg`, plus context fields.

| `msg` | `level` | Meaning |
|---|---|---|
| `galley status ok` | `info` | Galley answered and its database is `ok`. |
| `galley status ok but database unhealthy` | `warn` | Galley answered; `databaseStatus` is `error`. |
| `galley status check failed` | `error` | See `reason` below. |
| `runner registered` | `info` | Galley accepted the credential; `registeredAt`, `michelinVersion`, `hostname`. |
| `runner heartbeat ok` | `info` | Galley recorded `lastSeenAt`. |
| `runner credential rejected` | `error` | `401` on `step` `register` or `heartbeat`: the credential is wrong or revoked. |
| `runner not registered with galley; registering again` | `warn` | `409 runner_not_registered`; registers immediately. |
| `runner register failed`, `runner heartbeat failed` | `error` | See `reason` below. |

A rejected credential does not stop Michelin: it keeps retrying
registration at the heartbeat interval, so a supervisor does not
restart-loop it. Pair again, update `.env`, and restart Michelin.

`reason` on a failed check or runner request:

| `reason` | Meaning |
|---|---|
| `unreachable` | No response (`code`, e.g. `ECONNREFUSED`, when the OS gave one). |
| `timeout` | No complete response within `timeoutMs`. |
| `http_status` | Non-2xx; `httpStatus` holds it. |
| `invalid_body` | 2xx, but the body is not the expected response. |

`SIGINT` or `SIGTERM` aborts in-flight requests, clears both timers,
logs `michelin stopping` and `michelin stopped`, and exits with code 0.

## Generated types

`src/api/generated/schema.d.ts` comes from `contracts/openapi.yaml`.
Regenerate and check drift from `contracts/`:

```sh
npm ci
npm run generate:michelin
npm run check:michelin-drift
```

## Layout

```text
src/
├── main.ts           # entrypoint: config, logger, loops, signals
├── config.ts         # environment parsing and validation
├── credentials.ts    # the only reader of MICHELIN_RUNNER_TOKEN
├── logger.ts         # JSON-lines logger
├── statusLoop.ts     # status interval loop and shutdown
├── heartbeatLoop.ts  # register, then heartbeat
├── galley/client.ts  # request helper and GET /api/status
├── galley/runner.ts  # register and heartbeat requests
└── api/generated/schema.d.ts
```
