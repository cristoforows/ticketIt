# M1.8 — OpenCode effective fixed inputs across pause and ambient config

## Purpose

Prove the OpenCode half of feasibility experiment S3 ("Fixed inputs and
durable human input", `docs/integration-feasibility.md`) for
[M1.8 — OpenCode effective fixed inputs across pause and ambient config
(#19)](https://github.com/cristoforows/ticketIt/issues/19): a Round's fixed
inputs (Agent instructions, one Skill at version A, one Recipe at version A
supplied as Ticket context) must still be what the engine actually consumes
after the Round pauses for input, even while the shared library is
republished to version B and conflicting ambient configuration is planted
into every discovery source the pinned build supports; a brand-new Round
started afterward must observe version B. Per
`docs/integration-feasibility.md`'s "Interpretation for ticketIt": "Saving a
configuration snapshot is insufficient unless the engine actually uses the
fixed content rather than rereading mutable ambient files" — this record's
ground truth is the stub model's own request log, not a saved snapshot file.

This extends `experiments/opencode-harness/` (built for
[M1.5 #16](https://github.com/cristoforows/ticketIt/issues/16), extended for
[M1.6 #17](https://github.com/cristoforows/ticketIt/issues/17)) through a new,
separate package, `experiments/opencode-fixed-inputs/`, depending on it via
`"opencode-harness": "file:../opencode-harness"`. Per this issue's
instructions (two other slices, #18 and #20, concurrently modify
`opencode-harness` itself), this package does not modify any file under
`experiments/opencode-harness/`.

## Exact versions

Identical to `docs/evidence/m1/16-opencode-boot.md` and
`docs/evidence/m1/17-opencode-questions.md` (same pinned engine/SDK, same
Node/npm/toolchain; nothing re-pinned for this slice):

- Node: `v26.9.0` (matches `experiments/.nvmrc` and this package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- `typescript`: `7.0.2`, `tsx`: `4.23.13`, `@types/node`: `26.6.1`
  (devDependencies, exact)
- `opencode-ai` (executable) and `@opencode-ai/sdk` (SDK): `1.18.31` each,
  released together — see `16-opencode-boot.md` for the version-pairing
  rationale; unchanged here.
- `opencode-harness`: `0.1.0`, consumed via `file:../opencode-harness`
  (unmodified by this slice).
- Test runner: `node --import tsx --test`.

## Reproducible commands

```sh
cd experiments/opencode-fixed-inputs
rm -rf node_modules
npm ci
npm run typecheck
npm test
```

No env vars or fixture files need to be supplied externally: the stub
server, the "library" directory, the isolated HOME/XDG tree, and every
decoy are created by the tests themselves under `os.tmpdir()`. The two
ambient-environment tests set and always restore (in a `finally`)
`process.env.OPENCODE_CONFIG`/`process.env.OPENCODE_PERMISSION` for the
duration of a single `startManagedOpenCode` call each.

Verified three consecutive full `npm test` runs green (3/3), including one
immediately after a clean `rm -rf node_modules && npm ci`. `ps aux | grep
opencode` after every run showed no leftover process.

### A note on this package's own `.npmrc`

`experiments/opencode-fixed-inputs/.npmrc` sets `install-links=true`. npm's
default for a local `"file:"` dependency is a symlink into the target
directory; because Node resolves a symlinked module's own imports from its
*real* path, `opencode-harness`'s `import ... from "@opencode-ai/sdk"`
resolved (with the default symlink behavior) by walking up from
`experiments/opencode-harness/` itself — which this slice must never write
into (two concurrent slices, #18 and #20, install into that shared
package's own `node_modules`). `install-links=true` makes npm copy
`opencode-harness` into this package's own `node_modules/opencode-harness`
instead (a plain, read-only-from-the-source-directory copy, like `npm
pack`), so resolution climbs into this package's own `node_modules` (which
already has `@opencode-ai/sdk`/`opencode-ai` as this package's own direct
dependencies, pinned to the same exact version) and `npm ci`/`npm install`
never write into `experiments/opencode-harness/` at all. Verified: `ls -la
node_modules/opencode-harness` is a regular directory, not a symlink, both
after `npm install --install-links` and after a clean `npm ci` (which reads
this same `.npmrc`).

## Documentation research (unverified)

Read from the pinned `opencode-ai@1.18.31` executable's own compiled
strings (`strings -a node_modules/opencode-ai/bin/opencode.exe`) and the
pinned `@opencode-ai/sdk@1.18.31` package's shipped TypeScript
declarations — not yet independently executed at the point each claim
below is made; the ones this evidence file's tests actually exercise are
cross-referenced into "Fixture/stub evidence" below.

- **The pinned build ships its own config/skill documentation as a
  built-in skill.** The compiled binary embeds a built-in Skill named
  `customize-opencode` (source noted in the compiled strings as
  `packages/core/src/plugin/skill.ts`; its Markdown body is the config/skill
  reference reproduced below) whose description is "Use ONLY when the user
  is editing or creating opencode's own configuration...". This is
  effectively the pinned build's own internal spec for config and skill
  discovery, more precise than the public docs pages
  `docs/integration-feasibility.md` cites (`opencode.ai/docs/config/`,
  `opencode.ai/docs/skills/`), since it is extracted from the exact pinned
  version rather than whatever the website currently documents. Quoting
  the load-bearing "Where files live" table verbatim:

  | Scope | Path |
  | --- | --- |
  | Project config | `./opencode.json`, `./opencode.jsonc`, or `.opencode/opencode.json` (opencode walks up from the cwd to the worktree root) |
  | Global config | `~/.config/opencode/opencode.json` or `~/.config/opencode/opencode.jsonc` (NOT `~/.opencode/`) |
  | Project agents | `.opencode/agent/<name>.md` or `.opencode/agents/<name>.md` |
  | Global agents | `~/.config/opencode/agent(s)/<name>.md` |
  | Project commands | `.opencode/command/<name>.md` or `.opencode/commands/<name>.md` |
  | Global commands | `~/.config/opencode/command(s)/<name>.md` |
  | Project skills | `.opencode/skill(s)/<name>/SKILL.md` |
  | Global skills | `~/.config/opencode/skill(s)/<name>/SKILL.md` |
  | External skills (auto-loaded) | `~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md` |

  The same embedded skill documents the `opencode.json` schema, including
  `instructions: ["AGENTS.md", "docs/style.md"]` (an array of Markdown
  file paths merged into the system prompt) and `skills: { paths: [...],
  urls: [...] }` (extra skill-scan locations beyond the defaults above),
  and states plainly: **"Config is loaded once when opencode starts and
  is not hot-reloaded... The running session will keep using the
  already-loaded config"** — directly relevant to this issue's premise.
  It also documents these escape-hatch env vars: `OPENCODE_DISABLE_PROJECT_CONFIG`,
  `OPENCODE_CONFIG` (one additional explicit config file),
  `OPENCODE_CONFIG_CONTENT` (final inline-JSON merge — this is the exact
  mechanism `@opencode-ai/sdk`'s `createOpencodeServer` uses to deliver
  `startManagedOpenCode`'s `config`, per `docs/evidence/m1/16-opencode-boot.md`),
  `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_PURE`,
  `OPENCODE_DISABLE_EXTERNAL_SKILLS`/`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`
  ("skip the external skill scans under `~/.claude/` and `~/.agents/`").
- **The exact config-source merge order**, read from the compiled binary's
  `Config.loadInstanceState` function (decompiled/minified source,
  variable names elided by the bundler): global config directory → (if
  present) `OPENCODE_CONFIG` (one extra file; its own scope, "local" vs
  "global", depends on whether its path is under the project directory)
  → (unless `OPENCODE_DISABLE_PROJECT_CONFIG`) project config files found
  walking up from the working directory → each `.opencode`-suffixed
  directory (or `OPENCODE_CONFIG_DIR`) found walking up, each contributing
  its own `opencode.json`/`opencode.jsonc` plus commands/agents/plugins →
  (if present) `OPENCODE_CONFIG_CONTENT` → remote "well-known"/managed-org
  config (requires an authenticated OpenCode Console connection — not
  exercised, no real credentials) → an OS-managed config directory /
  managed preferences file (enterprise/policy-managed — not exercised,
  no such directory exists in an isolated test environment) → finally, if
  present, `OPENCODE_PERMISSION` (parsed as JSON and merged into the
  `permission` key specifically, **after everything else**, including
  `OPENCODE_CONFIG_CONTENT`). This ordering was then directly exercised —
  see "Fixture/stub evidence" for which claims were confirmed, including
  two that behave differently under merge than "later wins" would suggest.
- **The `skill` tool's exact contract**, read from `client.tool.list({query:
  {provider, model}})`'s response for tool id `"skill"` (a live, executed
  probe promoted to "Fixture/stub evidence" below, not merely documentation
  research): parameters `{ name: string }` (required), description "Load a
  specialized skill when the task at hand matches one of the skills listed
  in the system prompt. Use this tool to inject the skill's instructions
  and resources into current conversation... The skill name must match one
  of the skills listed in your system prompt." This is the pinned build's
  native mechanism for reading a Skill on demand, distinct from a plain
  file "read" tool call.
- **The file snapshot/rollback feature is not a configuration snapshot.**
  The pinned SDK's shipped declarations (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`,
  confirmed identically in the `/v2` subpath's own generated types) declare
  a top-level `snapshot?: boolean` config field, a `SnapshotPart` message
  part type (`{ type: "snapshot"; snapshot: string }`), and
  `SessionRevertData`/`SessionUnrevertData` (`POST /session/{id}/revert`,
  `POST /session/{id}/unrevert`, keyed by `messageID`/`partID`) —
  `sdk.gen.d.ts`'s own docstrings: "Revert a message" / "Restore all
  reverted messages". The `/v2` client additionally exposes
  `session.revert.stage()/.clear()/.commit()` (a three-step
  stage/clear/commit revert flow) and event types
  `EventSessionNextRevertStaged/-Cleared/-Committed`. Every one of these is
  scoped to a **session's file-tree changes** (per `SnapshotFileDiff`, an
  array of file diffs attached to a revert), i.e. undoing/restoring edits
  the agent made to the project's working tree during a session — not the
  Agent's instructions, Skill content, Recipe content, model, or
  permission configuration. Nothing in either generated client surface
  connects `session.revert()`/`snapshot` to `config`, `instructions`,
  `skills`, or `permission`. This is documentation research (the revert
  mechanism itself was never invoked in this experiment — reverting file
  edits is out of this issue's scope), but the *type-level* absence of any
  connection to configuration is precise, citable evidence for the
  distinction the issue asks to make explicit, not an inference from
  prose.
- Public docs pages `docs/integration-feasibility.md` already cites
  ([opencode.ai/docs/config/](https://opencode.ai/docs/config/),
  [opencode.ai/docs/skills/](https://opencode.ai/docs/skills/)) were not
  independently re-read for this slice; the embedded built-in skill above
  was treated as the more authoritative, version-matched source and is
  itself pinned-version source, not decompiled guesswork about behavior.

## Fixture/stub evidence (observed)

All of the following was actually executed on this machine via `npm test`
(3/3 passing) plus several ad hoc probe scripts run during development
(not committed, since they duplicate what the committed tests already
assert; noted individually below where they add information the committed
suite does not).

**Materialization.** `src/library.ts` models ticketIt's shared
recipe/skill library (`createLibrary`, `publishLibraryVersion`,
`readLibraryVersion`) as one mutable directory outside any Round's
process, and `materializeRoundInputs(projectDir, library)` copies the
library's *current* version into a fresh Round-private location under a
Round's own isolated `projectDir` once, at Round start:
`AGENT-INSTRUCTIONS.md` (for the `instructions` config field), `.opencode/skill/<name>/SKILL.md`
(an engine-native project Skill location), and `.ticketit/recipe.md` (a
private snapshot; the Recipe's *text* is also returned for the caller to
embed directly into the Round's initial prompt, since OpenCode has no
native "Recipe" concept — see "Observed limitations").

**Round 1: pause survives the library moving to B and every ambient decoy**
(`test/pause-resume-fixed-inputs.test.ts`, passing). Version A is
materialized; the stub is scripted with a `skill` tool call (via this
package's own `scriptSkillToolCall`, see below) followed by a `question`
tool call. Once `listPending` observes the pending question (confirming
the Round paused), the test:

1. Publishes version B to the library.
2. Plants a decoy `opencode.json` (model `decoy-provider/decoy-global-model`,
   `instructions: ["DECOY-GLOBAL-INSTRUCTIONS.md"]`) plus a decoy
   same-named Skill into the Round's own *isolated* global config
   directory (`isolatedPaths.opencodeConfigDir`) — the harness's own fake
   "real" global config location per #16, not the developer's actual
   machine.
3. Plants a decoy `opencode.json` (model `decoy-provider/decoy-project-model`)
   directly inside the Round's own running `projectDir` (a file that did
   not exist when the Round started), plus a brand-new (non-colliding)
   decoy project Skill.
4. Plants decoy same-named Skills into `~/.claude/skills/<name>/SKILL.md`
   and `~/.agents/skills/<name>/SKILL.md` under the Round's isolated
   `homeDir`.
5. Sets `process.env.OPENCODE_PERMISSION` to a decoy value in the *test's
   own* process (restored in a `finally`).
6. Replies to the question and awaits the resumed prompt.

Assertions against the ground truth (every completion request the stub
received across the Round's *entire* lifetime, before and after the
pause) all passed: every request after the skill call carries
`VERSION-A-SKILL-CONTENT-SENTINEL` and never `VERSION-B-...` or any decoy
Skill sentinel; every request carries `AGENT-INSTRUCTIONS-VERSION-A-SENTINEL`
and never the version B or decoy-global/decoy-project instructions
sentinels; the initial prompt request carries `VERSION-A-RECIPE-CONTENT-SENTINEL`
and no request ever carries the B recipe sentinel; no request's `model`
field is ever anything but the Round's real `stub-model`; and
`client.config.get()` queried live after resume still reports the Round's
real model, never either decoy model name. The skill tool's own recorded
`state.output` (from `session.messages()`) was also asserted directly to
contain only the version A body.

**Round 2: a fresh Round observes B** (same test, continued). A second,
independent `startManagedOpenCode()` call (fresh isolated `HOME`/project,
per the harness's existing per-call isolation) materializes from the
library's *current* content (now B), scripts the same skill read, and
asserts the tool's `state.output` contains `VERSION-B-SKILL-CONTENT-SENTINEL`
(never A), the prompt request carries `VERSION-B-RECIPE-CONTENT-SENTINEL`
(never A), and — since Round 2 gets an entirely fresh isolated `HOME`/`projectDir`
— none of Round 1's decoy sentinels (global/project/external skill) ever
appear either, confirming the decoys were pure noise, not a
version-B-adjacent contamination.

**A local `scriptSkillToolCall` helper** (`src/skill-tool.ts`).
`opencode-harness@0.1.0` exports `scriptBashToolCall`/`scriptQuestionToolCall`/`scriptTextTurn`
but no equivalent for the `skill` tool (added for #17, before this skill
mechanism was in scope). Per this issue's instructions not to modify that
package, this is implemented locally as a thin, mechanical peer of the
existing scripters (same `ScriptedTurn` shape, same `nextCallId` pattern);
it would be a reasonable, low-risk candidate to fold into
`opencode-harness/src/scripting.ts` in a later slice.

**Skill-tool schema, confirmed live** (ad hoc probe during development,
not a committed test — the schema itself is exercised implicitly by every
committed test's assertions on `state.output`). `client.tool.ids({})`
against a running managed instance still returns the same 14 ids recorded
in `17-opencode-questions.md` including `"skill"`.
`client.tool.list({query:{provider:"stub", model:"stub-model"}})` for id
`"skill"` returns exactly the parameters/description quoted in
"Documentation research" above. One captured tool-result example
(`state.output` for a scripted call with `{"name":"fixed-inputs-demo"}`
against a Skill whose body was `VERSION-A-SENTINEL-CONTENT`):

```
<skill_content name="fixed-inputs-demo">
# Skill: fixed-inputs-demo

VERSION-A-SENTINEL-CONTENT

Base directory for this skill: <projectDir>/.opencode/skill/fixed-inputs-demo
Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.
Note: file list is sampled.

<skill_files>

</skill_files>
</skill_content>
```

**Skill discovery is scanned lazily, once per process, then cached — not
per session, not per request** (ad hoc probes during development, not
committed tests; this finding shapes the committed tests' design rather
than being asserted by them directly). Observed sequence in one process:
create a project Skill *after* `startManagedOpenCode()` returns but
*before* the first prompt → the Skill's `<name>/<description>/<location>`
descriptor appears in that first request's system prompt. Then, still
within the same running process: plant a same-named decoy in the global
skill directory, `~/.claude/skills/`, and `~/.agents/skills/`, plus an
entirely new (non-colliding) Skill in `~/.claude/skills/` → a second
prompt in the *same* session shows none of them; a third prompt in a
*brand-new session created in the same still-running process* also shows
none of them. This means: (a) the committed tests' mid-pause decoy
planting is representative of the strongest realistic version of this
threat (planting before the *first* real use would matter; planting after
does not, for the lifetime of the process); and (b) **a new ticketIt Round
that must observe new fixed-input versions needs a new OpenCode server
process, not merely a new OpenCode session in an existing process** — this
package's two Rounds are therefore modeled as two separate
`startManagedOpenCode()` calls, not two sessions in one call, and this is
a load-bearing design fact for any future OpenCode adapter, not just a
convenience of this test.

**Skill-tool *content* is cached after first load; `instructions`-file
content is not** (ad hoc probe, not a committed test — an asymmetry
significant enough to record even though the committed tests never rely
on re-reading a Round's own already-materialized files). In one process:
invoke the `skill` tool once, mutate the *same* Round-private `SKILL.md`
file on disk, invoke the `skill` tool again in the same session → both
calls' `state.output` show the *original* content. Separately: send a
prompt with `instructions: ["AGENT-INSTRUCTIONS.md"]` configured, mutate
the *same* Round-private instructions file on disk, send a second prompt
in the same session → the second request's system prompt shows the *new*
content. This means the "config is loaded once, not hot-reloaded" claim
from the pinned build's own documentation (quoted above) is precisely
about the config JSON structure (which paths/fields are configured) and
about Skill bodies (cached at/after first load) — not about the *content*
of each `instructions`-listed file, which is read fresh from disk on
every completion request. Consequently, version-A immutability for
instructions in this experiment is a property of the calling app's
discipline (materializing once per Round and never rewriting that exact
path again), not an engine-enforced snapshot; if a future Round ever
reused another Round's already-open instructions file path, it could
observe a live edit mid-Round. See "Decision impacts" (D9).

**FAILED GATE — `OPENCODE_CONFIG`'s `instructions` array leaks into an
unrelated new Round; its `model` field does not**
(`test/ambient-environment-sources.test.ts`, passing — the test asserts
the observed leak, it does not hide it). An ambient `OPENCODE_CONFIG` env
var (simulating one left over in a shared runner's environment,
unconnected to this Round, never set or cleared by
`startManagedOpenCode`/`isolatedEnvOverrides`) pointing at a decoy file
with its own `model` and `instructions` fields is present *before* a new
Round's process is spawned. Observed: the resolved `model` remains the
Round's real model (later-source-precedence protects a scalar field
correctly, matching the documented merge order). But the resolved (and
actually-sent-to-the-stub) `instructions` array is the **concatenation**
of the decoy file's list and the Round's own list — this pinned build's
config merge does not replace array fields across sources, it appends —
so the decoy's instructions Markdown content (`DECOY-ENV-INSTRUCTIONS-SENTINEL`)
appears verbatim in the request body alongside the Round's own real
instructions. Reproduction: set `process.env.OPENCODE_CONFIG` to a file
declaring `instructions: [<decoy path>]` before calling
`startManagedOpenCode({ extraConfig: { instructions: ["AGENT-INSTRUCTIONS.md"] } })`.

**FAILED GATE — `OPENCODE_PERMISSION` silently overrides a Round's
configured permission** (`test/ambient-environment-sources.test.ts`,
passing — again, asserting the observed leak). An ambient
`OPENCODE_PERMISSION=$'{"bash":"allow"}'` env var, present before a new
Round's process is spawned, while the Round itself explicitly configures
`extraConfig: { permission: { bash: "ask" } }`: the resolved config's
`permission.bash` is `"allow"`, not `"ask"` (`OPENCODE_PERMISSION` merges
in *after* `OPENCODE_CONFIG_CONTENT` in the documented order, confirmed
here executing against a live instance). Behaviorally verified end to
end, mirroring `experiments/opencode-harness/test/permission-round-trip.test.ts`'s
pattern: a scripted `bash` tool call that should have required approval
executed **without any pending permission request ever appearing**
(polled via `listPending` for ~3.75s), and the marker file shows exactly
one execution — the shell command ran directly, silently bypassing the
Round's own permission gate.

**Mid-pause project/global config file writes have zero effect on an
already-running process, full stop** — not merely "the harness's decoy
doesn't win a precedence contest": the resolved config (`client.config.get()`)
is byte-for-byte identical before and after planting either decoy,
confirming the pinned build genuinely never re-reads config after boot
(ad hoc probe during development, subsumed by the committed Round 1 test's
equivalent assertions against live request bodies).

## Real-provider evidence (observed, or "none executed")

None executed. Every completions request in this experiment went to a
local `StubModelServer` on `127.0.0.1` (`enabled_providers: ["stub"]` in
every generated config, asserted empty of any other traffic shape by the
existing `test/boot.test.ts` pattern this package's `stub1`/`stub2` reuse
via `opencode-harness`); no API key for a real provider exists anywhere in
this repository or its isolated environments. The only network access
during `npm ci` is the public npm registry (package downloads), per
`experiments/README.md`.

## Observed limitations

- **Recipe has no OpenCode-native discovery mechanism**, unlike
  Instructions (`instructions` config field) and Skill (`.opencode/skill/`
  convention plus the built-in `skill` tool). This experiment therefore
  models "Recipe... supplied as Ticket context" (this issue's own wording)
  by embedding the Recipe's materialized text directly into the Round's
  initial prompt string — the model receives it because it was sent, not
  because OpenCode discovered or read a file. This is a reasonable,
  explicitly-stated modeling choice for this experiment, not an engine
  capability; a real ticketIt/Galley OpenCode adapter would need to make
  the same choice (or use OpenCode's unrelated `references` config field,
  which advertises directories/repos via `@`-autocomplete rather than
  injecting content — not evaluated here, out of scope).
- **Instructions-file content is read fresh from disk on every completion
  request; it is not cached at process boot the way the config JSON
  structure and Skill bodies are** (see "Fixture/stub evidence" above).
  Version-A immutability across this experiment's pause therefore rests
  on the calling code's discipline (never rewriting an already-materialized
  Round's instructions path), not on an engine-enforced snapshot. This
  experiment's own `materializeRoundInputs` never rewrites a path it has
  already handed to a running Round, so the committed tests are not
  exposed to this, but it is a real, load-bearing fact for any future
  adapter design and is exactly the kind of thing
  `docs/integration-feasibility.md`'s "Saving a configuration snapshot is
  insufficient..." line anticipates.
- **Skill discovery (project/global/external) is scanned lazily once per
  OpenCode server *process* and then cached for that process's whole
  lifetime — not per session, not per request** (see "Fixture/stub
  evidence"). A practical implication beyond this issue's own scope: a
  ticketIt Ticket whose Agent's Skill assignment changes between two
  Rounds needs each Round to get its own OpenCode process (which this
  harness's `startManagedOpenCode()` already does, one call per Round);
  reusing one long-lived OpenCode process across multiple Rounds of the
  same Ticket would NOT pick up a Skill/instructions change between them
  without a restart.
- **This experiment's "fake global config directory" and "ambient skill
  directories" are per-Round-fresh, by construction of
  `startManagedOpenCode()`** (a brand-new `mkdtempSync` root, hence a
  brand-new isolated `HOME`, every call). This proves such a decoy planted
  during Round N's pause cannot leak into Round N *or* into a
  *subsequently-started, independently-isolated* Round N+1 (Round 2 in
  this experiment's own test never sees Round 1's decoys). It does
  **not** prove anything about a deployment where multiple Rounds
  (possibly on the same Ticket, possibly across Tickets) share one
  *persistent* real global-config-equivalent location on a runner host —
  a plausible production arrangement this M1 harness does not model. In
  that arrangement, a stray global-config write during Round N's pause
  *would* be read by the *next* Round's boot (config is read fresh at
  every new process start; it is only "not hot-reloaded" within an
  already-running process). This is a genuine open question for whatever
  production runner topology is chosen, not a hole in this evidence's own
  claims about what it tested — routed to D9 below.
- **`opencode-harness`'s `isolatedEnvOverrides` does not clear
  `OPENCODE_CONFIG` or `OPENCODE_PERMISSION`** (it only sets `HOME`,
  `OPENCODE_TEST_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
  `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `OPENCODE_CONFIG_DIR`, `TMPDIR`, plus
  whatever `extra` the caller passes). Both ambient-leak findings above
  exist because of this gap, not because of anything this package's own
  test setup does wrong. This package cannot close that gap itself without
  editing `experiments/opencode-harness/`, which this issue's instructions
  forbid; a future slice extending that package could add
  `delete process.env.OPENCODE_CONFIG` / `delete process.env.OPENCODE_PERMISSION`
  (or explicit empty overrides) to `isolatedEnvOverrides`'s spawn
  preparation to close this specific leak at the harness level.
- The remote "well-known"/managed-org config-merge step and the OS-managed
  config directory / managed preferences step (both read from decompiled
  source, see "Documentation research") were not exercised — the former
  requires an authenticated OpenCode Console connection, the latter an
  enterprise/OS-policy-managed directory; neither is obtainable under this
  workspace's no-real-credentials rule.
- The defensive escape-hatch env vars (`OPENCODE_DISABLE_PROJECT_CONFIG`,
  `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`,
  `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_PURE`) were read from
  documentation but not exercised: they disable a source rather than
  inject conflicting content, so they are not a leak vector by
  themselves, but a future slice could still verify they behave as
  documented.
- Session.revert()/unrevert() (the file snapshot/rollback feature) was
  never invoked — establishing the type-level distinction from
  configuration (see "Documentation research") did not require exercising
  the revert flow itself, and doing so is unrelated to this issue's scope.

## Discovery-source table

Every configuration and Skill discovery source the pinned build
(`opencode-ai`/`@opencode-ai/sdk` `1.18.31`) supports, per the
"Documentation research" section above, with observed evidence for
whether this harness's isolation holds against a mid-pause or
new-Round-boundary ambient plant. "Isolated" means: a decoy planted here
was observed to have no effect on the running/next Round's effective
inputs. "LEAK (failed gate)" means: it did.

| # | Source | Mechanism | Mid-pause plant result | Boot-time ambient plant result | Status |
| - | --- | --- | --- | --- | --- |
| 1 | Global config directory (`~/.config/opencode/opencode.json[c]`, or `OPENCODE_CONFIG_DIR`-redirected) | File(s) read at process start | No effect (config not hot-reloaded; #16 already isolates the real machine's location via `HOME`/`XDG_CONFIG_HOME`) | n/a (this is the harness's own controlled location, not ambient) | Isolated |
| 2 | Project config (`./opencode.json`, `./opencode.jsonc`, `.opencode/opencode.json`, walked up to worktree root) | File(s) read at process start | No effect (config not hot-reloaded; fresh temp git project per Round) | n/a (fresh project dir per Round; nothing to pre-seed) | Isolated |
| 3 | `.opencode/` project Skill directory (`.opencode/skill(s)/<name>/SKILL.md`) | Lazily scanned once per process, cached | Same-name AND brand-new decoy: not observed in later requests, same session or a new session in the same process | n/a (fresh project dir per Round) | Isolated |
| 4 | Global Skill directory (`~/.config/opencode/skill(s)/<name>/SKILL.md`) | Lazily scanned once per process, cached | Same-name decoy: not observed | n/a (fresh isolated `HOME` per Round) | Isolated |
| 5 | External Skill directories, auto-loaded (`~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`) | Lazily scanned once per process, cached | Same-name AND brand-new decoy: not observed, even in a new session in the same process | n/a (fresh isolated `HOME` per Round) | Isolated |
| 6 | `OPENCODE_CONFIG` (one extra explicit config file) | Env var, read at process start | n/a (env cannot reach an already-running process) | `model` field: not leaked (later-source precedence). `instructions` array: **leaked** (arrays concatenate across sources, not replaced) | **LEAK (failed gate)** for array fields; isolated for scalar fields |
| 7 | `OPENCODE_CONFIG_CONTENT` (final inline-JSON merge) | Env var, read at process start | n/a | Not an independent ambient vector under this harness's usage: unconditionally overwritten by `createOpencodeServer`'s own spawn call (`env: {...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config)}`) | Isolated (by construction of the SDK helper) |
| 8 | `OPENCODE_PERMISSION` (merged into `permission`, after everything else) | Env var, read at process start | n/a | **Leaked**: silently overrides the Round's own configured permission action | **LEAK (failed gate)** |
| 9 | Remote "well-known"/managed-org config (authenticated OpenCode Console connection) | HTTPS fetch at process start | Not exercised | Not exercised | Unverified (no real credentials; documentation research only) |
| 10 | OS-managed config directory / managed preferences | File(s), OS-policy-managed | Not exercised | Not exercised | Unverified (no such directory in an isolated test environment; documentation research only) |
| 11 | Escape-hatch disable flags (`OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_PURE`) | Env vars | Not applicable (they disable a source, not inject content) | Not exercised | Not applicable / unverified |
| 12 | Skill tool content cache (per process) | In-memory, after first `skill` tool load | A mutation to the SAME already-loaded Round-private `SKILL.md` is NOT observed on a second same-session call | n/a | Isolated (stronger than required) |
| 13 | Instructions-file content re-read (per request) | Disk read, every completion request | A mutation to the SAME already-materialized Round-private instructions file IS observed on the next request in the same session | n/a | **Not engine-isolated** — isolation here is an app-discipline property (never rewrite an already-open Round's path), not an engine snapshot; this experiment's own code follows that discipline throughout |
| 14 | Session vs. process granularity for config/Skill re-scan | N/A (a fact about scope, not a source) | A brand-new session in an already-running process does NOT pick up a fixed-input change either — same as a same-session second prompt | n/a | Informational: a new Round needs a new process, not just a new session |
| 15 | File snapshot/rollback (`session.revert()`/`.unrevert()`, `snapshot: boolean` config, `SnapshotPart`) | Git-based file-tree checkpoint per message/step | Not exercised (out of scope) | Not exercised | **Not a configuration snapshot** — type-level evidence only connects it to file-tree diffs, never to `config`/`instructions`/`skills`/`permission` |

## Outstanding checks and owning milestone

- Closing the `OPENCODE_CONFIG`/`OPENCODE_PERMISSION` ambient-leak gaps at
  the harness level (clearing them in `isolatedEnvOverrides`) is not done
  here (would require editing `experiments/opencode-harness/`, forbidden
  by this issue's instructions) — candidate for a future harness-owning
  slice, or for whichever milestone hardens the real OpenCode adapter's
  process-spawn environment (M7/M8).
- Whether a real ticketIt/Galley deployment gives each Round a genuinely
  fresh isolated global-config-equivalent location (as this harness does)
  or shares one persistent location across Rounds/Tickets on a runner host
  — and if shared, what stops a stray write between Rounds from reaching
  the next Round's boot — is an operational/runtime-topology decision not
  yet made; routed to D9 below and to whichever milestone designs the
  production OpenCode runner's directory layout (M7/M8).
- Version and retirement policy for the library's own Skill/Recipe/instructions
  versions (how many past versions ticketIt retains, when a version is
  eligible for cleanup) is explicitly out of this issue's scope per
  `docs/agent-execution.md`'s "Recipe versions" ("Retain the versions used
  by earlier rounds") — routed to D9, owning milestone M6 (recipe/skill
  storage) per `docs/open-decisions.md`.
- Reloading native checkpointed state after an actual process
  death/restart (not just an in-process pause) and reconciling a pending
  question across that restart is explicitly out of this issue's "What to
  build" (it is the general S3 description in
  `docs/integration-feasibility.md`, not this issue's own bullets) —
  covered by native-path work in `experiments/native-durable-input/` and
  by #18's abort/interrupt scope for OpenCode specifically, not repeated
  here.
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
  this slice adds two concrete, reproducible findings that an ambient
  environment variable an unrelated process left behind on a shared
  runner host — never set by ticketIt/Galley itself, and not something
  the current harness clears — can silently change what a Round actually
  sends to the model (`OPENCODE_CONFIG`'s `instructions` array
  concatenating in extra content) and can silently loosen a Round's own
  permission boundary (`OPENCODE_PERMISSION` overriding a configured
  `"ask"` to `"allow"`, confirmed to suppress a real pending-permission
  wait and let a shell command execute directly). Per this issue's
  instructions, both are recorded as failed gates, not weakened or hidden.
  This does not resolve D1; it supplies two more "if required behavior
  cannot be gated, choose an integration change or obtain an explicit
  requirement decision" triggers D1 anticipates, alongside #17's
  once-versus-always finding — a real OpenCode adapter must control (or
  the runner process must guarantee a clean environment for) these two
  specific env vars, not merely rely on this pinned build's directory-based
  config isolation.
- **D9** (Version and workspace retention/cleanup): the same two failed
  gates are also routed here per this issue's explicit instruction ("mark
  it a failed gate routed to D1 and D9"), since both are, at bottom, a
  version/scope-boundary question — an ambient config "version" from
  outside any Round's own history reaching into a Round it has no
  connection to. Separately and non-failing: this slice's finding that
  instructions-file immutability is an app-discipline property rather
  than an engine snapshot (source #13 in the table above), and the open
  question about whether Rounds share one persistent global-config
  location in production (source #1/#4/#5's limitation above), are both
  genuine D9-relevant retention/isolation-boundary questions for whichever
  milestone designs the production runner's directory/version-retention
  layout (M6 recipe/skill storage; M7/M8 adapters) — this experiment
  observes and records them, per `experiments/README.md`, without
  resolving D9 itself.
