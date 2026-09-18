# V1 implementation plan

**Status:** proposed sequencing of the [approved v1 scope](v1-scope.md); no application implementation or runtime validation has been completed. Unresolved product choices are not silently decided by this plan.

## Delivery approach

Build independently verifiable vertical slices across Swiftlet, Galley, and Michelin. Prove the difficult engine boundaries early, then deliver native research before coding. Both execution paths are required for v1 completion.

```text
M0: decisions + feasibility gates
          ↓
M1: owner + manual ticket slice
          ↓
M2: controlled, durable simulated round
          ↓
M3: native research + stored deliverable
          ↓
M4: preparation + configuration + full review UI
          ↓
M5: OpenCode coding + PR lifecycle
          ↓
M6: reporting + deployment + full acceptance
```

Milestones are dependencies, not estimates. Frontend scaffolding and engine experiments can proceed in parallel after agreeing contracts; coding rollout cannot bypass its permission/control gates.

## M0 — Close blocking contracts and verify integrations

**Output:** pinned engine/SDK versions, a tested integration contract, and recorded decisions required by the next milestones.

- Resolve the initial items identified in [open-decisions.md](open-decisions.md), especially supported agent/template combinations and human-review evidence.
- Run the five bounded experiments in [integration-feasibility.md](integration-feasibility.md): lifecycle/control, live admission, snapshots/HITL, provider wire fidelity, and GitHub delivery.
- Start with deterministic model/API fixtures and fake clocks. Record exactly which behavior is stub-verified and which still requires a real selected-model test.
- Pin the OpenCode executable and SDK together. Treat mutable upstream documentation as evidence to test, not a release guarantee.
- Select a provisional deployment/database and get owner confirmation of R2 or Supabase Storage before deployed research acceptance. Check persistence and cold-start behavior against the below-$10/month constraint.

**Exit gate:** an explicit list of supported execution paths and enforceable permissions. If OpenCode cannot prevent required new actions during disconnect/revocation, change the integration design or seek a requirement decision before promising that path. Do not relabel abort/restart as pause/resume.

## M1 — Owner and manual ticket slice

**Depends on:** M0 domain/API decisions; does not need live models.

- Scaffold independent `apps/swiftlet`, `apps/galley`, and `apps/michelin` projects with documented build/test entry points. Establish `contracts/` for APIs and generated-client configuration.
- Add PostgreSQL migrations and explicit ownership. Implement configured-owner GitHub OAuth sign-in and a ticketIt session distinct from connected-account authorization.
- Implement title-only Backlog capture, Basic/Coding templates, manual guidance, owner/agent assignment representation, badges, and completion-condition metadata.
- Deliver list and board views, ticket full-page route, modal navigation, and archive/restore rules. Start with manual tickets so the lifecycle is useful before engines connect.
- Centralize field validation, allowed commands, archive eligibility, and transition checks in Galley rather than UI-only restrictions.

**Verify:** non-owner access denied; creation works with title only; insufficient tickets cannot become agent-ready through either status or assignment changes; archive preserves records and restores Ready as Backlog; frontend and backend build/test independently.

## M2 — Controlled, durable round with a simulated engine

**Depends on:** M1 plus passing control/admission experiments from M0.

- Pair/authenticate Michelin with Galley through outbound requests. Define runner health, eligible-work claims, progress, pending questions, permission requests, stop requests, and reconciliation APIs.
- Use durable round IDs distinct from engine session/thread IDs. Define command/event IDs and deduplication before adding external side effects.
- Atomically validate eligibility and claim work in PostgreSQL. Start with sequential execution and explicit handling of a paused round retaining its slot.
- Implement immutable execution snapshots and live permission resolution, including separate ticket/time grant lifetimes and full-access bounds.
- Exercise the whole lifecycle with a deterministic engine: delivery, question/answer, grant approval/expiry/revocation, Stop, disconnect, process death, failure, and explicit rework.
- Implement locked fields and View/Stop controls from actual round state, including Waiting for Input and Runner disconnected. Only confirmed stop unlocks and adds Stopped.
- Persist usage/activity from the beginning, even when the engine is simulated, to establish provenance and no-double-counting rules.

**Verify:** competing claims produce one round; duplicate events/answers do not repeat work; archived work cannot start; pending Stop beats continuation on reconnect; ended rounds never auto-restart; abandoned runner handling follows an explicitly agreed recovery policy.

## M3 — Native research vertical slice

**Depends on:** M2, provider fidelity/snapshot gates, and selected test storage connection.

- Connect LangChain TypeScript `createAgent` and a durable LangGraph checkpointer behind the native-engine adapter.
- Resolve runner-local OpenRouter credentials and explicit model configuration. Verify tool calling, built-in web search, citations, usage, and cost handling through the pinned adapter paths.
- Add reusable agent configuration and self-contained skill-version selection sufficient for the Researcher preset.
- Implement recipe upload/preview/replacement, ticket links, immutable versions, and document retrieval through authorized storage access.
- Execute a Basic-template ticket through Ready → In Progress → In Review with a rendered/downloadable Markdown report in its round section; owner acceptance yields Done.
- Preserve partial results and incomplete usage on failure/stop. Reconcile storage writes with database metadata without publishing a nonexistent report or counting duplicate delivery twice.

**Verify:** research cites supplied recipe versions and web sources; updating recipes/skills/settings during a round cannot alter its inputs; permission changes still apply; report retrieval enforces ownership; rework produces a separate round/result rather than replacing history.

This is the first working end-to-end AI slice, not the completed v1 release.

## M4 — Preparation and full owner workflow

