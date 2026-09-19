# opencode-admission

An OpenCode plugin that bridges OpenCode's before-tool-execution hook to
the shared `AdmissionLedger`, proving the core of feasibility experiment
S2 ("Live permission and disconnect admission",
`docs/integration-feasibility.md`) for open decision **D1**. Built for
[M1.9 — OpenCode live admission bridge across disconnect, expiry,
revocation, and stop (#20)](https://github.com/cristoforows/ticketIt/issues/20).

This is a **new, independent experiment package** (its own
`package.json`/lockfile), separate from `experiments/opencode-harness`
(#16/#17) and `experiments/opencode-cancellation`/`opencode-fixed-inputs`
(#18/#19, not touched by this slice). It depends on
`experiments/opencode-harness` and `experiments/shared` only through
local `file:` dependencies and their exported public APIs; it never
modifies either package.

See `docs/evidence/m1/20-opencode-admission.md` for exact versions,
documentation research (the plugin registration/hook mechanism for this
pinned build, cited from both the installed package and the compiled
CLI's own embedded text), fixture evidence per scenario, and decision
impacts (D1, D8).

## Running

```sh
cd experiments/opencode-admission
npm ci
npm test
```

`npm test` runs 8 suites end to end (all fixture/stub, no real network
provider):

- `test/00-baseline.test.ts`: the plugin loads for this pinned build, a
  valid grant admits the shell tool, and the ledger records exactly one
  allow, one dispatch, and one completion.
- `test/01-disconnected-before-dispatch.test.ts` (**scenario 1**): a
  valid grant exists but the ledger is disconnected before the prompt is
  even sent; the tool never executes (proven with a marker file); records
  how OpenCode reacts to the hook's denial (the thrown error is delivered
  back to the model as a tool error, and the engine asks the model again
  rather than retrying the same tool call).
- `test/02-disconnected-during-action.test.ts` (**scenario 2**):
  disconnect happens strictly after a dispatch is observed (polled from
  the ledger, never a fixed tick count) but before the shell command
  finishes; the in-flight action still completes and records its
  completion, and a second action requested afterward is not admitted.
- `test/03-hook-precedes-native-permission-ask.test.ts`: a pipeline-
  ordering finding this bridge's design depends on — `tool.execute.before`
  (and this bridge's admit+dispatch) resolves BEFORE OpenCode's own
  native `permission: { bash: "ask" }` request ever becomes pending, not
  after.
- `test/04-disconnected-during-admission-wait.test.ts` (**scenario 3**,
  redesigned per the ordering finding above): disconnected during this
  bridge's own bounded hold-poll wait; reconnecting mid-wait produces a
  strictly fresh `/admit` call (never a stale cached decision) that then
  dispatches.
- `test/05-parallel-requests.test.ts` (**scenario 4**): one assistant turn
  with two simultaneous "bash" tool calls; both pass through admission
  and the ledger records both decisions and both dispatches, correlated
  by distinct `callID`s.
- `test/06-reconnect-variants.test.ts` (**scenario 5**): in one continuous
  session/Round, an expired time-based grant denies, a revoked grant
  denies, a pending Stop denies (and surfaces its reason to the
  model/session), and a fresh grant lets the same session continue —
  driven deterministically by the ledger's `FakeClock`, no wall-clock
  waiting for expiry.
- `test/07-always-grant-hook-still-runs.test.ts` (**critical #17
  interaction**): replying "always" to OpenCode's native permission ask
  suppresses the engine's own prompt for a later call in the same
  session (re-confirming issue #17's finding) — but this bridge's hook
  still runs and still denies once the ledger's grant is revoked, proving
  external admission is a viable gate independent of engine memory.

## Public API (`src/index.ts`)

- `startAdmittedOpenCode(options)` — starts an `AdmissionLedger` (backed
  by a `FakeClock`), exposes it over `shared`'s `startLedgerServer`
  loopback HTTP facade, and starts a managed OpenCode server
  (`opencode-harness`'s `startManagedOpenCode`) configured to load the
  admission-bridge plugin via an absolute `file://` URL in
  `Config.plugin`. Returns `{ ledger, clock, ledgerServer, managed,
  agentId, account, ticketId, roundId, action, resource, close() }`.
- `ADMISSION_PLUGIN_URL` — the absolute `file://` URL to the plugin
  module (`src/plugin/admission-plugin.ts`).
- `ADMISSION_ENV` — the environment-variable names the plugin reads
  inside the spawned OpenCode process (ledger URL, agent/account/ticket/
  round identifiers, the gated tool name, and the bounded hold-poll
  parameters). Exported so the bridge and its tests share one source of
  truth for this process-boundary contract instead of duplicated string
  literals.
- `attachRoundMapping(roundId, engineExecutionReference)` — a small local
  helper for the Round-ID/engine-execution-reference identity mapping
  (ADR 0002), for a Round ID minted *before* the OpenCode session exists
  (matching production order: Galley creates the Round at claim time,
  before Michelin starts OpenCode). Implemented locally because
  `opencode-harness`'s own `createRoundMapping` always mints its own
  `randomUUID()` bound to an already-created session id and has no
  parameter for a caller-supplied Round ID; this package does not modify
  that file. A natural follow-up would be to generalize
  `opencode-harness/src/round-mapping.ts` to accept an optional
  pre-existing Round ID and have this package depend on it instead.

The plugin itself (`src/plugin/admission-plugin.ts`) is never imported by
this package's own test process — it runs inside the spawned OpenCode
process (Bun runtime) and reaches the ledger only over the loopback HTTP
facade, configured entirely through the `ADMISSION_ENV` environment
variables (see the file's own module comment for the full citation of
how plugin registration and the hook surface were determined for this
pinned build).

## What this template pins

Same pinned versions as `experiments/opencode-harness` (`opencode-ai`,
`@opencode-ai/sdk`: `1.18.31`; `typescript`/`tsx`/`@types/node` match the
rest of this workspace), plus `@opencode-ai/plugin@1.18.31` (the
same-monorepo package that ships this pinned build's plugin/hook
TypeScript types — used only for type-checking this package's plugin
source; the plugin itself is loaded by OpenCode's own runtime, not by
this package). `"allowScripts"` approves `opencode-ai`'s and `esbuild`'s
install scripts (the latter a transitive build dependency of
`@opencode-ai/plugin`'s own dependency graph); two other optional native
install scripts (`fsevents`, `msgpackr-extract`) are left unapproved —
neither is on any code path this package exercises, confirmed by every
test passing without them.

See `experiments/README.md` for the full workspace rules (no real
credentials or providers, exact pins, one evidence file per experiment).
