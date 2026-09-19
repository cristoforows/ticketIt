# M1.13 — Native admission before tool and model calls, including provider-executed search

## Purpose

Prove, with deterministic fixtures, that the native path of feasibility
experiment S2 ("Live permission and disconnect admission",
[docs/integration-feasibility.md](../../integration-feasibility.md)) can be
enforced when Michelin controls both tool execution and model invocation
directly, using [`AdmissionLedger`](../../../experiments/shared/src/admission-ledger.ts)
(M1.4, [#15](https://github.com/cristoforows/ticketIt/issues/15)) and the
[`native-harness`](../../../experiments/native-harness/) tracer (M1.11,
[#22](https://github.com/cristoforows/ticketIt/issues/22)) as the deterministic
substitutes those slices built. This is
[M1.13 — Native admission before tool and model calls, including
provider-executed search (#24)](https://github.com/cristoforows/ticketIt/issues/24).

Both a tool call and a model call are checked because, in the native path,
the model call is *also* where OpenRouter's provider-executed web search
happens: there is no separate, later, interceptable step for search
(docs/integration-feasibility.md, "OpenRouter integration": "Search occurs
inside provider calls and may be an already-dispatched remote action rather
than a separately intercepted local tool"). Relevant open decisions per
`docs/open-decisions.md` (read only, not edited — see "Decision impacts"
below): **D1** (enforceable action boundary and disconnect behavior) and
**D8** (in-flight manual revocation and non-budget execution limits).

## Exact versions

- Node: `v26.9.0` (matches `experiments/.nvmrc` and every package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- PostgreSQL: 17.11 (Homebrew), local, default port 5432 (`pg_isready`:
  `/tmp:5432 - accepting connections`); shares the `ticketit_m1_native`
  database `native-harness` already sets up. Docker not available/used.
- `typescript`: `7.0.2`; `tsx`: `4.23.13`; `@types/node`: `26.6.1`;
  `@types/pg`: `8.23.1` — all match `experiments/native-harness` and
  `experiments/shared`.

Direct dependencies pinned exactly in
`experiments/native-admission/package.json`:

| Package | Version |
| --- | --- |
| `@langchain/core` | `1.2.11` |
| `@langchain/langgraph` | `1.4.15` |
| `@langchain/langgraph-checkpoint-postgres` | `1.0.5` |
| `pg` | `8.23.0` |
| `native-harness` | `file:../native-harness` (own `package.json`: `0.1.0`) |
| `shared` | `file:../shared` (own `package.json`: `0.1.0`) |

Resolved transitive versions this record's results depend on (from
`npm ls --all`, both directly and through `native-harness`'s own tree; not
directly pinned by this package):

| Package | Version |
| --- | --- |
| `langchain` (provides `createAgent`, resolved through `native-harness`'s own `node_modules`) | `1.5.11` |
| `@langchain/langgraph-checkpoint` | `1.1.5` |
| `@langchain/langgraph-sdk` | `1.11.1` |
| `@langchain/protocol` | `0.0.19` |
| `zod` | `4.6.5` |
| `langsmith` | `0.10.4` |

`langsmith`'s optional peers (`@opentelemetry/*`, `openai`, `ws`) and
`@langchain/langgraph-sdk`'s optional peers (`react`, `react-dom`) are
reported "UNMET OPTIONAL DEPENDENCY" and were not installed; nothing
exercised here needed them. `npm ls --all` also reports `shared`'s own
devDependencies (`@types/node`, `tsx`, `typescript`) as "missing" for this
consumer — expected and benign: npm does not install a linked `file:`
package's `devDependencies` for a consumer, only its `dependencies`, and
`shared` has none.

## Reproducible commands

From a clean checkout:

```sh
cd experiments/native-harness
npm ci
npm run db:setup   # createdb ticketit_m1_native (idempotent) + checkpointer.setup() + round_registry table

cd ../native-admission
npm ci
npm test           # node --test, 7 scenario tests
npm run typecheck
```

No environment variables or synthetic credentials are required. All model
calls are scripted/fixture chat models (`native-harness`'s own
`ScriptedChatModel`, this package's `ControllableChatModel` and
`PartialOutputChatModel`); no network call to any model provider is made.
The only network activity is to the local PostgreSQL instance.

## Documentation research (unverified)

- [LangChain JS `createAgent` overview](https://docs.langchain.com/oss/javascript/langchain/overview)
  and `node_modules/langchain/dist/agents/ReactAgent.d.ts`/`.js` (read
  directly, not just the prose docs) were the primary references for how
  `createAgent`'s compiled agent (`ReactAgent`) exposes its model node and
  graph. One concrete, load-bearing finding from reading the shipped
  `.d.ts` rather than trusting prose: `ReactAgent.getState()` is typed
  `never` on purpose — its own doc comment says "The following are internal
  methods to enable support for LangGraph Platform... intentionally return
  as `never` to avoid type errors due to type inference." Reading
  `ReactAgent.js` confirmed it still works at runtime (`getState(config,
  options) { return this.#graph.getState(config, options); }`), so every
  test here calls `agent.graph.getState(...)` instead of `agent.getState(...)`
  — identical runtime behavior, properly typed as `Promise<StateSnapshot>`.
  This is exactly the kind of upstream doc/type divergence
  `docs/integration-feasibility.md`'s preamble warns about.
- `node_modules/@langchain/langgraph/dist/prebuilt/tool_node.js`
  (`ToolNode`'s default `handleToolErrors: true`, which catches a plain
  thrown error into a synthetic error `ToolMessage` but unconditionally
  re-throws when `isGraphInterrupt(e)`) and
  `node_modules/langchain/dist/agents/ReactAgent.js` (the model node has no
  analogous catch) are why `admittedTool` raises a refusal through
  `@langchain/langgraph`'s `interrupt()` while `admittedModel` throws
  `AdmissionRefused` directly — documented in-line in
  `src/admitted-tool.ts` and `src/admission-refused.ts`. This was salvaged
  from a prior partial attempt at this issue and re-verified against the
  actual installed source in this worktree before being relied on further
  (see "What was salvaged vs. rewritten" below).
- [LangChain JS `RunnableConfig`/cancellation](https://docs.langchain.com/oss/javascript/langchain/overview)
  and `BaseChatModel`'s `ParsedCallOptions` (`node_modules/@langchain/core/dist/language_models/chat_models.d.ts`)
  document that `signal` (an `AbortSignal`) is one of the few `RunnableConfig`
  fields that survives into a chat model's `_generate`/`_streamResponseChunks`
  call options. Unverified beyond that until scenario 5 (below) actually
  exercised it end-to-end through `createAgent`'s ReAct loop.
- [OpenRouter web-search plugin docs](https://openrouter.ai/docs/guides/features/plugins/web-search)
  describe URL citations returned alongside a completion. `src/search-fixtures.ts`'s
  `simulatedWebSearchReply()` approximates this as an OpenAI-compatible
  `annotations: [{ type: "url_citation", url_citation: {...} }]` array under
  `additional_kwargs`, following the existing convention in this repo
  (`native-harness`'s `ScriptedChatModel` puts everything the "model"
  returns verbatim on the returned `AIMessage`). **This shape is
  unverified against a real OpenRouter response** — no live call was made
  (see "Real-provider evidence" below) — and the field names/values,
  including the `usage.search_context_cost` figure, are this experiment's
  own approximation, clearly labeled as fixture data in the source comment.
- [OpenRouter usage accounting docs](https://openrouter.ai/docs/guides/guides/usage-accounting)
  mention a search-cost breakdown in principle; this experiment simulates
  one number for it (`0.0042`) purely to assert that this package does not
  invent a separate *tool* admission for that cost, not as a claim about
  real OpenRouter billing shape.

## Fixture/stub evidence (observed)

All of the following were actually executed against a local PostgreSQL 17
instance in this worktree, not just read about. `npm test`: **7/7** scenario
tests passed, run 5+ times in a row with no flakes observed after the fixes
described below (~0.9–1.3s wall time per run). `npm run typecheck`
(`tsc -p tsconfig.json --noEmit`) passed with no errors. `npm ci` from a
clean `node_modules` succeeded for both `native-harness` and
`native-admission` (`added 47/48 packages`, `0 vulnerabilities` each).

### Scenario 1 — disconnect before the next tool

Model unwrapped (isolates tool admission); tool wrapped with `admittedTool`
against a valid ticket-based grant; `ledger.setConnected(false)` before the
turn. `agent.invoke()` **resolved** (no exception reached the caller) with
only `[Human, AI(tool_calls)]` — the tool step never completed;
`markerState.callCount === 0`. Mechanism, observed via
`agent.graph.getState(...)`: `state.next === ["tools"]`, one paused task
carrying an `interrupts` entry whose payload is
`{ type: "admission-refused", decision: "hold", reason: "disconnected" }`.
Ledger evidence (real excerpt from a run in this worktree):

```json
[
  {
    "admissionId": "admission-1",
    "request": { "roundId": "...", "ticketId": "...", "agentId": "agent-native-admission-tracer", "account": "fixture-account", "action": "run_tool", "resource": "marker" },
    "decision": "hold",
    "reason": "disconnected",
    "grantId": "grant-1",
    "decidedAtMs": 1767225600000
  }
]
```

Exactly one decision, `"hold"`; zero `"allow"` decisions recorded while
disconnected; `ledger.dispatches().length === 0` (a held admission is never
dispatched).

### Scenario 2 — disconnect during a model call

Model wrapped with `admittedModel`, inner is `ControllableChatModel` (this
package's own gated fixture model — see "New fixtures" below). The call is
held open (`armDelay()`), its admission/dispatch confirmed recorded
(`waitFor` — see "Bugs found and fixed" below), then the ledger is
disconnected and the gate released while the call is genuinely in flight.
The already-dispatched call **completed** with its real scripted content
(`"first reply, dispatched before disconnect"`); `dispatch().completedAtMs`
was set. Real excerpt:

```json
// decisions
[{ "admissionId": "admission-1", "decision": "allow", "reason": "ok", "grantId": "grant-1", "decidedAtMs": 1767225600000 }]
// dispatches
[{ "admissionId": "admission-1", "dispatchedAtMs": 1767225600000, "completedAtMs": 1767225600000 }]
```

The NEXT model call, attempted on the same thread while still disconnected,
was rejected: `AdmissionRefused { decision: "hold", reason: "disconnected" }`;
the second scripted reply remained unconsumed (`inner.remainingResponses === 1`).

### Scenario 3 — expiry mid-run via FakeClock

Two independent grants: a ticket-based grant for the tool's scope
(`run_tool`/`marker`) and a time-based grant for the model's scope
(`invoke_model`/`search`, `expiresAt = clock.nowMs() + 60_000`). The marker
tool's own execution (which happens strictly between the run's two model
calls in the ReAct loop) advances the `FakeClock` by 120s — a deterministic
synchronization point rather than a real-time race. Observed: the first
model call was `"allow"`; the tool call was `"allow"` (ticket-based grant,
untouched by the model grant's expiry); the second model call was `"deny"`,
`reason: "expired"`, and `agent.invoke()` rejected with `AdmissionRefused`.
`markerState.callCount === 1` (the tool genuinely ran) and the second
scripted model reply remained unconsumed. This directly demonstrates
v1-scope.md's "Expired authority does not stop otherwise permitted work" at
the native-harness/agent level, not just at the ledger's own unit tests
(which M1.4's evidence record already covered in isolation).

### Scenario 4 — revocation between calls

Turn A: valid ticket-based grant, tool runs, turn completes normally
(`markerState.callCount === 1`). `ledger.revoke(grant.id)` between turns.
Turn B (same thread, second `HumanMessage`): the same tool action is now
`"deny"`/`"revoked"`; `admittedTool` raises the refusal through
`interrupt()` exactly as in scenario 1 (mechanism is decision-agnostic: hold
and deny both pause the tool step the same way). `agent.graph.getState(...)`
confirmed `next === ["tools"]` and the interrupt payload
`{ decision: "deny", reason: "revoked" }`. `markerState.callCount` stayed at
`1` (the tool did not run a second time); turn A's dispatch remained
`completedAtMs !== undefined`, untouched by the later revocation.

### Scenario 5 — pending Stop / abort

Built a new fixture model (`PartialOutputChatModel`, see "New fixtures"
below) because neither `native-harness`'s `ScriptedChatModel` (no partial
state) nor this package's `ControllableChatModel` (one all-or-nothing gate
around a whole scripted message) can represent "content that arrived before
an abort." The model "streams" two chunks; chunk index 1 is gated. Once
chunk 0 (`"Partial answer: as of the source consulted, "`, usage
`inputTokens: 12, outputTokens: 8`) genuinely landed (`waitFor`), the test
called `ledger.requestStop(roundId)` (per execution-interface.md, "Stop with
evidence-bearing confirmation": "records a pending 'Stop requested' command
for the Round") and then `controller.abort()` on the `AbortSignal` threaded
through `runTurn`'s new optional `signal` field (see "`native-harness`
changes" below). `agent.invoke()` rejected with a real `AbortError` (name
`"AbortError"`, matches `DOMException("...", "AbortError")`). Real excerpt:

```json
// inner.lastCapture right before it threw
{ "content": "Partial answer: as of the source consulted, ", "usage": { "inputTokens": 12, "outputTokens": 8 }, "chunksEmitted": 1, "aborted": true }
// ledger.dispatches() -- allow was recorded and dispatched, but never completed
[{ "admissionId": "admission-1", "dispatchedAtMs": 1767225600000 }]
```

The next admission attempt (`runTurn` again on the same thread) was denied
with `AdmissionRefused { decision: "deny", reason: "stop-pending" }` — taking
precedence over the still-otherwise-valid ticket-based grant, exactly per
`AdmissionLedger.admit()`'s documented precedence rule. The checkpoint
remained readable: `checkpointer.getTuple({ configurable: { thread_id } })`
resolved to a defined tuple after the aborted call.

**What "retained partial output and usage" means here, precisely:** the
`AbortError` itself carries none of this — `PartialOutputChatModel`
actively accumulates `content`/`usage` into `#lastCapture` on every
successfully-appended chunk and again right before re-throwing on an
aborted gate, so the caller has an explicit, testable record of "how far
the call got." A real OpenRouter/provider integration would need an
equivalent explicit accumulation strategy (e.g., buffering SSE deltas as
they arrive); this fixture demonstrates the shape of that requirement, not
a specific real-provider implementation of it.

### Scenario 6 — new grant continues the same thread

Used a real `RoundRegistry` (from `native-harness`) to register an
authoritative Round ID for the thread before either turn ran. The grant was
revoked *before* the first turn even attempted the tool, so that turn paused
immediately (`[Human, AI(tool_calls)]`, `next === ["tools"]`,
`markerState.callCount === 0`). A **new** grant (not a reconnect, not
restoring the revoked one — `ledger.setConnected` was never touched, and
the old grant stays `revoked: true` forever) was then created for the same
scope, and the run was resumed with
`agent.invoke(new Command({ resume: true }), { configurable: { thread_id } })`.
The tool then genuinely ran (`markerState.callCount === 1`) and the turn
completed with the scripted final reply. Confirmed no new thread and no new
Round: `roundRegistry.roundIdForThread(threadId)` and
`roundRegistry.threadIdForRound(roundId)` both still resolved to the
original pair registered before either turn started.

### Scenario 7 — provider-executed search

`admittedModel` wraps a `ControllableChatModel` scripted with
`simulatedWebSearchReply()`; `tools: []` — there is no tool registered for
"search" at all, by construction, so there is structurally nothing for a
separate "search tool" admission to attach to. Mid-call disconnect (same
technique as scenario 2) did not undo the already-dispatched search: the
final message's content and its citation `annotations` array both survived
and were returned to the caller. Real excerpt of the returned message:

```json
{
  "content": "Based on a web search, the current stable release is documented at the URL cited below.",
  "additional_kwargs": {
    "annotations": [{ "type": "url_citation", "url_citation": { "url": "https://example.invalid/docs/release-notes", "title": "Release notes (fixture)", "content": "Fixture citation content -- no real network call was made.", "start_index": 0, "end_index": 0 } }]
  },
  "response_metadata": { "model": "fixture/simulated-search-model", "usage": { "search_context_cost": 0.0042 } }
}
```

Exactly one admission was recorded for the whole run
(`action: "invoke_model", resource: "search"`); `decisions.every(d =>
d.request.action !== "run_tool")` held. A second call attempted while still
disconnected was held (`decision: "hold", reason: "disconnected"`), the same
already-dispatched/next-call split scenario 2 demonstrates, now shown
specifically for the call that carries a simulated search.

## New fixtures added in this package

- `ControllableChatModel` (salvaged, see below) — a `ScriptedChatModel`-like
  model whose call can be held open via `armDelay()`/`release()` and
  aborted through `options.signal`.
- `PartialOutputChatModel` (new in this slice) — chunk-by-chunk scripted
  model, gated per chunk index via `armChunkGate(atChunkIndex)`, so a test
  can abort a call partway through and read exactly how much content/usage
  had accumulated. See its doc comment in
  `src/partial-output-chat-model.ts` for why chunk-index targeting (rather
  than "gate the next call") is required: chunk 0 and chunk 1 of the same
  non-streamed `_generate` call have no `await` boundary between them for a
  test to hook into unless a gate for the *specific* chunk is already
  armed before the call starts.

## `native-harness` changes (additive only)

Both changes were confirmed necessary while building this package, not
spec-driven guesses:

1. `package.json` gained `"main": "./src/index.ts"` and
   `"types": "./src/index.ts"`. Without them, this package's own
   `import ... from "native-harness"` could not resolve through the
   `file:../native-harness` link. `experiments/shared`'s `package.json`
   already had both fields — this brings `native-harness` in line with that
   existing convention, not a new one. No dependency versions changed; the
   committed `package-lock.json` is untouched (confirmed via `git diff`).
2. `src/harness.ts`'s `RunTurnOptions` gained an optional
   `signal?: AbortSignal`, forwarded into `agent.invoke()`'s
   `RunnableConfig.signal` only when present. Existing callers (including
   `native-harness`'s own boot test) are unaffected — verified by re-running
   `native-harness`'s own `npm test` (1/1 passed) and `npm run typecheck`
   (clean) after both changes.

No existing native-harness export, behavior, or test was changed. Both
changes are reflected in `experiments/native-harness/README.md`.

## What was salvaged vs. rewritten

A previous attempt at this exact issue ran out of budget partway, leaving
uncommitted work on disk in a separate worktree. That work was copied in
(`cp -R`, then `rm -rf node_modules package-lock.json` to regenerate a clean
lockfile) and verified by actually running it, not trusted as-is:

- **Salvaged and verified working as-is:** `src/admission-scope.ts`,
  `src/admission-refused.ts`, `src/admitted-tool.ts`,
  `src/admitted-model.ts`, `src/controllable-chat-model.ts`,
  `src/search-fixtures.ts`, `src/index.ts` (extended, not replaced),
  `package.json`/`tsconfig.json`/`.gitignore`, and scenario 1's test file
  unchanged. The `native-harness` `package.json` `main`/`types` addition
  was also salvaged (confirmed to match what this worktree independently
  needed).
- **Salvaged but bug-fixed:** scenario 2's test assumed exactly two
  `await Promise.resolve()` ticks were enough for an in-flight `_generate`
  call to reach `ledger.admit()`/`dispatch()` before asserting on ledger
  state. Running it directly in this worktree failed
  non-deterministically: `assert.equal(fixture.ledger.decisions().length,
  1, ...)` sometimes saw `0`. Root-caused with debug instrumentation (a
  temporary copy of the test with `console.log`/inner try-catch) to confirm
  it was a real assertion failure, not the red-herring `"Cannot use a pool
  after calling end on the pool"` error that surfaced afterward once the
  test's `try` block threw early and its `finally` closed the checkpointer
  pool while an abandoned in-flight call (its delay gate never released,
  since the test never reached that line) was still pending. Fixed by
  replacing the fixed-tick assumption with `waitFor()`, a small polling
  helper added to `test/helpers.ts`, and reused it in scenarios 5 and 7 for
  the same kind of "wait for an in-flight call's admission to be recorded"
  check. This is a genuine, root-caused fix, not a timing band-aid: the
  underlying assumption (a fixed number of microtask ticks between
  `runTurn()` and the model node's `_generate` call) was never guaranteed by
  anything in `createAgent`'s or `PregelLoop`'s own contract.
- **Rewritten from scratch:** scenarios 3, 4, 6, 7, and the evidence record.
  `PartialOutputChatModel` (scenario 5's fixture model) is new code; the
  salvaged work had no scenario 5 file to build on.
- Verification performed independently in this worktree: `npm ci` (both
  `native-harness` and `native-admission`) from clean `node_modules`,
  `npm test` 5+ times in a row (7/7 passing, no flakes after the fix
  above), and `npm run typecheck` (clean) for both packages.

## Real-provider evidence (observed, or "none executed")

None executed. No real call to OpenRouter, any other model provider, or any
network endpoint beyond the local PostgreSQL instance, per
`experiments/README.md`'s "No calls to real providers or real repositories."
`simulatedWebSearchReply()`'s exact field shape is documentation research,
not an observed real response (see "Documentation research" above).

## Observed limitations

- **Held/denied tool calls and held/denied model calls surface to the graph
  through two different, deliberately different mechanisms.** A tool
  refusal pauses the graph via `@langchain/langgraph`'s `interrupt()`
  (checkpointed, resumable at the exact same step via `Command({ resume })`,
  and invisible to the model — it never sees a refusal message). A model
  refusal throws `AdmissionRefused` directly, rejecting `agent.invoke()`
  outright; resuming means a fresh call on the same `threadId` (thread-level
  continuity), not a step-level resume of the exact refused model call. This
  was a deliberate choice, confirmed necessary by reading
  `ReactAgent.js`/`tool_node.js` (see "Documentation research" above), not
  an oversight — but it means "the graph pauses or ends the step gracefully"
  (the issue's own phrasing) has two genuinely different shapes depending on
  whether the refused call was a tool or a model call, and callers of this
  package need to handle both.
- **Abort cancels the call; it does not "undo" anything the call had
  already caused as a side effect.** `PartialOutputChatModel` has no side
  effects of its own to demonstrate this concretely, but the design
  principle (matching v1-scope.md's "Already-dispatched actions may
  complete on expiry" carve-out, generalized here to abort) is: once
  `dispatch()` is recorded, the ledger makes no further judgment about that
  admission id regardless of what happens to the call — cancellation is a
  property of the call's own promise, not of the ledger. A real provider
  call that had already caused an external side effect (e.g., a
  provider-side charge for tokens generated before the abort was
  acknowledged) would not be reversed by this mechanism, matching
  `docs/integration-feasibility.md`'s "Cancel versus pause" row: "No general
  documented guarantee that abort can be resumed at the exact suspended
  point."
- **`admittedModel`'s scope is fixed at construction, not re-derived
  per-call.** `BaseChatModel._generate`'s `ParsedCallOptions` does not carry
  `thread_id`/`configurable` (confirmed while building `admission-scope.ts`:
  `ParsedCallOptions` omits everything from `RunnableConfig` except
  `signal`/`timeout`/`maxConcurrency`), so there is no per-call channel to
  pull a different `roundId`/`ticketId` out of the LangGraph invocation
  itself. A real integration reusing one wrapped model instance across
  multiple Rounds would need a different mechanism (e.g., a scope resolved
  from the LangGraph config via a side-channel, or a fresh wrapped model per
  Round — this package always does the latter in every scenario, matching
  how a real Round would boot a fresh wrapped agent).
- **`PartialOutputChatModel`'s "streaming" is a fixture convenience, not a
  model of real SSE behavior.** It has no notion of a truncated/malformed
  chunk, no token-level granularity, and its gate-per-chunk-index API is
  intentionally test-only ergonomics; `docs/integration-feasibility.md`'s
  S4 concerns (Unicode offsets, usage-only final chunks, truncated streams)
  are explicitly out of scope for this package and remain S4's own concern
  (issue #26).
- **No concurrency control**, same limitation the ledger's own M1.4
  evidence record already noted: nothing here models multiple in-flight
  admissions racing each other beyond the specific two-call sequencing each
  scenario deliberately constructs.
- The `native-harness` `package.json` `main`/`types` fix was needed because
  the package had no `main`/`exports` field at all before this slice — an
  omission from M1.11 that any `file:`-dependent consumer package would
  have hit, not something specific to admission.

## Outstanding checks and owning milestone

- Real OpenCode-path admission (the OpenCode half of S2, tool interception
  via `tool.execute.before` plugin hooks) is a separate M1 slice (#23 is
  native durable-input; the OpenCode admission bridge is issue #20,
  referenced in the M1.4 evidence record) and is not exercised here.
- Real OpenRouter web-search payload fidelity (actual citation/usage field
  names, SSE truncation, Unicode offsets) is S4's concern (issue #26); this
  slice only classifies *where* the admission boundary sits for
  provider-executed search, using a fixture reply.
- A real controlled Round exercising this admission wrapping end-to-end
  through the actual application (Galley/Michelin, not this ledger
  substitute) is M4–M6's concern (`docs/integration-feasibility.md`,
  "Planned feasibility experiments").
- Live enforcement against a real, running native engine process (not a
  scripted/fixture model) is M5/M7's concern
  (`docs/integration-feasibility.md`: "verify the actual native and
  OpenCode integrations in M7 and M8").
- Concurrency/claim-epoch semantics for admission (multiple simultaneous
  admission attempts, per-connection/per-claim disconnect rather than a
  single global `setConnected` flag) remain unmodeled here, same as noted
  in the M1.4 ledger evidence record; still owned by later milestones
  implementing the real Galley authorization/control state.

## Decision impacts (open-decision IDs)

- **D1** (enforceable action boundary and disconnect behavior): this slice
  demonstrates one concrete, testable shape for that boundary specifically
  at the two native-path admission points (tool execution and model
  invocation), including that a held/denied tool and a held/denied model
  call need genuinely different graph-level mechanisms (interrupt vs.
  thrown rejection) to surface correctly — a concrete constraint D1 should
  account for when scoping what "enforceable" means per engine. It does not
  resolve D1.
- **D8** (in-flight manual revocation and non-budget execution limits): this
  slice's abort scenario (5) gives a concrete behavior for "in-flight
  handling" specifically for a *model* call cancelled via AbortSignal —
  distinct from the ledger's own already-dispatched carve-out for
  disconnect/expiry/revocation (M1.4's concern) — and records explicitly
  what "retained partial output and usage" requires an integration to do
  (active accumulation, not something the cancellation signal provides for
  free). It does not resolve D8.
- Provider-executed search (scenario 7) is additional evidence for **D1**:
  it demonstrates that "enforceable action boundary" for search specifically
  means the model-call boundary, with no finer-grained interception
  available, which is exactly the kind of "unsupported required
  interception is a failed integration gate, not permission to silently
  weaken the spec" risk `docs/integration-feasibility.md`'s S2 section
  warns about — here it is *not* a failure, because the model-call boundary
  is sufficient to admit-or-refuse the whole search, but a future
  requirement for finer-grained search interception (e.g., approving one
  search query but not another within the same call) would not be
  representable with this mechanism.
- Never selects object storage, hosting, native model, or OpenCode
  provider/model, per open decision **D7** and `experiments/README.md`.
