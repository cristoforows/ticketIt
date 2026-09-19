# native-harness

Reusable native-harness library for
[M1.11 — Native harness boots with a scripted model, durable checkpoint,
and Round/thread identity (#22)](https://github.com/cristoforows/ticketIt/issues/22).
See [../../docs/evidence/m1/22-native-harness-boot.md](../../docs/evidence/m1/22-native-harness-boot.md)
for the full evidence record.

Boots [LangChain JS `createAgent`](https://docs.langchain.com/oss/javascript/langchain/overview)
with a scripted (no-network) chat model and a marker tool, persists a
LangGraph checkpoint to a dedicated local PostgreSQL database, and records a
Round ID distinct from the LangGraph thread ID with a stored mapping between
them (see [ADR 0002](../../docs/adr/0002-round-identity-separate-from-engine-identity.md)
and [docs/contracts/execution-interface.md](../../docs/contracts/execution-interface.md),
"Identity model"). Later M1 slices (native admission #23/#24, durable input,
OpenRouter persistence #26) depend on this package through
`dependencies: { "native-harness": "file:../native-harness" }` and should
only import from `src/index.ts`.

## What this is, and is not

This is an M1 adapter proof, not the ticketIt application. It selects no
object storage, hosting, native model, or OpenCode provider/model -- those
are open decision D7, owned by later milestones (see
[experiments/README.md](../README.md), "Rules"). It uses a scripted chat
model and no real credentials or provider calls.

## Exact versions

Pinned in `package.json` (no `^`/`~`):

- `langchain`: `1.5.11` (provides `createAgent`)
- `@langchain/core`: `1.2.11`
- `@langchain/langgraph`: `1.4.15`
- `@langchain/langgraph-checkpoint-postgres`: `1.0.5`
- `pg`: `8.23.0`
- `typescript`, `tsx`, `@types/node`: match the versions already used by
  `experiments/shared` (`7.0.2`, `4.23.13`, `26.6.1`)
- `@types/pg`: `8.23.1`

See [docs/evidence/m1/22-native-harness-boot.md](../../docs/evidence/m1/22-native-harness-boot.md)
for the full resolved dependency tree (including transitively-resolved
`@langchain/langgraph-checkpoint`, `zod`, and `langsmith` versions) and
documentation research.

## Database setup

Uses PostgreSQL 17 running locally (no Docker). By default connects to
`postgresql://localhost:5432/ticketit_m1_native`; override with the
`NATIVE_HARNESS_DATABASE_URL` environment variable.

```sh
cd experiments/native-harness
npm ci
npm run db:setup   # createdb (idempotent) + checkpointer.setup() + round_registry table
npm test
```

`npm run db:setup` runs `scripts/db-setup.sh`, which:

1. Runs `createdb <database>` (the last path segment of the connection
   string), tolerating "already exists".
2. Runs `scripts/db-setup.ts`, which calls the PostgreSQL checkpointer's
   `setup()` (creates/migrates the `checkpoints`, `checkpoint_blobs`,
   `checkpoint_writes`, and `checkpoint_migrations` tables) and
   `RoundRegistry.setup()` (creates the `round_registry` table).

**`npm test` never silently falls back.** If the database is unreachable,
`assertDatabaseReachable()` throws a clear, actionable error naming the
connection string and the setup command to run, and the test suite fails
loudly rather than skipping the database-backed assertions or falling back
to an in-memory/file-backed checkpointer. A file-backed fallback was not
needed on this machine: PostgreSQL 17 (Homebrew) was reachable throughout
development (see the evidence record's "Observed limitations").

## Public API (`src/index.ts`)

- `ScriptedChatModel` -- a `BaseChatModel` subclass that returns a queue of
  pre-scripted `AIMessage`s (including ones with `tool_calls`), supports
  `bindTools()` (returns a bound copy sharing the same response queue and
  request log), records every request it receives (`.requests`, including
  the resolved system prompt text and the bound tool names), and implements
  a minimal `_streamResponseChunks`. No network calls.
- `MarkerState` / `createMarkerTool(state)` -- a tool with a side-effect
  counter (`state.callCount`, `state.calls`) so a test can assert a
  scripted tool call actually executed, not just that the model requested
  it.
- `resolveDatabaseUrl()`, `DEFAULT_DATABASE_URL`, `DATABASE_URL_ENV_VAR`,
  `assertDatabaseReachable(connectionString)`,
  `createPostgresCheckpointer(connectionString)` -- connection-string
  resolution, the fail-clearly reachability check, and a
  `PostgresSaver` factory.
- `RoundRegistry` -- generates a Round ID (`crypto.randomUUID()`) and
  attaches a LangGraph thread ID as the engine execution reference, storing
  the mapping in a `round_registry` table in the same database. The thread
  ID is never used as the Round ID (ADR 0002).
- `createHarnessAgent({ model, tools, checkpointer, systemPrompt })` --
  wraps LangChain JS `createAgent`.
- `runTurn(agent, { roundId, threadId, input, signal? })` -- runs one turn on the
  given LangGraph thread; the Round ID is carried through the result but
  never used as the LangGraph `thread_id`. The optional `signal` (added for
  M1.13, issue #24) is forwarded to `agent.invoke()`'s `RunnableConfig.signal`
  when present; existing callers that omit it are unaffected.

## Verification

```sh
cd experiments/native-harness
npm ci
npm run db:setup
npm test        # node --test, one boot test
npm run typecheck
```

The boot test (`test/boot.test.ts`):

1. Creates a Round via `RoundRegistry.registerRound(threadId)` and asserts
   the Round ID differs from the thread ID, with the mapping resolving both
   ways.
2. Boots the agent with `ScriptedChatModel` (two scripted turns: a
   `marker` tool call, then a final reply) and the marker tool.
3. Runs one turn and asserts the marker tool ran exactly once.
4. Reads the checkpoint back through `checkpointer.getTuple()` for that
   thread, and independently via a direct `SELECT count(*) FROM
   checkpoints WHERE thread_id = $1` SQL query.
5. Cleans up via `checkpointer.deleteThread()` in a `finally` block; the
   thread ID is also unique per run (`boot-<uuid>`) so concurrent/repeated
   runs never collide.
