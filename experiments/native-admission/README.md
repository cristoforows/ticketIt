# native-admission

Native-path admission for
[M1.13 — Native admission before tool and model calls, including
provider-executed search (#24)](https://github.com/cristoforows/ticketIt/issues/24).
See
[../../docs/evidence/m1/24-native-admission.md](../../docs/evidence/m1/24-native-admission.md)
for the full evidence record.

Wraps [`native-harness`](../native-harness/)'s `createAgent`-based tool
execution and model invocation with
[`shared`](../shared/)'s `AdmissionLedger`, so that in the native path --
where Michelin controls both tool execution and model invocation directly --
every tool call and every model call is checked against the ledger first.
The model call is checked too, and not only the tool call, because
provider-executed web search (OpenRouter's web-search plugin) happens
*inside* the model call: there is no separate, later, interceptable step for
it (see
[docs/integration-feasibility.md](../../docs/integration-feasibility.md),
"OpenRouter integration").

## What this is, and is not

This is an M1 adapter proof, not the ticketIt application. It selects no
object storage, hosting, native model, or OpenCode provider/model (open
decision D7). It makes no call to a real model provider: `ScriptedChatModel`
and `ControllableChatModel` (from `native-harness`) and this package's own
`PartialOutputChatModel` never touch the network, and the simulated
web-search reply in `src/search-fixtures.ts` is a fixture, not a real
OpenRouter response.

## Public API (`src/index.ts`)

- `admittedTool(tool, ledger, scope)` -- wraps a LangChain tool so every
  execution first calls `ledger.admit(scope)`. On `"allow"` it dispatches,
  runs the tool, and completes. On `"hold"` or `"deny"` the tool's own
  effect never runs; the refusal is raised through
  `@langchain/langgraph`'s `interrupt()` so the graph pauses at that step
  rather than the model seeing a synthetic tool failure. See the doc
  comment on `admittedTool` in `src/admitted-tool.ts` for the full
  model-facing behavior and why this mechanism (not a thrown error, not a
  refusal `ToolMessage`) was chosen.
- `admittedModel(model, ledger, scope)` / `AdmittedChatModel` -- wraps a
  `BaseChatModel` so every `_generate`/`_streamResponseChunks` call first
  checks admission for the fixed `scope`. On `"hold"` or `"deny"` it throws
  `AdmissionRefused` directly (no `interrupt()` -- see the doc comment on
  `AdmittedChatModel` in `src/admitted-model.ts` for why `interrupt()` is
  not attempted for a model call). This is the only admission point for
  provider-executed search: see scenario 7 below.
- `AdmissionRefused` -- the typed error/interrupt-payload both wrappers
  construct on a non-`"allow"` decision (`src/admission-refused.ts`).
- `AdmissionScope` / `toAdmitRequest` -- the fixed identity (round/ticket/
  agent/account/action/resource) a wrapped tool or model checks on every
  call, bound once at construction (`src/admission-scope.ts`).
- `ControllableChatModel` -- like `native-harness`'s `ScriptedChatModel`,
  but a call can be held open until explicitly released (`armDelay()`), so
  a test can observe ledger/connectivity state changing while a model call
  is genuinely in flight, and can abort a held call through the standard
  `options.signal` (`src/controllable-chat-model.ts`).
- `PartialOutputChatModel` -- a chunk-by-chunk scripted model, gated per
  chunk index (`armChunkGate(atChunkIndex)`), so a test can abort a call
  partway through and assert exactly how much content/usage had
  accumulated before the `AbortSignal` fired
  (`src/partial-output-chat-model.ts`).
- `simulatedWebSearchReply()` -- a scripted `AIMessage` simulating an
  OpenRouter web-search-plugin reply (citation-like `annotations`), for
  scenario 7 (`src/search-fixtures.ts`). Shape is documentation research,
  not observed -- see the doc comment and the evidence record.

## Scenarios (`test/`)

Each scenario is a `node:test` test using `createHarnessAgent` /
`runTurn` from `native-harness` against a real `PostgresSaver` checkpointer:

1. `scenario-1-disconnect-before-tool.test.ts` -- disconnect before the next
   tool holds admission; the graph pauses via `interrupt()`; zero `"allow"`
   decisions while disconnected.
2. `scenario-2-disconnect-during-model-call.test.ts` -- an in-flight model
   call completes despite a mid-call disconnect (already dispatched); the
   next model call is held.
3. `scenario-3-expiry-mid-run.test.ts` -- a time-based grant expiring mid-run
   (via `FakeClock`) denies the search-scoped model call while the tool's
   own ticket-based grant, unaffected by that expiry, keeps it allowed.
4. `scenario-4-revocation-between-calls.test.ts` -- revoking a grant between
   turns denies the next tool call; the earlier turn's completed dispatch is
   untouched.
5. `scenario-5-pending-stop-abort.test.ts` -- a pending Stop cancels an
   in-flight model call through `AbortSignal`, retaining partial output and
   usage; the next admission is denied with `stop-pending`; the checkpoint
   remains readable.
6. `scenario-6-new-grant-continues-thread.test.ts` -- a new grant (not a
   reconnect, not restoring the revoked one) lets the same thread and the
   same Round continue via a LangGraph `Command` resume, never a new thread
   or a new `RoundRegistry` entry.
7. `scenario-7-provider-executed-search.test.ts` -- provider-executed search
   is admitted only at the model call; no separate tool admission exists for
   it; a mid-call disconnect does not undo the already-dispatched search.

## Verification

```sh
cd experiments/native-admission
npm ci
npm test        # node --test, 7 scenario tests
npm run typecheck
```

Requires the same local PostgreSQL 17 database as `native-harness`
(`ticketit_m1_native` by default; see
[../native-harness/README.md](../native-harness/README.md), "Database
setup"). Run `cd ../native-harness && npm run db:setup` first if it has not
been created yet.

## `native-harness` changes

This package depends on `native-harness` via `file:../native-harness` and
only made additive changes to it, both confirmed necessary while building
this package:

- `package.json` gained `"main": "./src/index.ts"` and
  `"types": "./src/index.ts"`. Without them, Node's package resolution for a
  `file:` dependency with no `main`/`exports` field could not resolve
  `import ... from "native-harness"` from this package.
- `src/harness.ts`'s `RunTurnOptions` gained an optional `signal?:
  AbortSignal` field, forwarded to `agent.invoke()`'s `RunnableConfig` when
  present. Existing callers that omit it are unaffected. Needed for scenario
  5, which cancels a long-running scripted model call through the same
  cancellation channel a real provider call would use.

No existing native-harness behavior, export, or test was changed.
