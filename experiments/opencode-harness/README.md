# opencode-harness

Reusable library that boots a headless [OpenCode](https://opencode.ai) server
against a local scripted stub model, with isolated config/data/cache/state
directories. Built for
[M1.5 — OpenCode boots headless with pinned versions and a scripted model
(#16)](https://github.com/cristoforows/ticketIt/issues/16), corresponding to
the startup part of feasibility experiment S1
(see `docs/integration-feasibility.md`). Later M1 slices (#17–#21) depend on
this package through a local `file:../opencode-harness` dependency, so its
public API (`src/index.ts`) is meant to be reused, not just its test.

See `docs/evidence/m1/16-opencode-boot.md` for exact versions, the
version-pairing rationale, observed request/response evidence, and known
limitations.

## Running

```sh
cd experiments/opencode-harness
npm ci
npm test
```

`npm test` runs eight suites end to end:

- `test/boot.test.ts`: starts a `StubModelServer`, starts a managed OpenCode
  server against it, creates a session, sends a prompt, asserts the stub
  received that exact prompt, asserts the scripted reply is visible through
  the SDK's message query, asserts a decoy "real" global config marker was
  never observed (neither by the stub nor in OpenCode's own resolved
  config), asserts the Round ID is never sent to OpenCode, then closes and
  verifies the spawned process actually exited (no orphan).
- `test/config-isolation.test.ts`: a positive/negative control for config
  isolation using the pinned CLI's `opencode debug config` directly (faster,
  no server/stub needed) — proves the decoy marker is picked up when
  pointed at directly, and is not picked up once `XDG_CONFIG_HOME`/
  `OPENCODE_CONFIG_DIR` are redirected, even though `HOME` still points at
  the decoy.
- `test/versions.test.ts`: confirms the pinned `opencode-ai` and
  `@opencode-ai/sdk` versions resolve to the matching lockstep release.
- `test/permission-round-trip.test.ts`, `test/question-round-trip.test.ts`,
  `test/reconnect-recovery.test.ts`, `test/duplicate-reply.test.ts`,
  `test/once-versus-always.test.ts`: added for
  [M1.6 — OpenCode questions, permission requests, and event reconciliation
  (#17)](https://github.com/cristoforows/ticketIt/issues/17). See
  `docs/evidence/m1/17-opencode-questions.md` for exact versions, the SDK
  endpoints/types these exercise (including a documented mismatch between
  the pinned SDK's default-export generated types and what the server
  actually emits), fixture evidence per test, and the once-vs-always
  finding that feeds the admission bridge slice (#20).

## Public API (`src/index.ts`)

- `StubModelServer` — a local OpenAI-compatible HTTP server (`node:http`,
  127.0.0.1, ephemeral port) implementing `/v1/chat/completions` (streaming
  SSE and non-streaming) and `/v1/models`, returning pre-scripted turns from
  a queue and logging every request (`.requests`) so tests can assert what
  the engine sent.
- `startManagedOpenCode(options)` — starts a headless OpenCode server
  through the SDK's `createOpencodeServer` helper, spawning the pinned
  local binary inside a fresh temporary git repository, with global
  config/data/cache/state redirected to temporary directories and a custom
  OpenAI-compatible provider pointing at a `StubModelServer`. Returns
  `{ client, session, serverUrl, projectDir, homeDir, isolatedPaths, pid,
  providerId, modelId, close() }`. `close()` shuts the process down and
  verifies it actually exited (`orphanCheckError` is `null` on success).
- `createRoundMapping(engineExecutionReference)` — issues a Round ID (uuid)
  and attaches an OpenCode session ID as its engine execution reference,
  per ADR 0002 and `docs/contracts/execution-interface.md` ("Identity
  model"). Returns `{ roundId, engineExecutionReference }`; the two are
  always distinct, and the Round ID is never sent to OpenCode.
- `makeIsolatedPaths(root)` / `isolatedEnvOverrides(paths, extra)` — the
  isolation directory layout and the env vars (`HOME`,
  `OPENCODE_TEST_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
  `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `OPENCODE_CONFIG_DIR`, `TMPDIR`) that
  redirect them, reusable outside `startManagedOpenCode` for direct CLI
  probes.
- `readResolvedOpencodeConfig(env, cwd)` / `readOpencodePaths(env, cwd)` —
  run the pinned CLI's `opencode debug config` / `opencode debug paths`
  against an explicit environment, for isolation proofs independent of a
  running server.
- `resolveOpencodeVersion()` / `resolveOpencodeSdkVersion()` /
  `resolveOpencodeBinary()` / `resolveOpencodeBinDir()` — locate the
  pinned executable and its version, and the `node_modules/.bin` directory
  that must be on `PATH` for the SDK's server helper (which spawns the bare
  command `opencode`) to find it.
- `ManagedOpenCode.v2Client` — a second generated SDK client instance (from
  the pinned package's `@opencode-ai/sdk/v2` subpath), pointed at the same
  running server/directory as `client`. Added for #17: this pinned build's
  bare `@opencode-ai/sdk` export has no `.permission`/`.question`
  namespaces and declares an `Event` union whose permission shape
  (`"permission.updated"`) the server never actually emits; the `/v2`
  subpath's generated types are the ones that match observed runtime
  behavior (`permission.asked`, `question.asked`, `client.permission.list()/
  .reply()`, `client.question.list()/.reply()/.reject()`). See
  `docs/evidence/m1/17-opencode-questions.md`.
- `subscribeEvents(client)` — subscribes to `GET /event` (works with either
  `client` or `v2Client`) and buffers every event into `.events` in arrival
  order; `stop()` aborts the underlying fetch, `closed` resolves once the
  background consumption loop has actually exited.
- `listPending(v2Client, sessionId)` — queries `client.permission.list()`
  and `client.question.list()` (REST queries, not the event stream) and
  returns the pending permission/question requests belonging to
  `sessionId`.
- `replyPermission(v2Client, requestId, "once" | "always" | "reject")` /
  `replyQuestion(v2Client, requestId, answers)` / `rejectQuestion(v2Client,
  requestId)` — reply to a pending request via `POST /permission/{id}/reply`
  or `POST /question/{id}/reply` / `/reject`. Return `{ok, error}` rather
  than throwing, so a duplicate/rejected reply's exact engine error can be
  inspected.
- `scriptBashToolCall(...)` / `scriptQuestionToolCall(...)` /
  `scriptTextTurn(...)` — build `ScriptedTurn`s for `StubModelServer` that
  invoke OpenCode's built-in `"bash"` or `"question"` tools (OpenAI-style
  `tool_calls`), or a plain follow-up text turn.
- `markerAppendCommand(path, line?)` / `readMarkerLines(path)` — a shell
  command (for `scriptBashToolCall`) that appends one line to a marker
  file, and a reader for it, used as an external, engine-independent count
  of how many times a scripted shell call actually executed.

## What this template pins

- `engines.node`: `26.9.0`, matching `experiments/.nvmrc`.
- `typescript`, `tsx`, `@types/node`: exact versions, matching the other
  packages in this workspace.
- `opencode-ai`, `@opencode-ai/sdk`: exact versions, released together (see
  the evidence file for the pairing rationale). `opencode-ai` ships a
  compiled per-platform executable behind a `postinstall` script; this
  package's `package.json` carries `"allowScripts": {"opencode-ai@1.18.31":
  true}` so `npm ci`/`npm install` run it (npm 11's install-script
  allowlist otherwise skips it, leaving no `opencode` binary to spawn).
- `dependencies.shared`: `file:../shared`, per workspace convention (unused
  by this package's own logic today, kept for consistency with the other
  experiment packages).

See `experiments/README.md` for the full workspace rules (no real
credentials or providers, exact pins, one evidence file per experiment).
