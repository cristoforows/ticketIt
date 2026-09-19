# native-durable-input

Native-harness durable question, duplicate-safe continuation, fixed-inputs-
across-pause, restart-semantics, and process-death-rule proof for
[M1.12 — Native durable question, duplicate-safe continuation, and
process-death rule (#23)](https://github.com/cristoforows/ticketIt/issues/23).
See
[../../docs/evidence/m1/23-native-durable-input.md](../../docs/evidence/m1/23-native-durable-input.md)
for the full evidence record.

This is the native half of feasibility experiment S3 ("Fixed inputs and
durable human input",
[docs/integration-feasibility.md](../../docs/integration-feasibility.md)):
a durable human-input interrupt built on
[LangGraph's `interrupt()`](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
inside a tool, proven across two genuinely separate OS processes reconnecting
only through the shared PostgreSQL checkpointer that
[native-harness (#22)](../native-harness/README.md) already establishes.

## What this is, and is not

This is an M1 adapter proof, not the ticketIt application. It selects no
object storage, hosting, native model, or OpenCode provider/model — those
are open decision D7, owned by later milestones (see
[experiments/README.md](../README.md), "Rules"). It uses a scripted chat
model (`native-harness`'s `ScriptedChatModel`) and no real credentials or
provider calls. The "harness's process-death recovery rule" this package
implements (`src/recovery.ts`'s `RecoveryPolicy`) is this experiment's local
stand-in for Michelin/Galley's reconciliation-on-reconnect logic (see
[docs/contracts/execution-interface.md](../../contracts/execution-interface.md),
"Reconciliation on reconnect"), not the authoritative implementation — see
the evidence record's "Outstanding checks" for what M5 owns.

## Exact versions

Pinned in `package.json` (no `^`/`~`), matching `native-harness`:

- `native-harness`: `file:../native-harness` (re-exports `AIMessage`,
  `tool`, `z`, `interrupt`, `Command` from its own installed copies of
  `@langchain/core`/`@langchain/langgraph`/`zod` — see the comment in
  `../native-harness/src/index.ts` for why this package must not install
  its own separate copies of those packages as runtime dependencies)
- `shared`: `file:../shared`
- `pg`: `8.23.0`
- `@langchain/core`, `@langchain/langgraph` (devDependencies, types only —
  used for `RunnableConfig`/`StateSnapshot` type imports in
  `src/recovery.ts`; the actual runtime objects always come from
  `native-harness`'s re-exports): `1.2.11`, `1.4.15`
- `typescript`, `tsx`, `@types/node`, `@types/pg`: match `native-harness`
  (`7.0.2`, `4.23.13`, `26.6.1`, `8.23.1`)

See [docs/evidence/m1/23-native-durable-input.md](../../docs/evidence/m1/23-native-durable-input.md)
for the resolved dependency tree and documentation research.

## Database setup

Uses the SAME local PostgreSQL 17 database as `native-harness`
(`postgresql://localhost:5432/ticketit_m1_native` by default; override with
`NATIVE_HARNESS_DATABASE_URL`). Run `native-harness`'s setup once first:

```sh
cd ../native-harness
npm ci
npm run db:setup
```

This package's own `src/connection.ts` idempotently creates the one
additional table it needs (`execution_snapshots`, via
`ExecutionSnapshotStore.setup()`) on every `connect()` call — no separate
`db:setup` script is needed for this package itself. Like `native-harness`,
this package never silently falls back if PostgreSQL is unreachable:
`assertDatabaseReachable()` throws a clear, actionable error naming the
connection string and the setup command to run.

## Verification

```sh
cd experiments/native-durable-input
npm ci
npm test        # node --test, 5 scenario tests, spawns process-a.ts/process-b.ts as real OS processes
npm run typecheck
```

`npm test` (`test/scenarios.test.ts`) spawns `src/process-a.ts` and
`src/process-b.ts` with `node:child_process` (see `test/helpers/spawn.ts`)
— genuinely separate OS processes, not in-process function calls — and
inspects their JSON stdout, the file-based cross-process marker ledger
(`src/marker-store.ts`), and direct SQL queries against `checkpoints`,
`checkpoint_writes`, and `round_registry` in the shared PostgreSQL database.
Every test uses a fresh, unique thread ID (`durable-input-<scenario>-
<randomUUID>`) and a fresh `mkdtempSync` temp directory, and cleans both up
in a `finally` block (deleting its own checkpoint/execution-snapshot rows;
`round_registry` rows accumulate by design, matching `native-harness`'s own
convention — it is an append-only registry, not scratch state).

### Scenarios

1. **Durable question** (`test/scenarios.test.ts`, first test) — Process A
   runs a scripted turn that calls `ask_human` (`src/tools.ts`), which calls
   `interrupt()`; Process A prints the pending interrupt payload and exits.
   A fresh Process B reconnects purely through the checkpointer, reads the
   pending interrupt via `getState()`, resumes with `Command({ resume })`,
   and the marker side effect runs exactly once.
2. **Duplicate reply** — resuming a second time with the same answer leaves
   the side-effect count at one. See the evidence record for which
   mechanism was responsible (observed: a framework-level no-op on this
   pinned version, not the harness-level idempotency key, for this
   already-completed-thread path).
3. **Fixed inputs across pause** — Instructions/Skill/Recipe version A is
   fixed into a durable per-thread `execution_snapshots` row
   (`src/execution-snapshot-store.ts`) at Round start; version B is
   published to the mutable library file (`src/library.ts`) before
   resuming; the resumed call still used A, and a new thread afterwards
   used B.
4. **Restart semantics** — a marker placed BEFORE `interrupt()` in the same
   tool (`src/tools.ts`'s `createRestartProbeTool`) runs twice (once per
   node execution attempt), demonstrating LangGraph's restart-from-the-
   beginning behavior and the resulting requirement to place side effects
   after an interrupt, or make them idempotent.
5. **Process death** — Process A is SIGKILLed while genuinely blocked
   inside a tool call (polling for a flag file that never appears); the
   last checkpoint shows an incomplete step (non-empty `next`, no pending
   interrupt). `RecoveryPolicy.continueIfIntact()` (`src/recovery.ts`)
   refuses with `RecoveryRefusedError("interrupted-not-resumable")`. A
   clearly labelled negative demonstration (`--negative-demo` on
   `process-b.ts`) then calls `graph.invoke(null, config)` directly,
   bypassing the harness's policy, and shows LangGraph itself completes the
   tool call once the flag file is created — proving the refusal above is
   the harness's own applied rule, not a LangGraph limitation.
