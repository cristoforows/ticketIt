# M1.12 — Native durable question, duplicate-safe continuation, and process-death rule

## Purpose

Prove the native half of feasibility experiment S3 ("Fixed inputs and
durable human input",
[docs/integration-feasibility.md](../../integration-feasibility.md)) for
[M1.12 — Native durable question, duplicate-safe continuation, and
process-death rule (#23)](https://github.com/cristoforows/ticketIt/issues/23):
a durable human-input interrupt built on LangGraph's `interrupt()`, proven
across two genuinely separate OS processes that share no memory and
reconnect only through the PostgreSQL checkpointer
[M1.11/#22](22-native-harness-boot.md) already establishes, plus the
application's own process-death recovery rule
(docs/v1-scope.md, "Lifecycle"; docs/contracts/execution-interface.md,
"Reconciliation on reconnect") layered on top of what the framework alone
provides. Lives in `experiments/native-durable-input/`, depending on
`native-harness` (`file:../native-harness`) and `shared`
(`file:../shared`).

## Exact versions

- Node: `v26.9.0` (matches `experiments/.nvmrc` and `engines.node`)
- npm: `11.19.1`
- OS: macOS 26.6.2 (Darwin 25.6.0), arm64
- PostgreSQL: 17.11 (Homebrew), local, default port 5432; the SAME database
  `native-harness` uses (`ticketit_m1_native`), not a separate one.
- `typescript`: `7.0.2`; `tsx`: `4.23.13`; `@types/node`: `26.6.1`;
  `@types/pg`: `8.23.1` (all match `native-harness` and `experiments/shared`)

Direct dependencies pinned exactly in
`experiments/native-durable-input/package.json`:

| Package | Version | Role |
| --- | --- | --- |
| `native-harness` | `file:../native-harness` | `createHarnessAgent`, `runTurn`, `ScriptedChatModel`, `RoundRegistry`, checkpointer helpers, and this slice's additive re-exports (`AIMessage`, `tool`, `z`, `interrupt`, `Command`) |
| `shared` | `file:../shared` | `EVIDENCE_SECTIONS` (used by `test/evidence-record.test.ts` to check this very file) |
| `pg` | `8.23.0` | direct SQL for `execution_snapshots` and the test suite's independent database assertions |
| `@langchain/core` (devDependency) | `1.2.11` | TYPE-ONLY: `RunnableConfig` in `src/recovery.ts` |
| `@langchain/langgraph` (devDependency) | `1.4.15` | TYPE-ONLY: `StateSnapshot` in `src/recovery.ts` |

Resolved transitive versions (`npm ls --all` against the committed
`package-lock.json`), matching M1.11's record: `@langchain/langgraph-checkpoint@1.1.5`,
`@langchain/langgraph-sdk@1.11.0`, `@langchain/protocol@0.0.19`,
`zod@4.6.5`, `langsmith@0.10.4`, plus (via `native-harness`)
`langchain@1.5.11` and `@langchain/langgraph-checkpoint-postgres@1.0.5`.

## Reproducible commands

From a clean checkout, with PostgreSQL 17 already set up for
`native-harness`:

```sh
cd experiments/native-harness
npm ci
npm run db:setup   # createdb ticketit_m1_native (idempotent) + checkpointer.setup() + round_registry table

cd ../native-durable-input
rm -rf node_modules
npm ci
npm test        # node --test, 6 tests (5 scenarios + 1 evidence-record self-check)
npm run typecheck
```

This package's own `src/connection.ts` idempotently creates the one
additional table it needs (`execution_snapshots`) on every call, so no
separate `db:setup` script exists for this package. No credentials beyond
the local trust-auth PostgreSQL connection are used.

Every test in `test/scenarios.test.ts` generates a fresh, unique thread ID
(`durable-input-<scenario>-<randomUUID>`) and a fresh `mkdtempSync` temp
directory, and cleans both up (`checkpoints`/`checkpoint_writes`/
`checkpoint_blobs`/`execution_snapshots` rows deleted, temp dir removed) in
a `finally` block, so repeated/concurrent runs — including other agents'
concurrent work against the same shared local database — never collide or
leak fixture state. `round_registry` rows accumulate by design, matching
`native-harness`'s own convention (an append-only registry, not scratch
state).

## Documentation research (unverified)

- [LangGraph JS interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
  documents the `interrupt()` / `Command({ resume })` pause-and-resume
  pattern this slice uses. The package's own shipped `.d.ts`
  (`node_modules/@langchain/langgraph/dist/interrupt.d.ts`) was more
  precise and was used as the primary reference: "If there's a `resume`
  value available (from a previous `Command`), it returns that value.
  Otherwise, it throws a `GraphInterrupt` with the provided value... The
  graph can be resumed by passing a `Command` with a `resume` value,"
  and its `@example` block shows the exact pattern this slice's
  `createAskHumanTool`/`createRestartProbeTool` (`src/tools.ts`) follow:
  interrupt inside a node/tool, catch the eventual resume value as this
  function's return value, never wrapped in try/catch (interrupt
  propagates via throwing `GraphInterrupt`, which a surrounding try/catch
  would swallow).
- **Dual-package hazard (documented reasoning, confirmed by direct file
  inspection — see "Fixture/stub evidence" for the executed proof):**
  `native-harness/src/index.ts`'s own comment (added in this slice)
  explains that a dependent package must reuse `native-harness`'s own
  installed copies of `@langchain/core`/`@langchain/langgraph`/`zod`
  rather than installing separate copies, because LangChain/LangGraph
  internals do `instanceof`-style identity checks on message/tool objects.
  This was verified directly, not just asserted: `ls
  experiments/native-harness/node_modules/@langchain/core/package.json`
  and `experiments/native-durable-input/node_modules/@langchain/core/package.json`
  both exist as separate physical files (identical *content*, since both
  resolve to the same pinned `1.2.11`, but two distinct npm-installed
  copies on disk, because `native-harness` is a real, independently
  `npm install`-ed package under `file:../native-harness`, not something
  npm hoists/dedupes across sibling packages). `interrupt()`'s own
  pause/resume plumbing and `isCommand()`/`Command` detection are
  documented (`node_modules/@langchain/langgraph/dist/interrupt.d.ts`,
  `node_modules/@langchain/langgraph/dist/index.d.ts`'s exported
  `isCommand`) to key off structural markers (a `COMMAND_SYMBOL` export is
  visible in the same `index.d.ts` barrel) rather than `instanceof`, which
  is why the interrupt/resume plumbing itself is documented as safe across
  separate copies even before this package started re-exporting
  `interrupt`/`Command` — but re-exporting them anyway (from
  `native-harness/src/index.ts`) avoids this package needing a second,
  separately pinned `@langchain/langgraph` *runtime* dependency at all
  (it is only a devDependency here, for types). This package's own
  `AIMessage`/`tool` usage (constructing scripted responses and tool
  objects that `native-harness`'s `createAgent`/`ToolNode` internals must
  recognize) DOES rely on `instanceof`-sensitive identity in those
  internals, so those two re-exports are load-bearing, not merely
  precautionary — confirmed working end to end (see below).
- `langchain@1.5.11`'s `ReactAgent` (`node_modules/langchain/dist/agents/ReactAgent.d.ts`)
  types `getState`/`updateState`/`invoke` on the object `createHarnessAgent`
  returns as `never` ("reserved for internal LangGraph Platform use").
  This package's `src/recovery.ts` (`graphOf()`) reaches the real compiled
  graph through the `.graph` getter instead, which is untyped/unreserved
  and exposes a working `getState`/`invoke`. This was necessary for every
  state read and resume in this package (`readPendingInterrupt`,
  `RecoveryPolicy`, both `process-a.ts` and `process-b.ts`).

## Fixture/stub evidence (observed)

All of the following were actually executed against a local PostgreSQL 17
database, not just read about. `npm test`: **6/6 tests passed**
(`test/scenarios.test.ts` x5, `test/evidence-record.test.ts` x1), a clean
`rm -rf node_modules && npm ci` run included, ~4.9s total for the five
scenario tests (each spawns 2–3 real `node --import tsx` child processes).

**1. Durable question.** Process A (`node --import tsx src/process-a.ts
question <threadId> <tmpDir>`) ran a scripted turn that called the
`ask_human` tool, which called `interrupt({ kind: "question", question })`;
Process A printed one JSON line reporting `interrupted: true`, an
`interruptId`, and the interrupt's `value`, then exited (`exitCode: 0`).
Independently verified: `SELECT count(*) FROM checkpoints WHERE thread_id =
$1` returned `> 0` immediately after Process A exited, and `round_registry`
had a matching row — both read by a completely separate raw `pg.Pool` in
the test, not through anything Process A held in memory. A fresh Process B
(`node --import tsx src/process-b.ts question <threadId> <tmpDir> "yes,
proceed"`) — a new OS process with no shared memory — called `getState()`
and recovered the SAME `interruptId` Process A had printed
(`pendingInterruptId` matched exactly), resumed with
`graph.invoke(new Command({ resume: { interruptId, answer } }), config)`,
and the marker side effect ran exactly once
(`marker.sideEffectCount: 1`). Cross-checked directly against the marker
FILE on disk (`MarkerFileStore.read()`), not just Process B's self-reported
JSON: `sideEffectCount: 1`, `appliedKeys: ["<interruptId>:yes, proceed"]`.

**2. Duplicate reply.** Resuming the SAME thread a second time with the
SAME answer, via a third fresh process invocation of `process-b.ts`, left
`marker.sideEffectCount` at exactly `1` (verified both from the process's
JSON and from the marker file on disk). **Mechanism responsible (recorded
per the acceptance criteria): the framework, not harness-level
idempotency**, for this specific duplicate-resume path. Observed evidence:
on the second resume, `hadPendingInterruptBeforeResume: false` (the
checkpoint's `next` was already empty — the thread had genuinely
completed), `modelRequestCountThisProcess: 0` (the scripted model was never
called), and `marker.toolInvocations` stayed at `2` (unchanged from the
first resume) — i.e. the `ask_human` tool body never ran a second time, so
`MarkerFileStore.recordSideEffectOnce`'s own idempotency key
(`interruptId:answer`, checked inside the tool body) was never even
reached. `graph.invoke(new Command({ resume }), config)` on an
already-completed LangGraph thread (pinned `@langchain/langgraph@1.4.15`)
is itself a no-op that returns the final state without scheduling any
node. The harness-level idempotency key in `src/tools.ts`'s
`createAskHumanTool` (via `MarkerFileStore.recordSideEffectOnce`) remains
implemented, per the issue's instruction to add it "if the framework would
repeat it" — it is exercised as real, load-bearing logic in scenario 4
below, where the tool body genuinely does re-run before the interrupt
resolves — but it was not the deciding mechanism for the straightforward
duplicate-resume-after-completion path tested here.

**3. Fixed inputs across pause.** Version A (system prompt + Skill text +
Recipe text, `src/library.ts`) was live when Process A started (thread 1);
`ExecutionSnapshotStore.save()` fixed a durable per-thread snapshot of the
composed system prompt at Round start (`ON CONFLICT (thread_id) DO
NOTHING`, so only the first, start-of-round write ever takes effect).
Process A's first scripted model request's system prompt
(`firstRequestSystemPrompt`) contained "instructions version A" / "Skill v
A" / "Recipe v A". Before resuming, the test published version B directly
to the SAME mutable library file (`LibraryStore.publish("B")`) — simulating
an owner edit while the Round is paused. Process B for thread 1 then
resumed by loading the DURABLE per-thread `execution_snapshots` row (never
re-reading the mutable library file): `snapshotVersion: "A"` and
`resumedRequestSystemPrompt` still contained "instructions version A" /
"Skill v A" and did NOT contain "version B". A brand-new thread (thread 2)
started via Process A AFTER B was published read the library file fresh
(`LibraryStore.read()`) and received version B end to end:
`version: "B"`, `firstRequestSystemPrompt` contained "instructions version
B" / "Skill v B" / "Recipe v B". This matches
docs/agent-execution.md ("Recipe versions": "Edits to the library do not
change the recipe content used by an existing round, including a round
paused for human input... New rounds use the latest versions available
when they start.").

**4. Restart semantics.** `createRestartProbeTool` (`src/tools.ts`) records
a marker BEFORE calling `interrupt()`, in the same tool/node. Process A ran
it once: `markerAfterProcessA.beforeInterruptCount: 1`,
`toolInvocations: 0` (the after-interrupt code had not run). Process B
resumed the SAME thread: `markerAfterResume.beforeInterruptCount: 2` — the
pre-interrupt marker ran AGAIN, confirming LangGraph restarts an
interrupted node from the beginning on resume, exactly as
docs/integration-feasibility.md's "LangChain human input" row warns
("Interrupted nodes may restart from the beginning; effects before an
interrupt can repeat."). The after-interrupt marker
(`markerAfterResume.toolInvocations: 1`) ran exactly once, since the
interrupt itself only truly resolves once. **Resulting requirement,
recorded per the acceptance criteria:** any side effect that must not
repeat has to be placed AFTER the `interrupt()` call in the same node (or
be made idempotent, as scenario 1/2's `ask_human` tool is via
`recordSideEffectOnce`) — a side effect placed before `interrupt()` WILL
observably repeat on every resume attempt of that node.

**5. Process death.** Process A (`process-death` scenario) was spawned and
allowed to print a `"started": true` line (confirming it was genuinely
inside its poll loop, waiting on a flag file that does not exist), then
`SIGKILL`ed 300ms later — a hard kill, not a graceful stop, verified by
asserting the signal was actually delivered and awaiting the child's own
`exit` event. Database state after the kill: `checkpoints` and
`checkpoint_writes` both had `> 0` rows for the thread (the in-flight
step's scheduling was durably recorded even though the tool call itself
never returned and no completing checkpoint was ever written). A fresh
Process B computed `RecoveryPolicy.classify()` from `getState()`:
`status: "interrupted-not-resumable"`, `next: ["tools"]`,
`hasPendingInterrupt: false` — a scheduled-but-incomplete step with no
genuine interrupt, distinguishing this from a real durable-question wait.
`RecoveryPolicy.continueIfIntact()` threw
`RecoveryRefusedError("interrupted-not-resumable")`; `process-b.ts`
printed `refused: true, reason: "interrupted-not-resumable"` and exited
`0` (a clean, expected refusal, not a crash). **Clearly labelled NEGATIVE
demonstration** (`process-b.ts ... --negative-demo`, run only after
creating the flag file so the underlying tool call can actually complete):
bypassing `RecoveryPolicy` entirely and calling
`graph.invoke(null, config)` directly on the SAME checkpoint LangGraph
happily continued — the `blocking_wait` tool restarted from the beginning
(a second `"started"` marker, per the same restart-from-beginning
semantics as scenario 4) and then completed once it observed the flag
file: `frameworkContinued: true`. This is the evidence that the refusal
above is the harness's own applied rule
(docs/v1-scope.md, "Lifecycle": "Execution actually stops unexpectedly" ->
Ticket Blocked, Round Interrupted, "explicit recovery required";
docs/contracts/execution-interface.md, "Reconciliation on reconnect":
"Continuation of the same Round happens only when execution is reported
intact... Otherwise, Galley records the Round as Interrupted") — not a
limitation LangGraph itself would have enforced.

**Additional check:** re-running `npm test` a second time back to back
(same command, no state reset beyond each test's own `finally` cleanup)
produced the same 6/6 pass result, confirming unique-thread-ID isolation
actually works and the suite is not order- or state-dependent across runs.

## Real-provider evidence (observed, or "none executed")

None executed. No real model provider, no OpenRouter call, no real GitHub
call. `ScriptedChatModel` (from `native-harness`) makes no network calls;
the only network activity in this tracer is to the local PostgreSQL
instance.

## Observed limitations

- **`RecoveryPolicy` cannot, and does not try to, distinguish WHY a step is
  incomplete.** `classify()`'s `"interrupted-not-resumable"` status only
  observes "the checkpoint has a scheduled-but-not-completed next step and
  no pending interrupt" — this is consistent with the executing process
  dying mid-tool-call (this slice's scenario), but is structurally
  indistinguishable, from the checkpoint alone, from other causes (e.g. a
  node that legitimately takes a long time, or a crash during a
  non-interrupt-bearing node for an unrelated reason). The real
  application's reconciliation (docs/contracts/execution-interface.md,
  "Reconciliation on reconnect") additionally uses Michelin's own runner
  report and a claim epoch, which this local stand-in does not model — see
  "Outstanding checks" below.
- **The duplicate-reply "framework no-op" finding is narrow, not general.**
  It was observed for exactly one path: resuming an already-completed
  thread (no pending interrupt) a second time with
  `Command({ resume })`. This slice did not attempt to construct a genuine
  race (e.g. two Process B/C instances resuming concurrently before either
  commits, or resuming while a pending interrupt still exists via a stale
  read), which is the scenario where the harness-level idempotency key
  (`MarkerFileStore.recordSideEffectOnce`) would actually be the deciding
  mechanism rather than defense-in-depth. This is a genuine gap in this
  record, not a claim that the framework no-ops every duplicate-resume
  shape.
- **`MarkerFileStore` is a fixture, not a shippable idempotency
  mechanism.** It is a JSON file that this experiment alone reads/writes to
  prove cross-process side-effect counts; it is not what a real tool's
  side effect (a GitHub API call, a file write against a user's repo,
  etc.) would use to guarantee "applied once." A real implementation's
  idempotency keying would need to be specific to that tool's actual
  effect (see docs/integration-feasibility.md's "Interpretation for
  ticketIt": "No selected library replaces ticket ownership checks, round
  accounting, human review, or idempotent side-effect handling.").
- **The dual-package hazard was mitigated only for the object kinds this
  slice actually needed** (`AIMessage`, `tool`, `z`, `interrupt`,
  `Command`). A future slice constructing other LangChain/LangGraph object
  kinds (e.g. `HumanMessage`, `ToolMessage`, custom channels) from its own
  separately-installed copy would need the same re-export treatment or
  would risk the same `instanceof` hazard; this was not exhaustively
  enumerated.
- `agent.graph` (used by `graphOf()` in `src/recovery.ts`) is reached via
  an `as unknown as { graph: ... }` cast past `langchain@1.5.11`'s own
  `never`-typed `getState`/`updateState`/`invoke`. This works on this
  pinned version but is exactly the kind of "reserved for internal...
  use" surface `docs/integration-feasibility.md`'s preamble warns is
  liable to change across releases without a semver-major bump signal.
- This slice's `RecoveryPolicy` is scoped narrowly to the mid-node-death
  refusal the issue asks for; it is not a general-purpose "may this Round
  resume?" gate for every classification. `"waiting-for-input"` and
  `"completed"` are returned normally by `continueIfIntact()`, but this
  slice does not add scenario coverage exercising Michelin/Galley's fuller
  reconnection contract (claim epoch, runner self-report) on top of it.

## Outstanding checks and owning milestone

- **M5** owns real process-death/reconnection recovery for the actual
  application (Michelin's own runner report plus Galley's authoritative
  claim-epoch check — docs/contracts/execution-interface.md,
  "Reconciliation on reconnect"). This slice's `RecoveryPolicy` is a local,
  narrowly-scoped stand-in exercising only the checkpoint-shape signal
  (`next` non-empty, no pending interrupt); it is not that reconciliation
  logic.
- **D5** (stranded-runner/reattachment; referenced from the M1.11 evidence
  record, 22-native-harness-boot.md, "Outstanding checks"): multi-turn /
  multi-Round reuse of the same LangGraph thread and reattachment of a new
  engine execution reference to an existing Round are still not exercised
  here — every scenario in this slice uses a single Round/thread pairing
  from start to (at most) one resume.
- Constructing a genuine concurrent-resume race (two fresh processes
  calling `Command({ resume })` on the same pending interrupt at nearly the
  same time) to positively exercise the harness-level idempotency key as
  the deciding mechanism, rather than the framework's own no-op, is not
  covered here and would need deliberate scheduling/locking in the test
  harness itself; not attempted in this slice given its scope.
- OpenRouter payload fidelity and this same checkpointer/durable-input
  mechanism combined with a real provider-backed model (S4) remains owned
  by #26 and is unaffected by this slice.

## Decision impacts (open-decision IDs)

- **D5** (stranded-runner/reattachment): this slice adds one more data
  point — a mid-tool-call `SIGKILL` leaves a checkpoint with a
  scheduled-but-incomplete step and no interrupt, which this experiment's
  harness-level policy classifies `"interrupted-not-resumable"` and
  refuses to auto-continue. It does not resolve D5; the real
  claim-epoch/runner-report reconciliation is M5's.
- **D8** ("In-flight manual revocation and non-budget execution limits";
  `docs/open-decisions.md`: "Cancellation cannot promise to undo completed
  external effects" — not modified here per workspace rules): this slice's
  restart-semantics finding (scenario 4) is direct evidence for that
  clause: a side effect placed BEFORE `interrupt()` in a node has already
  run by the time any pause, stop, or cancellation could apply, and
  observably runs AGAIN on resume (LangGraph restarts the node from the
  beginning) — there is no framework-level way to "undo" or suppress the
  already-dispatched first execution. The corresponding requirement this
  evidence supports: effects that must not be duplicated or left
  dangling have to be placed after the interrupt point, or be made
  idempotent (as this slice's `MarkerFileStore.recordSideEffectOnce`
  does for the post-interrupt case). This record does not resolve D8
  itself — per `experiments/README.md`, an experiment observes and
  records, and the gate-report slice (#29) reconciles decisions and the
  evidence index.
- **D7** (object storage / hosting / native model / OpenCode
  provider-model selection): not touched. No model, storage, or hosting
  choice is made; `ScriptedChatModel` remains a stub.
