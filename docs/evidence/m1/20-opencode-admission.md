# M1.9 — OpenCode live admission bridge across disconnect, expiry, revocation, and stop

## Purpose

Prove the core of feasibility experiment S2 ("Live permission and
disconnect admission", `docs/integration-feasibility.md`) against a real
pinned OpenCode process for the first time: an OpenCode plugin whose
before-tool-execution hook consults the `AdmissionLedger` (built for
[#15](https://github.com/cristoforows/ticketIt/issues/15)) for the
built-in shell ("bash") tool, reaching the ledger across the process
boundary over `shared`'s loopback HTTP facade
(`startLedgerServer`/`src/ledger-server.ts`). This is
[M1.9 — OpenCode live admission bridge across disconnect, expiry,
revocation, and stop (#20)](https://github.com/cristoforows/ticketIt/issues/20),
routed from open decision **D1** ("Enforceable OpenCode action boundary
and disconnect behavior") — per `docs/integration-feasibility.md`'s gate
outcome, "S2 is the highest-priority uncertainty" in M1.

This experiment lives in a **new** package, `experiments/opencode-admission/`,
independent from `experiments/opencode-harness` (#16/#17, read but never
modified) and from `experiments/opencode-cancellation`/`opencode-fixed-inputs`
(#18/#19, not touched by this slice), per the issue's instructions.

## Exact versions

Same pinned toolchain as `experiments/opencode-harness`
(`docs/evidence/m1/16-opencode-boot.md`), plus one additional pinned
package for this slice:

- Node: `v26.9.0` (matches `experiments/.nvmrc` and this package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- `typescript`: `7.0.2`, `tsx`: `4.23.13`, `@types/node`: `26.6.1`
  (devDependencies, exact)
- `opencode-ai` (the OpenCode executable) and `@opencode-ai/sdk`:
  `1.18.31` each — identical pin to `experiments/opencode-harness`; see
  `docs/evidence/m1/16-opencode-boot.md` for the version-pairing
  rationale, unchanged here.
- `@opencode-ai/plugin`: `1.18.31` — **new dependency for this slice**,
  the same-monorepo package (confirmed via `npm view @opencode-ai/plugin@1.18.31 dependencies`,
  which declares `"@opencode-ai/sdk": "1.18.31"` as an exact dependency,
  the same lockstep-release evidence `16-opencode-boot.md` already used
  for the executable/SDK pair) that ships this pinned build's plugin/hook
  TypeScript types (`Plugin`, `Hooks`, `PluginInput`, etc.). Used only to
  type-check this package's plugin source; the plugin file itself is
  loaded and executed by OpenCode's own bundled runtime, not by anything
  in this package's `node_modules` resolution.
- Test runner: `node --import tsx --test`, consistent with the rest of
  this workspace.

## Reproducible commands

```sh
cd experiments/opencode-admission
rm -rf node_modules
npm ci
npm run typecheck
npm test
```

No env vars or fixture files need to be supplied externally: the stub
server, the ledger, its HTTP facade, marker files, and the isolated
OpenCode HOME/XDG tree are all created by the tests themselves under
`os.tmpdir()`. Verified with a clean `rm -rf node_modules && npm ci`
followed by two more `npm test` runs, all 8/8 green; `npm run typecheck`
passes with no errors; `ps aux | grep opencode` after every run showed no
leftover process.

One setup note carried over unchanged from `experiments/opencode-harness`
(`docs/evidence/m1/16-opencode-boot.md`): `opencode-ai` ships a compiled
per-platform binary behind a `postinstall` script, approved once via
`npm install-scripts approve opencode-ai`, recorded in this package's own
`package.json` as `"allowScripts": {"opencode-ai@1.18.31": true}` so
`npm ci` alone is sufficient going forward. This slice additionally
approved `esbuild@0.28.2`'s install script (a transitive build dependency
inside `@opencode-ai/plugin`'s own dependency graph, needed only to
resolve/install it, not exercised at test runtime). Two further optional
native install scripts (`fsevents`, `msgpackr-extract`, both transitive)
were left unapproved; every test passed without them, confirming neither
is on any code path this package exercises.

## Documentation research (unverified)

**Plugin registration mechanism for this pinned build**, cross-checked
from three independent sources — the installed package's own shipped
type declarations, this pinned executable's own embedded documentation
text, and the public docs site — with the exact citation for each claim:

1. **`Config.plugin` field shape.** The bare `@opencode-ai/sdk` generated
   types declare `plugin?: Array<string>;`
   (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`, line ~1067).
   `@opencode-ai/plugin`'s own `Config` type additionally allows a tuple
   form: `Config = Omit<SDKConfig, "plugin"> & { plugin?: Array<string |
   [string, PluginOptions]> }` (`node_modules/@opencode-ai/plugin/dist/index.d.ts`).
   This bridge uses only the plain-string form (see point 2), so no cast
   past `opencode-harness`'s own `Partial<Config>` parameter type was
   needed.
2. **Accepted string forms for one `plugin` entry, and the plugin-module
   shape.** Extracted directly from the compiled, pinned executable
   itself — `strings -a node_modules/opencode-ai/bin/opencode.exe`,
   searching for `## Plugins` — which turned out to contain a full
   embedded builtin skill (`location:"/builtin/customize-opencode.md"`,
   `description:"Use ONLY when the user is editing or creating opencode's
   own configuration..."`) baked into the binary for OpenCode's own
   in-product configuration assistant to read. Quoted verbatim (only
   backslash-escaping from the extracted JS string literal removed):

   ```
   "plugin:" is an array. Each entry is one of:
   ```json
   "plugin": [
     "opencode-gemini-auth",            // npm spec, latest
     "opencode-foo@1.2.3",              // npm spec, pinned
     "./local-plugin.ts",               // file path, relative to the declaring config
     "file:///abs/path/plugin.js",      // file URL
     ["opencode-bar", { "key": "val" }] // tuple form with options
   ```
   Auto-discovered plugins (no config entry needed): any `*.ts` or `*.js` file in
   `.opencode/plugin/` or `.opencode/plugins/`.
   A plugin module exports `default` (or any named export) of type
   `Plugin = (input: PluginInput, options?) => Promise<Hooks>`. The export is a
   function, not a plain object literal, and the function returns an object
   (return `{}` if there is nothing to register).
   ```

   The same embedded text also enumerates the full hook surface
   (`event`, `config`, `chat.message`/`chat.params`/`chat.headers`,
   `tool.execute.before`/`tool.execute.after`, `tool.definition`,
   `command.execute.before`, `shell.env`, `permission.ask`, several
   `experimental.*` hooks, plus the object-shaped `tool`/`auth`/
   `provider` registrations) and states plainly: "Hook surface (mutate
   `output` in place; return `void`)". This matches
   `node_modules/@opencode-ai/plugin/dist/index.d.ts`'s `Hooks` interface
   exactly, including that `tool.execute.before`/`tool.execute.after`
   both carry `callID` (used by this bridge to correlate a dispatch with
   its later completion).
3. **This bridge's chosen registration form.** Given the above, this
   bridge registers via `extraConfig: { plugin: [ADMISSION_PLUGIN_URL] }`
   (`src/admitted-opencode.ts`), where `ADMISSION_PLUGIN_URL` is an
   absolute `file:///...` URL to `src/plugin/admission-plugin.ts`,
   computed with `pathToFileURL`. The explicit `file://` form (rather
   than the `.opencode/plugin/` auto-discovery directories) was chosen
   because `startManagedOpenCode`'s `extraConfig` parameter is the only
   hook this package has into the harness's generated config — the
   auto-discovery directories live inside a temporary project directory
   the harness creates *internally*, after the point this package could
   place a file there, since this package does not modify
   `opencode-harness`.
4. **Denial mechanism.** Neither the installed package's `.d.ts` files
   nor the pinned binary's embedded skill text state a declared return
   value for "block this tool call" — the `Hooks` type signature for
   `tool.execute.before` returns `Promise<void>`. The public docs page
   (https://opencode.ai/docs/plugins/, fetched 2026-09-19, **unverified
   until exercised**) shows blocking via a thrown error inside the hook,
   e.g. `if (...) { throw new Error("Do not read .env files") }`. This
   experiment's own fixture evidence (below) is what actually confirms,
   for this exact pinned build, that throwing here stops dispatch and
   exactly what the model/session then sees.

**Process-boundary design (documentation research, then confirmed by
running it).** `opencode-harness`'s `startManagedOpenCode` has no `env`
parameter (see `docs/evidence/m1/16-opencode-boot.md`, "Observed
limitations": `createOpencodeServer` always spawns with
`env: {...process.env, ...}`). This bridge configures the plugin (ledger
URL, agent/account/ticket/round identifiers, the gated tool name, and the
bounded hold-poll parameters) by setting environment variables on the
*calling* Node process immediately before invoking
`startManagedOpenCode`, and restoring them immediately after — the same
technique the harness itself already uses for `HOME`/`XDG_*`/`PATH`. This
was necessary rather than passing options through the plugin's own
`options` parameter (the tuple config form) because it keeps the
call site using the SDK's own plain `Array<string>` `plugin` type with no
cast, and it kept the plugin file itself free of any dependency on this
package's other modules (it only ever reads `process.env` and calls the
global `fetch`, since it executes inside OpenCode's own Bun runtime, a
separate OS process from the `node --test` process hosting the ledger).

## Fixture/stub evidence (observed)

All of the following was actually executed on this machine. `npm test`
(8 suites) passed on repeated runs, including immediately after a clean
`rm -rf node_modules && npm ci`; `npm run typecheck` passed with no
errors; `ps aux | grep opencode` after every run showed no leftover
process.

```
✔ baseline: plugin loads, a valid grant admits the shell tool, ledger records allow/dispatch/complete
✔ scenario 1: disconnected before dispatch -> tool not executed, hold exhausted, denial recorded
✔ scenario 2: disconnected during an action -> in-flight action finishes, next action is not admitted
✔ ordering: tool.execute.before (and this bridge's admit+dispatch) resolves before the native permission request becomes pending
✔ scenario 3 (bridge admission wait): disconnected during the bridge's own hold-wait, reconnect drives a fresh admit() that then dispatches
✔ scenario 4: parallel tool calls both pass through admission and are both recorded
✔ scenario 5: expired/revoked/pending-Stop each deny the next dispatch; a fresh grant continues the same session
✔ critical #17 interaction: hook still runs (and still gates) under a remembered "always" native grant
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

### How the plugin reaches the ledger (in-process bridge or local endpoint)

**Local endpoint (loopback HTTP facade), not an in-process bridge.** The
plugin (`src/plugin/admission-plugin.ts`) runs inside the spawned
OpenCode process (confirmed: it is loaded via a `file://` URL into a
process this package's own `startManagedOpenCode` call spawns as a
*child* process — a separate OS process from the `node --test` process
that constructs the `AdmissionLedger`/`FakeClock`). It calls
`POST {ledgerUrl}/admit`, `POST {ledgerUrl}/dispatch`, and
`POST {ledgerUrl}/complete` on `shared`'s `startLedgerServer` facade
(`experiments/shared/src/ledger-server.ts`) over `127.0.0.1` using the
global `fetch` (available in OpenCode's Bun runtime), exactly as issue
#20 anticipated ("the HTTP facade exists precisely so a plugin in
another process can reach the ledger").

### Whether the hook can hold (wait) or only deny

**It can hold.** `tool.execute.before` is `async` and this bridge's
implementation exploits that directly: on a `"hold"` decision (the
ledger's own semantics for "disconnected, but would otherwise allow" —
`experiments/shared/src/admission-ledger.ts`), the hook sleeps and
re-polls `/admit` up to a bounded number of attempts
(`TICKETIT_HOLD_POLL_MS`/`TICKETIT_HOLD_MAX_ATTEMPTS`, defaulting to
150ms × 30 ≈ 4.5s) before treating a still-persisting hold as effective
non-admission. This is proven two ways:

- `test/04-disconnected-during-admission-wait.test.ts` disconnects,
  observes **at least two** separate fresh `/admit` calls while still
  disconnected (never a cached decision — `ledger.decisions().length`
  actually grows on each poll), reconnects mid-wait, and asserts the very
  next poll iteration is what allows dispatch (`decisions.length >
  decisionsBeforeReconnect` and the last decision is `"allow"`).
- `test/01-disconnected-before-dispatch.test.ts` shows the other edge:
  when the ledger never reconnects, every poll returns `"hold"`, the
  bounded budget is exhausted, and the hook then throws — i.e., a
  persistent hold that never resolves is, from the tool's and model's
  point of view, indistinguishable from a deny. The exact thrown message
  observed: `ticketit-admission: tool "bash" not admitted
  (callID=call_bash_1): decision=hold reason=disconnected
  admissionId=admission-4 attempts=3` (captured via an ad hoc probe of
  `session.messages()`, reproduced by the committed test's assertions on
  the same text).

This bounded hold-poll window is **this bridge's own implementation
choice**, not a resolution of D8 ("reasonable technical loop/time
limits") — see "Decision impacts" below.

### Scenario 1 — disconnected before dispatch: how OpenCode reacts to a hook denial

`test/01-disconnected-before-dispatch.test.ts`. A valid grant exists but
`ledger.setConnected(false)` happens before the prompt is sent; the
ledger never reconnects. Observed:

- Marker file: zero lines (tool never executed).
- Ledger: every recorded decision has `reason: "disconnected"`, decision
  never `"allow"`; zero dispatches.
- **What the model sees.** Captured via `session.messages()` (ad hoc
  probe, then reproduced by the committed test's own assertions): the
  tool's message `part` has `type: "tool"`, `state.status: "error"`, and
  `state.error` set to exactly the thrown `Error`'s message text (quoted
  above). This is delivered back to the model as a normal tool result,
  not surfaced as a fatal engine error.
- **Whether the model/engine continues.** Yes. Exactly **2** chat
  completion requests were observed at the stub
  (`completionRequestCount: 2` in the test's own logged summary): one for
  the initial prompt (which produced the tool call), and exactly one more
  after the tool's error was delivered back — which is what consumed the
  scripted follow-up text turn ("Done after scenario 1."). The session
  continued normally to a new assistant message (`finish: "stop"`).
- **Retry behavior.** **None observed at the engine/tool level.** The
  engine did not automatically re-invoke the same "bash" tool call after
  the hook denied it; it asked the model again (a fresh completion
  request) and the model's own (scripted) next turn was plain text, not
  another tool call. Whether a REAL model, seeing a denial error, would
  choose to retry the same tool call is a property of the model's own
  behavior, not of OpenCode's engine — this is exactly the boundary
  `docs/open-decisions.md`'s **D8** routes "reasonable technical loop/time
  limits" to; this experiment did not observe or need to model any
  engine-level retry loop because none exists at the hook/dispatch layer
  itself.

### Scenario 2 — disconnected during an action

`test/02-disconnected-during-action.test.ts`. The first shell call sleeps
briefly (`sleep 0.6 && ...`) so there is a real, observable window
between dispatch and completion. Disconnect is triggered by **polling
`ledger.dispatches()` until an entry appears** (never a fixed tick
count), confirming the action was dispatched but not yet completed at
that instant. Observed: the in-flight action still finished (`marker ==
["first"]`) and its completion **was** recorded
(`dispatches[0].completedAtMs` set) despite the ledger being disconnected
at completion time — `AdmissionLedger#complete` is deliberately
independent of `connected` (`experiments/shared/src/admission-ledger.ts`).
A second shell call requested afterward, still disconnected, was not
admitted: zero new dispatches, last decision `reason: "disconnected"`,
marker unchanged.

### Pipeline-ordering finding (load-bearing for scenario 3's design)

`test/03-hook-precedes-native-permission-ask.test.ts`. With a bash tool
gated by BOTH this bridge's hook AND OpenCode's native
`permission: { bash: "ask" }`, the very first instant a native permission
request is observed pending (via `listPending`), the ledger **already**
shows one `"allow"` decision and one dispatch, and the marker file is
still empty. In other words: **`tool.execute.before` (and this bridge's
admit+dispatch call) resolves BEFORE the native permission-ask gate ever
becomes visible, not after.** This is architecturally sensible (native
permission "patterns" are derived from the tool's — possibly
hook-mutated — final arguments, so the pattern-matching step must follow
`tool.execute.before`), but it means a plugin at this hook position
cannot implement "one fresh check strictly after human approval,
immediately before dispatch" for a tool that is *also* gated by native
"ask" permission — `tool.execute.before` is inherently a pre-flight
check relative to the engine's own approval wait, not a post-approval
one. This directly shaped scenario 3's test design below and is recorded
here as a finding in its own right, not folded silently into that test.

### Scenario 3 (redesigned) — disconnected during an admission wait

`test/04-disconnected-during-admission-wait.test.ts`. Given the ordering
finding above, "disconnected during an approval wait" was tested as
disconnection during THIS BRIDGE's own hold-wait (the closest thing to
an "approval wait" a hook at this pipeline position can observe) rather
than during OpenCode's native ask. Observed: several fresh `/admit` polls
while still disconnected (each a new ledger decision, `reason:
"disconnected"`), zero execution during that window, then reconnecting
mid-wait produces additional new decisions culminating in one `"allow"`,
after which the tool executes exactly once and its dispatch completes.
The requirement "after reconnect, [a] fresh admission check [happens]
before dispatch" is satisfied in the sense that matters operationally:
dispatch only ever follows a decision made *after* reconnect was
observed by a live poll, never a decision cached from before disconnect.

### Scenario 4 — parallel requests

`test/05-parallel-requests.test.ts`. One scripted assistant turn carries
two simultaneous "bash" tool calls (`toolCalls` with two entries, OpenAI
parallel-tool-call shape). Both executed (`marker == ["a", "b"]`, order
not asserted), the ledger recorded **exactly two** `"allow"` decisions
with **distinct `admissionId`s**, and both dispatches completed. The two
calls were correlated correctly by their distinct `callID`s
(`dispatchedByCallId` map in `src/plugin/admission-plugin.ts`), which is
what makes this safe under concurrency in the first place. Not
established: true wall-clock concurrency of the two `/admit` calls versus
strictly sequential dispatch — the ledger's own timestamps
(`decidedAtMs`) are `FakeClock`-based, not wall-clock, so they cannot
distinguish "concurrent" from "back-to-back sequential" for this
assertion; see "Observed limitations".

### Scenario 5 — reconnect variants

`test/06-reconnect-variants.test.ts`, one continuous OpenCode session/
Round, six sequential rounds, driven entirely by `FakeClock.advance()`
(no wall-clock waiting for expiry, and no polling needed for the
expiry/revoke/stop transitions themselves since they are evaluated
against a clock this test fully controls):

| Round | Ledger state change | Observed decision | Marker |
| --- | --- | --- | --- |
| 1 | valid time-based grant (`expiresAt: 1000`), clock at 0 | `allow` | `r1` executes |
| 2 | `clock.advance(2000)` (now past `expiresAt`) | deny, `reason: "expired"` | unchanged |
| 3 | fresh time-based grant | `allow` | `r3` executes; **same session id** confirmed via `session.get()` |
| 4 | `ledger.revoke(grant.id)` | deny, `reason: "revoked"` | unchanged |
| 5 | `ledger.requestStop(roundId)` | deny, `reason: "stop-pending"` | unchanged; the exact string `"stop-pending"` was found present in `session.messages()` — the Stop reason is surfaced to the model/session, not silently swallowed |
| 6 | `ledger.confirmStop(roundId)` + fresh grant | `allow` | `r6` executes; **same session id** confirmed again |

Every denied round still consumed its scripted follow-up text turn (per
the scenario 1 finding that a denial does not stop the engine from
asking the model again), so all 12 queued turns (6 tool calls + 6 text
replies) were consumed in order with no leftover/misaligned turn — a
known `StubModelServer` gotcha documented in
`docs/evidence/m1/17-opencode-questions.md` ("Flakiness and how it was
stabilized").

### Critical interaction with issue #17's finding

`test/07-always-grant-hook-still-runs.test.ts`. Issue #17's finding
(`docs/evidence/m1/17-opencode-questions.md`, "once versus always") is
that OpenCode's own remembered `"always"` permission reply suppresses its
native ask for later shell calls, even across sessions. This is exactly
the risk `docs/integration-feasibility.md`'s "Live grants" row and open
decision **D1** name: engine memory could bypass ticketIt's own
authority checks. **This bridge's hook was tested explicitly under that
condition, in the same session:**

1. Round 1: native ask pending (confirming the ordering finding: this
   bridge's hook had already admitted before the ask appeared), replied
   `"always"`. Executes; marker `["r1"]`.
2. The grant used for round 1 is **revoked**.
3. Round 2 (same session): polled for up to ~1.8s — **zero** native
   permission requests ever became pending (re-confirming #17's finding:
   the engine's own gate was silently bypassed by its "always" memory).
   **This bridge's hook still ran** (`ledger.decisions().length`
   increased for round 2) and **still denied** (`reason: "revoked"`).
   Marker stayed `["r1"]` — the tool did **not** execute, despite the
   engine's own permission system having no further say in the matter.
4. Round 3: fresh grant issued; still no native ask observed (persistent
   "always" memory); this bridge's hook ran again and allowed. Marker
   became `["r1", "r3"]`. Same session id confirmed throughout via
   `session.get()`.

**Finding, recorded prominently as instructed:** on this pinned build,
the plugin hook **still runs, and is still the operative gate**, even
when the engine has a remembered "always" grant that suppresses its own
native prompt entirely. This is the positive result D1 needed: external
admission via `tool.execute.before` is mechanically independent of
OpenCode's own permission memory, because the hook fires on every tool
invocation attempt regardless of whether the engine's own gate has
anything left to ask. Had round 2 executed despite the revoked grant,
that would have been a failed gate for D1; it did not.

## Real-provider evidence (observed, or "none executed")

None executed. Every completions request in this experiment went to the
local `StubModelServer` on `127.0.0.1` (unchanged mechanism from
`experiments/opencode-harness`); no API key for a real provider exists
anywhere in this repository or its isolated environment. The only
network activity beyond loopback was `npm ci`/`npm view` against the
public npm registry (package resolution, not a model or execution
provider), per `experiments/README.md`.

## Observed limitations

- **The bounded hold-poll window is this experiment's own design choice**
  (default 150ms × 30 ≈ 4.5s), not a specified or resolved value. A
  persistent hold past that budget is treated as non-admission (the tool
  is denied). This is recorded as this bridge's behavior, not as a
  resolution of D8's "reasonable technical loop/time limits" — see
  "Decision impacts".
- **No engine-level retry loop was observed or needed to be modeled** at
  the hook/dispatch boundary (scenario 1): the engine asks the model
  again after a denial rather than automatically re-invoking the same
  tool call. Whether a *model* (not the engine) would itself choose to
  retry a denied action repeatedly is unconstrained by anything this
  bridge enforces; that possibility is exactly what D8's loop/time-limit
  language anticipates and this experiment does not attempt to bound it.
- **Only the "bash" tool is gated.** Per issue #20's explicit scope ("for
  one built-in tool (the shell tool)"), the plugin only intercepts
  `input.tool === "bash"`; every other registered/custom/MCP tool,
  direct API path, and model-only continuation is untouched by this
  slice, exactly as `docs/integration-feasibility.md`'s S2 description
  anticipates needing a fuller test matrix ("every enabled
  registered/custom/MCP tool, direct API path, model-only continuation,
  and Git/SSH operation... nested shell and provider-search boundaries")
  — none of that is exercised here. **Routed to #21** (see below).
- **Parallel-call concurrency was not distinguished from sequential
  dispatch.** `AdmissionLedger`'s timestamps come from a `FakeClock` that
  this experiment never advances during the parallel scenario, so
  `decidedAtMs`/`dispatchedAtMs` cannot show whether the two `/admit`
  calls were genuinely concurrent in wall-clock time or simply
  back-to-back. Only the outcome (both admitted, both recorded, distinct
  ids) is established, not the true concurrency shape.
- **The admission ledger and its HTTP facade carry the same limitations
  already recorded in `docs/evidence/m1/15-admission-ledger.md`**
  ("Observed limitations"): in-memory only, no persistence, no
  concurrency control/claim-epoch semantics, opaque string matching for
  `resource`/`account`, and an unauthenticated loopback-only HTTP facade.
  This slice adds no new mitigation for any of those; it is a consumer of
  that ledger, not a hardening of it.
- **No genuine network-level failure of the HTTP facade itself was
  exercised** — every "disconnect" here is `ledger.setConnected(false)`,
  the ledger's own connectivity flag, not an actual killed/unreachable
  HTTP server. This bridge's plugin has no distinct handling for a
  fetch-level network error talking to the ledger (e.g. connection
  refused); such an error would currently propagate as an unhandled
  rejection inside the hook rather than a clean deny. Not exercised or
  fixed here — recorded as a real gap for a hardened version of this
  bridge, not silently assumed safe.
- **The pipeline-ordering finding (hook-before-native-ask) was confirmed
  only for the "ask" permission action; "deny"/"allow" native permission
  configurations, and non-bash tools, were not separately probed for the
  same ordering.** Plausible by the same architectural reasoning (pattern
  matching needs the hook's finished output), but not independently
  observed.
- **`OPENCODE_PURE`/`OPENCODE_DISABLE_DEFAULT_PLUGINS` and similar
  plugin-related escape hatches** (documented in the same embedded
  builtin-skill text cited above) were read but never exercised; this
  bridge relies on the default plugin-loading path being active, which
  every passing test already confirms empirically for this pinned build.

## Outstanding checks and owning milestone

- **The full action-path coverage matrix** — every other registered tool,
  direct API paths, model-only continuation, and Git/SSH operations, plus
  nested shell and provider-search boundaries per
  `docs/integration-feasibility.md`'s S2 description — is explicitly
  routed to **[#21](https://github.com/cristoforows/ticketIt/issues/21)**,
  per issue #20's own instructions ("A follow-up slice (#21) will extend
  YOUR package with the full action-path coverage matrix"). This
  package's `startAdmittedOpenCode`/plugin design is written to be
  reusable for that extension (see `src/index.ts`'s exports).
- **Live enforcement against a real Galley/Michelin boundary** (this
  experiment's ledger and HTTP facade are still a bounded local
  substitute) is owned by **M4–M6** (exercising the corresponding
  application behavior through controlled Rounds) and verified for real
  in **M7/M8** (`docs/implementation-plan.md`), per
  `docs/integration-feasibility.md`'s "Planned feasibility experiments"
  framing.
- **A hardened version of the ledger-facade network-failure path**
  (fetch-level errors, authentication, retries) is not scoped to M1's
  bounded adapter proof; flagged above as a real gap for whichever
  milestone builds the production admission-control service.
- The gate-report slice
  ([#29](https://github.com/cristoforows/ticketIt/issues/29)) owns
  reconciling `docs/evidence/m1/README.md`,
  `docs/integration-feasibility.md`, and `docs/open-decisions.md` against
  this and other M1 evidence.

## Decision impacts (open-decision IDs)

- **D1** (Enforceable OpenCode action boundary and disconnect behavior) —
  the central decision this slice serves:
  - **Positive result:** a plugin hook (`tool.execute.before`) can gate
    the shell tool through an externally-owned admission decision,
    reached over a process-boundary HTTP facade, and — critically — that
    gate remains operative even when OpenCode's own native permission
    memory ("always") would otherwise bypass its own prompt entirely
    (the #17-interaction test). This is the specific viability question
    D1 posed for this slice, and the observed answer is yes, for the
    shell tool, on this pinned build.
  - **Boundary found, not resolved:** the pipeline-ordering finding
    (`tool.execute.before` resolves *before* a native "ask" permission
    request becomes pending, not after) means a design that assumes "one
    check immediately before physical dispatch, after any human
    approval" does not hold when native "ask" permission is also
    configured for the same tool — the check instead happens as a
    pre-flight step. Any real implementation combining this bridge's
    admission with native "ask" permission needs to account for that
    ordering explicitly (e.g., decide whether native "ask" should be
    disabled in favor of the bridge's own hold/deny, or whether a second
    hook such as `permission.ask` is also needed) — this is recorded here
    as an integration-design point for D1's resolution, not silently
    routed around.
  - **Scope respected:** only the shell tool was gated (per issue #20's
    explicit scope); D1's "prove live admission for every enabled path"
    remains open pending #21.
- **D8** (In-flight manual revocation and non-budget execution limits) —
  this slice's bounded hold-poll window (default ~4.5s) and the observed
  absence of any engine-level automatic retry loop after a denial are
  both recorded as relevant inputs, not resolutions: D8 explicitly scopes
  "reasonable technical loop/time limits," and this experiment picked one
  concrete, disclosed number for its own hold-poll behavior without
  claiming it as the product answer. Scenario 2's finding (an
  already-dispatched action's completion is recorded independent of
  later disconnect) is consistent with, and reuses, the same
  already-dispatched carve-out `docs/evidence/m1/15-admission-ledger.md`
  recorded as its own chosen (not dictated) behavior for D8's
  "already-dispatched handling" language.
