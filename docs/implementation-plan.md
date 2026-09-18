# V1 implementation plan

**Status:** approved ten-milestone plan, published as issues #2–#11 against [v1 spec #1](https://github.com/cristoforows/ticketIt/issues/1). Application implementation and runtime validation have not started. Unresolved product choices remain in [open-decisions.md](open-decisions.md).

This document mirrors the published milestone scope and native blocking relationships. The linked issues hold acceptance checklists and current execution status; keep the plan and affected detail docs aligned when that scope or sequencing changes. [V1 scope](v1-scope.md) records the approved product behavior.

## Delivery approach

Each milestone spans multiple implementation sessions. Before implementing it, split its scope into independently verifiable vertical slices using the code and contracts that exist at that point. Each slice should state what already exists, the observable behavior it adds, and its stopping/verification point, introducing at most one substantial new mechanism.

Make foundational work explicit: boot the browser/API path, establish persistence, then add authentication and Ticket behavior. Likewise, connect Michelin before claiming work, then add execution start, progress, and delivery. Touching several applications is acceptable when the change reuses established boundaries; building several foundations and a feature in one task is not the intended unit of work.

| Milestone | Published issue | Blocked by |
| --- | --- | --- |
| M1 | [#2 — Foundational decisions and integration proofs](https://github.com/cristoforows/ticketIt/issues/2) | None |
| M2 | [#3 — Application foundations and persistent owner workflow](https://github.com/cristoforows/ticketIt/issues/3) | M1 |
| M3 | [#4 — Planning, navigation, and Ticket organization](https://github.com/cristoforows/ticketIt/issues/4) | M2 |
| M4 | [#5 — Connected runner and durable controlled Rounds](https://github.com/cristoforows/ticketIt/issues/5) | M3 |
| M5 | [#6 — Human input, live Permissions, and execution recovery](https://github.com/cristoforows/ticketIt/issues/6) | M4 |
| M6 | [#7 — Agent configuration and versioned Skills/Recipes](https://github.com/cristoforows/ticketIt/issues/7) | M4 |
| M7 | [#8 — Native research, Reports, and Grill Mode](https://github.com/cristoforows/ticketIt/issues/8) | M5, M6 |
| M8 | [#9 — Managed coding and GitHub delivery lifecycle](https://github.com/cristoforows/ticketIt/issues/9) | M5, M6 |
| M9 | [#10 — Usage accounting and owner reporting](https://github.com/cristoforows/ticketIt/issues/10) | M7, M8 |
| M10 | [#11 — Deployment, operational setup, and v1 acceptance](https://github.com/cristoforows/ticketIt/issues/11) | M9 |

Work the frontier: a milestone can start when its blockers are complete. M5 and M6 can proceed independently after M4; both M7 and M8 require M5 and M6, but neither requires the other. Both real execution paths are required before M9 and release.

### When agentic behavior arrives

- **M1:** isolated adapter experiments, not application features.
- **M2–M3:** persistent manual Ticket tracker.
- **M4:** Agent assignment, queue, Michelin execution, results, and review using a controlled engine with scripted behavior.
- **M5–M6:** questions, live Permissions, recovery, configuration, Skills, and Recipes around controlled execution.
- **M7:** real native research and Grill Mode through LangChain/OpenRouter.
- **M8:** real coding through managed OpenCode, independently of research delivery.

## M1 — Foundational decisions and integration proofs

**Output:** tested architecture/execution contracts, pinned adapter versions, and evidence about supported integration paths.

- Resolve initial Agent/Ticket Template compatibility and human-assigned lifecycle rules without making the Agent determine completion.
- Establish Swiftlet/Galley/Michelin ownership and expected work-claim, event, question, stop, and reconciliation contracts. Keep Round identity separate from engine identity.
- Run the five bounded experiments in [integration-feasibility.md](integration-feasibility.md): lifecycle/control, live admission, fixed inputs/human input, provider payload fidelity, and GitHub delivery/identity.
- Start with deterministic model/API fixtures, fake clocks, and controlled application-interface substitutes. Pin the OpenCode executable and SDK together.
- Record actual results separately from documentation research and outstanding real-provider checks. Route later owner choices to their owning milestones in [open-decisions.md](open-decisions.md).

**Acceptance:** reproducible commands and observed results for each experiment; foundational rules documented; unsupported required behavior remains a failed gate requiring a decision. Abort is not assumed to be resumable pause, and worktrees are not a host sandbox. This milestone does not claim that the application or its AI features exist.

## M2 — Application foundations and persistent owner workflow

**Output:** the Owner can sign in, capture and refine a Ticket, and manage basic human-assigned work.

1. Boot Swiftlet and Galley, display backend-provided status, and establish independent builds and local startup.
2. Establish PostgreSQL migrations and prove persistence across restart with a development-only diagnostic.
3. Add configured-owner GitHub OAuth sign-in and a persisted ticketIt session distinct from account-action authorization.
4. Add title-only Backlog capture, a persisted list, and canonical full-page Ticket details.
5. Add goal, context, Success Criteria, constraints, and manual guidance.
6. Introduce Basic/Coding templates with retained completion conditions and implement supported human-assigned transitions in Galley. Coding execution stays unavailable until its prerequisites exist.

**Acceptance:** independent builds and the browser/API smoke path work before Ticket features; non-owner access is rejected; development diagnostics are unavailable in production; Tickets survive restart; capture/refinement require no AI; human assignment launches no automation; completion remains independent of assignment. Establish browser-to-backend tests with real PostgreSQL.

## M3 — Planning, navigation, and Ticket organization

**Output:** a consistent everyday tracker with board/list navigation, Badges, and archival behavior.

- Add a status-column board over the same Ticket collection and authoritative transition commands.
- Open details in a modal from board/list, preserving position; retain direct full-page URLs and Open full page.
- Create, attach, remove, and filter reusable custom Badges.
- Archive instead of permanently delete; retain history and exclude archived work from execution eligibility.
- Add the Archived filter and restoration: Ready returns to Backlog; other previous statuses are retained, including Done.
- Enforce editing and transition rules in Galley, not only in UI controls. Later execution work extends those rules to open Rounds.

**Acceptance:** board/list/modal/full-page state stays consistent; Badge workflows persist; archived records remain accessible; restoring Ready cannot authorize execution. Direct API requests obey the same rules as Swiftlet.

## M4 — Connected runner and durable controlled Rounds

**Output:** an Agent-assigned Ticket executes through Michelin's controlled engine, produces a retained result, and undergoes owner review.

- Introduce minimal reusable Agent configuration and assignment; pair/authenticate Michelin through outbound communication and show runner health.
- Validate Ready plus Agent assignment in either order, requiring a goal, Success Criteria, and capability-specific prerequisites.
- Atomically claim eligible work with sequential scheduling. Split connection, claim, execution start, progress, and delivery into implementation-sized steps.
- Create durable Rounds independent of engine sessions; Galley owns authoritative transitions and Michelin reports facts.
- Lock fields during open Rounds and keep execution independent of browser sessions.
- Persist activity, results, and initial usage observations from the start, with command/event deduplication.
- Deliver to In Review; implement human acceptance where applicable and explicit requeue creating a new Round.

**Acceptance:** competing claims produce one execution; queued work stays Ready until execution starts; offline Michelin does not imply In Progress; archived/invalid work cannot start, including archive/claim races; delivery is not acceptance; rework retains previous results; replay cannot duplicate actions, deliveries, or usage. Real model execution is not part of this milestone.

## M5 — Human input, live Permissions, and execution recovery

**Output:** the Owner can interact with, authorize, stop, and recover controlled execution.

- Persist questions/answers. Waiting for Input makes the Ticket Blocked but keeps its Round open, locked, and occupying the sequential slot; answering resumes the same Round without repeated effects.
- Implement action/resource-scoped Permissions and explicit full connected-account access bounded by actual authenticated capabilities.
- Support separate ticket-based and time-based grants, approval, expiry, renewal, and revocation. Default requests to the current Ticket, allowing time-based access.
- Check current authority before subsequent actions. Ticket grants expire permanently at Done; time grants expire independently. Resolve in-flight manual revocation and technical limits before implementing their behavior.
- Add greyed-out active cards, food-delivery animation, waiting reasons, View/Stop controls, and Stopping until cessation is confirmed.
- Implement Stopped, Failed, Interrupted, disconnect reconciliation, and agreed stranded-runner recovery, retaining partial work and usage.
- Enforce open-Round archive restrictions and manually removable Stopped Badges.

**Acceptance:** duplicate answers cannot repeat effects; ended Rounds never restart automatically; lost contact blocks new actions and retains locks; queued Stop precedes continuation; confirmed Stop returns Backlog with Stopped Badge; Failed/Interrupted leave Blocked Tickets; reopening does not revive ticket grants. Loss of contact alone never proves execution stopped.

## M6 — Agent configuration and versioned Skills/Recipes

**Output:** reusable Agent behavior and background context that cannot change the effective inputs of work already underway.

- Complete Agent settings for name, instructions, engine, provider/model, supported tools, Skills, and Permission configuration. Use the shared authorization contract; M5 owns live enforcement.
- Provide Researcher/Coder presets with honest capability availability; a configured preset does not imply its execution adapter exists yet.
- Upload, preview, and replace self-contained Markdown Skills, explicitly excluding companion scripts/resources.
- Select R2 or Supabase Storage and build an authorized shared Recipe library with explicit Ticket links.
- Create immutable replacement versions, retain historical references, and resolve document/Skill retirement policy.
- Enforce fixed model, instructions, Skill versions, and Recipe Versions during each Round; later Rounds use current versions. Reconcile storage retries without breaking retained inputs.

**Acceptance:** actual consumed inputs, not merely stored history, remain fixed; only linked Recipes are supplied; upload/replacement/historical retrieval enforce ownership; Skills/Recipes grant no authority and Permissions are not frozen. M6 can proceed independently of M5; verify pause/resume version retention when composing the two in the real-engine milestones.

## M7 — Native research, Reports, and Grill Mode

**Output:** the Owner can prepare a Ticket through an interview, run real native research, and review a cited Report.

- Integrate LangChain TypeScript `createAgent` and durable LangGraph checkpoints with controlled providers first, adopting shared questions, fixed inputs, live Permissions, cancellation, and recovery.
- Select/verify the native OpenRouter model and resolve runner-local credentials; hosted settings reference the connection without embedding its secret.
- Enable built-in web search and preserve citations and available token/cost metadata through real adapter/streaming paths.
- Store Markdown Reports with findings, citations, Success Criteria assessment, and uncertainties; render/download them from their producing Round.
- Reconcile storage/delivery retries; retain earlier Reports on rework and partial work on unsuccessful execution.
- Implement Grill Mode on a saved Backlog Ticket with persisted conversation/preparation usage and reviewed field application. Resolve its configuration, context access, and scheduling first.
- Keep Agents scoped to their assigned Ticket; follow-up suggestions belong in deliverables.

**Acceptance:** a selected-model scenario produces a cited, retrievable Report using fixed linked context; acceptance and explicit rework retain history; native controls conform to the shared lifecycle; adapter fixtures plus a live compatibility check validate citations/usage; unfinished interviews retain conversation/costs. Finishing Grill Mode never authorizes execution or silently creates a parallel execution lane. Coding is not a prerequisite.

## M8 — Managed coding and GitHub delivery lifecycle

**Output:** a coding Ticket executes through headless OpenCode, delivers a draft PR, supports explicit rework, and completes through reviewed merge.

- Verify the runner-local fine-grained PAT identity separately from OAuth login, Git/SSH access, and commit metadata. Product API operations do not require the development agent's `gh` profile or the GitHub CLI.
- Map repositories to local checkouts and validate eligibility; create a per-Ticket worktree/branch without disturbing the owner's checkout.
- Select OpenCode provider/model credentials, supervise the pinned headless process, enforce effective snapshots, and integrate questions, Permissions, cancellation, reconciliation, and usage.
- Prove tool, model, and Git/API action boundaries before enabling live delivery; record limitations of direct-host execution.
- Publish draft PRs with summary, tests/results, Success Criteria assessment, and delivered commit attached to the Round.
- Surface external feedback without automatic execution; explicit requeue reuses branch/worktree/PR until merge and retains previous deliveries.
- Resolve and implement owner-review evidence, merge authority, exceptional PR transitions, repository/template changes, and workspace setup/cleanup. Reviewed merge completes the applicable Ticket and permanently expires its ticket-based grants.

**Acceptance:** a real authorized fixture change produces one reconciled draft PR; wrong identity/resources are rejected; actual OpenCode obeys shared controls and fixed inputs; feedback never starts work; approval alone does not satisfy merge completion; agent authority cannot replace mandatory owner review. Closed-unmerged PRs, reopening after merge, merge during execution, and cleanup follow explicit rules preserving history and owner work. Research and Grill Mode are not prerequisites.

## M9 — Usage accounting and owner reporting

**Output:** trustworthy preparation/execution accounting across both real engines.

- Normalize observations collected since M4, rather than postponing collection until reporting work.
- Preserve provenance and reconcile overlapping, late, partial, and repeated observations, including reasoning/cache fields where available.
- Distinguish reported costs, estimates, and unavailable metrics; do not invent missing search-cost breakdowns.
- Show Ticket preparation/execution/total costs, Round counts, and per-Round Agent/model/token/cost details.
- Separate active and human-wait time; add dashboard date ranges and Ticket/Agent/model filters.
- Include failed, interrupted, stopped, reworked, and archived work.

**Acceptance:** both engines and Grill Mode contribute correctly; replay and overlapping aggregates cannot inflate totals; missing observations remain visibly incomplete; archive/rework preserve costs; filters match known observations. No spending enforcement or budget-triggered pauses are introduced.

## M10 — Deployment, operational setup, and v1 acceptance

**Output:** a reproducibly installed and verified v1 that the Owner can operate.

- Select application/PostgreSQL hosting, deploy Swiftlet/Galley together while retaining separate boundaries, and configure persistent PostgreSQL plus selected object storage.
- Document owner bootstrap, OAuth callbacks, migrations, persistence, backups, and actual build/test/startup commands.
- Document local Michelin setup, outbound pairing, credentials, OpenCode installation, and repository mapping.
- Verify cold starts, reconnects, access from another device, and execution without an open browser.
- Validate the combined hosting/database/document-storage target below $10/month separately from OpenRouter usage.
- Run the research, coding, and control/recovery scenarios in [acceptance-scenarios.md](acceptance-scenarios.md) with real selected providers. Provision the initial installation before the hosting-comparison demonstration; the scenario cannot choose its own prerequisite infrastructure.

**Acceptance:** documented setup reproduces a working installation; research includes preparation, cited Report, acceptance, and usage; coding includes draft PR, feedback, explicit rework, and reviewed merge; cross-engine recovery covers questions, expiry/renewal, Stop, disconnect, process loss, failure, and archive/restore. Required behavior must have actual evidence; an unsupported or unexecuted check is not a passed acceptance case.

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

- Use the approved primary application seam through Swiftlet, Galley, and Michelin where relevant, with real PostgreSQL and controlled external-provider substitutes. M1 establishes bounded adapter proofs before application features exist.
- Test observable lifecycle invariants and race conditions with real PostgreSQL transactions where relevant.
- Use deterministic fake engines/providers for retries, cancellation, expiry, and disconnects; add narrow real-adapter checks for behavior those substitutes cannot prove.
- Use selected-model and authorized GitHub smoke tests to validate the integrations fixtures cannot prove.
- Limit UI tests to complete workflows and critical locks/navigation, rather than duplicating component implementation details.
- Record test evidence at each milestone and update affected docs when decisions change.
