# opencode-fixed-inputs

The OpenCode half of feasibility experiment S3 ("Fixed inputs and durable
human input", `docs/integration-feasibility.md`) for
[M1.8 — OpenCode effective fixed inputs across pause and ambient config
(#19)](https://github.com/cristoforows/ticketIt/issues/19). See
[../../docs/evidence/m1/19-opencode-fixed-inputs.md](../../docs/evidence/m1/19-opencode-fixed-inputs.md)
for the full evidence record: exact versions, the discovery-source table,
and request-log excerpts proving version A survives a pause while version
B and every ambient decoy do not leak in (with two documented exceptions,
recorded as failed gates, not hidden).

Depends on [`opencode-harness`](../opencode-harness/) (built for
[#16](https://github.com/cristoforows/ticketIt/issues/16), extended for
[#17](https://github.com/cristoforows/ticketIt/issues/17)) via
`file:../opencode-harness`. Per this issue's instructions, this package
**does not modify** any file under `experiments/opencode-harness/` — two
other slices (#18, #20) depend on and modify that same shared package
concurrently.

## What this is, and is not

This is an M1 adapter proof, not the ticketIt application. It selects no
object storage, hosting, native model, or OpenCode provider/model (open
decision D7): the "stub" provider is a local fixture. It makes no call to
a real model provider — see the evidence file's "Real-provider evidence".

## Public API (`src/index.ts`)

- `createLibrary(root, skillName)` / `publishLibraryVersion(library,
  version)` / `readLibraryVersion(library)` (`src/library.ts`) — a
  stand-in for ticketIt's shared recipe/skill library (CONTEXT.md's
  Recipe/Skill glossary entries): one mutable directory outside any
  Round's own OpenCode process. Publishing a new version here has no
  effect on any Round that already materialized its inputs.
- `materializeRoundInputs(projectDir, library)` — copies the library's
  *current* version into a fresh Round-private location under a Round's
  own isolated `projectDir` (an `AGENT-INSTRUCTIONS.md` for the
  `instructions` config field, a `.opencode/skill/<name>/SKILL.md` project
  Skill, and a private Recipe snapshot), and returns the Recipe's text for
  the caller to embed into the Round's initial prompt as Ticket context
  (OpenCode has no native Recipe concept — see the evidence file's
  "Observed limitations").
- `scriptSkillToolCall({ name })` (`src/skill-tool.ts`) — scripts an
  OpenAI-style tool-call turn invoking the pinned build's built-in
  `"skill"` tool (`{ name: string }`, confirmed live via
  `client.tool.list()`). `opencode-harness@0.1.0` exports scripters for
  `"bash"`/`"question"`/plain text but not `"skill"` (added for #17,
  before this mechanism was in scope); this is a thin, mechanical local
  peer of those, not a harness change — see the evidence file's "Fixture/stub
  evidence" for why, and it would be a reasonable candidate to fold into
  `opencode-harness/src/scripting.ts` in a later slice.

## Tests (`test/`)

1. `pause-resume-fixed-inputs.test.ts` — the core proof: materializes
   version A (instructions, one Skill, one Recipe), scripts a Skill read
   then a question so the Round pauses, publishes version B to the
   library and plants conflicting decoys into the fake global config
   directory, the running project worktree, and the external
   `~/.claude/skills`/`~/.agents/skills` directories while paused, resumes
   with the answer, and asserts every request the stub received (before
   and after the pause) still carries version A and never version B or any
   decoy. A second, independent Round then materializes from the
   library's now-B content and is asserted to observe B, with none of
   Round 1's decoys.
2. `ambient-environment-sources.test.ts` — two FAILED GATE tests
   (asserting the observed leak, not hiding it): an ambient
   `OPENCODE_CONFIG` env var's `model` field does not leak into an
   unrelated new Round, but its `instructions` array does (array fields
   concatenate across config sources rather than being replaced); an
   ambient `OPENCODE_PERMISSION` env var silently overrides a Round's own
   configured `permission.bash` from `"ask"` to `"allow"`, suppressing a
   real pending-permission wait. Both are routed to D1 and D9 in the
   evidence file.

## Verification

```sh
cd experiments/opencode-fixed-inputs
npm ci
npm test        # node --test, 3 tests
npm run typecheck
```

No database, network access beyond `npm ci`'s registry calls, or real
credentials are required — the stub server, the library directory, and
every decoy are created by the tests themselves under `os.tmpdir()`.

## A note on `.npmrc`

This package's `.npmrc` sets `install-links=true` so `npm install`/`npm
ci` **copy** `opencode-harness` into this package's own `node_modules`
instead of npm's default local-`file:`-dependency symlink. See the
evidence file's "Reproducible commands" section for why: a symlinked
`opencode-harness` resolves its own imports (`@opencode-ai/sdk`,
`opencode-ai`) from its *real* path, which would require
`experiments/opencode-harness/node_modules` to already have those
packages — i.e. installing into that shared package, which this issue's
instructions forbid. Copying instead means this package's own
`node_modules` (which already has both packages pinned as direct
dependencies) satisfies resolution, and `npm ci`/`npm install` never
write into `experiments/opencode-harness/` at all.
