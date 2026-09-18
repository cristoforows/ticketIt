# Open decisions

The [v1 scope](v1-scope.md) records approved behavior. Items below remain unresolved; recommendations are proposals, not accepted changes. Resolve each choice before implementing its affected behavior in the owning milestone rather than reopening the whole design.

Milestone references use the approved M1–M10 [implementation plan](implementation-plan.md) and its published issues. Publishing the plan did not resolve these choices. M1 establishes foundational contracts and routes later choices to their owning milestones.

## Product and integration decisions

| ID | Decision | Why it matters / recommendation to evaluate | Resolution gate |
| --- | --- | --- | --- |
| D1 | Enforceable OpenCode action boundary and disconnect behavior | Prove live admission for every enabled path. Registered-tool hooks may not cover model-only continuation, shell internals, provider tools, or direct APIs. Respect the accepted direct-host v1 scope, but do not advertise unsupported granular controls. If required behavior cannot be gated, choose an integration change or obtain an explicit requirement decision. | [M1 proofs](https://github.com/cristoforows/ticketIt/issues/2); [M8 live coding gate](https://github.com/cristoforows/ticketIt/issues/9) |
| D2 | Human-review evidence for PR completion and agent merge authority | A personal PR may be authored through the same identity that reviews/merges it; a separate GitHub approval may not be available. Define what demonstrates owner review and ensure agent access cannot silently replace the human completion decision. Evaluate owner-controlled merge plus a clearly bounded supported action surface. | [M8 review/merge implementation](https://github.com/cristoforows/ticketIt/issues/9) |
| D3 | Agent/template compatibility and human-assigned workflow | Templates are not work types. Define supported v1 execution capabilities, repository requirements, and manual completion/rework without deriving completion from engine. Evaluate explicit capability validation and preserving the template-derived completion condition through reassignment. | [M1 foundational contract](https://github.com/cristoforows/ticketIt/issues/2); apply in M2, M4, and M8 |
| D4 | Exceptional PR and template/repository changes | Define closed-unmerged PRs, reopening a ticket after merge, merge arrival during an open round, and changes to repository/template after delivery. Same-PR reuse is approved only until merge. Preserve prior deliveries; never infer a new PR or successful completion without a defined transition. | [M8 coding lifecycle](https://github.com/cristoforows/ticketIt/issues/9) |
| D5 | Stranded runner and stop recovery | A lost connection does not prove execution ended, yet editing/archive require an ended round. Define evidence and owner recovery authority when a runner never returns. Evaluate explicit recovery with stale-execution fencing; no automatic duplicate execution or false stop confirmation. | [M5 controlled recovery](https://github.com/cristoforows/ticketIt/issues/6) |
| D6 | Grill Mode configuration and scheduling | Choose its model/profile, context access, field-application review, and scheduling relative to the single active round. Preparation needs the local service but is not an execution round. Evaluate the native configuration plus persisted interview state; do not silently create a parallel execution lane. | [M7 preparation workflow](https://github.com/cristoforows/ticketIt/issues/8) |
| D7 | Runtime/provider selections | Owner to choose R2 or Supabase Storage. Select application/PostgreSQL hosting, native OpenRouter model, and OpenCode model/auth source. OpenRouter is approved for native research, not automatically every OpenCode configuration. Validate tool/search support and below-$10/month hosting. | [M6 storage](https://github.com/cristoforows/ticketIt/issues/7); [M7 native model](https://github.com/cristoforows/ticketIt/issues/8); [M8 OpenCode](https://github.com/cristoforows/ticketIt/issues/9); [M10 hosting](https://github.com/cristoforows/ticketIt/issues/11) |
| D8 | In-flight manual revocation and non-budget execution limits | Subsequent actions must observe revoked authority. Define already-dispatched handling and reasonable technical loop/time limits separately from deferred spending budgets. Cancellation cannot promise to undo completed external effects. | [M5 control rules](https://github.com/cristoforows/ticketIt/issues/6); verify in M7/M8 adapters |
| D9 | Version and workspace retention/cleanup | Historical input/delivery preservation is approved. Define recipe/skill retirement, partial-output handling, and worktree cleanup without removing retained versions or owner work. Prefer explicit cleanup over unapproved destructive automation. | [M6 input versions](https://github.com/cristoforows/ticketIt/issues/7); [M7 Reports](https://github.com/cristoforows/ticketIt/issues/8); [M8 workspaces](https://github.com/cristoforows/ticketIt/issues/9) |

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