**Depends on:** M3; uses shared round controls rather than another lifecycle implementation.

- Implement optional Grill Mode on a saved Backlog ticket: persisted questions/answers, resumable interview, proposed field content, and preparation usage. Finalize its agent configuration and scheduling rule first.
- Complete the agent-profile editor for names/instructions, engines, providers/models, skills, and supported permissions. Display fixed or unsupported settings accurately.
- Complete recipe/skill libraries with upload, preview, and replacement versions. Skill uploads explicitly support a self-contained `SKILL.md`, not missing companion assets.
- Complete badge controls, Archived filter, ticket modal/full-page parity, reports/PR sections, and active/waiting/stopping/disconnected presentation.
- Add the food-delivery-themed animation while keeping state and controls understandable when animation is reduced or absent.

**Verify:** unfinished interviews and their costs survive navigation/restart; interview completion does not start execution; the same detail component respects field locks in modal and full-page views; Stopped removal is manual and does not change historical outcomes.

## M5 — Managed OpenCode coding slice

**Depends on:** M2 control contract, M0 OpenCode/GitHub gates, and M3/M4 shared records and UI.

- Configure repository identity → local checkout mapping. Create a per-ticket worktree/branch without altering the owner's normal checkout; define setup and explicit cleanup policy before deleting any workspace.
- Supervise the pinned headless OpenCode process. Materialize fixed agent/skill inputs and validate effective configuration against ambient/global/project settings.
- Translate questions, permission requests, activity, usage, delivery, and errors into the shared contract. Prevent supported new model/tool/API admissions when disconnected or unauthorized, using the proven integration mechanism.
- Use the verified local GitHub identity and fine-grained PAT for API actions; configure Git SSH identity and commit metadata separately. Do not use the development agent's `gh` profile as product authentication.
- Publish a draft PR through the authorized connection and attach summary, tests/results, success-criteria assessment, and delivered commit to the round.
- Synchronize comments/reviews without automatic requeue. Rework updates the same worktree/branch/PR until merge. Implement the approved human-review evidence and PR exception policies.
- Transition a merge-completion ticket to Done once the qualifying reviewed PR is merged; expire ticket-based grants atomically with completion.

**Verify:** use a small authorized fixture repository for real delivery acceptance after mock tests; wrong identity/resources rejected; draft PR duplication avoided on retries; feedback does not trigger work; previous commit/delivery remains inspectable; token/SSH access and documented host limitations are accurately represented.

## M6 — Accounting, deployment, and v1 acceptance

**Depends on:** all preceding slices.

- Finish the dashboard and filters using records collected since M2: preparation/execution totals, per-round detail, active and human-wait time, and retained archived-ticket costs.
- Reconcile provider-reported costs and estimates; preserve raw provenance. Handle reasoning/cache tokens, late/partial usage, and duplicate messages without pretending unavailable costs are zero.
- Package Swiftlet and Galley for the selected host while retaining separate application boundaries. Document PostgreSQL migrations, owner bootstrap, object storage, OAuth callback configuration, Michelin pairing, local credentials, OpenCode installation, and repository setup.
- Document persistence/backups and cold-start/reconnect behavior appropriate to the selected providers. Validate the below-$10/month hosting estimate separately from model/search spend.
- Run the research, coding, and control/recovery scenarios in [acceptance-scenarios.md](acceptance-scenarios.md).
- Publish actual setup/build/test commands once they exist. No v1 budget enforcement is introduced through reporting work.

**Exit gate:** both real execution paths meet agreed behavior and the owner can operate the app using the documented setup. Record any unavailable provider metrics or engine capability limits explicitly; unresolved required behavior is not a passed acceptance case.

## Proposed boundaries and records

These are implementation recommendations, not a frozen database schema or new product concepts.

| Area | Responsibilities / records |
| --- | --- |
| Identity | Owner, login identities, app sessions, runner registration, connected-account references |
| Tickets | Template defaults, ticket fields, completion condition, assignment, status, badge links, archive flag |
| Execution | Work request/claim, round, engine execution reference, immutable input/config versions, commands/events, pending questions |
| Authorization | Presets, scoped grants, mutually exclusive temporary lifetime, expiry/revocation, admission decisions |
| Documents | Recipe/skill versions, ticket recipe links, report metadata, immutable storage references |
| Delivery | Repository registration, worktree/branch, PR association, per-round delivered commit/result |
| Accounting | Preparation/round usage observations, provider generation/message IDs, estimate provenance, time intervals |

Galley alone changes authoritative domain records. Michelin reports facts and requests actions; Swiftlet renders state and submits owner commands. Framework checkpoints and engine histories are execution records, not substitutes for the application's state machine.

## Engineering choices to make during implementation

Select frontend tooling, Go routing/data-access libraries, package manager, contract format, transport, migration tooling, and test runners based on these boundaries. They are not yet approved product requirements. A practical starting direction is schema-described HTTP APIs and generated clients, PostgreSQL-backed work claims, and polling/reconciliation before adding another queue service.

Keep permission admission, credentials, storage, engine execution, and host process/workspace handling behind narrow interfaces. Future extensibility does not require building a universal workflow engine in v1.

## Verification discipline

- Test observable lifecycle invariants and race conditions with real PostgreSQL transactions where relevant.
- Use deterministic fake engines/providers for retries, cancellation, expiry, and disconnects; cover the real adapters separately.
- Use selected-model and authorized GitHub smoke tests to validate the integrations fixtures cannot prove.
- Limit UI tests to complete workflows and critical locks/navigation, rather than duplicating component implementation details.
- Record test evidence at each milestone and update affected docs when decisions change.
