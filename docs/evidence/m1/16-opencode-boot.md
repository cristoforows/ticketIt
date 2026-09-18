# M1.5 — OpenCode boots headless with pinned versions and a scripted model

## Purpose

Prove the startup part of feasibility experiment S1 ("OpenCode lifecycle and
control", `docs/integration-feasibility.md`) for
[M1.5 — OpenCode boots headless with pinned versions and a scripted model
(#16)](https://github.com/cristoforows/ticketIt/issues/16): a pinned
OpenCode executable/SDK pair can be started headless, in an isolated
temporary git worktree, against a local scripted stub model instead of a
real provider; config/data/cache/state isolation actually redirects away
from a fake "real" global config; a Round ID and the OpenCode session ID
are distinct identities (ADR 0002); and shutdown leaves no orphaned
process. This is the reusable harness (`experiments/opencode-harness/`)
that later S1-adjacent slices (#17 questions/permissions, #18
cancellation, #19 fixed inputs) depend on via `file:../opencode-harness`.

## Exact versions

- Node: `v26.9.0` (matches `experiments/.nvmrc` and this package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- `typescript`: `7.0.2` (devDependency, pinned exact)
- `tsx`: `4.23.13` (devDependency, pinned exact)
- `@types/node`: `26.6.1` (devDependency, pinned exact)
- `opencode-ai` (the OpenCode executable npm package, ships a compiled
  per-platform binary — `opencode-darwin-arm64` was selected on this
  machine): `1.18.31`
- `@opencode-ai/sdk` (the OpenCode SDK npm package): `1.18.31`
- Test runner: Node's built-in `node --test`, loaded via
  `node --import tsx --test`, consistent with the rest of this workspace.

### How the executable/SDK pairing was determined

Ran, from `experiments/opencode-harness/` (network access to the public
npm registry, not a model provider — allowed by `experiments/README.md`):

```sh
npm view opencode-ai versions --json
npm view opencode-ai time --json
npm view @opencode-ai/sdk versions --json
npm view @opencode-ai/sdk time --json
npm view @opencode-ai/plugin           # sanity check: same-monorepo package
npm view opencode-ai@1.18.31 --json    # publisher / gitHead / repository fields
npm view @opencode-ai/sdk@1.18.31 --json
```

Findings:

- Both packages' `latest` dist-tag is `1.18.31` at review time (18–19
  September 2026), and both list `1.18.31` as their newest non-prerelease
  version (the `versions` arrays end at `1.18.31`; everything after in
  `npm view ... time` is `0.0.0-dev-*` prerelease churn).
- `npm view ... time --json` gives the exact publish instants:
  `opencode-ai@1.18.31` → `2026-09-14T17:47:43.078Z`;
  `@opencode-ai/sdk@1.18.31` → `2026-09-14T17:47:44.575Z` — 1.497 seconds
  apart.
- Both were published by the same identity, `GitHub Actions
  <npm-oidc-no-reply@github.com>` (`_npmUser`/`publisher` field), i.e. the
  same CI run in the upstream monorepo, not two independently-timed human
  publishes.
- `@opencode-ai/plugin@1.18.31` (a third package from the same monorepo)
  declares `"@opencode-ai/sdk": "1.18.31"` as an exact dependency — the
  monorepo's own packages pin the matching SDK version at that exact
  number, reinforcing that the release is lockstep-versioned across the
  whole monorepo rather than independently numbered per package.
- Neither package's registry metadata exposes a `repository`/`gitHead`
  field (both came back empty), so the pairing could not be
  cross-checked against a specific upstream commit; the version-number
  match plus the sub-2-second joint publish timestamp from the same CI
  publisher is the evidence recorded here. `docs/integration-feasibility.md`
  already flags that "upstream dev/main source can differ from released
  packages," so this pairing is the safest fixed point available from the
  registry alone.

Recorded in `package.json`: `dependencies: { "opencode-ai": "1.18.31",
"@opencode-ai/sdk": "1.18.31" }` — both exact, no ranges.

## Reproducible commands

```sh
cd experiments/opencode-harness
rm -rf node_modules
npm ci
npm run typecheck
npm test
```

No env vars or fixture files need to be supplied externally: the stub
server, the temporary git worktree, the isolated HOME/XDG tree, and the
decoy "real" global config marker are all created by the tests themselves
under `os.tmpdir()`.

One setup note load-bearing for `npm ci`: `opencode-ai` ships a compiled
per-platform binary behind a `postinstall` script
(`node ./postinstall.mjs`, which selects and stages
`opencode-<platform>-<arch>` as `bin/opencode.exe`). npm 11's
install-script allowlist skips unapproved postinstall scripts by default
(`npm warn install-scripts ... not yet covered by allowScripts`), which
would silently leave no `opencode` binary to spawn. This was approved once
with `npm install-scripts approve opencode-ai`, which npm recorded as
`"allowScripts": {"opencode-ai@1.18.31": true}` in `package.json` (now
committed), so `npm ci` runs it on every clean install without further
action.

## Documentation research (unverified)

Read (not executed against) from the pinned packages' own shipped
TypeScript declarations and the compiled CLI's extracted strings, plus the
citations already in `docs/integration-feasibility.md` ("Managed
OpenCode", "Configuration and skills"):

- `@opencode-ai/sdk`'s `dist/server.d.ts`/`dist/server.js`
  (`createOpencodeServer`) spawns the bare command `opencode` via
  `cross-spawn`, resolved through `PATH`, with
  `env: {...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {})}`.
  `ServerOptions` has no field to pass a custom `env`, and the returned
  `{url, close()}` exposes no pid or `ChildProcess`. (Confirmed by
  reading the shipped `.d.ts`/`.js` directly, not the docs site; then
  exercised — see "Fixture/stub evidence" below for how the harness works
  around both gaps.)
- `@opencode-ai/sdk`'s generated `Config`/`ProviderConfig` types
  (`dist/gen/types.gen.d.ts`) document the custom-provider config shape:
  `provider.<id> = { npm, name, options: { baseURL, apiKey, ... },
  models: { <modelId>: {...} } }`, plus `enabled_providers`/
  `disabled_providers` and top-level `model: "<providerId>/<modelId>"`.
  This matches the general shape described in
  `docs/integration-feasibility.md`'s citation of
  [opencode.ai/docs/config/](https://opencode.ai/docs/config/).
- The compiled CLI binary's extracted strings (`strings -a bin/opencode.exe`)
  show the full config-source merge order and every recognized
  `OPENCODE_*`/`XDG_*` env var, including two not mentioned in the public
  docs pages cited by `docs/integration-feasibility.md`:
  `OPENCODE_TEST_HOME` (a dedicated home-directory override, checked
  before falling back to `os.homedir()`) and `OPENCODE_CONFIG_DIR` (an
  explicit override for the resolved global config directory, checked
  before the `XDG_CONFIG_HOME`-derived path). The full merge order
  reconstructed from the strings, later entries overriding earlier ones
  for overlapping keys: global config dir (`config.json`/`opencode.json`/
  `opencode.jsonc`, subject to `OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME`) →
  `OPENCODE_CONFIG` (one extra explicit file) → project config found
  walking up from the working directory (unless
  `OPENCODE_DISABLE_PROJECT_CONFIG`) → `.opencode/` directories found
  walking up (also installs `@opencode-ai/plugin` in the background for
  each such directory) → `OPENCODE_CONFIG_CONTENT` → remote
  "well-known"/managed-org config (requires an authenticated account,
  not exercised here) → `OPENCODE_PERMISSION`. This ordering is
  documentation research in the sense that it was read from decompiled
  source, not from a written spec; the specific claims about
  `OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME` precedence and
  `OPENCODE_CONFIG_CONTENT` were then directly exercised (see below), the
  remote/managed-org steps were not (no account/auth available or wanted,
  per the workspace's no-real-credentials rule).
- `opencode debug config` ("show resolved configuration") and
  `opencode debug paths` ("show global paths (data, config, cache,
  state)") are undocumented-on-the-website CLI subcommands discovered via
  `opencode debug --help`; the SDK exposes the equivalent resolved config
  over HTTP as `client.config.get()`.

## Fixture/stub evidence (observed)

All of the following was actually executed on this machine, not just read.

**Boot test** (`experiments/opencode-harness/test/boot.test.ts`), three
consecutive clean runs (`rm -rf node_modules && npm ci && npm test`, then
two more `npm test` runs), all green:

```
✔ boot: stub -> opencode -> session -> prompt -> scripted reply -> isolation -> clean close (~1.9–2.2s)
✔ config isolation: decoy marker observed only when pointed at, never through the isolated env (~1.0–1.4s)
✔ versions: pinned opencode-ai and @opencode-ai/sdk resolve to the same version, released together (<1ms)
ℹ tests 3, pass 3, fail 0
```

`npm run typecheck` (`tsc -p tsconfig.json --noEmit`) passes with no
errors. `ps aux | grep opencode` after every run above showed no leftover
process.

**Stub receives the exact prompt, scripted reply is visible via the SDK,
Round ID is never sent.** The boot test sends the prompt `"Please greet
the M1.5 boot test, token ROUND-PROMPT-9f31."` through
`client.session.prompt(...)` and asserts: (a) the stub's logged request
body contains that exact string; (b) `client.session.messages(...)`'s
JSON contains the scripted reply text; (c) no request body received by
the stub contains the Round ID generated by `createRoundMapping`. An
ad-hoc capture of one full request (`node --import tsx` running the same
harness code directly, outside `node:test`) recorded, trimmed to the
load-bearing parts:

Request headers to the stub:

```json
{
  "authorization": "Bearer stub-fixture-key",
  "content-type": "application/json",
  "user-agent": "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
  "x-session-affinity": "ses_f4a433f82ffeQEdDiv8qe4I0Xb",
  "x-session-id": "ses_f4a433f82ffeQEdDiv8qe4I0Xb"
}
```

Request body (trimmed — the real body also includes the full built-in
tool schema, ~32KB total):

```json
{
  "model": "stub-model",
  "max_tokens": 32000,
  "messages": [
    { "role": "system", "content": "You are opencode, an interactive CLI tool... You are powered by the model named stub-model. The exact model ID is stub/stub-model ..." },
    { "role": "user", "content": "Please greet the M1.5 boot test, token ROUND-PROMPT-9f31." }
  ],
  "tools": [ "... built-in tool schema, 15+ tools ..." ],
  "tool_choice": "auto",
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

`user-agent` confirms the pinned build (`opencode/1.18.31`) is running on
Bun `1.3.14` internally, using `ai-sdk/provider-utils@4.0.23`. Note
`x-session-id`/`x-session-affinity` carry the *OpenCode* session id, never
the Round ID — the same separation the test asserts on the body. Requests
are streaming SSE by default (`"stream": true`); `StubModelServer`
correctly serves both branches, but only the streaming branch was
observed in this scenario. `/v1/models` was implemented in the stub but
was **not** observed to be called — OpenCode did not query it when the
model was statically declared in the custom provider's config.

**Round ID vs. OpenCode session ID are distinct (ADR 0002).** One capture:
`roundId: "c0e012b5-edee-4fa1-9f92-435e22447f3a"`,
`engineExecutionReference: "ses_f4a433f82ffeQEdDiv8qe4I0Xb"` (an OpenCode
session id). `test/boot.test.ts` asserts these are never equal and that
the Round ID never appears in any request the stub received.

**Config isolation, both directions.** `test/config-isolation.test.ts`
runs `opencode debug config` three ways, all via `execFileSync` against
explicit `env`, no server needed:

- Positive control — `HOME` pointed straight at a decoy directory
  containing `~/.config/opencode/opencode.json` with
  `"model": "decoy-provider/decoy-marker-model"`: resolved config's
  `model` field **is** the marker. This proves the marker is live (would
  be picked up if isolation were broken), not an inert unused file.
- Negative control — same decoy `HOME`, but `XDG_CONFIG_HOME` and
  `OPENCODE_CONFIG_DIR` redirected to an isolated temp directory: resolved
  config's `model` is **not** the marker.
- `opencode debug paths` with the full isolation env
  (`HOME`/`OPENCODE_TEST_HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/
  `XDG_CACHE_HOME`/`XDG_STATE_HOME`/`OPENCODE_CONFIG_DIR`/`TMPDIR`, all
  built by `isolatedEnvOverrides`) reports every one of `config`, `data`,
  `cache`, `state` rooted under the isolated temp directory — none under
  the decoy, none under the real machine's `$HOME`. One captured run
  (`opencode debug paths`, isolated env, cold start): completed in `346ms`
  wall time.

  ```
  home    <isolated root>/home
  data    <isolated root>/home/.local/share/opencode
  bin     <isolated root>/home/.cache/opencode/bin
  log     <isolated root>/home/.local/share/opencode/log
  repos   <isolated root>/home/.local/share/opencode/repos
  cache   <isolated root>/home/.cache/opencode
  config  <isolated root>/home/.config/opencode
  state   <isolated root>/home/.local/state/opencode
  tmp     <isolated root>/tmp/opencode
  ```

  Every path, including `tmp`, resolves under the isolated root. `tmp` is
  the one path the pinned CLI derives from `os.tmpdir()` rather than an
  `XDG_*` variable, so it only isolates correctly because
  `isolatedEnvOverrides` also sets `TMPDIR` (POSIX). An earlier
  exploratory probe that set the `XDG_*`/`HOME`/`OPENCODE_CONFIG_DIR`
  variables but not `TMPDIR` showed `tmp` falling back to the real
  machine's `/var/folders/.../T/opencode` instead — which is what led to
  adding `TMPDIR` to `isolatedEnvOverrides` in the first place.

`test/boot.test.ts` additionally proves the same negative-control property
end to end through the real running server (not just the CLI probe): the
same decoy marker/instruction file is planted, the managed OpenCode
process is started with the full isolation env, and after the
prompt/reply round trip the test asserts (a) the stub's request log never
contains the marker model name or the marker instruction file's sentinel
text, and (b) `client.config.get()` (the SDK's live HTTP config query)
returns the stub model, not the marker, and does not mention the marker
instruction file.

**Startup timing.** `createOpencodeServer` resolving (the "opencode
server listening" line observed) took `415ms`, `424ms`, and `496ms` across
three separate boot runs (a fresh temporary git repo, isolated
HOME/XDG/config, and `OPENCODE_DISABLE_MODELS_FETCH=true` each time). The
full `test/boot.test.ts` case, including stub startup, decoy setup,
session create, prompt round trip through the stub, message query, config
isolation checks, close, and the orphan-process check, took `1.9–2.2s`
total across repeated runs.

**Clean shutdown, no orphan.** `ManagedOpenCode.close()` calls the SDK's
own `close()` (which sends the process a kill signal), then awaits the
captured `ChildProcess`'s `'exit'` event (escalating to `SIGKILL` after a
5s grace period), then confirms via `process.kill(pid, 0)` throwing
`ESRCH` that the pid no longer exists, returning
`{ exitCode, signal, orphanCheckError }`. Every boot-test run asserted
`orphanCheckError === null`, and `ps aux | grep opencode` after each run
(and after three repeated `npm test` invocations back to back) showed no
leftover process.

**Network access observed at startup.** With
`OPENCODE_DISABLE_MODELS_FETCH` left at its default (`false`, i.e. fetch
enabled — the harness itself defaults this to `true` for deterministic
tests, see "Observed limitations"), one manual run showed the pinned CLI
fetching the public [models.dev](https://models.dev) catalog and caching
it at `<isolated cache>/opencode/models.json` — `4,696,866` bytes,
starting with a JSON object of third-party model/provider metadata (e.g.
`"subconscious": {"npm":"@ai-sdk/anthropic", "api":"https://api.subconscious.dev/v1", ...}`).
This did not block or measurably slow the session-create/prompt round
trip (it completed while the fetch presumably ran in the background); per
the workspace rules this is public metadata, not a call to a real model
provider, and the request never reached it directly — the harness's
`enabled_providers: ["stub"]` config and the stub's own request log
confirm the *only* HTTP requests reaching a model-provider-shaped endpoint
went to `127.0.0.1` (the stub), never to any real provider. `npm ci`
itself also reaches the public npm registry (package downloads and the
version-pairing `npm view` calls above) — expected and allowed.

## Real-provider evidence (observed, or "none executed")

None executed. No request in this experiment was ever sent to a real
model provider (OpenAI, Anthropic, OpenRouter, etc.); the only completions
traffic observed anywhere was to `StubModelServer` on `127.0.0.1`,
confirmed by `enabled_providers: ["stub"]` in the generated OpenCode
config and by the stub's own request log (asserted empty of any
non-stub-shaped traffic in `test/boot.test.ts`). No API key for a real
provider exists anywhere in this repository or in the isolated
environment; `options.apiKey` sent to OpenCode is the synthetic fixture
string `"stub-fixture-key"`, consumed only by the local stub.

## Observed limitations

- **`ServerOptions` has no way to pass a custom `env`.**
  `createOpencodeServer` always spawns with
  `env: {...process.env, OPENCODE_CONFIG_CONTENT: ...}`. To isolate
  `HOME`/`XDG_*`/`OPENCODE_CONFIG_DIR`/`TMPDIR`/`PATH`, `startManagedOpenCode`
  temporarily mutates its own `process.env` immediately before the call
  and restores the previous values immediately after (in a `finally`).
  This works, and is reasonably contained (a narrow, restored mutation
  around one `await`), but it is a workaround for a real gap in the
  pinned SDK's public API, not something the SDK supports directly.
- **The returned server handle exposes no pid or `ChildProcess`.**
  `{url, close()}` is all `createOpencodeServer` returns; `close()`
  itself only calls `proc.kill()` without confirming exit.
  `startManagedOpenCode` works around this by temporarily patching
  `node:child_process.spawn` for the duration of the `createOpencodeServer`
  call to capture the `ChildProcess` it creates (core-module patching is
  process-wide and process-cache-shared, so `cross-spawn`'s internal
  `require('child_process')` sees the same patched function), then
  restores the original `spawn` immediately after. This is what makes the
  "no orphan" proof possible at all with the current SDK surface.
- **`--port=0` ("OS picks an ephemeral port") was unreliable through this
  path.** Direct manual `spawn()` calls with `--port=0` (a raw absolute
  path to the binary, with an isolated HOME/XDG/state tree) consistently
  produced a real OS-assigned ephemeral port across several runs.
  Separately, calling through `createOpencodeServer` (which spawns the
  bare `opencode` command resolved via `PATH`), and separately, direct
  `--port=0` invocations against an *unmodified* real-`HOME` environment,
  both deterministically came back bound to the fixed port `4096` instead
  of a random one — reproduced identically for the binary's real file
  path, the `node_modules/.bin/opencode` symlink, and the bare `PATH`-resolved
  command. An explicit, specific, non-zero `--port=<N>` was honored
  correctly in every trial, with no observed collisions. The exact
  triggering condition was not fully isolated in the time available (it
  did not depend on symlink-vs-real-path, and inconsistent results were
  seen even holding args identical) — most plausibly some form of
  per-directory/per-state port memory tied to the CLI's `opencode attach
  <url>` reconnect feature, but this is not confirmed. **Workaround
  applied:** `startManagedOpenCode` now finds a free port itself
  (`net.createServer().listen(0, ...)`, read back the assigned port,
  close, then pass that literal number as `--port`) instead of relying on
  the CLI's own `--port=0` behavior. `test/boot.test.ts` asserts the
  managed server's port is never `4096`, so a regression back to the
  unreliable behavior would fail the suite. This is exactly the kind of
  fragile/unsupported-looking behavior `experiments/README.md` and
  `docs/integration-feasibility.md` ask to be recorded rather than
  silently routed around.
- **`@opencode-ai/sdk`'s `exports` map blocks straightforward version
  resolution.** `require.resolve("@opencode-ai/sdk/package.json")` throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED` (no `"./package.json"` entry), and even
  `require.resolve("@opencode-ai/sdk")` (the bare specifier) throws "No
  'exports' main defined" under CJS-style resolution, because `"."` in
  the package's `exports` map only declares an `"import"` condition, not
  `"require"`/`"default"`. `resolveOpencodeSdkVersion()` works around this
  with `import.meta.resolve("@opencode-ai/sdk")` (ESM resolution, which
  does match `"import"`) followed by walking up from that resolved file to
  find `package.json` directly via `fs`, bypassing the exports map
  entirely for that plain filesystem read. `opencode-ai` itself has no
  `exports` map at all, so its version/binary path resolve the simple way
  (`require.resolve("opencode-ai/package.json")`).
- **`opencode-ai`'s postinstall requires an explicit one-time approval**
  under npm 11's install-script allowlist (see "Reproducible commands"
  above); without it, `node_modules/opencode-ai/bin/opencode.exe` never
  gets created and every spawn attempt fails with `ENOENT`. This is now
  recorded in the committed `package.json` (`"allowScripts"`), so `npm
  ci` alone is sufficient going forward — but it is a real one-time
  environment-dependent step worth flagging, since `experiments/shared`
  and `experiments/_template` (M1.3, issue #14) never needed it.
- **Temporary directories are not deleted by `close()`.** Each
  `startManagedOpenCode()` call creates a fresh `mkdtempSync` root (project
  git repo + isolated home/config/data/cache/state/tmp) and never removes
  it, by design — useful for post-mortem inspection of a failed run — but
  it means repeated local runs accumulate directories under
  `os.tmpdir()` (observed: several MB to, in one case, ~160MB per run,
  the latter likely from `.cache/opencode/bin` or similar staged content;
  not investigated further). Callers that run this in a loop (future
  slices, CI) should clean up the returned `isolatedPaths.root` themselves
  after `close()`.
- **The pinned CLI's `tmp` path is not `XDG_*`-controlled**, unlike
  `config`/`data`/`cache`/`state` — it comes from
  `path.join(os.tmpdir(), "opencode")`, so isolating it needed adding
  `TMPDIR` (POSIX) to `isolatedEnvOverrides` specifically; this is not a
  remaining gap (confirmed isolated in the `debug paths` output above),
  but it is a real divergence from the other four paths' env-var
  convention worth flagging for anyone extending this harness.
- **Models.dev fetch, if left enabled, is unauthenticated/unbounded from
  this experiment's point of view** — no mechanism was checked here to
  cap its size, retry behavior, or failure handling if the network is
  unavailable; `OPENCODE_DISABLE_MODELS_FETCH=true` (the harness default)
  sidesteps this rather than characterizing it further, which is
  sufficient for M1.5's scope but not a general answer about that
  behavior.
- The remote "well-known"/managed-org config-merge steps read from the
  decompiled source (see "Documentation research") were not exercised —
  they require an authenticated OpenCode account, which is out of scope
  here (no real credentials).

## Outstanding checks and owning milestone

- Emitting a question, a permission request, and a tool call from the
  stub, and replying through the SDK — routed to
  [#17](https://github.com/cristoforows/ticketIt/issues/17).
- Abort/cancel of blocked or running work, and observed process/tool
  state before reporting Stopped — routed to
  [#18](https://github.com/cristoforows/ticketIt/issues/18).
- Fixed inputs (settings/skill/recipe versions staying pinned across a
  pause/resume, conflicting ambient config) and durable human input —
  routed to [#19](https://github.com/cristoforows/ticketIt/issues/19).
- Drop/reconnect event recovery without duplicates, and killing the
  execution process outright (distinct from a clean `close()`) to check
  Interrupted/Blocked semantics — remaining S1 scope, not covered by this
  slice; owned by the same S1-adjacent M1 issues above plus the M5
  stranded-runner/reconciliation work (D5).
- Live permission/disconnect admission (S2), OpenRouter payload fidelity
  (S4), and GitHub delivery/identity (S5) are unrelated separate M1
  experiments, not covered here.
- The gate-report slice
  ([#29](https://github.com/cristoforows/ticketIt/issues/29)) owns
  reconciling `docs/evidence/m1/README.md`,
  `docs/integration-feasibility.md`, and `docs/open-decisions.md` against
  this and other M1 evidence.

## Decision impacts (open-decision IDs)

- **D1** (Enforceable OpenCode action boundary and disconnect behavior):
  this slice only proves managed *startup* against a stub — it does not
  exercise tool interception, permission hooks, or disconnect admission
  at all (those are S1's later scope, #17/#18, and S2). It does show that
  the harness's own process lifecycle (spawn, capture pid, verify actual
  exit) is controllable and observable from outside OpenCode, which D1's
  eventual admission-control mechanism will need to build on, but it does
  not itself prove or disprove any tool-boundary enforcement.
- **D7** (Runtime/provider selections): this experiment selects no object
  storage, hosting, native OpenCode model, or provider, per
  `experiments/README.md` and `docs/open-decisions.md`. The `stub`
  provider configured here is a fixture — a local, synthetic
  OpenAI-compatible endpoint used only to prove the harness mechanics —
  and must not be read as validating or leaning toward any real provider
  or model choice. It does, incidentally, confirm that OpenCode's
  "custom OpenAI-compatible provider" config path (`provider.<id>.npm =
  "@ai-sdk/openai-compatible"`) works end to end on the pinned version,
  which is relevant *mechanism* evidence for D7 without resolving D7
  itself.
