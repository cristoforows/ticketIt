# M1.7 — OpenCode cancellation confirmation and process death

## Purpose

Prove the cancellation and process-death parts of feasibility experiment S1
("OpenCode lifecycle and control", `docs/integration-feasibility.md`) for
[M1.7 — OpenCode cancellation confirmation and process death
(#18)](https://github.com/cristoforows/ticketIt/issues/18): abort of
blocked/running work is only ever reported as Stopped once there is
observed evidence execution actually ceased; abort during a pending
permission wait is characterized precisely (cleared or not, and what a
later reply does); a new prompt after abort does not silently resume the
aborted work; and killing the OpenCode server process outright is treated
as Interrupted/Blocked with no automatic new Round, distinct from a clean
`close()`. This is a new package, `experiments/opencode-cancellation/`,
depending on `experiments/opencode-harness/` (built for
[#16](https://github.com/cristoforows/ticketIt/issues/16),
[#17](https://github.com/cristoforows/ticketIt/issues/17)) via
`file:../opencode-harness`, per this issue's instruction not to modify the
harness while #19 and #20 build against it concurrently.

## Exact versions

Identical pins to `docs/evidence/m1/16-opencode-boot.md` and
`17-opencode-questions.md` (same lockstep-released engine/SDK pair, same
toolchain; nothing re-pinned for this slice):

- Node: `v26.9.0` (matches `experiments/.nvmrc` and this package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- `typescript`: `7.0.2`, `tsx`: `4.23.13`, `@types/node`: `26.6.1`
  (devDependencies, exact)
- `opencode-ai` (executable) and `@opencode-ai/sdk` (SDK): `1.18.31` each
  — resolved from `experiments/opencode-harness/node_modules` (this
  package depends on the harness via `file:../opencode-harness` and never
  installs its own copy of `opencode-ai`; `@opencode-ai/sdk` is also a
  direct dependency of this package, at the same pinned version, only
  because it needs `createOpencodeServer`/`createOpencodeClient` directly
  for `src/direct-server.ts` — see "Observed limitations").
- Test runner: `node --import tsx --test`, consistent with the rest of
  this workspace.

## Reproducible commands

```sh
cd experiments/opencode-harness && npm ci   # this package's file: dependency
cd ../opencode-cancellation
npm ci
npm run typecheck
npm test
```

No env vars or fixture files need to be supplied externally: the stub
server, marker/pid files, and isolated HOME/XDG/root directories are all
created by the tests themselves under `os.tmpdir()`. Verified three
consecutive full `npm test` runs green (11/11), one immediately after a
clean `rm -rf node_modules && npm ci`. `ps aux | grep opencode` (and a
grep for this worktree's own path) after every run showed no leftover
`opencode` server process; a deliberately-produced orphaned `sleep`
process (see "Fixture/stub evidence", scenario 4) is explicitly
`SIGKILL`ed by the test's own cleanup, not left to expire naturally.

## Documentation research (unverified)

- `docs/integration-feasibility.md` ("Cancel versus pause", S1) already
  cites the SDK's `session.abort` and the execution source
  ([`packages/opencode/src/session/prompt.ts` on the `dev`
  branch](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts))
  as implementing cancellation, flagging "no general documented guarantee
  that abort can be resumed at the exact suspended point." Fetching that
  file (unverified: this is the `dev` branch, not necessarily the exact
  source behind the pinned `1.18.31` release — `opencode-ai` ships only a
  compiled binary, per `16-opencode-boot.md`'s "no `repository`/`gitHead`
  field" finding, so the pinned build's own source cannot be pinned
  precisely) shows more than "no guarantee of resumability": an
  `AbortController` is wired through tool execution via `Effect.onInterrupt`,
  and for shell commands specifically the spawned child is passed
  `forceKillAfter: "3 seconds"` (via `ChildProcess.make(sh, args, {...,
  forceKillAfter: "3 seconds"})`), i.e. the documented design explicitly
  kills the underlying process (escalating after a grace period), not
  just marking bookkeeping as cancelled — matching, not contradicting,
  what "Fixture/stub evidence" below found by direct observation on the
  pinned build. Bookkeeping is also updated in the same interrupt handler
  (`state: { status: "error", error: "Cancelled", ... }`); this pinned
  build was observed to end up with tool-part `status: "completed"`
  carrying an aborted marker in `output` instead (see below), which is
  either drift between the `dev` branch and `1.18.31`, or a later
  rewrite of the same terminal state — not conclusively distinguished
  here.
- The pinned `@opencode-ai/sdk@1.18.31` package's own shipped
  declarations (read, not executed, ahead of writing tests):
  `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` declares
  `SessionAbortData` (`path: {id: string}`, `url: "/session/{id}/abort"`,
  response `200: boolean`) and, separately, `MessageAbortedError` (`name:
  "MessageAbortedError", data: {message: string}`) as one of an assistant
  message's possible `error` shapes. It also declares `SessionStatus` as
  a union (`{type:"idle"}`, `{type:"retry", attempt, message, next}`,
  `{type:"busy"}`) returned by `client.session.status()` (`GET
  /session/status`, a map keyed by session id), and `ToolStateError`
  (`status: "error", error: string, ...`) as one of a tool part's
  possible terminal states. The `/v2` subpath
  (`dist/v2/gen/types.gen.d.ts`) declares the same `SessionAbortData`
  shape but keyed `path: {sessionID: string}` instead of `path: {id:
  string}` — both route to the identical `/session/{id}/abort` endpoint;
  this package's tests use the bare "v1" client's `{id}` form throughout,
  consistent with `ManagedOpenCode.session`'s existing helpers from #16.
  Confirmed against the live server's own `/doc` OpenAPI document (the
  same probe method `17-opencode-questions.md` used) that no separate
  route exists for cancelling a single pending permission/question
  request independent of the whole session.
- No documentation (shipped types or the `dev`-branch source above) makes
  any claim about what happens to a pending permission/question request
  when its session is aborted, or about whether pending state survives a
  server process restart. Both were determined only by direct
  observation (see "Fixture/stub evidence").

## Fixture/stub evidence (observed)

All of the following was actually executed on this machine. `npm test`
(11 tests) passed on three consecutive runs, one from a fully clean
`node_modules`; `npm run typecheck` passed with no errors.

**Scenario 1 — abort while running**
(`test/abort-while-running.test.ts`). A scripted `bash` tool call
(background `sleep 5 &`, capture `$!` to a pid file, `wait`, then a
second marker line — see `src/slow-bash.ts`, written locally because
`opencode-harness`'s own `markerAppendCommand` only supports a single
atomic append and exposes no way to observe an in-flight child process)
ran under the pinned build's **default** bash permission (no
`permission.bash: "ask"` — confirmed by an ad hoc probe before writing
this test that the tool starts running immediately with no pending
permission at all under default config). Once the pid file appeared
(the tool had started) and `client.session.status()` reported
`{type: "busy"}`, `client.session.abort({path:{id: session.id}})` was
called.

- `abort()` itself returned `true` and took, across the ad hoc timing
  probe run for this evidence file (5 trials, not part of the committed
  suite, each a fresh managed instance): **42ms, 45ms, 45ms, 46ms, 75ms**
  wall time (HTTP round trip plus server-side work).
- **The cessation gap — the time between `abort()` returning and the
  tool's own child process (the backgrounded `sleep`, checked via
  `process.kill(pid, 0)`/`ESRCH`, exactly the technique
  `opencode-harness`'s own orphan check uses) actually being gone — was 0ms
  in 4 of 5 trials and 1ms in the fifth**: by the time the client-side
  `abort()` promise resolved, the child process had already exited. The
  committed test (`confirmStop` with `intervalMs: 20`, `maxAttempts: 100`)
  confirmed this on every run (`confirmation.attempts === 1` every time
  observed), asserting a generous `< 5000ms` sanity bound rather than
  this exact number, since exact sub-poll-interval timing is not something
  to pin a hard assertion to.
- The marker file held exactly `["before-sleep"]` — the `after-sleep`
  line, which only appears once `wait $SLEEP_PID` returns naturally, never
  appeared. `client.session.status()` no longer listed the session as
  busy afterward.
- `session.messages()` showed the assistant message's `error` field as
  `{"name":"MessageAbortedError","data":{"message":"Aborted"}}` (matching
  the declared type above), and the bash tool part's state was
  `{"status":"completed", ..., "output":"(no output)\n\n<shell_metadata>\nUser
  aborted the command\n</shell_metadata>", ...}` — **`status: "completed"`,
  not `"error"`**, with the abort recorded inside `output` instead. Only
  once all of this (child process gone, marker file unchanged, session no
  longer busy) was observed did the test's `confirmStop` call report
  `status: "Stopped"`; `confirmStop` never reports Stopped on the
  `abort()` HTTP call succeeding alone.

**Scenario 2 — abort while waiting**
(`test/abort-while-waiting.test.ts`). With `permission.bash: "ask"` (the
same isolated per-instance config mechanism `17-opencode-questions.md`'s
permission-round-trip test uses) and a pending permission request
confirmed via `listPending` (as in #17), `session.abort()` was called
while the request was still pending. Observed, reproduced on every run:

- **The pending permission request is not cleared by abort.**
  `listPending` immediately after returns the identical request (same
  `id`), not an empty list.
- **A reply to that request after the session was already aborted still
  succeeds** — `replyPermission(..., "once")` returns `{ok: true, error:
  null}`, not an error — **but has no observable side effect**: the
  scripted marker command is never actually run (`readMarkerLines`
  returns `[]` even after a settle window), because the turn the
  permission belonged to had already ended. The reply does consume the
  pending record (a follow-up `listPending` shows it gone), and a
  *second* reply to the same now-consumed id fails with the identical
  error `17-opencode-questions.md`'s duplicate-reply test observed: HTTP
  404, `{"_tag":"PermissionNotFoundError","requestID":"<id>","message":"Permission
  request not found: <id>"}`. This is a genuinely new finding this slice
  adds, not a re-run of #17's test: a reply "succeeding" is not evidence
  the underlying action happened, once the session that owned it has been
  aborted.
- The original `promptText()` call resolved (did not hang or reject) with
  the same `MessageAbortedError` shape as scenario 1.

**Scenario 3 — after abort**
(`test/after-abort.test.ts`). After confirming cessation exactly as in
scenario 1, a **new**, explicit prompt (`"Please continue."`) was sent to
the *same* OpenCode session. Observed:

- **History is retained**: `session.messages()` before the new prompt had
  2 messages (the original user message, the aborted assistant message);
  after, 4 (those two, plus a new user message and a new assistant
  message with the next scripted turn's text, `"Reply after abort."`).
- **The aborted work does not resume by itself.** The earlier aborted
  tool part's own JSON (status, output, callID, everything) is
  byte-for-byte identical before and after sending the new prompt — it is
  not touched, re-run, or marked completed by the act of continuing the
  session. The marker file still shows only `["before-sleep"]`; no new
  `sleep` process is spawned and no `after-sleep` line ever appears.
  The new prompt is answered as a fresh turn, not a continuation of the
  interrupted tool call.
- This directly supports stating the rule explicitly: **abort ends the
  Round; sending another prompt to the same OpenCode session afterward is
  conversation continuity at the engine level, never an automatic resumed
  Round.** ticketIt's own Round boundary (a new Round requires the owner
  to return the Ticket to Ready, per `docs/v1-scope.md` "Lifecycle") is a
  separate, stronger guarantee this experiment does not implement — it is
  a fixed rule in the application layer, not something this session-level
  observation could contradict or weaken.

**Scenario 4 — process death**
(`test/process-death.test.ts`, two tests). `opencode-harness`'s own
`startManagedOpenCode` always creates and owns a brand-new, single-use
temporary root (`mkdtempSync` internally) with no way through its public
API to point a second call at directories an earlier call already used —
exactly what "restart against the same storage" requires. Per this
issue's instruction not to modify the harness, `src/direct-server.ts`
locally re-implements the relevant slice of `startManagedOpenCode`
(env-override mutation, the `cp.spawn`-capture trick for a pid, port
selection, building both SDK client surfaces), parameterized on an
existing `root`/`projectDir` instead of creating its own; see "Observed
limitations" for why this exists instead of a harness change.

- The OpenCode server process was killed with `process.kill(pid,
  "SIGKILL")` (not `close()`) while the same slow scripted bash tool call
  from scenario 1 was mid-`sleep`. **Detection is external polling**
  (`process.kill(pid, 0)`/`ESRCH`), not a direct child `'exit'` event:
  like `ManagedOpenCode`, `startOpencodeAtRoot` captures a pid but does
  not expose the underlying `ChildProcess` outside its own module, so an
  external caller that only has the pid — exactly what a real supervisor
  reattaching after its own restart would have — is what is being
  modeled. Across a 5-trial ad hoc timing probe for this evidence file:
  detection took **11ms, 11ms, 11ms, 12ms, 12ms** after the `SIGKILL` was
  sent (polling every 5ms); the committed test polls every 20ms and
  asserts a `< 5000ms` sanity bound.
- **The tool's own child process (the backgrounded `sleep`) survived its
  parent's `SIGKILL` in every trial (5/5 ad hoc, and every committed-test
  run)** — `process.kill(childPid, 0)` still succeeded after the server
  process was confirmed gone. `SIGKILL` to a single pid does not
  propagate to that process's own already-spawned children; the shell
  process tree OpenCode's "bash" tool spawns becomes an orphan, still
  running, reparented to the OS's init process. This is the opposite of
  scenario 1's finding (a clean `abort()` does kill the tool's child
  quickly): **only a clean abort was observed to actually terminate the
  underlying process; an unclean server death does not**, and there is no
  supervisor-side cleanup implemented anywhere in this package or the
  harness for that orphan — the committed test explicitly `SIGKILL`s it
  itself afterward, purely for local test hygiene, and says so in a
  comment rather than presenting that as a real recovery mechanism.
- **No automatic restart.** After a 500ms grace period the old pid was
  still gone and `fetch(oldServerUrl + "/session")` still rejected
  (`TypeError: fetch failed`, connection refused) — nothing in
  `startOpencodeAtRoot`, `ManagedOpenCode`, or the SDK itself retries or
  respawns on its own.
- **What is recoverable from the same storage, and what is not, after
  starting a second server against it:**
  - *Recoverable*: `client.session.list()` on the fresh server includes
    the prior session id; `client.session.messages()` for it includes the
    interrupted assistant message and its bash tool part, whose state is
    `{"status": "running", ...}` — **stuck at `"running"` forever**,
    never transitioned to `"completed"` or `"error"` by the restart (in
    sharp contrast to scenario 1's clean-abort tool part, which reached
    `"completed"` with an abort marker in `output`). This is itself
    useful, distinguishing evidence: a persisted tool part still showing
    `"running"` is a concrete, checkable signal that the Round it belongs
    to ended by process death, not by a clean stop.
  - *Not recoverable*: a second test
    (`"a pending permission request is not recoverable after restart"`)
    reproduced a permission request pending at the moment of `SIGKILL`
    (`permission.bash: "ask"`), and confirmed `client.permission.list()`
    against the fresh server returns an **empty array** — the pending
    request is gone, even though the session/message history containing
    the tool call that raised it is still there. Pending permission/
    question state is in-memory only on this pinned build, not persisted
    to the same on-disk storage session/message history uses.
  - Merely starting the second server and querying it (`session.list()`,
    `session.messages()`, `permission.list()`) triggered **no new
    completion request** to the stub (`stub.requests.length` unchanged
    across a 1s idle window after restart) — nothing about reattaching to
    existing storage by itself causes any continuation.
- `classifyProcessDeath` (this package's own pure function, unit-tested
  separately in `test/process-death-classification.test.ts` across five
  observation variants including both "tool child survived" and "did
  not," and both "history recovered" and "not") always returns `{round:
  "Interrupted", ticket: "Blocked", newRoundRequiresExplicitOwnerAction:
  true, autoContinued: false}` — there is no branch in this function that
  could produce automatic continuation regardless of what is recoverable,
  which is the code-level proof this issue asks for ("prove your code
  refuses to auto-continue") to complement the integration-level proof
  (no new stub request) above.

**`confirmStop`'s refusal path**
(`test/confirm-stop.test.ts`, independent of any running OpenCode
instance). A fake `hasCeased` that always returns `observed: false`
causes `confirmStop` to exhaust its full polling budget (asserted: called
exactly `maxAttempts` times, not fewer) and return `status:
"not-confirmed"` with a reason string matching `/refusing to report
Stopped/` and `observedAtMs: null` — it never upgrades "no evidence
found" to "Stopped." A second test confirms the positive path stops
polling as soon as (and not after) evidence appears, and records a
timestamp within the observed wall-clock window. `allOf` (composing
multiple cessation checks into one) was also unit-tested: it only reports
`observed: true` once every composed check has, in the same poll.

## Real-provider evidence (observed, or "none executed")

None executed. Every completions request in this experiment went to the
local `StubModelServer` on `127.0.0.1` (this package's own tests
construct fresh `StubModelServer` instances per test, same as
`opencode-harness`'s existing tests; no shared/global stub); no API key
for a real provider exists anywhere in this repository or its isolated
environment. `npm ci`/registry access is the only network activity
(installing the pinned `@opencode-ai/sdk` and dev dependencies), plus one
`WebFetch` of a public GitHub source file for documentation research
(no model-provider traffic).

## Observed limitations

- **`startManagedOpenCode` cannot be reused for scenario 4** because it
  always calls `mkdtempSync` itself and owns a single-use root with no
  parameter to accept an existing one. This package's
  `src/direct-server.ts` (`startOpencodeAtRoot`) is a local, ~130-line
  duplication of the relevant slice of `startManagedOpenCode` (the
  env-override mutation around `createOpencodeServer`, the `cp.spawn`
  capture trick for a pid, ephemeral port selection, building both SDK
  client surfaces) plus `src/temp-git-project.ts` (a duplicate of the
  harness's private `initTempGitProject`). Per this issue's instruction
  not to modify any file under `experiments/opencode-harness/` while
  #19/#20 build against it concurrently, this was not folded back in;
  **flagging here for the PR**: accepting a pre-built `IsolatedPaths`/
  root (skipping the internal `mkdtempSync` and git-init) would be a
  reasonable, small enhancement to `startManagedOpenCode` for whichever
  slice next needs "reattach to existing storage" — this one, or M5's
  stranded-runner recovery work.
- **This package also depends directly on `@opencode-ai/sdk`** (same
  pinned `1.18.31`), solely so `direct-server.ts` can call
  `createOpencodeServer`/`createOpencodeClient` itself; it does **not**
  depend on `opencode-ai` directly (`resolveOpencodeBinDir()`, imported
  from the harness, resolves the executable relative to the harness
  package's own `node_modules`, which already has it installed and
  `allowScripts`-approved from #16 — no second postinstall/approval was
  needed here).
- **"The supervisor observes the exit" is external polling, not a direct
  `'exit'` event**, in both `opencode-harness`'s own `ManagedOpenCode` and
  this package's `startOpencodeAtRoot` — neither exposes the captured
  `ChildProcess` outside its own module (the SDK's own `close()` gives no
  handle at all, per `16-opencode-boot.md`). This is arguably a more
  realistic model of a real supervisor that only persists a pid (see
  `docs/open-decisions.md`, D5, "stranded runner"), but it means the
  exact detection latency measured
  here (11-12ms) is bounded below by this test's own poll interval (5ms
  in the ad hoc timing probe, 20ms in the committed test), not by
  whatever OS-level notification latency a direct child-process handle
  would see.
- **The orphaned `sleep` process from scenario 4 is real and is only
  cleaned up by explicit test-code `SIGKILL`, not by anything this
  package or the harness implements as a general mechanism.** A real
  stranded shell process from a genuinely crashed OpenCode server would
  need its own recovery/cleanup story; this experiment only demonstrates
  that the gap exists (D8) and does not propose or implement a fix for
  it, as instructed.
- **Only one flavor of "slow" tool call was exercised**: a backgrounded
  `sleep` with its own captured pid, chosen specifically because it gives
  an OS-level handle independent of anything OpenCode reports. Other tool
  shapes (a foregrounded long computation with no separate child process,
  a tool that spawns multiple children, an MCP tool) were not exercised;
  their cessation/orphan behavior on abort or process death is not
  established by this evidence.
- **The `dev`-branch source read for "Documentation research" is not
  guaranteed to match the pinned `1.18.31` binary's actual source**, per
  `16-opencode-boot.md`'s existing caveat about `opencode-ai`/`sdk` having
  no `repository`/`gitHead` metadata; it is corroborating unverified
  context for the empirical finding, not a substitute for it.
- **Timing numbers (cessation gap, detection gap, `abort()` wall time)
  are from small ad hoc probes (5 trials each) run on one development
  machine**, not a statistically rigorous benchmark; they are reported as
  observed ranges, not guarantees, and the committed tests assert only
  generous sanity bounds (`< 5000ms`), polling rather than asserting a
  fixed tick count, per this issue's instructions.
- Only bash-tool permission requests were exercised for the
  abort-while-waiting and pending-state-after-restart scenarios (matching
  #17's own scope); a pending *question* (rather than permission) was not
  separately re-tested here, since the issue's acceptance criteria treats
  "a pending permission request (or question)" as one scenario and #17
  already established the two behave analogously through the same
  `/v2` client surface.

## Outstanding checks and owning milestone

- Real orphan-process cleanup after a genuine (non-test) process death —
  this experiment only observes and flags the gap (D8); implementing
  supervisor-side cleanup of stranded host processes is M5's
  stranded-runner/reconciliation work
  ([#6](https://github.com/cristoforows/ticketIt/issues/6)).
- Reconciling this session-level "abort ends the OpenCode Round but the
  same process/session could technically accept another prompt" behavior
  against ticketIt's own Round/Ticket state machine (a new Round always
  requires an explicit owner action, regardless of what the underlying
  engine session would technically still accept) is application-layer
  work for M4-M6, not this experiment; this evidence only establishes the
  engine-level facts that layer must not contradict.
- Fixed inputs across pause/resume and durable human input across a real
  process restart (not just cancellation) — routed to
  [#19](https://github.com/cristoforows/ticketIt/issues/19).
- Reconciling engine-reported state (busy/idle, tool part status) against
  ticketIt's own admission/authority model, and the once/always
  cross-session finding from #17 — routed to
  [#20](https://github.com/cristoforows/ticketIt/issues/20).
- Folding `startOpencodeAtRoot`'s "reattach to an existing isolated root"
  capability back into `opencode-harness` itself (see "Observed
  limitations") — left to whichever future slice needs it next, most
  likely M5's stranded-runner recovery work.
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
  this slice shows a clean `session.abort()` does reliably and quickly
  (observed: 0-1ms after the call returns) terminate a running shell
  tool's actual child process on this pinned build — a positive data
  point for D1's eventual admission-control mechanism, since it means the
  engine itself can be trusted to stop *newly-running* shell work once
  told to, without ticketIt needing its own process-tree tracking for
  that specific case. It does **not** extend to: (a) a request already
  replied-to-but-moot after abort (scenario 2: the reply "succeeds" with
  no effect, a silent no-op rather than an error a caller could detect
  and reconcile against), or (b) unclean process death (scenario 4: the
  tool's own child process survives outright and needs separate cleanup).
  Both are gaps D1's boundary design needs to account for, not resolved
  here.
- **D5** (Stranded runner and stop recovery): scenario 4 is direct
  evidence for this decision's core tension — "a lost connection does not
  prove execution ended." Losing the OpenCode server process left its
  tool's child process still running (a real stranded execution), while
  session/message history was recoverable from the same storage but the
  in-flight tool part was permanently stuck at `"running"` (never
  self-resolving) and any pending permission/question was **not**
  recoverable at all (in-memory only). This evidence supports D5's
  planned direction (explicit recovery with stale-execution fencing, no
  automatic duplicate execution) by showing concretely what "explicit
  recovery" would need to inspect (a stuck `"running"` tool part is a
  reliable signal; an empty pending-permission list after restart is not
  evidence nothing was pending, only that nothing survived) and what it
  cannot lean on (no automatic engine-side recovery of pending state).
  `classifyProcessDeath`'s fixed Interrupted/Blocked/no-auto-continue
  output for every observation variant is this package's own applied
  instance of D5's "no automatic duplicate execution or false stop
  confirmation" rule, not a resolution of D5 itself.
- **D8** (In-flight manual revocation and non-budget execution limits):
  two new findings feed this directly. First, replying to a permission
  request after its owning session was aborted returns success with no
  execution effect (scenario 2) — this is evidence that "already-
  dispatched handling" needs a definition broader than "did the reply
  error": a caller cannot distinguish "my reply executed the action" from
  "my reply was silently accepted into a dead turn" by the reply's own
  return value alone. Second, an orphaned host shell process surviving
  its parent's death (scenario 4) is concrete evidence that "cancellation
  cannot promise to undo completed external effects" extends even further
  than in-flight *model* work: a host-level child process can keep running
  indefinitely with no engine-level or supervisor-level mechanism
  observed to bound it, which is exactly the "reasonable technical
  loop/time limits" gap D8 is scoped to define. Neither finding resolves
  D8; both are concrete inputs for the M5 control-rules work
  ([#6](https://github.com/cristoforows/ticketIt/issues/6)) and later
  M7/M8 adapter verification.
