# Michelin

ticketIt's runner: a long-lived TypeScript/Node process. This slice
([issue #129](https://github.com/cristoforows/ticketIt/issues/129))
only checks Galley's `GET /api/status` on start and on an interval and
logs each result. No pairing, credentials, claims, or engine yet. See
[ADR 0001](../../docs/adr/0001-single-authority-galley.md): Michelin
reports facts to Galley and owns no workflow rule.

Builds, typechecks, and tests with Node alone; no Go.

## Commands

Node `26.9.0` (`engines`). Run from this directory.

```sh
npm ci
npm start           # node src/main.ts
npm run typecheck   # tsc --noEmit
npm test
```

Node runs the TypeScript directly through its built-in type stripping,
so `tsconfig.json` sets `erasableSyntaxOnly` and relative imports carry
their `.ts` extension. There is no build step or emitted output.

## Configuration

Environment variables only.

| Variable | Default | Meaning |
|---|---|---|
| `GALLEY_URL` | `http://localhost:8080` | Galley's base URL, `http` or `https`. |
| `MICHELIN_STATUS_INTERVAL_MS` | `10000` | Wait between the end of one check and the start of the next. Positive integer. |

An invalid value logs an `invalid configuration` error naming every
problem and exits with code 1.

## Behaviour

- Checks `GET /api/status` at start, then again `MICHELIN_STATUS_INTERVAL_MS`
  after each check finishes, so checks never overlap.
- Each request times out after 5 seconds.
- One JSON object per line on stdout: `time`, `level`, `msg`, plus
  context fields.

| `msg` | `level` | Meaning |
|---|---|---|
| `galley status ok` | `info` | Galley answered and its database is `ok`. |
| `galley status ok but database unhealthy` | `warn` | Galley answered; `databaseStatus` is `error`. |
| `galley status check failed` | `error` | See `reason` below. |

`reason` on a failed check:

| `reason` | Meaning |
|---|---|
| `unreachable` | No response (`code`, e.g. `ECONNREFUSED`, when the OS gave one). |
| `timeout` | No complete response within `timeoutMs`. |
| `http_status` | Non-2xx; `httpStatus` holds it. |
| `invalid_body` | 2xx, but the body is not a valid status response. |

`SIGINT` or `SIGTERM` aborts an in-flight request, clears the timer,
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
├── main.ts        # entrypoint: config, logger, loop, signals
├── config.ts      # environment parsing and validation
├── logger.ts      # JSON-lines logger
├── statusLoop.ts  # interval loop and shutdown
├── galley/client.ts   # GET /api/status, typed from the generated schema
└── api/generated/schema.d.ts
```
