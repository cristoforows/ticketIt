# Open decisions

The [v1 scope](v1-scope.md) records approved behavior. Items below remain unresolved unless explicitly marked Resolved; recommendations on open items are proposals, not accepted changes. Resolve each choice before implementing its affected behavior in the owning milestone rather than reopening the whole design.

Milestone references use the approved M1–M10 [implementation plan](implementation-plan.md) and its published issues. Publishing the plan did not resolve these choices. M1 establishes foundational contracts and routes later choices to their owning milestones.

M1's bounded adapter experiments ran 18–19 September 2026; what they learned for each decision below is recorded under "What M1 learned," each claim linking to the evidence record that backs it (full index: [docs/evidence/m1/README.md](evidence/m1/README.md)). None of these findings resolve their decision — an M1 experiment observes and records; only the Owner (or, for D3, the Owner's approval on #13) resolves a decision. Decisions whose M1 findings show a required behavior cannot currently be gated are marked **FAILED GATE** below.

## Product and integration decisions

| ID | Decision | Why it matters / recommendation to evaluate | Resolution gate |
| --- | --- | --- | --- |
| D1 | Enforceable OpenCode action boundary and disconnect behavior | Prove live admission for every enabled path. Registered-tool hooks may not cover model-only continuation, shell internals, provider tools, or direct APIs. Respect the accepted direct-host v1 scope, but do not advertise unsupported granular controls. If required behavior cannot be gated, choose an integration change or obtain an explicit requirement decision. | [M1 proofs](https://github.com/cristoforows/ticketIt/issues/2); [M8 live coding gate](https://github.com/cristoforows/ticketIt/issues/9) |
| D2 | Human-review evidence for PR completion and agent merge authority | A personal PR may be authored through the same identity that reviews/merges it; a separate GitHub approval may not be available. Define what demonstrates owner review and ensure agent access cannot silently replace the human completion decision. Evaluate owner-controlled merge plus a clearly bounded supported action surface. | [M8 review/merge implementation](https://github.com/cristoforows/ticketIt/issues/9) |
| D3 | Agent/template compatibility and human-assigned workflow | **Resolved by Owner:** any Agent may be assigned regardless of Template; validate required inputs and actual action prerequisites, not a template/capability whitelist. Preserve completion conditions, human workflow, open-Round locks, and confirmed Stop. Temporary MVP limits must be explicit implementation limits with follow-up work. See the [accepted decision](decisions/d3-agent-template-compatibility.md) and [Owner comment](https://github.com/cristoforows/ticketIt/issues/13#issuecomment-5743245026). | Apply in M2, M4, and M8; D2/D4/D5 remain open |
| D4 | Exceptional PR and template/repository changes | Define closed-unmerged PRs, reopening a ticket after merge, merge arrival during an open round, and changes to repository/template after delivery. Same-PR reuse is approved only until merge. Preserve prior deliveries; never infer a new PR or successful completion without a defined transition. | [M8 coding lifecycle](https://github.com/cristoforows/ticketIt/issues/9) |
| D5 | Stranded runner and stop recovery | A lost connection does not prove execution ended, yet editing/archive require an ended round. Define evidence and owner recovery authority when a runner never returns. Evaluate explicit recovery with stale-execution fencing; no automatic duplicate execution or false stop confirmation. | [M5 controlled recovery](https://github.com/cristoforows/ticketIt/issues/6) |
| D6 | Grill Mode configuration and scheduling | Choose its model/profile, context access, field-application review, and scheduling relative to the single active round. Preparation needs the local service but is not an execution round. Evaluate the native configuration plus persisted interview state; do not silently create a parallel execution lane. | [M7 preparation workflow](https://github.com/cristoforows/ticketIt/issues/8) |
| D7 | Runtime/provider selections | Owner to choose R2 or Supabase Storage. Select application/PostgreSQL hosting, native OpenRouter model, and OpenCode model/auth source. OpenRouter is approved for native research, not automatically every OpenCode configuration. Validate tool/search support and below-$10/month hosting. | [M6 storage](https://github.com/cristoforows/ticketIt/issues/7); [M7 native model](https://github.com/cristoforows/ticketIt/issues/8); [M8 OpenCode](https://github.com/cristoforows/ticketIt/issues/9); [M10 hosting](https://github.com/cristoforows/ticketIt/issues/11) |
| D8 | In-flight manual revocation and non-budget execution limits | Subsequent actions must observe revoked authority. Define already-dispatched handling and reasonable technical loop/time limits separately from deferred spending budgets. Cancellation cannot promise to undo completed external effects. | [M5 control rules](https://github.com/cristoforows/ticketIt/issues/6); verify in M7/M8 adapters |
| D9 | Version and workspace retention/cleanup | Historical input/delivery preservation is approved. Define recipe/skill retirement, partial-output handling, and worktree cleanup without removing retained versions or owner work. Prefer explicit cleanup over unapproved destructive automation. | [M6 input versions](https://github.com/cristoforows/ticketIt/issues/7); [M7 Reports](https://github.com/cristoforows/ticketIt/issues/8); [M8 workspaces](https://github.com/cristoforows/ticketIt/issues/9) |

## What M1 learned, per decision

### D1 — Enforceable OpenCode action boundary and disconnect behavior — **FAILED GATE (partial)**

M1 ran the central S2 experiment this decision asked for, against a real
pinned OpenCode process (`opencode-ai`/`@opencode-ai/sdk` `1.18.31`) and
against the native `createAgent` path. Record both sides fairly:

- **What is enforceable.** A `tool.execute.before` plugin hook, backed by
  an externally-owned `AdmissionLedger` reached over a loopback HTTP
  facade, gates the shell tool and survives both of OpenCode's own known
  permission bypass vectors: an engine-remembered **"always"** approval
  (the hook still ran and still denied a revoked grant even though the
  engine's own prompt was permanently suppressed for that
  pattern — [20-opencode-admission.md](evidence/m1/20-opencode-admission.md),
  "Critical interaction with issue #17's finding") and the **ambient
  `OPENCODE_PERMISSION` environment variable** that independently defeats
  OpenCode's own native permission config (the hook still denied while the
  ambient variable silently turned the native `"ask"` into
  `"allow"` — [21-opencode-coverage-matrix.md](evidence/m1/21-opencode-coverage-matrix.md),
  "Priority 1"). Under `gateAllTools`, every built-in tool and a custom
  plugin-registered tool were each independently admitted/denied by the
  same hook with no new mechanism
  ([21-opencode-coverage-matrix.md](evidence/m1/21-opencode-coverage-matrix.md),
  "Priority 4"/"Priority 5"). The native path's tool and model admission
  points show the same disconnect/expiry/revocation/Stop behavior
  ([24-native-admission.md](evidence/m1/24-native-admission.md)).
- **What is not enforceable.** **Model-only continuation is structurally
  ungated at this hook position.** Three scripted text-only turns, fully
  disconnected throughout, produced zero `admit()` calls — `tool.execute.before`/`.after`
  fire only on tool dispatch, so a model that keeps producing assistant
  text (including a fabricated claim of completed work) has no
  associated event for any hook at this position to intercept. This is
  not a bug in this bridge's implementation; it is a permanent property of
  gating at this hook
  ([21-opencode-coverage-matrix.md](evidence/m1/21-opencode-coverage-matrix.md),
  "Priority 2"). **Nested shell sub-actions get a single whole-call
  admission with no visibility inside it**: one admitted "bash" call that
  internally ran a git commit, a git push over a fake-SSH transport, and a
  loopback HTTP request produced exactly one `admit()`/dispatch pair for
  all three sub-actions, each independently confirmed to have actually
  happened via evidence outside the ledger
  ([21-opencode-coverage-matrix.md](evidence/m1/21-opencode-coverage-matrix.md),
  "Priority 3"). **Only the shell tool is gated under this bridge's
  default configuration** — every other built-in tool is completely
  ungated unless a deployment explicitly turns on `gateAllTools` or an
  equivalent explicit list; the mechanism generalizes, but today's default
  does not. **A local stdio MCP tool could not be made dispatchable at
  all** on this pinned build — the connection reports "connected" and the
  `tools/list` handshake succeeds, but a call under the tool's own name is
  classified as the engine's internal `"invalid"` placeholder and never
  reaches any hook, so its coverage could not be evaluated either way
  ([21-opencode-coverage-matrix.md](evidence/m1/21-opencode-coverage-matrix.md),
  "Priority 5").
- **Verdict.** Live admission is enforceable for dispatched tool actions —
  including against both of OpenCode's own permission bypass vectors — and
  is **not** enforceable for model continuation at this integration
  point. Per this decision's own text ("If required behavior cannot be
  gated, choose an integration change or obtain an explicit requirement
  decision"), the requirement cannot be met by a plugin hook alone: closing
  the model-only-continuation gap or the nested-shell granularity gap, if
  either is required, needs a different mechanism entirely (candidate
  mechanisms — session/process abort on disconnect or Stop, a
  wrapper/supervisor turn-or-time budget, a `bash`-replacement binary that
  calls back into the ledger per sub-command, host-level network policy,
  git hooks — are proposed only, in
  [21-opencode-coverage-matrix.md](evidence/m1/21-opencode-coverage-matrix.md)'s
  "Decision impacts," none built or endorsed). The MCP-tool gap is recorded
  as an open risk, not assumed safe in either direction, and needs
  re-verification before any coverage claim for that path.

### D2 — Human-review evidence for PR completion and agent merge authority

Not resolved by M1, and not expected to be — M1's github-delivery slices
established a constraint any resolution must account for, nothing more.
The Connected Account identity that authors commits/PRs is architecturally
independent of the Owner's OAuth sign-in identity, and both are
independently configured/verified in the fixtures
([27-github-identity.md](evidence/m1/27-github-identity.md)): the same
physical person controlling both accounts provides no automatic proof of
*human* review versus *agent* action through the same account. Separately,
`DeliveryModule` was built with no merge-capable method at all and
`injectMerge` deliberately bypasses identity to simulate a human acting
directly on GitHub — demonstrating (not deciding) one bounded
action-surface option this decision's own text names: "owner-controlled
merge plus a clearly bounded supported action surface"
([28-pr-delivery-lifecycle.md](evidence/m1/28-pr-delivery-lifecycle.md)).
An observed merge fact (`merged: true`) proves only that GitHub's state
shows the PR merged; it proves nothing about who performed it or whether a
human reviewed the change.

### D3 — Agent/template compatibility and human-assigned workflow

**Status: Resolved by the [Owner's decision on #13](https://github.com/cristoforows/ticketIt/issues/13#issuecomment-5743245026).**
The original proposal restricted Basic/Coder and Coding/Researcher assignment.
The Owner rejected those restrictions and approved the human workflow and existing
execution/field-lock rules. [The accepted D3 decision](decisions/d3-agent-template-compatibility.md)
records all six assignment combinations as allowed by design, best-effort Agent work,
and required-input/action validation independently of templates. Rounds may contribute
without completing the whole Ticket; reassignment preserves completion and history.
Temporary MVP limitations are allowed as explicit implementation limitations with
follow-up work. D2 review evidence, D4 exceptional PR transitions, and D5 stranded
recovery remain open. This resolution comes from the Owner, not an experiment result.

### D4 — Exceptional PR and template/repository changes

Not resolved by M1, per the delivery-lifecycle issue's own instruction.
Both exceptional cases this decision names were exercised with real
observed data and recorded as explicit **undefined transitions**, never
inferring a status change: a closed-unmerged PR (`kind: "closed-unmerged"`)
and a merge observed while a Round is open (`kind: "merge-during-open-round"`),
each leaving Ticket status completely unchanged and preserving the prior
delivery
([28-pr-delivery-lifecycle.md](evidence/m1/28-pr-delivery-lifecycle.md)).
A future D4 resolution can consume the recorded `observed` payloads
directly.

### D5 — Stranded runner and stop recovery — process-death findings

M1 ran process-death scenarios on both engines and recorded consistent
findings neither of which resolves D5, but both of which are concrete
inputs for the real claim-epoch/runner-report reconciliation M5 owns:

- **A killed OpenCode server leaves the tool's own child process running.**
  `SIGKILL` to the OpenCode server process does not propagate to a
  shell tool's already-spawned child (a backgrounded `sleep` survived in
  5/5 trials); nothing in the harness or this pinned build cleans up that
  orphan. By contrast, a *clean* `session.abort()` reliably kills the
  child within 0–1ms
  ([18-opencode-cancellation.md](evidence/m1/18-opencode-cancellation.md),
  scenario 4).
- **History survives a restart; pending state does not.** After restarting
  an OpenCode server against the same on-disk storage, session/message
  history — including the interrupted tool part, permanently stuck at
  `"running"` — is recoverable; a pending permission/question request is
  not (in-memory only, confirmed empty after restart even though the
  message history that raised it is intact)
  ([18-opencode-cancellation.md](evidence/m1/18-opencode-cancellation.md),
  scenario 4). The native path shows the checkpoint-shape analog: a
  mid-tool-call `SIGKILL` leaves a checkpoint scheduled-but-incomplete with
  no pending interrupt, which the application's own recovery policy
  refuses to auto-continue — even though LangGraph itself would have
  happily continued and re-run the pre-interrupt side effect, demonstrated
  by a clearly labeled negative-control test
  ([23-native-durable-input.md](evidence/m1/23-native-durable-input.md),
  scenario 5).
- **Abort during a wait leaves a request that accepts a reply with no
  effect, then reports not found.** Aborting a session while a permission
  request is pending does not clear that request; a reply afterward still
  returns success (`{ok: true}`) but the scripted action never actually
  runs — a caller cannot distinguish "my reply executed the action" from
  "my reply was silently accepted into a dead turn" from the reply's
  return value alone. A *second* reply to that same now-consumed request
  then fails with `PermissionNotFoundError`, the identical error a genuine
  duplicate reply produces
  ([18-opencode-cancellation.md](evidence/m1/18-opencode-cancellation.md),
  scenario 2).

### D6 — Grill Mode configuration and scheduling

Untouched by M1. No M1 evidence record exercises Grill Mode; it remains
routed to M7 in full.

### D7 — Runtime/provider selections

Untouched by M1, deliberately. No M1 experiment selected a provider,
model, hosting target, or object storage — every evidence record's
"Decision impacts" section confirms this explicitly, and
`experiments/README.md`'s workspace rules forbid it inside M1. The
OpenRouter adapter-fidelity findings (S4) and the OpenCode/native
admission mechanism findings (S2) apply to whichever choices D7 eventually
makes, but do not lean toward any of them.

### D8 — In-flight manual revocation and non-budget execution limits — in-flight and limit findings

- **Already-dispatched actions complete.** Across every admission
  substitute M1 built (the ledger itself, the OpenCode bridge, the native
  path, the GitHub delivery gate), an action already dispatched before a
  disconnect, expiry, or revocation is allowed to finish, and its
  completion is recorded independent of the later state change
  ([15-admission-ledger.md](evidence/m1/15-admission-ledger.md),
  [20-opencode-admission.md](evidence/m1/20-opencode-admission.md) scenario
  2, [24-native-admission.md](evidence/m1/24-native-admission.md) scenario
  2). This is this experiment work's own chosen behavior for the "already-dispatched
  handling" language, not a resolution: `docs/agent-execution.md` itself
  still marks in-flight revocation handling as open.
- **The hold-poll bound and the absence of an engine-level retry loop are
  inputs, not resolutions.** The OpenCode admission bridge's bounded
  hold-poll window (~4.5s default) is this experiment's own implementation
  choice, not a specified value
  ([20-opencode-admission.md](evidence/m1/20-opencode-admission.md)). No
  engine-level automatic retry loop was observed after a denial at either
  the OpenCode hook or the native admission boundary — the engine asks the
  model again rather than re-invoking the same denied tool call — but
  whether a *model* would itself choose to keep retrying a denied action is
  unconstrained by anything either bridge enforces. This is exactly the
  "reasonable technical loop/time limits" gap D8 is scoped to define, not
  something M1 bounded.
- **A pre-interrupt side effect repeats on resume in the native path.**
  LangGraph restarts an interrupted node from the beginning; a side effect
  placed before `interrupt()` in the same node observably re-runs on every
  resume attempt of that node, confirmed directly
  ([23-native-durable-input.md](evidence/m1/23-native-durable-input.md),
  scenario 4). The corresponding requirement: any side effect that must
  not repeat has to be placed after the interrupt point, or be made
  idempotent.
- Also relevant: an orphaned host shell process surviving a killed
  OpenCode server (see D5 above) is itself a D8-scoped "loop/time limit"
  gap — a host-level process can run indefinitely with no engine- or
  supervisor-level mechanism observed to bound it
  ([18-opencode-cancellation.md](evidence/m1/18-opencode-cancellation.md)).

### D9 — Version and workspace retention/cleanup — ambient-configuration leak

M1's fixed-inputs experiment found the concrete failure mode this decision
needs to account for: an ambient `OPENCODE_CONFIG` environment variable
left in a shared runner's environment — never set by ticketIt/Michelin
itself, and not cleared by this harness's own isolation — has its
`instructions` array **concatenated** into an unrelated new Round's
request rather than replaced by the Round's own later configuration
source, and a same-shaped `OPENCODE_PERMISSION` variable silently
overrides a Round's own configured permission action
([19-opencode-fixed-inputs.md](evidence/m1/19-opencode-fixed-inputs.md)).
Both are recorded as failed gates for D1 and, per that evidence record's
own routing, for D9: at bottom this is a version/scope-boundary question
— content from outside any Round's own history reaching into a Round it
has no connection to. Separately and non-failing: instructions-file
immutability across a pause is an application-discipline property (never
rewrite an already-open Round's path), not an engine-enforced snapshot,
since instructions-file content is re-read fresh from disk on every
completion request even though Skill bodies and config JSON structure are
cached after first load. Whether a real deployment gives each Round a
genuinely fresh isolated global-config-equivalent location, or shares one
persistent location across Rounds/Tickets on a runner host (and if shared,
what stops a stray write between Rounds from reaching the next Round's
boot), remains a genuinely open production-topology question for whichever
milestone designs the real OpenCode runner's directory layout (M7/M8).

## Known robustness items from M1 (follow-ups, not decisions)

These are not open product/integration decisions; they are implementation
robustness gaps M1 observed and recorded rather than fixed, since fixing
them was out of scope for a bounded adapter proof. Tracked here so they
are not lost before the milestone that would fix them:

- **Timing sensitivity under heavy parallel load.** The
  `opencode-cancellation` suite (11 tests) passed 11/11 when run alone,
  repeatedly, but failed 3 of 11 when run concurrently with heavy parallel
  load from other work in the same environment. The suite's polling-based
  assertions (bounded retry loops, not fixed sleeps) are not fully immune
  to host contention. Not root-caused further within M1's scope; a future
  milestone that runs this suite in CI alongside other concurrent work
  should budget for this or increase timeouts/isolation.
  ([18-opencode-cancellation.md](evidence/m1/18-opencode-cancellation.md))
- **Unhandled rejection on ledger HTTP facade network failure.** The
  OpenCode admission bridge's plugin has no distinct handling for a
  fetch-level network error talking to the ledger (e.g. connection
  refused) — every "disconnect" M1 exercised was the ledger's own
  `setConnected(false)` flag, not a genuinely killed/unreachable HTTP
  server. A real network failure of that facade would currently surface as
  an unhandled rejection inside the hook rather than a clean deny.
  ([20-opencode-admission.md](evidence/m1/20-opencode-admission.md),
  "Observed limitations")
- **The MCP dispatch failure is an unexplained open risk.** A local stdio
  MCP tool connects and completes the `initialize`/`tools/list` handshake
  correctly, but never becomes dispatchable on this pinned OpenCode build —
  the engine classifies a call under the tool's own name as its internal
  `"invalid"` placeholder instead of routing it to any hook. The root
  cause (a further undiscovered protocol requirement, or a genuine gap in
  this pinned build's local-MCP wiring) was not identified. This must not
  be assumed either safe (never executes, nothing to gate) or unsafe (a
  missed execution path) — it needs re-verification before any coverage
  claim for MCP tool paths on a future pinned version.
  ([21-opencode-coverage-matrix.md](evidence/m1/21-opencode-coverage-matrix.md),
  "Priority 5")

## What M2 observed, per decision

M2's application slices (#49–#61, gate-reported at
[#62](https://github.com/cristoforows/ticketIt/issues/62)) resolve no
open decision — the observations below are what M2's implementation
confirmed or newly surfaced for decisions D3's acceptance already
touches, recorded per this document's own "Updating decisions" rule.
D1, D5, D6, D7, D8, D9 are untouched: M2 has no Agent, Round,
execution, Grill Mode, storage, or hosting concept of any kind.

### D3 — Agent/template compatibility and human-assigned workflow — implemented, not further resolved

M2 is the first milestone to build against the Owner's accepted
decision. [#59](https://github.com/cristoforows/ticketIt/issues/59)
implements the Template/completion-condition rule (a Template supplies
presentation, required information, and a default completion condition
only, retained independently of later edits); [#60](https://github.com/cristoforows/ticketIt/issues/60)/[#61](https://github.com/cristoforows/ticketIt/issues/61)
implement §2's human-assigned Status table, the explicit Accept
command, and Owner assignment. Both are proven by tests that would fail
if a real Template-to-Agent/engine mapping were added
(`TestNoTemplateToCapabilityMapping`, extended to catch a
string-literal form found during review) and if a manual command ever
created an execution artifact
(`TestManualLifecycleActionsCreateNoExecutionRecords`, real PostgreSQL,
demonstrated actually failing against a phantom table name). Neither
test result changes D3's own status — the Owner resolved it on #13
before M2 began; M2 only exercises it.

### D2 — Human-review evidence for PR completion and agent merge authority — M2 observation

Unresolved, as before. M2 makes the consequence of that in a
human-assigned world concrete: a `reviewedPrMerge` Ticket (Coding
Template) cannot reach Done anywhere in M2, by design.
`AcceptTicket` rejects it with a distinct `reviewed_pr_merge_not_implemented`
code naming D2 and M8 directly in its message
([#60](https://github.com/cristoforows/ticketIt/issues/60)), and
Swiftlet's own Accept control shows that exact reason rather than
hiding the control or silently downgrading the completion condition to
`humanAcceptance` ([#61](https://github.com/cristoforows/ticketIt/issues/61)).
No code path anywhere in Galley writes `completion_condition` outside
Ticket creation, so this cannot be worked around by mistake before M8
resolves D2.

### D4 — Exceptional PR and template/repository changes — M2 observation

Unresolved, as before. D3 §2's own transition table notes `Done →
Ready` is allowed "subject to D4 for an already-merged PR"; M2 permits
that transition **unconditionally**, with no PR-merge-aware
restriction of any kind, since D4 is explicitly out of scope for
[#60](https://github.com/cristoforows/ticketIt/issues/60) and remains
unresolved. This is a recorded, explicit gap, not a silent narrowing —
D4 is still owned by M8, and a future resolution can add the missing
precondition to `ChangeTicketStatus`'s existing `Done` source-status
entry without redesigning the transition mechanism itself.

## Engineering decisions within the approved design

These need implementation design and validation, but not new user-facing scope by default:

- Frontend tooling, Go router/data-access layer, package manager, test tools, and API schema/code generation.
- Owner bootstrap, app-session transport, runner pairing/credential lifecycle, and local secret-storage mechanism.
- Round/engine ID mapping, claim fencing, command/event deduplication, checkpoint persistence, and notification reconciliation.
- Concrete permission actions/resources, precedence, storage access, and engine adapter mappings within D1/D3.
- Queue ordering for the simple sequential scheduler; persistent ordering must be documented rather than accidentally determined by database queries.
- Recipe/skill/report upload limits, Markdown rendering, and version/object metadata consistency.
- Usage normalization, provider cost reconciliation, missing-data quality flags, and active/wait/disconnect timing.
- GitHub synchronization transport, worktree paths/setup, process supervision, and durable pending controls.

These decisions must not change approved invariants such as manual requeue, read-only open tickets, separate temporary-grant kinds, immutable execution inputs, live permissions, and template-independent agents.

## Known operational selections awaiting the owner

- **Object storage:** Cloudflare R2 or Supabase Storage.
- **Model defaults:** native OpenRouter model and OpenCode provider/model credentials.
- **Deployment provider:** must fit limited personal use below $10/month excluding OpenRouter; sleep/cold starts acceptable with persistent data.

The hosting-comparison acceptance ticket is a demonstration after a provisional installation exists. Select that initial installation independently; the future app cannot provision its own prerequisite infrastructure through a scenario it cannot yet execute.

## Deferred work is not an unresolved v1 requirement

Container isolation and the messaging-connected Manager Agent are v2 priorities. Booths, sprints, custom templates, RAG, editors, skill bundles, budget enforcement, additional account/storage providers, web-managed credentials/multiple owners, and remote/service-packaged runners remain later work unless explicitly promoted.

## Updating decisions

When a decision is made, update this register, the affected detail document, and the scope/plan if behavior changes. Add an ADR only for a hard-to-reverse, surprising choice made through a real trade-off. Do not put implementation decisions into the domain glossary.
