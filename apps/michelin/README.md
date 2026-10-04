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
([#136](https://github.com/cristoforows/ticketIt/issues/136)), and
pulls the Round's commands so the Owner can Stop it
([#159](https://github.com/cristoforows/ticketIt/issues/159)), and can
report a Failed or Interrupted Round
([#161](https://github.com/cristoforows/ticketIt/issues/161)): no model,
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
| `MICHELIN_COMMAND_INTERVAL_MS` | `1000` | Wait before each poll of the held Round's commands. Positive integer. |
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

Three loops run side by side, and a fourth while a Round is held:

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
- **Commands:** while a claimed Round runs, every
  `MICHELIN_COMMAND_INTERVAL_MS`,
  `GET /api/runner/rounds/{roundId}/commands`. Galley lists the Round's
  unacknowledged commands. A failed poll is logged and the next one
  runs on schedule; the loop ends with the Round. Each command id is
  handled once:
  - `stop` with the claim's `claimEpoch` stops the engine at its next
    step boundary (see "Stop" below).
  - `stop` with another `claimEpoch` is acknowledged `ignored`; the
    engine keeps running.
  - `answer` with the claim's `claimEpoch` hands `answer.text` to the
    `ask` step waiting on `answer.questionId` (see "Questions" below);
    with another `claimEpoch` it is acknowledged `ignored`. A listing
    with an `answer` lacking `answer.questionId` or `answer.text` is an
    `invalid_body` poll failure.
  - `approval` with the claim's `claimEpoch` hands `approval.grantId` to
    the `act` step waiting on `approval.requestId` (see "Permissions"
    below); with another `claimEpoch` it is acknowledged `ignored`. A
    listing with an `approval` lacking either field is an
    `invalid_body` poll failure.
  - Any other type is logged once and left unacknowledged.

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
| `fail` | `failed` | `<roundId>:<step index>` | End the Round as Failed with `explanation` (the progress note's limits). Galley moves the Ticket to Blocked, keeps the activity and usage, and frees the slot; the engine returns and the claim loop polls again. Only the last step. |
| `interrupt` | `interrupted` | `<roundId>:<step index>` | End the Round as Interrupted with `evidence` (the progress note's limits), otherwise as `fail`. Only the last step. |
| `ask` | `question_raised`, then `resumed` | the `questionId`; then `<roundId>:<step index>` | Raise `question` (the progress note's limits) and wait for the Owner's answer. `questionId` is a UUID v5 of `ask:<step index>` in the Round's id, so a restarted engine raises the same question under the same id. See "Questions" below. |
| `act` | `progress`; or `permission_requested`, then `resumed`, then `progress` | `<roundId>:<step index>`; the `requestId`, then `<roundId>:<step index>:resumed` | Perform `action` on `resource` through Connected Account `account` (each 1 to 200 characters, not blank, no control characters), once Galley's live authority check allows it. `requestId` is a UUID v5 of `act:<step index>` in the Round's id. See "Permissions" below. |
| `hold` | none | none | Wait until Michelin stops. Only the last step, so a script ends with at most one of `hold`, `deliver`, `fail` and `interrupt`. |

With `MICHELIN_ENGINE_SCRIPT` unset, the script is: `start`; progress
"Reading the Ticket", "Working towards the goal" and "Writing up the
result", one second apart; one `reported` usage observation from
provider `controlled`, model `scripted` (1200 in, 300 out, `"0.004500"`
USD, 2000 ms); then `deliver` with a short Markdown Report that says it
was written by a scripted engine.

The script is read and checked when Michelin starts, against the same
limits Galley enforces. An unknown step, an unknown key, an invalid
field, or a `deliver`, `hold`, `fail` or `interrupt` that is not the last step is a configuration error. The error names
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

**Stop.** A Stop for the claim's epoch ends a `wait` or a `hold` at
once. An event already in flight, its retries and backoff included, is
allowed to finish; the engine then runs no further step and logs
`engine stopped`. It then sends `stop_confirmed` with key
`<roundId>:stop` and `data.evidence` `Stopped before step <step index
+ 1> of <step count> on Stop command <commandId>` (`Stopped after step
<step count> of <step count> …` when the Stop lands during the last
step's `wait`), with the same retry as any event.
Galley answers `stopped`: the Round has ended, its slot is free and the
Ticket is in Backlog with the Stopped Badge. Only after that answer is
`POST /api/runner/rounds/{roundId}/commands/{commandId}/ack` with
`{"outcome": "applied"}` sent, with the same retry. If Galley refuses
the confirmation, Michelin logs `round event refused; round abandoned
locally` and acknowledges nothing. A Round whose in-flight delivery,
failure or interruption lands ends as reported, and its Stop is not
acknowledged; a Stop that arrives before a `fail` or `interrupt` step
wins, and that step is never sent. Claim
polling resumes once the acknowledgement is answered.

**Questions.** Galley answers `question_raised` with the Round
`waiting_for_input` (the Ticket Blocked); the engine logs `engine
waiting for an answer` and sends nothing until the `answer` command for
that `questionId` arrives. It then sends `resumed` (Galley moves the
Round back to `running`), acknowledges the command `applied` only after
that, and appends the progress note `Owner's answer: <answer>`
(truncated to 2000 characters) with key `<roundId>:<step index>:answer`
before the next step. Only the first answer for a question is used. A
Stop while waiting wins over an answer that arrives with it: the engine
confirms the Stop with the evidence `Stopped while waiting for the
answer to step <step index + 1> of <step count> on Stop command
<commandId>`, and the answer is never acknowledged, because Galley
stops listing an ended Round's commands. A Michelin restarted while a
Round waits does not pick it up again: Galley holds the slot, so the
claim answers `204` until reconciliation (M5) recovers it.

**Feedback.** The claim's `ticket.feedback` lists the Owner's feedback
no earlier Round received, as `{roundId, roundSequence, body,
createdAt}`; Galley marks it received by this claim, so a later claim
never repeats it. A claim whose `ticket.feedback` is missing or holds an
item without a string `roundId`, `body` (not empty) or `createdAt`, or a
`roundSequence` that is not a positive integer, is an `invalid_body`
claim failure. When the list is not empty, the engine reports it in one
progress note right after `start`, with key `<roundId>:<step
index>:feedback`: the line `Owner's feedback received (<n> comment|comments):`,
then one line `Round <roundSequence>: <body>` per item in Galley's
order, truncated to 2000 characters. It is sent and retried like any
event, so a refusal abandons the Round. Scripts need no step for it.

**Permissions.** An `act` step first asks Galley
(`POST /api/runner/rounds/{roundId}/authority-checks`) whether the
Agent holds authority for its scope now. The answer is used for that
one action and never remembered, so every `act` asks again.

- `allow`: the step sends the progress note `Performed <action> on
  <resource>` and the script continues.
- `deny`: the step reports `permission_requested` with the scope and
  waits, logging `engine waiting for an approval`. When the `approval`
  command for its `requestId` arrives, it sends `resumed` with that
  `requestId`, acknowledges the command `applied` only after that, and
  checks again. An `allow` performs the action. A second `deny` ends the
  Round as Failed (`Could not <action> on <resource> with the <account>
  account: Galley still denies it after the Owner's approval`); the
  step never asks twice.
- `400 unsupported_scope`: the Round ends as Failed with the explanation
  `… Galley does not support this scope`. Galley decides what is
  supported; Michelin's start-up check covers only the shape.
- Other refusals abandon the Round locally, as for events. Network
  failures and `5xx` are retried with the events' backoff.

A declined request sends no command, so the step keeps waiting until a
Stop, which it confirms with the evidence `Stopped while waiting for the
approval to step <step index + 1> of <step count> on Stop command
<commandId>`. The `controlled` account is a substitute: performing an
action only records the note, and nothing outside Galley changes.

Stopping Michelin aborts a wait, a hold, an `ask`'s wait for its answer, an `act`'s wait for its approval,
a backoff and an in-flight request at once.

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
| `round claimed` | `info` | `roundId`, `sequence`, `claimEpoch`, `ticketId`, `ticketTitle`, and `feedback`, the number of feedback items. No other Ticket field is logged. |
| `runner claim failed` | `error` | See `reason` below; polling continues. |
| `execution started reported` | `info` | `roundId`, `step`, `stepIndex`, `attempt`, `engineReference`, `httpStatus` (`200` replay or `201`). |
| `progress reported` | `info` | As above, plus the note's `seq` from Galley. |
| `feedback reported` | `info` | As `progress reported`, plus `feedback`, the number of items in the note. Feedback text is not logged. |
| `usage observation reported` | `info` | As above, plus `observationId`. |
| `delivery reported`, `engine delivered` | `info` | As above, plus Galley's `endedAt`; then the engine returns and polling resumes. |
| `failure reported`, `engine failed`; `interruption reported`, `engine interrupted` | `info` | As above, plus Galley's `endedAt`; then the engine returns and polling resumes. |
| `round event failed; retrying` | `warn` | `roundId`, `step`, `attempt`, `reason`, `httpStatus`, `errorCode`, `retryInMs`. |
| `round event refused; round abandoned locally` | `error` | `roundId`, `step`, `attempt`, `httpStatus`, Galley's `errorCode`. |
| `question raised` | `info` | `roundId`, `step` `ask`, `stepIndex`, `attempt`, `questionId`, `httpStatus`. |
| `engine waiting for an answer` | `info` | `roundId`, `stepIndex`, `questionId`. |
| `answer received` | `info` | An `answer` for the claim's epoch arrived: as `stop requested`, plus `questionId`. The text is not logged. |
| `resume reported` | `info` | As `question raised`, `step` `resume`. |
| `authority checked` | `info` | `roundId`, `step` `act`, `stepIndex`, `attempt`, `account`, `action`, `resource`, `decision`, and `grantId` on `allow`. |
| `authority check failed; retrying` | `warn` | As `authority checked`, plus `reason`, `httpStatus`, `errorCode`, `retryInMs`. |
| `authority check refused an unsupported scope`, `authority check refused; round abandoned locally` | `error` | As `authority checked`, plus `httpStatus` and `errorCode`. |
| `permission requested` | `info` | `roundId`, `step` `request`, `stepIndex`, `attempt`, `requestId`, the scope, `httpStatus`. |
| `engine waiting for an approval` | `info` | `roundId`, `stepIndex`, `requestId`. |
| `approval received` | `info` | An `approval` for the claim's epoch arrived: as `stop requested`, plus `requestId` and `grantId`. |
| `action performed` | `info` | As `progress reported`, `step` `act`, plus the scope. |
| `engine holding`, `engine script finished` | `info` | The script reached `hold`, or its last step. |
| `stop requested` | `info` | A `stop` for the claim's epoch arrived: `roundId`, `commandId`, `type`, `commandEpoch`, `claimEpoch`. |
| `engine stopped` | `info` | The engine halted at `stepIndex` for the Stop `commandId`. |
| `stop confirmation reported` | `info` | `roundId`, `step` `stop`, `attempt`, `httpStatus`, Galley's `endedAt`. |
| `command for another claim epoch ignored` | `warn` | As `stop requested`; the command is acknowledged `ignored`. |
| `unknown command left unacknowledged` | `warn` | As `stop requested`, for a type this Michelin does not know. |
| `round commands poll failed` | `error` | `roundId`, `reason`, `httpStatus`, `errorCode`; polling continues. |
| `command acknowledged` | `info` | `roundId`, `commandId`, `type`, `outcome`, `attempt`, Galley's `acknowledgedAt`. |
| `command acknowledgement failed; retrying` | `warn` | As above, plus `reason`, `httpStatus`, `errorCode`, `retryInMs`. |
| `command acknowledgement refused` | `error` | A final answer such as `409 command_already_acknowledged`; not retried. |
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
├── commandLoop.ts    # the held Round's command poll and acknowledgements
├── answerInbox.ts    # answers and approvals delivered by the command loop, awaited by the ask and act steps
├── engine.ts         # the controlled engine: script steps, event retry, abandonment, Stop, questions, authority checks
├── engineScript.ts   # the script format, its parser and the built-in default
├── galley/client.ts  # request helper and GET /api/status
├── galley/runner.ts  # register, heartbeat, claim, Round event and command requests
└── api/generated/schema.d.ts
```
