# Integration feasibility

Original documentation/source review: 18 September 2026. Bounded adapter
experiments for [M1 — Foundational decisions and integration proofs
(#2)](https://github.com/cristoforows/ticketIt/issues/2) ran 18–19
September 2026 and are reported below, per experiment, alongside the
original documentation-research findings they superseded or confirmed.
This document now reports what was actually observed, not only what was
planned. The consolidated gate report is
[M1.18 (#29)](https://github.com/cristoforows/ticketIt/issues/29); the
full per-experiment record lives in
[docs/evidence/m1/](evidence/m1/README.md), and reconciled decision
impacts live in [open-decisions.md](open-decisions.md).

Upstream `dev`/`main` source can differ from released packages. This
was confirmed directly during M1 (for example, `docs/evidence/m1/16-opencode-boot.md`'s
`ServerOptions`-vs-shipped-behavior finding, and
`docs/evidence/m1/22-native-harness-boot.md`'s `createAgent` parameter-name
mismatch between a `.d.ts` `@example` block and the actual constructor).
Every pinned-version claim below was reproduced on the exact package
versions named, not assumed from documentation.

This document keeps the distinction it always drew between three kinds of
evidence, now populated with real findings for each:

- **Documentation research (unverified)** — read from published docs,
  shipped `.d.ts` files, or decompiled/extracted source, not yet executed.
- **Fixture/stub evidence (observed)** — actually run in this repository,
  against local stubs, fakes, and fixtures; the load-bearing evidence for
  every claim below.
- **Real-provider evidence** — a real network call to a real provider or
  repository. M1 executed **none**; every real-provider check M1 identified
  is listed in "Outstanding real-provider checks" below and deferred to its
  owning milestone, per `experiments/README.md`'s workspace rule.

## S1 — OpenCode lifecycle and control

**Ran.** [`experiments/opencode-harness/`](../experiments/opencode-harness/),
[`experiments/opencode-cancellation/`](../experiments/opencode-cancellation/).
Pinned `opencode-ai`/`@opencode-ai/sdk` `1.18.31` (released together, same
CI publisher, confirmed via `npm view ... time --json`), Node `v26.9.0`,
`node --import tsx --test`.

- **Boot, isolation, shutdown** — [16-opencode-boot.md](evidence/m1/16-opencode-boot.md).
  `cd experiments/opencode-harness && npm ci && npm test` (3/3, repeated
  clean-checkout runs). A managed headless server boots against a local
  scripted stub model in an isolated temp git worktree; `HOME`/`XDG_*`/
  `OPENCODE_CONFIG_DIR`/`TMPDIR` isolation was proven both positively (a
  decoy config is read only when directly pointed at) and negatively (never
  read through the isolated env); the Round ID and OpenCode session ID are
  confirmed distinct (ADR 0002) and the Round ID never appears in any
  request the stub received; `close()` leaves no orphaned process,
  confirmed via `ps aux` and `process.kill(pid, 0)`. Observed limitation:
  `--port=0` was unreliable through `createOpencodeServer` (deterministically
  bound to a fixed port `4096` in several trial conditions); worked around
  by having the harness itself pick a free port.
- **Questions, permissions, reconnect** — [17-opencode-questions.md](evidence/m1/17-opencode-questions.md).
  Same package, `npm test` (8/8). A scripted "bash" tool call and a
  scripted "question" tool call each raise a real pending request, observed
  via both the live SSE event stream and a `listPending` query; dropping
  and resubscribing the event stream recovers the same pending request id
  with no duplicate side effect; a duplicate reply to an already-resolved
  request is rejected (HTTP 404 `PermissionNotFoundError`), not
  re-executed. **Finding, load-bearing for D1:** replying `"always"` to one
  bash permission request suppressed the native ask for a second tool call
  in the *same* session and for a brand-new session in the *same still-running
  process* — OpenCode's own permission memory is not scoped to a ticketIt
  Round, session, or even a fresh session boundary within one process.
- **Cancellation and process death** — [18-opencode-cancellation.md](evidence/m1/18-opencode-cancellation.md).
  New package `experiments/opencode-cancellation/`, `npm test` (11/11,
  repeated). A clean `session.abort()` while a shell tool is running kills
  the tool's actual child process within 0–1ms of the call returning
  (5-trial probe); `confirmStop` only ever reports Stopped after directly
  observing that cessation, never on the HTTP call alone. Aborting while a
  permission request is pending does **not** clear that request; a
  reply after abort still returns success but has no effect (the marker
  command never runs) — a reply "succeeding" is not evidence the action
  happened. A new prompt after abort does not resume the aborted tool call;
  history is retained, the aborted work is untouched. Killing the server
  process outright (`SIGKILL`, not `close()`) leaves the tool's own child
  process (a backgrounded `sleep`) running as an orphan — a clean abort
  reliably kills the child; an unclean process death does not, and nothing
  in this build or the harness cleans it up. A pending permission request
  does not survive a server restart (in-memory only); session/message
  history does, with the interrupted tool part stuck permanently at
  `"running"`. `classifyProcessDeath` always returns
  Interrupted/Blocked/no-auto-continue, matching `docs/v1-scope.md`'s
  Lifecycle table.

## S2 — Live permission and disconnect admission

**Ran — the highest-priority uncertainty, and the central D1 evidence.**
[`experiments/opencode-admission/`](../experiments/opencode-admission/)
(new package, plugin hook against a real pinned OpenCode process via
`@opencode-ai/plugin` `1.18.31`); native path in
[`experiments/native-admission/`](../experiments/native-admission/) against
`experiments/native-harness/`'s `createAgent`. See
[docs/open-decisions.md](open-decisions.md) (D1) for the full reconciled
verdict; this section summarizes what was run.

- **OpenCode plugin-hook bridge** — [20-opencode-admission.md](evidence/m1/20-opencode-admission.md),
  [21-opencode-coverage-matrix.md](evidence/m1/21-opencode-coverage-matrix.md).
  `cd experiments/opencode-admission && npm ci && npm test` (14/14). A
  `tool.execute.before` plugin hook consults `AdmissionLedger`
  (M1.4, `experiments/shared/`) over a loopback HTTP facade, from inside
  the spawned OpenCode process. **Positive result:** the hook remains the
  operative gate even when OpenCode's own native permission *memory*
  ("always") or its ambient `OPENCODE_PERMISSION` *configuration* would
  otherwise silently bypass its own prompt — both bypass vectors were
  tested directly and the hook still denied a revoked/ungranted action in
  both cases. Disconnect before dispatch holds then denies (a bounded
  ~4.5s hold-poll budget, this bridge's own choice, not a spec value);
  disconnect during a dispatched call lets that call finish and denies the
  next one; expiry/revocation/pending-Stop each deny the next admission
  with the correct reason, and a fresh grant lets the same session
  continue; parallel tool calls are each independently admitted and
  recorded. **Failed gates, recorded plainly:** model-only continuation
  (assistant text with no tool call) has zero code path through this hook
  — 0 `admit()` calls across three scripted text-only turns, fully
  disconnected throughout; nested shell sub-actions (a git commit, a push
  over a fake-SSH transport, a loopback HTTP request) all executed inside
  ONE admitted "bash" call, with only the single outer admission visible;
  under `gateAllTools` every built-in tool CAN be gated with no new
  mechanism, but the shipped default configuration gates only "bash"; a
  local stdio MCP tool connected and answered `tools/list` correctly but
  never became dispatchable at all on this pinned build, so its coverage
  could not be evaluated either way.
- **Native path (tool and model admission)** — [24-native-admission.md](evidence/m1/24-native-admission.md).
  `cd experiments/native-harness && npm ci && npm run db:setup`, then
  `cd ../native-admission && npm ci && npm test` (7/7, against local
  PostgreSQL 17). Both a wrapped tool call and a wrapped model call are
  gated by `AdmissionLedger`, since OpenRouter's provider-executed web
  search happens inside the model call itself with no separate
  interceptable step. Disconnect/expiry/revocation/Stop each block the
  next admission the same way the OpenCode bridge does; a held/denied tool
  call pauses the graph via `interrupt()` (resumable at the same step); a
  held/denied model call throws directly (thread-level resume, not a
  step-level one) — two different, both real mechanisms a caller must
  handle. Aborting an in-flight model call via `AbortSignal` retains
  partial content/usage only because the fixture model explicitly
  accumulated it — the abort signal itself carries none of that.

## S3 — Fixed inputs and durable human input

**Ran.** OpenCode half in
[`experiments/opencode-fixed-inputs/`](../experiments/opencode-fixed-inputs/);
native half in
[`experiments/native-harness/`](../experiments/native-harness/) and
[`experiments/native-durable-input/`](../experiments/native-durable-input/).

- **OpenCode effective fixed inputs** — [19-opencode-fixed-inputs.md](evidence/m1/19-opencode-fixed-inputs.md).
  `cd experiments/opencode-fixed-inputs && npm ci && npm test` (3/3). A
  Round on instructions/Skill/Recipe version A stayed on version A — proven
  against the stub's own request log, not a saved snapshot — across the
  library moving to B and decoys planted in every discovery source this
  build supports (global config, project config, project/global/external
  Skill directories); a fresh Round afterward observed B. **Two failed
  gates:** an ambient `OPENCODE_CONFIG` env var's `instructions` array
  *concatenates* into an unrelated Round's request rather than being
  replaced by later sources; an ambient `OPENCODE_PERMISSION` env var
  silently overrides a Round's own configured `"ask"` permission to
  `"allow"`, confirmed to suppress a real pending-permission wait and let
  a shell command execute directly. Neither is defended against by the
  harness's own directory-based isolation. Also observed: Skill discovery
  is scanned once per OpenCode *process*, not per session — a new Round
  needs a new process, not merely a new session, to pick up an input
  change.
- **Native durable question, duplicate-safe continuation, process death**
  — [22-native-harness-boot.md](evidence/m1/22-native-harness-boot.md),
  [23-native-durable-input.md](evidence/m1/23-native-durable-input.md).
  `cd experiments/native-harness && npm ci && npm run db:setup && npm test`
  (1/1); `cd ../native-durable-input && npm ci && npm test` (6/6, each
  scenario spawning genuinely separate OS processes sharing only a
  PostgreSQL checkpoint). A `LangGraph interrupt()`-based question survives
  across two separate processes with no shared memory; resuming an
  already-completed thread a second time with the same answer is a no-op
  at the **framework** level (not this harness's own idempotency key,
  which exists but was not the deciding mechanism for this specific path).
  Fixed inputs across a pause were proven the same way S3's OpenCode half
  was: a durable per-thread snapshot, not the mutable library file, is what
  a resumed Round reads. **Confirmed hazard:** LangGraph restarts an
  interrupted node from the beginning on resume — a side effect placed
  *before* `interrupt()` in the same node observably repeats on every
  resume; only a side effect placed after the interrupt (or made
  idempotent) does not. A mid-tool-call `SIGKILL` leaves a checkpoint
  scheduled-but-incomplete with no pending interrupt; the application's own
  recovery policy refuses to auto-continue that state (a negative-control
  test showed LangGraph itself *would* have happily continued and re-run
  the pre-interrupt side effect if the application had not refused).

## S4 — OpenRouter payload fidelity

**Ran.** [`experiments/openrouter-fidelity/`](../experiments/openrouter-fidelity/)
(fixture-server adapter matrix); [`experiments/usage-persistence/`](../experiments/usage-persistence/)
(checkpoint persistence + ingestion substitute). Pinned
`@langchain/openrouter` `0.4.13`, `@langchain/core` `1.2.11`, against a
local `FakeOpenRouterServer` — never a real OpenRouter endpoint.

- **Adapter fidelity matrix** — [25-openrouter-fidelity.md](evidence/m1/25-openrouter-fidelity.md).
  `cd experiments/openrouter-fidelity && npm ci && npm test` (21/21).
  Tool calls survive fully in both `invoke` and `stream` modes. **Citations
  are dropped entirely** by `ChatOpenRouter@0.4.13` — the `annotations`
  array never reaches the resulting message in either mode; recoverable
  only via a monkey-patched global `fetch` cloning the raw response.
  Reasoning/cached-token fields normalize into `usage_metadata` **only
  when usage rides the same chunk as `finish_reason`**; cost and
  cache-write tokens are preserved raw on `response_metadata.usage` but
  never normalized. **Most consequential finding:** when usage instead
  arrives via a separate trailing SSE chunk with empty `choices` — the
  pattern OpenRouter's own docs describe as the norm — `_streamResponseChunks`
  silently `continue`s past it, so streamed usage and cost read as
  completely absent, not merely unnormalized. A truncated stream throws
  `TypeError: terminated` in both modes, never resolving with a partial
  message; a mid-stream in-band `error` event is silently absorbed in
  stream mode (only `finish_reason: "error"` surfaces, the error code/message
  are dropped) while the non-streaming analog throws a fully-populated
  typed `OpenRouterError`.
- **Checkpoint persistence and ingestion substitute** — [26-usage-persistence.md](evidence/m1/26-usage-persistence.md).
  `cd experiments/usage-persistence && npm ci && npm run db:setup && npm test`
  (21/21, real `ChatOpenRouter` against the fake server, real local
  PostgreSQL). **New finding beyond the adapter matrix:** LangChain's
  normalized `usage_metadata` convenience field does **not** survive a
  LangGraph/Postgres checkpoint reload (it is assigned to the message
  instance after construction, not as a constructor kwarg that
  `Serializable.toJSON()` captures) — only the raw `response_metadata.usage`
  passthrough survives. The correct pattern, and what this package's own
  ingestion tests do throughout, is to build the usage observation from
  the fresh in-process adapter output at turn time, never re-derive it from
  a later checkpoint reload. The `UsageIngest` substitute demonstrated
  every stated M9 rule against real (fixture) adapter/server behavior:
  dedupe by generation ID, unknown usage never summed as zero (with an
  `incomplete` flag on the total), aggregate reported cost kept distinct
  from an unavailable search-cost breakdown, retained partial content with
  unknown usage on a truncated stream, and estimated-vs-reported cost kept
  independently visible when mixed in one total.

## S5 — GitHub delivery and identity

**Ran.** [`experiments/github-delivery/`](../experiments/github-delivery/),
built for identity (#27) and extended for delivery lifecycle (#28). All
fixtures: a local `FakeGitHubApi` (127.0.0.1) and a `FakeGitRemote` (a
bare repo plus a fake-SSH shell shim) — no real GitHub call, no real SSH
session.

- **Identity separation** — [27-github-identity.md](evidence/m1/27-github-identity.md).
  `cd experiments/github-delivery && npm ci && npm test` (26/26). Owner
  sign-in restriction, PAT identity verification against a configured
  Connected Account, and Git-transport SSH identity are each proven
  structurally separate: a GitHub-OAuth sign-in session alone carries no
  Connected Account authority (only an explicit `AdmissionLedger.grant()`
  does); a repository outside a fine-grained PAT's resource set returns
  404 with only that PAT ever sent over the wire — a separate, broader
  "admin" PAT configured in the same fake API but never passed to the
  connection is never sent, confirmed by inspecting the full request log;
  a token present but missing `pull_requests` permission returns 403, no
  credential substitution in either case. Commit authorship and the
  Git-SSH identity used for push are independently configurable and
  independently observed, separate from the API PAT. Every API and Git
  action (including local `commit`/`push`) is gated by
  `AdmissionLedger.admit()` first, refusing before any network or process
  call when disconnected, expired, or revoked.
- **Delivery lifecycle** — [28-pr-delivery-lifecycle.md](evidence/m1/28-pr-delivery-lifecycle.md).
  Same package, `npm test` (36/36 total, 10 new). A `DeliveryModule`
  commits, pushes, and finds-or-creates exactly one draft PR per ticket
  branch (list-before-create prevents a duplicate on a repeated request);
  an explicit requeue reuses the same branch/PR for a second Round while
  both Rounds' delivered commits remain independently retained; GitHub
  reviews (including an APPROVED review) and comments are observed and
  recorded as purely informational, never changing Ticket status or
  starting/ending a Round; an observed merge with no open Round moves the
  Ticket to Done and permanently ends its ticket-based grant while an
  unrelated time-based grant for the same Agent still allows; reopening a
  Done Ticket does not restore the ticket-based grant. A closed-unmerged PR
  and a merge observed while a Round is open are each recorded as an
  explicit **undefined transition** with the observed data, per D4 —
  status is never changed and no transition is invented. With the ledger
  disconnected, `deliver()` refuses before any API call or push.

## Interpretation for ticketIt

- A ticketIt round, OpenCode session, and LangGraph thread have distinct
  identities and lifecycles — confirmed directly (ADR 0002; every S1/S3
  evidence record asserts this rather than assuming it).
- Disconnect control means preventing new supported actions, not undoing
  already-dispatched effects. Preventing model continuation requires more
  than a tool-only hook — confirmed as a structural, not incidental, gap
  (S2, model-only continuation).
- Galley owns temporary grants. A single engine dispatch approval may use
  a one-call response internally while the application grant remains
  reusable until Done or expiry — this is exactly what the OpenCode
  once/always finding (S1) and the admission-bridge tests (S2) show is
  necessary: the engine's own memory is not a substitute for this.
- V1 direct-host execution knowingly lacks container isolation. Worktrees
  do not sandbox shell commands — demonstrated concretely, not only
  cited: one admitted "bash" call read a file outside both the
  OpenCode-managed project directory and the repository's own worktree
  (S2, nested-shell scenario).
- Saving a configuration snapshot is insufficient unless the engine
  actually uses the fixed content rather than rereading mutable ambient
  files — confirmed for OpenCode (instructions files are re-read from disk
  on every completion request; only Skill bodies and config JSON structure
  are cached) and confirmed as a real bypass vector for two ambient
  environment variables that this pinned build's own process isolation
  does not clear.
- No selected library replaces ticket ownership checks, round accounting,
  human review, or idempotent side-effect handling — confirmed by every
  "framework does X, application still refuses Y" pairing across S2/S3
  (e.g. LangGraph would happily continue past a mid-tool-call process
  death; the application's own recovery policy is what refuses it).

## Executed feasibility experiments

Every experiment below ran against deterministic local model/API stubs,
synthetic credentials, fake clocks, and dispatch ledgers, per
`experiments/README.md`'s workspace rules. None called a real provider or
selected an object storage, hosting, model, or OpenCode provider (open
decision D7 remains untouched by every one of them).

M1 ran bounded adapter proofs using controlled substitutes for
application interfaces that do not yet exist; it did not require the
completed Swiftlet/Galley/Michelin application. Exercising the
corresponding application behavior through controlled Rounds remains M4–M6's
work; verifying the actual native and OpenCode integrations against real
providers remains M7 and M8's work. Release acceptance across the deployed
application remains M10's work.

## Outstanding real-provider checks

M1 deliberately executed no real-provider or real-repository call,
per `experiments/README.md`. Every check below was identified by an M1
evidence record as needing a real provider and is deferred to its owning
milestone:

| Check | Owning milestone | Source |
| --- | --- | --- |
| Controlled real selected-model smoke test (tool calling, streaming, usage reporting, web search, citation shape) once a model is chosen under D7 | **M7** | [25-openrouter-fidelity.md](evidence/m1/25-openrouter-fidelity.md), [26-usage-persistence.md](evidence/m1/26-usage-persistence.md) |
| Authorized fixture-repository GitHub delivery test (real fine-grained PAT, real SSH deploy key, real disposable repo, real draft-PR create/update/review/merge round-trip) | **M8** | [27-github-identity.md](evidence/m1/27-github-identity.md), [28-pr-delivery-lifecycle.md](evidence/m1/28-pr-delivery-lifecycle.md) |
| Object-storage provider smoke test (R2 or Supabase Storage, once D7 selects one) | **M6** | [open-decisions.md](open-decisions.md) D7; no M1 evidence record touches storage |
| Real OpenCode/native engine integrations against actual production supervision (not a scripted stub) | **M7 (native)**, **M8 (OpenCode)** | every S1–S3 evidence record's "Outstanding checks" section |
| Whether a real OpenRouter response ever delivers `annotations` incrementally on streaming deltas, and whether the empty-choices usage-only trailing chunk pattern is actually used by the selected model | **M7**, feeding **M9** | [25-openrouter-fidelity.md](evidence/m1/25-openrouter-fidelity.md) |
| Whether a real web-search-enabled OpenRouter response populates a search-specific cost breakdown field | **M7/M9** | [24-native-admission.md](evidence/m1/24-native-admission.md), [26-usage-persistence.md](evidence/m1/26-usage-persistence.md) |
| `X-Accepted-GitHub-Permissions` header and organization-level fine-grained-token-approval interaction | **M8** | [27-github-identity.md](evidence/m1/27-github-identity.md) |
| Re-verifying local stdio MCP tool dispatchability against a future pinned OpenCode version | **M7/M8, or a dedicated follow-up** | [21-opencode-coverage-matrix.md](evidence/m1/21-opencode-coverage-matrix.md) |
| A deliberate policy for OpenCode's native `permission.external_directory` (defaults to `"ask"`, can hang a caller with nothing to answer it) and any other native permission action beyond `bash` | **M7/M8** | [21-opencode-coverage-matrix.md](evidence/m1/21-opencode-coverage-matrix.md) |

## Gate outcome

S2 was the highest-priority uncertainty and has now run. The verdict,
reconciled in [open-decisions.md](open-decisions.md) (D1): live admission
is enforceable for dispatched tool actions — including against both of
OpenCode's own permission bypass vectors ("always" memory and the
`OPENCODE_PERMISSION` ambient variable) — and is **not** enforceable for
model-only continuation at the `tool.execute.*` hook position, which is a
structural limit of that integration point, not a bug to fix within it.
Nested shell sub-actions receive only whole-call granularity. Neither of
these is silently weakened here: both are recorded as failed gates
requiring an Owner or integration decision, per D1. A local stdio MCP tool
could not be made dispatchable at all on this pinned build and is recorded
as an open risk, not assumed safe. No experiment claims a behavior is
delivered that was not directly observed, and no experiment substitutes
abort/restart for pause without that being the actual, disclosed observed
behavior (abort is not assumed resumable; see S1).
