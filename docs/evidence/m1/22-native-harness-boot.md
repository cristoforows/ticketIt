# M1.11 — Native harness boots with a scripted model, durable checkpoint, and Round/thread identity

## Purpose

Prove the `experiments/native-harness/` package boots LangChain JS
`createAgent` end to end for
[M1.11 — Native harness boots with a scripted model, durable checkpoint,
and Round/thread identity (#22)](https://github.com/cristoforows/ticketIt/issues/22),
the parent tracer package that later native-execution M1 slices (native
admission #23/#24, OpenRouter persistence #26) will depend on via
`dependencies: { "native-harness": "file:../native-harness" }`. This is not
one of the S1-S5 feasibility experiments in
[docs/integration-feasibility.md](../../integration-feasibility.md)
directly, but the underlying mechanism the "LangChain human input" evidence
row and S3 ("Fixed inputs and durable human input") build on: a scripted
(no-network) chat model, a tool with a side-effect marker, a durable
PostgreSQL-backed LangGraph checkpoint, and a Round ID kept distinct from
the LangGraph thread ID with a stored mapping, per
[ADR 0002](../../adr/0002-round-identity-separate-from-engine-identity.md)
and
[docs/contracts/execution-interface.md](../../contracts/execution-interface.md)
("Identity model").

## Exact versions

- Node: `v26.9.0` (matches `experiments/.nvmrc` and `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- PostgreSQL: 17 (Homebrew), local, default port 5432, `pg_isready` reports
  `/tmp:5432 - accepting connections`; Docker not available.
- `typescript`: `7.0.2` (matches `experiments/shared` and `_template`)
- `tsx`: `4.23.13`
- `@types/node`: `26.6.1`
- `@types/pg`: `8.23.1`

Direct dependencies pinned exactly in `experiments/native-harness/package.json`:

| Package | Version |
| --- | --- |
| `langchain` (provides `createAgent`) | `1.5.11` |
| `@langchain/core` | `1.2.11` |
| `@langchain/langgraph` | `1.4.15` |
| `@langchain/langgraph-checkpoint-postgres` | `1.0.5` |
| `pg` | `8.23.0` |

Resolved transitive versions that this record's results depend on (from
`npm ls --all` against the committed `package-lock.json`; not directly
pinned by this package, but recorded since they affect behavior):

| Package | Version |
| --- | --- |
| `@langchain/langgraph-checkpoint` | `1.1.5` |
| `@langchain/langgraph-sdk` | `1.11.0` |
| `@langchain/protocol` | `0.0.19` |
| `zod` | `4.6.5` |
| `langsmith` | `0.10.4` |
| `p-queue` | `6.6.2` (via `@langchain/core`) |
| `js-tiktoken` | `1.0.21` |
| `@cfworker/json-schema` | `4.1.1` |
| `@standard-schema/spec` | `1.1.0` |

`langsmith`'s optional peers (`@opentelemetry/api`,
`@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/sdk-trace-base`,
`openai`, `ws`) and `@langchain/langgraph-sdk`'s optional peers
(`react`, `react-dom`) are reported "UNMET OPTIONAL DEPENDENCY" by `npm ls`
and were not installed; nothing exercised by this tracer required them.

## Reproducible commands

From a clean checkout:

```sh
cd experiments/native-harness
rm -rf node_modules
npm ci
npm run db:setup   # createdb ticketit_m1_native (idempotent) + checkpointer.setup() + round_registry table
npm test
npm run typecheck
```

`npm run db:setup` runs `scripts/db-setup.sh`, which:

1. Resolves the connection string from `NATIVE_HARNESS_DATABASE_URL`,
   defaulting to `postgresql://localhost:5432/ticketit_m1_native`.
2. Runs `createdb <database>` (tolerating "already exists").
3. Runs `scripts/db-setup.ts` (via `node --import tsx`), which calls
   `PostgresSaver.setup()` and `RoundRegistry.setup()`.

No credentials beyond the local PostgreSQL connection (no password, local
Unix/TCP trust auth) are used; no `.env` or secret file was created.

## Documentation research (unverified)

- [LangChain JS `createAgent` overview](https://docs.langchain.com/oss/javascript/langchain/overview)
  and the package's own generated `.d.ts`
  (`node_modules/langchain/dist/agents/index.d.ts`,
  `node_modules/langchain/dist/agents/types.d.ts`) were the primary
  references for `createAgent`'s parameter shape. The doc comments in
  `types.d.ts` for `CreateAgentParams` were more precise than the prose
  examples in the same file: one JSDoc `@example` block in
  `node_modules/langchain/dist/agents/index.d.ts` shows `llm: model,` as a
  parameter name, which does not exist on `CreateAgentParams` in this
  pinned version (`1.5.11`) -- the actual field is `model`. This was caught
  by inspecting the shipped `.d.ts` directly rather than trusting the
  prose comment; see "Fixture/stub evidence" below for how it was found in
  practice (a similar name mismatch, `prompt` vs. `systemPrompt`, was
  actually hit at runtime).
- [LangGraph JS persistence / checkpointing](https://docs.langchain.com/oss/javascript/langgraph/persistence)
  documents the general `checkpointer` + `thread_id` pattern `createAgent`
  uses under the hood.
- `@langchain/langgraph-checkpoint-postgres`'s own `index.d.ts` doc comment
  (`node_modules/@langchain/langgraph-checkpoint-postgres/dist/index.d.ts`)
  documents `PostgresSaver.fromConnString(connString, options?)` and that
  `.setup()` "MUST be called directly by the user the first time
  checkpointer is used" -- this is why `scripts/db-setup.ts` calls it
  explicitly rather than relying on an implicit migration.
- [docs/integration-feasibility.md](../../integration-feasibility.md), row
  "LangChain human input": HITL/LangGraph interrupts "support checkpointed
  pauses and resume" but "[u]se durable storage, not only memory," and
  "[i]nterrupted nodes may restart from the beginning; effects before an
  interrupt can repeat." This tracer does not exercise an interrupt/resume
  path (that is S3 / a later slice's scope); it only establishes the
  durable-checkpoint plumbing and the scripted-model/tool-execution
  mechanism that a later durable-input slice will build the pause/resume
  assertions on top of.

## Fixture/stub evidence (observed)

All of the following were actually executed against a local PostgreSQL 17
instance, not just read about:

- `npm ci` (clean `node_modules`): `added 47 packages, and audited 48
  packages`, `0 vulnerabilities`. `npm warn install-scripts` reported
  `esbuild@0.28.2` (postinstall) and `fsevents@2.3.3` (install, macOS-only)
  as "not yet covered by allowScripts" and skipped, consistent with
  `docs/evidence/m1/14-experiment-workspace.md`'s prior observation; this
  did not break anything observed here.
- `npm run db:setup` against a fresh local database: created
  `ticketit_m1_native`, ran `PostgresSaver.setup()` (creates
  `checkpoint_migrations`, `checkpoints`, `checkpoint_blobs`,
  `checkpoint_writes` in the `public` schema) and `RoundRegistry.setup()`
  (creates `round_registry`). Re-running `npm run db:setup` a second time
  printed "database 'ticketit_m1_native' already exists, continuing." and
  completed successfully (idempotent, as required).
- `npm test`: 1/1 test passed
  (`test/boot.test.ts`, "native harness: scripted turn runs the marker
  tool once, persists a checkpoint, and keeps the Round ID and thread ID
  distinct with a resolvable mapping"), duration ~330ms end to end,
  including:
  - `RoundRegistry.registerRound(threadId)` returned a Round ID (uuid)
    distinct from the LangGraph thread ID (`boot-<uuid>`); both
    `threadIdForRound(roundId)` and `roundIdForThread(threadId)` resolved
    correctly against the `round_registry` table.
  - `createHarnessAgent` (wrapping `createAgent` from `langchain@1.5.11`)
    with a `ScriptedChatModel` scripted for two turns (an `AIMessage` with
    `tool_calls: [{ name: "marker", args: { note: "boot test" } }]`,
    followed by a plain-text `AIMessage`) and one real
    `PostgresSaver` checkpointer.
  - `runTurn()` invoked the agent once; the marker tool's side-effect
    counter (`MarkerState.callCount`) was exactly `1` after the turn, and
    `MarkerState.calls` recorded `["boot test"]` -- i.e. the tool actually
    executed, not merely requested.
  - `ScriptedChatModel.requests` recorded exactly 2 calls: the first with
    `messages = [SystemMessage, HumanMessage]` and the second with
    `messages = [SystemMessage, HumanMessage, AIMessage(tool_calls),
    ToolMessage]`, confirming the ReAct loop actually ran the tool and
    fed the result back to the model. `requests[0].systemPrompt` equaled
    the configured system prompt string, and `requests[0].boundToolNames`
    included `"marker"`.
  - The checkpoint was read back two independent ways: (a) through
    `checkpointer.getTuple({ configurable: { thread_id } })`, which
    returned a defined tuple whose `config.configurable.thread_id` matched;
    and (b) via a direct `SELECT count(*)::text AS count FROM checkpoints
    WHERE thread_id = $1` query against the same database using a separate
    raw `pg.Pool`, which returned a count greater than 0.
  - Cleanup: `checkpointer.deleteThread(threadId)` ran in a `finally`
    block after the assertions, and the thread ID was unique per run
    (`boot-<uuid>`) so repeated/concurrent runs cannot collide. Verified
    manually with `psql -d ticketit_m1_native -c "select count(*) from
    checkpoints;"` returning `0` after a test run, and `round_registry`
    accumulating one row per run (by design -- it is a registry/log, not
    scratch state, so it is not cleaned between runs).
- `npm run typecheck` (`tsc -p tsconfig.json --noEmit`, covering `src`,
  `test`, and `scripts`): passed with no errors.
- **Fail-clearly check (required by the issue):** ran
  `NATIVE_HARNESS_DATABASE_URL="postgresql://localhost:5999/does_not_exist"
  npm test`. Result: a single failing test with the message
  `native-harness: cannot reach the PostgreSQL database at
  postgresql://localhost:5999/does_not_exist. Run the setup script
  first: cd experiments/native-harness && npm run db:setup ... Original
  error: code=ECONNREFUSED; connect ECONNREFUSED 127.0.0.1:5999; connect
  ECONNREFUSED ::1:5999` and no other test ran. No fallback (in-memory or
  file-backed) was attempted; the suite failed loudly as required. This
  needed one fix during development: `pg`/`pg-pool` reject a connection
  failure with an `AggregateError` whose own `.message` is empty (the
  useful detail is on `.code` and the nested `.errors`), which
  `describeConnectionError()` in `src/checkpointer.ts` unwraps so the
  thrown error is actually actionable instead of ending in "Original
  error: " with nothing after it.
- **`createAgent` parameter-name correction (observed, not just
  documented):** the first working version of `src/harness.ts` passed
  `prompt: options.systemPrompt` to `createAgent`, following one
  `@example` block's naming in the shipped `.d.ts`. At runtime the
  system prompt never appeared in `ScriptedChatModel.requests[0].messages`
  (confirmed by an ad hoc debug script instantiating the agent with
  `MemorySaver` and logging each request's message list). Reading
  `node_modules/langchain/dist/agents/ReactAgent.js` showed the actual
  constructor call `systemMessage: normalizeSystemPrompt(this.options.systemPrompt)`,
  and `node_modules/langchain/dist/agents/types.d.ts` confirms the real
  field name is `systemPrompt?: string | SystemMessage` (not `prompt`).
  Fixed in `src/harness.ts`; the boot test now asserts the resolved system
  prompt text is present on the first recorded request. This is the kind
  of upstream source/doc divergence
  `docs/integration-feasibility.md`'s preamble warns about ("Upstream
  `dev`/`main` source can differ from released packages").
- `createAgent` accepted `ScriptedChatModel` (a `BaseChatModel` subclass)
  directly with no workaround needed: `bindTools()`, `_generate()`, and
  `_streamResponseChunks()` were sufficient. No fallback to hand-building a
  prebuilt ReAct graph from `@langchain/langgraph` was required.

## Real-provider evidence (observed, or "none executed")

None executed. No real model provider, no OpenRouter call, no real
GitHub call. `ScriptedChatModel` makes no network calls; the only network
activity in this tracer is to the local PostgreSQL instance.

## Observed limitations

- System-prompt content arrives at the model as a content-block array
  (`[{ type: "text", text: "..." }]`), not a plain string, even though
  `createAgent` was configured with a plain string `systemPrompt`.
  `ScriptedChatModel`'s request log extracts the text via a small
  `messageTextContent()` helper that handles both string and array
  content; a future slice building on this package should not assume
  `message.content` is always a string.
- `validateLLMHasNoBoundTools()` runs inside `createAgent`'s model node
  before it calls `model.bindTools()` itself: passing a model that already
  has tools bound (e.g. calling `.bindTools()` yourself before handing the
  model to `createHarnessAgent`) would throw. This tracer does not bind
  tools itself; it lets `createAgent` do so. Not exercised as a failure
  case here, but worth flagging for a later slice that might construct the
  model differently.
- `@langchain/langgraph-checkpoint-postgres`'s `.setup()` only creates
  tables/migrations inside an already-existing database; it does not
  (and cannot, since `CREATE DATABASE` cannot run inside another
  database's session/transaction in PostgreSQL) create the database
  itself. `scripts/db-setup.sh` therefore runs a separate `createdb`
  step first. A fresh clone that only runs `npm test` without first
  running `npm run db:setup` (and without the database existing from a
  prior manual `createdb`) gets the clear "cannot reach the PostgreSQL
  database" error, not a "table does not exist" error, because
  `assertDatabaseReachable()` fails at `SELECT 1` before any
  checkpointer/table-specific query would even run.
- This tracer intentionally exercises only one straight-line turn (a
  tool call, then a final reply). It does not exercise: a pause/resume
  interrupt, concurrent/parallel tool calls, multiple sequential Rounds
  reusing the same thread, checkpoint-history listing (`checkpointer.list()`),
  or the file-backed fallback checkpointer (PostgreSQL 17 was reachable
  throughout development on this machine, so the fallback path described
  in the issue was never needed and is not implemented).
- `RoundRegistry` rows are never deleted by this tracer (only
  `checkpoints` rows are cleaned via `deleteThread()`); repeated local
  `npm test` runs accumulate `round_registry` rows. This is intentional
  (a Round registry is meant to be an append-only record, not scratch
  state) but means a long-running local dev loop will grow that table;
  not a problem at this scale, and Galley owns the authoritative Round
  record in later milestones regardless.

## Outstanding checks and owning milestone

- Durable human input (pause on a question, publish new settings/skill/
  recipe versions, resume and confirm the paused turn still used the
  original versions; duplicate replies must not repeat a side effect) is
  explicitly out of scope here and is S3's concern
  ([docs/integration-feasibility.md](../../integration-feasibility.md)),
  owned by a later M1 slice referenced from issue #22 as "durable-input
  slice" (#23).
- Native admission (live permission/disconnect admission for the native
  engine specifically) is owned by #24.
- OpenRouter payload fidelity and persistence through this same
  checkpointer/Round-registry mechanism (S4) is owned by #26.
- Multi-turn / multi-Round reuse of the same LangGraph thread, and
  reattachment of a new engine execution reference to an existing Round
  (the "at most one current engine execution reference per Round" rule in
  [docs/contracts/execution-interface.md](../../contracts/execution-interface.md)),
  are not exercised by this single-turn boot test and are routed to D5
  (stranded-runner/reattachment), owned by M5.
- This tracer's `RoundRegistry` is a stand-in for Galley's authoritative
  Round record (per
  [docs/contracts/execution-interface.md](../../contracts/execution-interface.md),
  "Ownership statement": "Galley alone mutates authoritative records").
  Real Round creation/claim semantics (atomic claim, fencing token) belong
  to M4+ and are not implemented here.

## Decision impacts (open-decision IDs)

- **D7** (object storage / hosting / native model / OpenCode
  provider-model selection): not resolved here. This tracer selects no
  model -- `ScriptedChatModel` is a stub, not a provider choice -- and
  makes no object-storage or hosting decision. It only confirms that
  `createAgent`'s `model` parameter accepts a custom `BaseChatModel`
  subclass, which is a prerequisite for later slices to plug in a real
  OpenRouter-backed model without changing this package's public API.
- No other open decision is touched. In particular, no queue technology,
  transport, or payload schema is chosen (those are explicitly out of
  scope per
  [docs/contracts/execution-interface.md](../../contracts/execution-interface.md),
  "What this contract does not decide").
