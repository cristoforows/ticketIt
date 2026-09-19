# opencode-cancellation

Cancellation confirmation and process-death proofs for
[M1.7 — OpenCode cancellation confirmation and process death
(#18)](https://github.com/cristoforows/ticketIt/issues/18), the
cancellation/process-death part of feasibility experiment S1 (see
`docs/integration-feasibility.md`). Depends on
`experiments/opencode-harness/` (built for
[#16](https://github.com/cristoforows/ticketIt/issues/16)/
[#17](https://github.com/cristoforows/ticketIt/issues/17)) via
`file:../opencode-harness`; this package adds no changes to the harness
itself (two other slices, #19 and #20, build against it concurrently).

See `docs/evidence/m1/18-opencode-cancellation.md` for exact versions,
documentation research, full fixture evidence with timings, observed
limitations, and decision impacts (D1, D5, D8).

## Running

```sh
cd experiments/opencode-harness && npm ci   # this package's file: dependency
cd ../opencode-cancellation
npm ci
npm test
```

`npm test` runs 11 tests across 6 files:

- `test/abort-while-running.test.ts`: aborts a session mid-`sleep` (a
  scripted "bash" tool call); confirms cessation only from real evidence
  (the tool's own child process actually gone, via `confirmStop`), and
  measures the gap between `abort()` returning and that evidence.
- `test/abort-while-waiting.test.ts`: aborts a session while a permission
  request is pending; observes the pending request is *not* cleared by
  abort, and that replying to it afterward succeeds with no execution
  effect.
- `test/after-abort.test.ts`: sends a new prompt to an already-aborted
  session; confirms history is retained but the earlier aborted tool call
  is never silently resumed.
- `test/process-death.test.ts` (2 tests): `SIGKILL`s the OpenCode server
  process mid tool-run, confirms external detection and no auto-restart,
  observes the tool's child process surviving its parent, then starts a
  fresh server against the same storage and checks what is (session
  history) and is not (pending permission state) recoverable.
- `test/confirm-stop.test.ts`: unit tests for `confirmStop`'s refusal
  path (never reports Stopped without observed evidence) and its
  `allOf` check combinator, independent of any running OpenCode instance.
- `test/process-death-classification.test.ts`: unit tests proving
  `classifyProcessDeath` always returns Interrupted/Blocked/no-auto-continue
  regardless of what was observed or recoverable.

## Public API (`src/index.ts`)

- `confirmStop(options)` — polls a caller-supplied `hasCeased()` check on
  a bounded schedule and only ever reports `status: "Stopped"` once that
  check itself observed real evidence; exhausting the budget without
  evidence returns `status: "not-confirmed"` rather than guessing. See
  `docs/contracts/execution-interface.md` ("Stop with evidence-bearing
  confirmation").
- `allOf(checks)` — combine multiple `CessationCheck`s so `confirmStop`
  only treats a poll as evidence once every one of them has, in the same
  poll.
- `classifyProcessDeath(observation)` — a pure function that always
  returns `{round: "Interrupted", ticket: "Blocked",
  newRoundRequiresExplicitOwnerAction: true, autoContinued: false}`,
  regardless of the observation passed in; there is no branch that could
  produce automatic continuation.
- `slowBashScript(options)` / `readPidFile(path)` / `isProcessAlive(pid)`
  — build a shell command (for `scriptBashToolCall` from
  `opencode-harness`) that backgrounds a `sleep`, captures its own pid to
  a file, and waits on it; read that pid back; and check via
  `process.kill(pid, 0)` whether it is still alive. This is a local
  extension of the harness's `markerAppendCommand` (single atomic
  append, no child-process handle) — see the evidence file's "Observed
  limitations" for why it lives here instead of in the harness.
- `startOpencodeAtRoot(options)` / `initTempGitProject(root)` — start a
  headless OpenCode server against an **existing** isolated root/project
  directory (unlike `opencode-harness`'s `startManagedOpenCode`, which
  always creates and owns a brand-new single-use root), so a second
  server can be started against the same on-disk storage after killing
  the first. A local, parameterized re-implementation of the relevant
  slice of `startManagedOpenCode`, kept here rather than folded into the
  harness per this issue's instructions; see the evidence file for the
  case that this capability would be a reasonable future harness
  enhancement.

## What this package pins

- `engines.node`: `26.9.0`, matching `experiments/.nvmrc`.
- `typescript`, `tsx`, `@types/node`: exact versions, matching the other
  packages in this workspace.
- `dependencies.opencode-harness`: `file:../opencode-harness`.
- `dependencies["@opencode-ai/sdk"]`: `1.18.31`, exact, matching the
  harness's own pin — needed directly (not just through the harness) by
  `src/direct-server.ts`; see the evidence file for why.

See `experiments/README.md` for the full workspace rules (no real
credentials or providers, exact pins, one evidence file per experiment).
