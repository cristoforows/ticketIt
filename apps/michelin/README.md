# Michelin

ticketIt's runner: a long-lived TypeScript/Node process. It checks
Galley's `GET /api/status` on an interval
([#129](https://github.com/cristoforows/ticketIt/issues/129)), and
registers and heartbeats with its runner credential
([#130](https://github.com/cristoforows/ticketIt/issues/130)), claims a
Round
([#132](https://github.com/cristoforows/ticketIt/issues/132)), and runs
it with a scripted, controlled engine
([#134](https://github.com/cristoforows/ticketIt/issues/134)) that also
reports activity notes and usage observations
([#135](https://github.com/cristoforows/ticketIt/issues/135)) and
delivers a result
([#136](https://github.com/cristoforows/ticketIt/issues/136)): no model,
provider or network call beyond Galley. Every connection is outbound;
Michelin opens no listening socket. See
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
| `MICHELIN_CLAIM_INTERVAL_MS` | `5000` | Wait before each claim poll. Positive integer. |
| `MICHELIN_STATUS_INTERVAL_MS` | `10000` | Wait between the end of one status check and the start of the next. Positive integer. |
| `MICHELIN_ENGINE_SCRIPT` | the built-in default script | Path of a JSON file holding the controlled engine's script (see "Controlled engine"). |

A missing or invalid value logs an `invalid configuration` error
naming every problem and exits with code 1. A malformed token is
reported without echoing it. An unreadable or invalid script file is
reported with the variable, the path and, for a bad step, its index
(`steps[2]: ...`), never with the file's content.

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

Three loops run side by side:

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
- **Claim:** every `MICHELIN_CLAIM_INTERVAL_MS`, while the runner loop
  holds a successful registration, `POST /api/runner/claims` with no
  body. `204` means no work and is not logged. On `201` Michelin logs the
  Round and runs its script (next section). It does not poll claims
  while a Round runs, and polls again once the script ends or the Round
  is abandoned locally. A claim is not a heartbeat, and a failed claim
  never stops the runner loop.

Requests in one loop never overlap. The status and runner loops keep
running while a Round runs, so the runner stays Connected. Each request
times out after 5 seconds.

## Controlled engine

For each claimed Round the engine follows a deterministic script. It
makes no model or provider call. Each reporting step sends one event to
`POST /api/runner/rounds/{roundId}/events` with the claim's
`claimEpoch` and the time the event was built.

```json
{"steps": [
  {"step": "start"},
  {"step": "progress", "note": "Reading the Ticket"},
  {"step": "wait", "ms": 1500},
  {"step": "usage", "provider": "controlled", "model": "scripted",
   "inputTokens": 1200, "outputTokens": 300, "costUsd": "0.004500",
   "activeMs": 2000, "basis": "reported", "providerGenerationId": null},
  {"step": "deliver", "bodyMarkdown": "# Result\n\n- Found the cause\n",
   "summary": "Found the cause.", "criteriaAssessment": "A written cause: met."}
]}
```

| Step | Event | Idempotency key | Meaning |
|---|---|---|---|
| `start` | `execution_started` | `<roundId>:<step index>` | Report Execution started with a `controlled:<uuid>` engine reference generated once per Round. Must be the first step, and appears once. |
| `progress` | `progress` | `<roundId>:<step index>` | Append `note` (1 to 2000 characters, not blank, no control characters but tab and line feed) to the Round's activity. |
| `usage` | `usage_observed` | the `observationId` | Report one usage observation. `observationId` is a UUID generated once when the step runs. `provider` and `model` are required, 1 to 200 characters. `inputTokens`, `outputTokens` and `activeMs` are integers from 0 to 2^53−1. `costUsd` is a decimal string with at most 6 places, from `"0"` to `"999999.999999"`. `providerGenerationId` is optional. A figure that is absent or `null` is reported as unknown. `basis` is `reported` or `estimated`. |
| `wait` | none | none | Sleep `ms` (an integer, 1 to 3600000). |
| `deliver` | `delivered` | `<roundId>:<step index>` | Deliver the result: `bodyMarkdown` (1 to 1048576 bytes of UTF-8), `summary` (1 to 2000 characters) and `criteriaAssessment` (1 to 10000 characters), each not blank, with no control characters but tab and line feed. Galley moves the Ticket to In Review and frees the slot; the engine returns and the claim loop polls again. Only the last step. |
| `hold` | none | none | Wait until Michelin stops. Only the last step, so a script holds or delivers, never both. |

With `MICHELIN_ENGINE_SCRIPT` unset, the script is: `start`; progress
"Reading the Ticket", "Working towards the goal" and "Writing up the
result", one second apart; one `reported` usage observation from
provider `controlled`, model `scripted` (1200 in, 300 out, `"0.004500"`
USD, 2000 ms); then `deliver` with a short Markdown Report that says it
was written by a scripted engine.

The script is read and checked when Michelin starts, against the same
limits Galley enforces. An unknown step, an unknown key, an invalid
field, or a `deliver` or `hold` that is not the last step is a configuration error. The error names
the step and the steps supported now, so a script can never silently
do nothing and a bad note, figure or deliverable never abandons a Round.
"Not blank" uses Go's `unicode.IsSpace`, as Galley does, not
JavaScript's `\s`.

**Retry.** A network failure, a timeout, a `5xx`, or a `200`/`201` whose
body is not the expected result is retried with the identical request:
the same key, body, `occurredAt`, reference, `observationId` and deliverable. A
retried usage observation therefore never records a second observation
in Galley. Waits are 1, 2, 4, 8,
16 then 30 seconds, repeating at 30. Both `200` (a replay) and `201` are
success. Anything else is final: Michelin logs `round event refused;
round abandoned locally` with Galley's error code (`400`, `401`, `404`
`409` and `413` among them, including `observation_id_conflict`), stops that Round's script, and sends nothing
further for it. It never closes, fails or unlocks the Round, and never
exits. If Michelin restarts, it does not resume a Round it no longer
holds; a Round left `claimed` or `running` is recovered by
reconciliation, which is M5 (#6).

Stopping Michelin aborts a wait, a hold, a backoff and an in-flight
request at once.

## Logs

One JSON object per line on stdout: `time`, `level`, `msg`, plus
context fields. The credential is never logged.

| `msg` | `level` | Meaning |
|---|---|---|
| `galley status ok` | `info` | Galley answered and its database is `ok`. |
| `galley status ok but database unhealthy` | `warn` | Galley answered; `databaseStatus` is `error`. |
| `galley status check failed` | `error` | See `reason` below. |
| `runner registered` | `info` | Galley accepted the credential; `registeredAt`, `michelinVersion`, `hostname`. |
| `runner heartbeat ok` | `info` | Galley recorded `lastSeenAt`. |
| `runner credential rejected` | `error` | `401` on `step` `register`, `heartbeat` or `claim`: the credential is wrong or revoked. |
| `runner not registered with galley; registering again` | `warn` | `409 runner_not_registered`; registers immediately. |
| `runner register failed`, `runner heartbeat failed` | `error` | See `reason` below. |
| `round claimed` | `info` | `roundId`, `sequence`, `claimEpoch`, `ticketId`, `ticketTitle`. No other Ticket field is logged. |
| `runner claim failed` | `error` | See `reason` below; polling continues. |
| `execution started reported` | `info` | `roundId`, `step`, `stepIndex`, `attempt`, `engineReference`, `httpStatus` (`200` replay or `201`). |
| `progress reported` | `info` | As above, plus the note's `seq` from Galley. |
| `usage observation reported` | `info` | As above, plus `observationId`. |
| `delivery reported`, `engine delivered` | `info` | As above, plus Galley's `endedAt`; then the engine returns and polling resumes. |
| `round event failed; retrying` | `warn` | `roundId`, `step`, `attempt`, `reason`, `httpStatus`, `errorCode`, `retryInMs`. |
| `round event refused; round abandoned locally` | `error` | `roundId`, `step`, `attempt`, `httpStatus`, Galley's `errorCode`. |
| `engine holding`, `engine script finished` | `info` | The script reached `hold`, or its last step. |
| `engine failed unexpectedly` | `error` | A bug in the engine; polling resumes. |

A rejected credential does not stop Michelin: it keeps retrying
registration at the heartbeat interval, so a supervisor does not
restart-loop it. Pair again, update `.env`, and restart Michelin.

`reason` on a failed check or runner request:

| `reason` | Meaning |
|---|---|
| `unreachable` | No response (`code`, e.g. `ECONNREFUSED`, when the OS gave one). |
| `timeout` | No complete response within `timeoutMs`. |
| `http_status` | Non-2xx, or for a claim anything but `201` or `204`; `httpStatus` holds it (and Galley's `errorCode` for a Round event). |
| `invalid_body` | 2xx, but the body is not the expected response. |

`SIGINT` or `SIGTERM` aborts in-flight requests, clears every timer,
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
├── heartbeatLoop.ts  # register, then heartbeat; owns the shared registration flag
├── claimLoop.ts      # claim poll while registered; runs each claimed Round's script
├── engine.ts         # the controlled engine: script steps, event retry, abandonment
├── engineScript.ts   # the script format, its parser and the built-in default
├── galley/client.ts  # request helper and GET /api/status
├── galley/runner.ts  # register, heartbeat, claim and Round event requests
└── api/generated/schema.d.ts
```
