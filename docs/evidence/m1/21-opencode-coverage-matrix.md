# M1.10 — OpenCode action-path coverage matrix

## Purpose

Sweep feasibility experiment S2 ("Live permission and disconnect
admission", `docs/integration-feasibility.md`) to completion for open
decision **D1** ("Enforceable OpenCode action boundary and disconnect
behavior"): with the `AdmissionLedger` set to deny everything (zero
grants), determine for every enabled action path on this pinned OpenCode
build whether the admission bridge built in
[M1.9 #20](https://github.com/cristoforows/ticketIt/issues/20)
(`experiments/opencode-admission/`) actually covers it — gated by the
hook, gated only coarsely, or not gated at all — using side-effect
markers as the ground truth. This is
[M1.10 — OpenCode action-path coverage matrix
(#21)](https://github.com/cristoforows/ticketIt/issues/21), the last
experiment slice of M1 and the one issue #20 explicitly routed the full
matrix to ("A follow-up slice (#21) will extend YOUR package with the
full action-path coverage matrix").

This slice **extends** the existing `experiments/opencode-admission/`
package in place (own `package.json`/lockfile, unchanged pins) — it does
not create a new package, per this issue's instructions to build on #20's
bridge rather than rebuild it. `experiments/opencode-harness/`,
`experiments/shared/`, `experiments/opencode-cancellation/`, and
`experiments/opencode-fixed-inputs/` are unmodified.

## Salvage note

A previous, budget-exhausted attempt at this issue left uncommitted work
in another worktree
(`.claude/worktrees/agent-acb2ccf2132276b31/experiments/opencode-admission/`):
modifications to `src/admitted-opencode.ts` and
`src/plugin/admission-plugin.ts` adding a `gateAllTools` mode and an
optional plugin-registered `customTool`, plus an uncommitted
`scratch-probe.ts` (a `client.tool.ids()`/`.tool.list()` probe, not
committed here). The plugin/bridge changes were salvaged and completed —
the previous attempt had declared the new `ADMISSION_ENV` keys and
`StartAdmittedOpenCodeOptions` fields but never actually wired
`options.gateAllTools`/`options.customTool` into the environment
variables passed to the spawned process; this slice completed that
wiring (`src/admitted-opencode.ts`) before writing any new test. The
scratch probe's *technique* (`client.tool.ids()`/`.tool.list()` against a
running managed instance) was reused to enumerate this pinned build's
tool ids live (see "Fixture/stub evidence" below); the file itself was
not copied into this commit.

## Exact versions

Identical to `docs/evidence/m1/20-opencode-admission.md` (same package,
same lockfile; nothing re-pinned for this slice):

- Node: `v26.9.0` (matches `experiments/.nvmrc` and this package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- `typescript`: `7.0.2`, `tsx`: `4.23.13`, `@types/node`: `26.6.1`
  (devDependencies, exact)
- `opencode-ai` (executable), `@opencode-ai/sdk`, `@opencode-ai/plugin`:
  `1.18.31` each — unchanged pins, confirmed again for this slice via
  `node -p "require('./node_modules/<pkg>/package.json').version"`.
- Test runner: `node --import tsx --test`, now invoked with
  `--test-timeout=60000` (added this slice — see "Observed limitations,"
  a genuine hang this slice hit needed a hard per-test bound so a future
  regression fails loudly instead of hanging CI/an agent session
  indefinitely).

## Reproducible commands

```sh
cd experiments/opencode-admission
rm -rf node_modules
npm ci
npm run typecheck
npm test
```

No env vars or fixture files need to be supplied externally. Verified
with a clean `rm -rf node_modules && npm ci` followed by `npm test`:
**14/14 passing** (the 8 pre-existing #20 suites, unchanged and still
green, plus 6 new suites added by this slice). `npm run typecheck` passes
with no errors. `ps aux | grep "opencode serve"` after every run showed
no leftover process.

```
✔ baseline: plugin loads, a valid grant admits the shell tool, ledger records allow/dispatch/complete
✔ scenario 1: disconnected before dispatch -> tool not executed, hold exhausted, denial recorded
✔ scenario 2: disconnected during an action -> in-flight action finishes, next action is not admitted
✔ ordering: tool.execute.before ... resolves before the native permission request becomes pending
✔ scenario 3 (bridge admission wait): disconnected during the bridge's own hold-wait, reconnect drives a fresh admit() that then dispatches
✔ scenario 4: parallel tool calls both pass through admission and are both recorded
✔ scenario 5: expired/revoked/pending-Stop each deny the next dispatch; a fresh grant continues the same session
✔ critical #17 interaction: hook still runs (and still gates) under a remembered "always" native grant
✔ ambient OPENCODE_PERMISSION=allow does not defeat the plugin hook (ledger denies everything, "ask" is ambiently overridden to "allow")
✔ model-only continuation: text-only turns are not gated at all -- zero admit() calls even fully disconnected
✔ nested shell (git+fake-ssh push+HTTP) executes under ONE admitted bash call, coarse-grained; worktree is not a filesystem sandbox
✔ built-in tools sweep (gate-all-tools, zero grants): every listed tool id is gated by the hook, none executes
✔ custom plugin-registered tool: dispatches through the same hook, gated (denied, then allowed)
✔ local stdio MCP tool: connects and answers tools/list, but never becomes dispatchable on this pinned build (observed limitation)
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

## Documentation research (unverified)

- **`Config.permission.external_directory`** (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`,
  line 1168): `"ask" | "allow" | "deny"`, alongside `bash`, `edit`,
  `webfetch`, `doom_loop` in the same `permission` object. Not previously
  exercised by `docs/evidence/m1/17-opencode-questions.md` or
  `docs/evidence/m1/19-opencode-fixed-inputs.md` (neither tested a
  cross-directory file read or a network-touching shell command). This
  slice's fixture evidence (below) is what actually confirms its default
  behavior for this pinned build, not this citation alone.
- **`Config.mcp` / `McpLocalConfig`** (same file, lines 946–967):
  `mcp?: { [name]: McpLocalConfig | McpRemoteConfig }`, where
  `McpLocalConfig = { type: "local", command: string[], environment?:
  {[k]: string}, enabled?: boolean, timeout?: number (tool-fetch timeout,
  default 5000ms) }`. The SDK client additionally exposes
  `client.mcp.status()` (`GET /mcp`, "Get MCP server status") and
  `client.mcp.connect()`/`.disconnect()` (`node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts`,
  lines ~287–305) — not documented in this pinned build's own embedded
  `customize-opencode` skill text (that text covers config/skill/plugin
  discovery, not MCP). The Model Context Protocol stdio transport itself
  (newline-delimited JSON-RPC 2.0: `initialize` → `notifications/initialized`
  → `tools/list` → `tools/call`) is documented at
  https://modelcontextprotocol.io/specification (fetched knowledge, not
  re-fetched live for this slice; implemented directly in
  `test/fixtures/local-mcp-server.mjs` rather than adding a
  `@modelcontextprotocol/sdk` dependency, to keep this package's
  dependency graph small and every version pinned per
  `experiments/README.md`).
- **Tool id enumeration** (`client.tool.ids()`/`.tool.list()`), same
  technique `docs/evidence/m1/17-opencode-questions.md`'s "Tool
  discovery" ad hoc probe used, re-run live for this slice (promoted to
  fixture evidence below, not left as documentation research, since
  `test/11-built-in-tools-sweep.test.ts` asserts on it directly).

## Fixture/stub evidence (observed)

All of the following was actually executed on this machine (`npm test`,
14/14 passing, including a run immediately after `rm -rf node_modules &&
npm ci`).

### Priority 1 — ambient permission environment variable vs. the plugin hook

`test/08-ambient-permission-vs-hook.test.ts`. Reproduces
`docs/evidence/m1/19-opencode-fixed-inputs.md`'s failed-gate finding
exactly (`OPENCODE_PERMISSION={"bash":"allow"}` set ambiently in the
calling process before spawn, while the Round's own config asks for
`permission: { bash: "ask" }`) with the ledger holding **zero grants**
(deny-everything posture). Observed:

- The ambient override worked exactly as #19 found: `listPending` never
  showed a native permission request pending — OpenCode's own "ask" was
  silently neutralized to "allow."
- **This bridge's `tool.execute.before` hook still ran and still
  denied.** The marker file stayed empty; every recorded ledger decision
  was `reason: "no-grant"`, never `"allow"`; zero dispatches. The denial
  text (`"...not admitted..."`) appeared in the session's messages.

**This answers the single most important question this slice was asked
to prove: the ambient `OPENCODE_PERMISSION` environment variable does
NOT defeat the plugin hook.** The hook's admission decision comes
entirely from the ledger over the loopback HTTP facade and never
consults OpenCode's own `permission` config at all, so an ambient
variable that reconfigures *that* config has no path to reach it. This
is the same structural independence
`docs/evidence/m1/20-opencode-admission.md`'s "critical #17 interaction"
test established against OpenCode's own permission *memory* ("always"),
now separately confirmed against OpenCode's own permission *ambient
configuration* — two different engine-level bypass vectors, the same
bridge-side answer both times.

### Priority 2 — model-only continuation

`test/09-model-only-continuation.test.ts`. Three scripted text-only
turns (no tool calls at all), ledger fully **disconnected**
(`setConnected(false)`) for the whole interaction. Observed: all three
prompts completed normally end to end (all three scripted replies
delivered), and `admitted.ledger.decisions().length === 0` — the
disconnected ledger, which holds or denies every tool-gated action
throughout this entire suite, had literally nothing to admit, hold, or
deny, because no tool was ever invoked.

**Model-only continuation cannot be stopped by this bridge, structurally,
not as a bug.** `tool.execute.before`/`.after` are the only hooks this
bridge uses, and they fire exclusively on tool dispatch. A model
producing more assistant text — including a fabricated claim that
real-world work was completed — has no associated tool-execution event
for any hook at this position to intercept. This is a genuine, permanent
gap for D1 at this integration layer, not something a different plugin
hook choice within `tool.execute.*` could close.

### Priority 3 — nested shell (coarse-grained gating) and the worktree-is-not-a-sandbox demonstration

`test/10-nested-shell-and-worktree-sandbox.test.ts`. One admitted "bash"
tool call runs a compound command that (1) commits a file in a scratch
Git working directory, (2) pushes that commit to a local bare Git remote
over `ssh://`, using `GIT_SSH` pointed at a tiny local shim that ignores
the "host" argument and runs the remote command with a local shell
instead of opening a real network connection (a standard technique for
exercising git's ssh transport with zero real network egress — verified
standalone first: piping the shim's exact commands through plain
`execSync`, outside OpenCode entirely, produced the identical
`git log`-visible commit in the bare repo), (3) makes one HTTP GET to a
local marker server bound to `127.0.0.1` (loopback only), and (4) `cat`s
a marker file placed **outside** both the OpenCode-managed `projectDir`
and this repository's own git worktree. Observed:

- Exactly **one** `admit()` decision and **one** dispatch covered the
  ENTIRE compound command — `AdmissionLedger#admit`/`#dispatch` has no
  visibility into what a "bash" tool call actually runs once dispatched.
- All three sub-actions demonstrably occurred, each confirmed by an
  engine-external witness independent of anything OpenCode or the ledger
  reports: `git log --oneline refs/heads/main` in the bare repo showed
  the pushed commit; the local HTTP marker server's own hit counter went
  from 0 to 1; the outside-the-worktree marker file's sentinel content
  appeared verbatim in the session's tool-result messages.

**"Gated only coarsely" is the exact, literal finding for this path**:
the admission boundary sits at the granularity of "one bash tool call,"
never at the granularity of "one git push," "one network request," or
"one file read." There is no mechanism in this bridge, or in the
`tool.execute.before`/`.after` hook surface it uses, to see or deny
anything below the whole shell invocation.

**Worktree is not a sandbox — stated plainly**: from the shell tool, a
single admitted bash call read and returned the content of a marker file
located outside both the OpenCode-managed project directory and this
repository's own git worktree. This is exactly
`docs/agent-execution.md`'s "Coding deliverables" statement ("Git
worktrees separate working files and branches, but do not restrict
access to other files, credentials, or the network... must not be
described as a complete filesystem or network sandbox"), demonstrated
concretely for OpenCode specifically rather than only cited.

**A native permission gate this fixture had to discover and route
around** (recorded here because it is itself a finding, not just
development friction): with no `permission` config at all — the same
posture every #20 test and `test/00`–`09` here already use successfully
— a `cat` of a path outside the project directory, or a shell command
running `curl`, was observed to make `session.prompt()` **hang
indefinitely**, confirmed reproducible across multiple isolated retries
and root-caused via `Config.permission.external_directory` defaulting to
`"ask"` on this pinned build with nothing ever replying to the resulting
native pending request (indistinguishable from a hang without
instrumentation). This is DIFFERENT from `permission.bash`, which every
other test in this suite (and `docs/evidence/m1/17-opencode-questions.md`)
already established defaults to allow when unconfigured. Setting
`extraConfig: { permission: { bash: "allow", external_directory: "allow" } }`
resolved it immediately (prompt round-trip time returned to ~1.2s). This
fixture's own admission gate (the bridge under test) is entirely
independent of this native config, exactly as the priority-1 finding
above establishes — this native gate is a SEPARATE, additional
engine-level control surface, orthogonal to ticketIt's own admission
bridge, and not something this bridge's hook needs to (or can) account
for to keep functioning.

### Priority 4 — the remaining built-in tools, enumerated live

`test/11-built-in-tools-sweep.test.ts`. Live enumeration against a
running managed instance of this exact pinned build:
`client.tool.ids()` returns 14 ids —
`["invalid","question","bash","read","glob","grep","edit","write","task",
"webfetch","todowrite","websearch","skill","apply_patch"]` (matches
`docs/evidence/m1/17-opencode-questions.md`'s prior probe exactly).
`client.tool.list({query:{provider:"stub",model:"stub-model"}})` — the
set actually OFFERED to this experiment's generic OpenAI-compatible stub
provider/model — returns only **12** of those: `websearch` and
`apply_patch` are excluded (see "provider-executed tools" below).
`"invalid"` is the engine's own internal placeholder tool id for "the
model called something unregistered" (own schema `{tool, error}`), not a
real action path.

With `startAdmittedOpenCode({ gateAllTools: true })` (this slice's
extension: every tool call is gated, using each tool's own id as the
ledger `action`, instead of only the single configured tool id) and
**zero grants**, one scripted assistant turn issued one parallel tool
call per swept id (`bash`, `read`, `glob`, `grep`, `edit`, `write`,
`task`, `webfetch`, `todowrite`, `skill`, `question`). Observed:

- **Every single one** produced its own `admit()` decision, correlated
  by `action` = the tool's own id, and every one was denied
  (`reason: "no-grant"`). Zero dispatches.
- Side-effect witnesses independent of the ledger: the bash sub-call's
  marker file was never created; `write`'s target file was never
  created; `edit`'s target file's content was byte-for-byte unchanged
  from before the (denied) call. (`task`, `read`, `glob`, `grep`,
  `webfetch`, `todowrite`, `skill`, `question` have no comparably
  simple independent side-effect witness beyond "the real
  implementation never ran," which the denial-before-dispatch mechanism
  — proven for `bash` throughout this whole suite — establishes
  structurally: `tool.execute.before` throwing happens strictly before
  ANY tool's own `execute()`, built-in or otherwise, per this pinned
  build's own hook contract quoted in `src/plugin/admission-plugin.ts`'s
  module comment.)
- Every denial was surfaced to the model/session (the same
  scenario-1-established behavior: a hook denial is a normal tool
  error, not a fatal engine error), and the session continued to the
  scripted follow-up turn.

**This demonstrates the hook mechanism itself has no built-in-tool blind
spot: every listed built-in tool id CAN be gated by the exact same
`tool.execute.before` hook this bridge already uses for "bash," with no
new mechanism.** The caveat that matters for D1 is a *configuration*
fact, not an architectural one: **#20's shipped bridge, unextended,
gates ONLY the single tool id named in its `action` option (default
`"bash"`) — every other built-in tool is completely UNGATED under that
default.** Achieving the coverage this test demonstrates in a real
deployment requires actually configuring `gateAllTools` (or an
equivalent explicit per-tool gate list) rather than relying on the
single-action default #20 shipped. This is recorded as an outstanding
configuration requirement for whichever milestone wires a production
OpenCode adapter (M7/M8), not a failed gate — the mechanism is proven
sufficient; today's default configuration is simply narrower than "every
enabled path."

### Priority 4b — provider-executed tools ("not applicable" per this issue's own instruction)

Same test. `websearch` and `apply_patch` are registered tool ids
(present in `tool.ids()`) but are **not** offered to this generic
OpenAI-compatible stub provider/model (absent from `tool.list()`),
asserted directly in `test/11-built-in-tools-sweep.test.ts`. This is
consistent with both being provider-native capabilities (a built-in
"web search" tool and a provider-specific patch-format edit tool,
respectively) that a generic OpenAI-compatible stub does not advertise
support for. **Recorded as not applicable**, per this issue's own
instruction ("Provider-executed tools, if the provider configuration
supports them; otherwise record not applicable") and per
`experiments/README.md`'s prohibition on calling real providers or
selecting a model/provider (open decision D7) — this experiment cannot
and must not exercise a real provider's actual tool-execution path to
determine whether either tool would be gated when genuinely
provider-executed. That remains open, owned by M7/M8's real-adapter
verification (see "Outstanding checks").

### Priority 5 — custom plugin-registered tool and local stdio MCP tool

`test/12-custom-tool-and-mcp-tool.test.ts` (two tests).

**Custom plugin-registered tool: fully gated, both denied and allowed.**
`startAdmittedOpenCode({ customTool: { name, markerFile } })` (this
slice's extension) has the same admission plugin ALSO return a `tool`
hook (`Hooks["tool"]`, confirmed in
`node_modules/@opencode-ai/plugin/dist/index.d.ts`) registering one tool
via `@opencode-ai/plugin`'s own `tool()` helper. With zero grants, the
custom tool was denied (`reason: "no-grant"`, marker file never
created); with a matching grant, it executed exactly once (marker file
content `"custom-executed\n"`). Dispatched through the identical
`tool.execute.before`/`.after` hook as every built-in tool — no new
mechanism needed.

**Local stdio MCP tool: a documented negative result, not a passing gate
proof.** `test/fixtures/local-mcp-server.mjs` is a minimal,
dependency-free MCP stdio server (newline-delimited JSON-RPC 2.0)
registering one tool, `mcp_marker_tool`. Verified correct in complete
isolation first: piping the exact `initialize` →
`notifications/initialized` → `tools/list` → `tools/call` sequence into
it directly (no OpenCode involved) produced the correct handshake
responses and the expected marker-file append. Wired into a real managed
OpenCode instance via `extraConfig: { mcp: { <name>: { type: "local",
command: [...], environment: {...} } } }`:

- `client.mcp.status()` reports the server `"connected"`.
- This fixture's own wire log (`MCP_DEBUG_LOG_FILE`) shows OpenCode's
  client correctly sending `initialize` (requesting protocol version
  `"2025-11-25"` on this pinned build — newer than the `"2024-11-05"`
  baseline this fixture originally hardcoded before this was diagnosed)
  and `tools/list`, and this fixture correctly answering both, INCLUDING
  after being fixed to echo back the client's own requested protocol
  version (ruling out a version-mismatch explanation for what follows).
- Despite this, the tool **never becomes dispatchable**:
  `client.tool.ids()`/`.tool.list()` never list `mcp_marker_tool`, and a
  scripted tool call using that exact declared name is recorded by the
  ledger as **no admit() call at all** for that action — the engine
  classifies the call as its own `"invalid"` placeholder tool id
  instead of ever routing it to `tool.execute.before` under the MCP
  tool's own name. The marker file is never created.

**This is recorded as an observed integration limitation of this pinned
build's local-stdio-MCP wiring (or of some additional protocol
requirement beyond `initialize`/`tools/list` this investigation did not
uncover), not a finding about the admission bridge one way or the
other** — a tool that never becomes dispatchable at all cannot be used
to test whether admission covers it. It is a real, reproducible risk
surface flagged for D1 rather than silently assumed either safe (never
executes, so nothing to gate) or unsafe (a hidden execution path this
investigation missed): if a future pinned version, or some undiscovered
additional MCP protocol step, makes this dispatchable, its coverage by
this bridge's hook needs re-verification before relying on any coverage
claim for MCP tool paths.

### Priority 6 — real-provider evidence

See "Real-provider evidence" below: none executed. The `websearch`/
`apply_patch` provider-tool-list exclusion above (priority 4b) is the
only observation this slice can make about provider-executed tools
without violating `experiments/README.md`'s no-real-provider rule.

## Real-provider evidence (observed, or "none executed")

None executed. Every completions request in this experiment went to a
local `StubModelServer` on `127.0.0.1`; no API key for a real provider
exists anywhere in this repository or its isolated environments. The
only network activity beyond loopback during this slice's own test runs
was `npm ci`/`npm view` against the public npm registry during
dependency installation, per `experiments/README.md`. (The one apparent
exception investigated during development — see "Observed limitations"
below — turned out to be an artifact of a native `external_directory`
permission hang unrelated to this rule, not real provider traffic from
any test's actual assertions; no test in the committed suite makes or
depends on non-loopback network access.)

## Observed limitations

- **The full action-path coverage this matrix demonstrates requires
  configuration, not just capability.** `gateAllTools` proves every
  built-in tool, a custom plugin tool, and (in principle, pending the MCP
  finding above) an MCP tool can all be gated by the same hook — but
  #20's shipped default (`action: "bash"` only) gates nothing else. A
  real deployment must explicitly configure full coverage.
- **Model-only continuation is an unclosable gap at this hook position**
  (priority 2). No plugin hook change within `tool.execute.*` can close
  it; closing it, if required, needs a different integration point
  entirely (see "Decision impacts" below for candidate mechanisms,
  proposed only, never decided here).
- **Nested-shell sub-actions are invisible below the whole tool call**
  (priority 3). Git, SSH-transport, and raw network operations executed
  from inside one admitted "bash" call are completely opaque to the
  ledger; only the single outer admission is observable.
- **A previously-undiscovered native permission gate**
  (`permission.external_directory`, defaulting to `"ask"` on this pinned
  build) can silently hang a caller that does not expect it, for ANY
  path outside the project directory or (empirically) for `curl`
  specifically. Neither `docs/evidence/m1/17-opencode-questions.md` nor
  `docs/evidence/m1/19-opencode-fixed-inputs.md` exercised this — not an
  error in either of those slices, since neither tested a cross-directory
  read or a network-touching shell command, but a gap in this
  repository's cumulative permission-surface knowledge until now. A
  production OpenCode adapter needs an explicit, deliberate policy for
  this setting (allow, with ticketIt's own bridge as the real gate; or
  ask, with an adapter-side auto-reply/timeout so a real Round does not
  hang forever waiting on a prompt no one will ever answer), not silent
  reliance on whatever this pinned build's default happens to be.
- **The local stdio MCP tool path could not be evaluated for gating**
  (priority 5) — see above. This is a genuine unresolved risk, not a
  weakened requirement: the requirement (prove or disprove coverage) was
  not achievable within this slice's connection-layer investigation, and
  is recorded as such rather than assumed either way.
- **`websearch`/`apply_patch` (provider-executed tools) are recorded "not
  applicable"** for the reason given above (priority 4b) — this
  experiment's workspace rules (no real providers, no model/provider
  selection, D7) make it structurally unable to test a real provider's
  actual tool-execution path.
- **This slice added `--test-timeout=60000` to `npm test`** (this
  package's `package.json`) after a genuine, reproducible hang
  (root-caused to the native `external_directory` permission finding
  above) consumed significant investigation time with no visible
  progress or error. This is a durable improvement to this package, not
  scoped only to this slice's own new tests: every existing #20 test
  still completes in well under this bound (~5–15s each).
- **The custom-tool and gate-all-tools extensions in
  `src/plugin/admission-plugin.ts`/`src/admitted-opencode.ts` are both
  purely additive and OFF by default** (`gateAllTools` defaults to
  `false`; `customTool` defaults to unset) — every one of #20's original
  8 tests passes completely unchanged against the extended plugin,
  confirming no regression to the shipped single-action bridge.
- **Parallel/concurrent dispatch ordering** for the built-in-tools sweep
  was not separately re-verified for true wall-clock concurrency (same
  caveat `docs/evidence/m1/20-opencode-admission.md` already recorded
  for its own parallel-requests scenario) — only that every swept id
  produced its own decision, correlated correctly by `action`.

## Outstanding checks and owning milestone

- **Closing the model-only-continuation gap**, if a decision is made
  that it must be closed, is explicitly out of this experiment's scope
  to decide or implement — routed to D1 below, with candidate mechanisms
  proposed only, and to **M8** (live coding gate,
  [#9](https://github.com/cristoforows/ticketIt/issues/9)) as the
  milestone that would implement any such mechanism.
- **Closing the nested-shell coarse-granularity gap**, if required, is
  the same: proposed candidate mechanisms only, decision and
  implementation routed to D1 and **M8**.
- **A deliberate policy for `permission.external_directory`** (and any
  other native permission action beyond `bash` this investigation did
  not separately sweep, e.g. `edit`, `doom_loop`) for a production
  OpenCode adapter — routed to **M7/M8** (`docs/implementation-plan.md`).
- **Re-verifying local stdio MCP tool dispatchability** against a future
  pinned OpenCode version, or with a more thorough MCP handshake this
  investigation did not uncover, before relying on any coverage claim
  for that path — routed to whichever milestone next upgrades the pinned
  `opencode-ai` version (M7/M8) or to a dedicated follow-up if MCP tool
  support becomes a real product requirement.
- **Provider-executed tools under a real provider** — routed to **M7**
  (native model, [#8](https://github.com/cristoforows/ticketIt/issues/8))
  and **M8** (OpenCode provider/model,
  [#9](https://github.com/cristoforows/ticketIt/issues/9)), per open
  decision **D7** (runtime/provider selections), which this experiment
  must not pre-empt.
- **Live enforcement against a real Galley/Michelin boundary** (this
  experiment's ledger and HTTP facade remain a bounded local substitute)
  — owned by **M4–M6** and verified for real in **M7/M8**, unchanged from
  `docs/evidence/m1/20-opencode-admission.md`.
- The gate-report slice
  ([#29](https://github.com/cristoforows/ticketIt/issues/29)) owns
  reconciling `docs/evidence/m1/README.md`,
  `docs/integration-feasibility.md`, and `docs/open-decisions.md` against
  this and every other M1 evidence file.

## Coverage matrix

Ledger posture for every row: **zero grants (deny everything)**, unless
otherwise noted. "Gated by hook" = this bridge's `tool.execute.before`
admission check runs and is the operative control. "Gated only
coarsely" = a hook decision exists but cannot see or control anything
below the whole tool call it wraps. "Not gated" = no code path in this
bridge's hook ever runs for this action at all.

| # | Action path | Gated by hook | Gated only coarsely | Not gated | Observed evidence | Required by v1 spec (D1) | Gate status |
| - | --- | --- | --- | --- | --- | --- | --- |
| 1 | Built-in `bash` tool (single-action default config, `action:"bash"`) | Yes | — | — | 00-baseline + every #20 scenario test; 0 exec while denied, exactly N execs while allowed, every time | Yes | **PASS** |
| 2 | Ambient `OPENCODE_PERMISSION` env var vs. this bridge's hook, for the gated tool | Yes (hook independent of native `permission` entirely) | — | — | `08-ambient-permission-vs-hook`: native "ask" silently bypassed (per #19); this bridge's hook still denied (zero grants), marker stayed empty | Yes — this is D1's central question for this slice | **PASS** |
| 3 | OpenCode's own "always" permission memory (native), vs. this bridge's hook | Yes (re-confirmed from #20) | — | — | `07-always-grant-hook-still-runs.test.ts` (unchanged from #20): hook still ran and denied after revocation despite engine memory bypassing its own prompt | Yes | **PASS** |
| 4 | Model-only continuation (assistant text, no tool call) | — | — | Yes | `09-model-only-continuation`: 0 `admit()` calls across 3 prompts, ledger fully disconnected throughout | Yes (D1: "Registered-tool hooks may not cover model-only continuation") | **FAILED GATE** (structural; see Decision impacts) |
| 5 | Nested shell sub-actions (git commit; git push over fake-SSH transport; loopback HTTP request) inside one admitted "bash" call | Yes, at the whole-call level | Yes, below the whole call | — | `10-nested-shell...`: exactly 1 admit()/dispatch covers all 3 sub-actions; each sub-action independently confirmed to have executed (bare-repo git log, HTTP hit count) | Yes (S2: "Explicitly investigate nested shell... boundaries") | **FAILED GATE** for sub-action granularity (whole-call gate itself passes) |
| 6 | Filesystem read outside the OpenCode-managed project directory / this repo's worktree, via "bash" | Yes, at the whole-call level (this bridge); separately, OpenCode's own native `permission.external_directory` defaults to "ask" (engine-level, independent of this bridge) | Yes | — | `10-nested-shell...`: outside-worktree marker content returned verbatim in tool result once admitted (and once the native `external_directory` ask was configured `allow` so the native prompt did not hang the call) | Not required to be sandboxed (`docs/agent-execution.md`: "must not be described as a complete filesystem or network sandbox") | **N/A — demonstration, not a gate failure**; stated plainly: the worktree is not a sandbox |
| 7 | Built-in tools: `read`, `glob`, `grep`, `edit`, `write`, `task`, `webfetch`, `todowrite`, `skill`, `question` — under `gateAllTools: true` | Yes (mechanism proven for every one) | — | — (mechanism); **Yes, not gated under #20's shipped single-action default** | `11-built-in-tools-sweep`: all 10 produced their own denied admit() decision correlated by action; 0 dispatches; side effects absent where independently checkable | Yes (D1: "prove live admission for every enabled path") | **PASS (mechanism, when configured)** / **FAILED GATE today** under the shipped single-action default — see Decision impacts |
| 8 | `websearch`, `apply_patch` (provider-executed / provider-specific tools) | Unverified | Unverified | Unverified | `11-built-in-tools-sweep`: both registered (`tool.ids()`) but not offered to the generic stub provider/model (`tool.list()`) | Unknown — depends on D7's eventual provider/model choice | **NOT APPLICABLE** (no real provider in scope; see D7) |
| 9 | Custom plugin-registered tool | Yes | — | — | `12-custom-tool-and-mcp-tool` (test 1): denied with zero grants (marker absent), executed once granted (marker `"custom-executed\n"`) | Yes | **PASS** |
| 10 | Local stdio MCP tool | Unverified (never dispatchable) | — | Unverified | `12-custom-tool-and-mcp-tool` (test 2): MCP connection reports "connected," `tools/list` handshake correct, but the tool never appears in `tool.ids()`/`.list()` and a call under its own name is classified `"invalid"` by the engine, never reaching this bridge's hook | Yes, if the path is ever real | **NOT EVALUATED** (engine-level integration limitation; routed to D1 as an open risk, not assumed safe) |
| 11 | Provider-executed tools under a REAL provider (native tool execution, not routed through OpenCode's own tool dispatch) | Unverified | Unverified | Unverified | None executed — no real provider in scope, per `experiments/README.md` and D7 | Unknown | **NOT APPLICABLE** (none executed; routed to M7/M8) |

## Decision impacts (open-decision IDs)

- **D1** (Enforceable OpenCode action boundary and disconnect behavior) —
  the central decision this whole slice serves. Summary against D1's own
  language ("Prove live admission for every enabled path. Registered-tool
  hooks may not cover model-only continuation, shell internals, provider
  tools, or direct APIs... If required behavior cannot be gated, choose
  an integration change or obtain an explicit requirement decision."):
  - **Positive, load-bearing result reconfirmed and extended**: the
    plugin hook's independence from OpenCode's own permission system is
    now shown against BOTH of its known bypass vectors — permission
    *memory* ("always", #20) and permission *ambient configuration*
    (`OPENCODE_PERMISSION`, this slice). Every built-in tool, plus at
    least one custom plugin-registered tool, CAN be gated by the exact
    same hook with no new mechanism, once the bridge is configured to do
    so (`gateAllTools` or equivalent).
  - **Failed gate — model-only continuation** (row 4): structurally
    unclosable at the `tool.execute.*` hook position. Per D1's own
    instruction, this is recorded as a failed gate with **candidate
    mechanisms proposed only, not decided**: (a) abort or pause the
    OpenCode session/process on ledger disconnect or Stop, so a model
    cannot keep producing (and the owner cannot be shown) output past
    the point authority was withdrawn, even though no *tool* action is
    involved; (b) a wrapper/supervisor around the whole OpenCode process
    that enforces a maximum session/turn count or wall-clock budget
    independent of tool calls; (c) route this risk to D8's "reasonable
    technical loop/time limits" framing rather than treating it as a
    pure D1 admission question, since it is really about bounding
    engine activity in general, not about gating a specific action.
  - **Failed gate — nested-shell sub-action granularity** (row 5):
    candidate mechanisms, proposed only: (a) a wrapper shell (a custom
    `bash`-replacement binary on `PATH` inside the isolated OpenCode
    environment) that itself calls back into the ledger per sub-command
    rather than trusting the single outer admission; (b) host-level
    network policy (an egress proxy or firewall rule scoped to the
    isolated OpenCode process) to constrain what a nested network call
    can reach, independent of ticketIt's own admission layer; (c) git
    hooks (e.g. `pre-push`) inside any repository the agent can push to,
    calling back into the ledger before a push is allowed to complete.
    None of these were built, tested, or endorsed here — they are
    proposals for whichever milestone (M8) takes up closing this gap, if
    a decision is made that it must close.
  - **Newly discovered native permission surface** (row 6,
    `permission.external_directory`): not itself a failed gate for THIS
    bridge (the bridge's own hook was never expected to police OS-level
    file access, and `docs/agent-execution.md` already establishes no
    filesystem sandbox is promised), but a genuine addition to this
    repository's cumulative knowledge of engine-level controls a
    production adapter must deliberately configure (see "Observed
    limitations"), alongside `docs/evidence/m1/17-opencode-questions.md`'s
    "always" finding and `docs/evidence/m1/19-opencode-fixed-inputs.md`'s
    two `OPENCODE_PERMISSION`/`OPENCODE_CONFIG` failed gates.
  - **Configuration gap, not a mechanism gap** (row 7): #20's shipped
    bridge gates only "bash" by default; achieving "every enabled path"
    coverage the mechanism itself supports requires a real deployment to
    actually turn on `gateAllTools` (or list every consequential tool
    explicitly) — flagged as an outstanding requirement for whichever
    milestone (M7/M8) configures the production OpenCode adapter, not
    silently left implicit.
  - **Open risk, not resolved** (row 10, MCP tools): recorded as
    "not evaluated" rather than either "safe" or "unsafe" — a future
    change that makes MCP tools dispatchable on a newer pinned version
    must not be assumed to inherit this slice's coverage findings
    without re-verification.
  - This experiment does not resolve D1. It supplies the "prove or fail
    to prove" evidence D1 asks for, across every path this issue's own
    priority ordering named, plus the two engine-level permission
    surfaces (`OPENCODE_PERMISSION`, `external_directory`) discovered
    along the way.
- **D8** (In-flight manual revocation and non-budget execution limits) —
  the model-only-continuation gap (row 4) is arguably as much a D8
  question ("reasonable technical loop/time limits") as a D1 one: once a
  Round's authority is revoked or the runner disconnects, bounding how
  much MORE the model can say/do without any admitted action is a
  loop/time-limit question, not strictly an action-admission question.
  Recorded here as a cross-reference, not a resolution of either
  decision — the candidate mechanisms proposed above for D1 (session
  abort on disconnect, a wrapper/supervisor budget) are equally framed
  as D8 candidates.
