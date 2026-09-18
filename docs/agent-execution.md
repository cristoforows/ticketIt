# Agent execution

See [v1-scope.md](v1-scope.md) for consolidated scope, [implementation-plan.md](implementation-plan.md) for sequencing, and [integration-feasibility.md](integration-feasibility.md) for evidence and unverified engine assumptions.

## Initial execution engines

The first iteration supports two focused execution paths:

- **Native harness:** research work, built using an agent/model SDK rather than implementing provider plumbing from scratch.
- **OpenCode integration:** coding work, using OpenCode's existing execution capabilities.

The native harness is a long-term part of the product and may gain coding and other capabilities later. Integration with external open-source agent applications remains a product requirement, rather than a temporary bridge to be discarded.

The local runner uses TypeScript and Node.js. Use LangChain's TypeScript `createAgent` for the native harness, with its LangGraph foundation for agent execution, working state, and persistence capabilities.

Start with the provided agent structure rather than designing a custom graph upfront. The Go backend remains authoritative for ticket state, permission grants, and round records. The integration maps framework execution state to ticketIt rounds, enforces permissions, and attributes usage; framework checkpointing does not itself define round semantics or guarantee that repeating external actions is safe.

### Initial native model provider

Use OpenRouter for native research in v1. Agent configuration selects an OpenRouter model ID; the exact model remains to be decided.

Configure the OpenRouter API key locally on the runner for v1. Hosted agent settings reference the provider connection and model without containing the key. The specific local credential-storage mechanism remains undecided.

Web-managed model-provider configuration and credentials are a required future capability for multi-user support. Keep credential resolution behind a boundary that can later resolve an authorized owner's web-managed connection rather than assuming a single global runner credential.

Verify tool calling, streaming, and usage reporting for the selected model through the LangChain integration. Keep provider integration separate from ticket and round state so additional providers can be supported later.

## Agent configuration in v1

Include a basic editor for reusable agent configurations, starting from Researcher and Coder presets. Tickets select a saved agent.

The configuration structure includes:

- Name and instructions.
- Execution engine: native or OpenCode.
- Provider and model.
- Skills.
- Allowed tools and resource permissions.

Establish these concepts in the first iteration even where an option initially has only one supported value. Present fixed values honestly rather than implying unsupported alternatives are available. Engine-specific options apply only where supported.

Snapshot agent execution settings when each round starts, including model, instructions, and skill versions. Edits to these settings apply to subsequent rounds, not an existing round, including one paused for input. Retain the snapshot with round history so results and usage remain attributable to the configuration used.

Permissions remain live rather than frozen in the execution snapshot. Expiry, revocation, and newly approved access affect subsequent tool actions within the current round. Engine-specific configuration mapping remains to be designed.

### Skills

Use reusable Markdown skills following the `SKILL.md` convention, assigned to agents. Each engine consumes them through its own integration. Skills describe how to perform a type of work; recipes supply background information relevant to a ticket.

Skill instructions do not grant permissions. Tool and resource permissions govern which actions an agent can perform independently of the instructions it receives.

Skill versions used by a round are fixed in its execution snapshot. For v1, upload self-contained `SKILL.md` files, preview them in the app, and upload replacements as new versions. An in-app Markdown editor and full skill folders containing scripts, reference documents, or other assets are deferred.

Make the self-contained-file limitation explicit in the upload UI. Do not imply that referenced companion files are included or supported. Future full-folder support should treat the skill and its accompanying resources as a versioned bundle.

### Permissions and connected accounts

Use scoped capabilities packaged into permission presets as the design direction. Agents must also be able to use explicitly authorized connected accounts, acting through the user's authenticated external-service identity.

For example, GitHub work may use a specific personal GitHub account rather than an unrelated account or an application-owned identity. Authentication and authorization are distinct: an authenticated account is available for connection, while permission governs agent use of that account.

Support both granular action/resource grants and an explicit full connected-account access option. Selecting or authenticating an account alone does not grant full access. Full access authorizes the actions and resources exposed by that connection within its authenticated scopes; it does not expand the account's underlying authority or add unsupported integration capabilities.

Use ticket-based or time-based temporary permissions rather than permissions consumed by a single action. A temporary permission can cover repeated actions within its authorized account, action, and resource scope while it remains valid.

Support exactly two distinct types of temporary grant:

- **Ticket-based:** applies to the requesting agent's specified ticket. It survives review and additional rounds, then expires permanently when that ticket reaches Done. Reopening does not restore the grant.
- **Time-based:** applies to the specified agent across tickets within its authorized scope until the configured expiry. Individual ticket completion does not revoke it.

Do not combine ticket and time limits in a single grant. Permission requests default to ticket-based access for the current ticket; the user can instead choose time-based access. Account, action, and resource restrictions apply to both types. Manual revocation can end either type earlier.

When a time-based permission expires during a round, check current permissions before each new tool action. Already-dispatched actions may finish; the agent can continue work that remains permitted. Request renewed access only when necessary to proceed, using the existing Waiting for Input flow to continue the same round after approval.

Manual revocation takes effect for subsequent tool actions, as do newly approved grants. Execution snapshots do not preserve revoked authority. Handling already-dispatched actions during revocation remains to be specified.

GitHub is required for the initial coding deliverable workflow. Additional account integrations and detailed action/resource scopes remain undecided.

### Initial GitHub connection

Use a fine-grained personal access token configured locally on the runner for v1. The runner calls GitHub's API directly rather than requiring `gh`, verifies the authenticated account identity, and uses the connection for draft PR creation/updates, review feedback, and merge-status checks.

Limit the token to selected repositories and the permissions needed for the supported workflow, including contents and pull-request access as appropriate. Git operations can continue using the configured SSH identity. Git commit authorship and the account identity used for API actions remain separate configuration concerns.

Keep the connection identity independent of its authentication method. Browser-based, web-managed OAuth or GitHub App authorization can replace manual token setup later; the specific future mechanism is not selected.

## Initial research sources

Native research uses the public web, ticket contents, and recipes supplied by the user to ticketIt. Markdown files are the initial supported recipe format.

Use OpenRouter's built-in web search for native research in v1, reusing the OpenRouter connection. Verify citation handling, search usage/cost reporting, and LangChain compatibility with the selected model. Keep the integration replaceable so a dedicated search service can be introduced later if needed.

Recipes provide specific information or background relevant to the work. They live in a shared library and are explicitly linked to tickets, so the same recipe can be reused across tickets. Agents receive the recipes linked to their ticket rather than the entire library by default.

For v1, upload Markdown recipe files, preview them in the app, and upload replacements as new versions. An in-app Markdown editor is deferred. Existing rounds retain the recipe versions they started with.

The recipe library is intended to evolve to support retrieval-augmented generation (RAG). Retrieval design, indexing, and storage technology remain undecided.

### Recipe versions

At the start of each round, fix the versions of the recipes linked to its ticket. Edits to the library do not change the recipe content used by an existing round, including a round paused for human input.

New rounds use the latest versions available when they start. Retain the versions used by earlier rounds so their results can be understood in light of their original background information.

## Execution boundary

Ticket management and round history must remain separate from engine-specific execution. Both execution paths must map their progress, results, questions, interruptions, and usage into the agreed ticket and round lifecycle.

Engine capabilities may differ. Permission enforcement, human-input handling, cancellation, and available usage data must be verified for each integration rather than assumed equivalent.

Agent configuration must accommodate skills, permissions, and model settings. Future capabilities include additional external-account integrations and actions beyond coding or research; the underlying execution design must not assume that all tickets are repository changes.

## Coding deliverables

Each coding ticket explicitly selects one target repository in v1. The local runner maps that repository identity to a configured local checkout. Agents remain reusable across repositories; future booths may supply repository defaults.

Create a separate Git worktree and branch for each coding ticket, sharing repository history with the configured checkout. OpenCode works in that ticket's worktree rather than switching branches or mixing changes into the user's normal working directory. Reuse the worktree across subsequent rounds on the ticket.

Run coding execution directly on the user's computer in v1, using its existing development tools. Git worktrees separate working files and branches, but do not restrict access to other files, credentials, or the network. Application and engine permission checks must not be described as a complete filesystem or network sandbox.

Container-based runtime isolation is an important v2 upgrade. Keep workspace paths, environment setup, credential access, and process launching behind execution-environment boundaries so an isolated runtime can be added without changing ticket or round semantics. Worktree setup and cleanup remain to be decided.

Coding rounds deliver draft GitHub pull requests, published through the user's authorized connected GitHub account. The ticket's corresponding round section links to the draft PR and includes a change summary, tests performed and their results, and an assessment against success criteria.

OpenCode provides coding execution. The integration is responsible for coordinating delivery with ticket and round state and the applicable permissions.

Human review remains required. A ticket whose completion condition requires a reviewed PR becomes Done when that PR is merged; review approval alone leaves it In Review. A ticket with a human-acceptance completion condition becomes Done through acceptance in ticketIt. The condition comes from the ticket's template defaults and remains independent of the assigned agent or execution engine.

Reuse the same branch and PR across a coding ticket's feedback rounds until merge. Each round records the commit it delivered, its change summary, and its test results so earlier deliveries remain traceable as the PR evolves.

GitHub reviews and comments are informational in the first iteration, including a submitted Request changes review. Surface feedback in ticketIt, but require the user to explicitly return the ticket to Ready to request another round. This allows feedback and instructions to be consolidated before rework begins.

## Research reports

Reports are associated with the rounds that produce them. The ticket UI includes sections for its rounds, with each report available in the corresponding section.

Use S3-compatible object storage for reports and uploaded Markdown recipe versions in the first iteration. Keep their identities, ticket links, and round associations in the application's database. Cloudflare R2 and Supabase Storage are the shortlisted providers; the user will confirm the selection.

The design should accommodate connected storage services such as Google Drive, Dropbox, and future providers later. Report association with a round must remain independent of the chosen storage provider.

Generate reports as Markdown and save them to object storage. Render each report directly in its ticket's corresponding round section and provide a download option.

Reports include findings, source citations, assessment against the ticket's success criteria, and remaining uncertainties.

## Local first

The hosted web app delegates execution to a manually started local runner. OpenCode runs as a separate headless server process managed by that runner, rather than an interactive terminal UI. See `deployment.md` for the deployment split and lifecycle.

Execution initially runs on the user's computer. Work may stop when that computer shuts down. An interrupted round is retained in history, its ticket becomes Blocked, and another round requires an explicit return to Ready after inspection.

Local execution does not imply local document storage; reports and recipe versions use the S3-compatible storage described above.

Keep the runner separate from the web app through an explicit execution interface. Progress, results, and usage must be tracked independently of browser sessions and shared in-memory state, leaving room for remote runners later.

Pause new actions when the runner loses contact with ticketIt. Keep the ticket locked with a Runner disconnected indicator. On reconnect, continue the same round if execution state is intact and current permissions and pending controls permit it; an actually stopped process follows the Interrupted recovery flow. See `deployment.md`.

### Initial scheduling

The user delegates concurrency behavior to implementation simplicity. Start with sequential execution across the native and OpenCode engines: one active round at a time, with other eligible tickets waiting in Ready.

For the simplest first iteration, a round waiting for input retains the execution slot. Do not interleave another round while it is paused. This is an initial scheduling choice, not a permanent constraint on the execution interface.

## Autonomy

In v1, agents are scoped to their assigned ticket. They report progress, ask necessary questions, and submit results through that ticket's workflow. They do not create or modify other tickets; follow-up work is suggested in their deliverables for the owner to act on.

Ticket fields remain read-only while a round is open, including while waiting for input. The owner may inspect progress, answer questions, approve permissions, or stop the round; changing ticket fields requires ending the round first. Agent-profile edits remain possible but apply to subsequent rounds through the execution-snapshot rules above.

During agent execution, the ticket is locked in In Progress and exposes View and Stop round actions; see `ticket-views.md`. A stop request keeps the ticket locked with a Stopping indicator until the runner confirms execution has stopped. Then the round becomes Stopped and the ticket returns to Backlog with a Stopped badge, preserving history, usage, and available partial results.

Agents investigate available context and make reasonable, reversible assumptions within the ticket's scope. They ask for input only when missing information materially changes the intended outcome, required access or permission is unavailable, or a decision exceeds that scope.

A necessary question pauses an open round as Waiting for Input and blocks the ticket. The ticket retains its locked card treatment, animation, and View/Stop round controls while awaiting input. An answer continues that same round. Waiting time is distinguished from active work time.

Agent-delivered work enters In Review. Human review is required in the first iteration, and completion follows the ticket's retained condition: acceptance in ticketIt or merging its reviewed PR. It must not be inferred from the agent or execution engine. More customizable completion rules are deferred to a subsequent iteration.

### Failure

If the agent cannot complete the work after investigation and reasonable attempts, end the round as Failed and move the ticket to Blocked. Preserve usage, available partial work, and a clear explanation of the failure.

The owner can adjust the ticket or permissions, then explicitly return it to Ready to request another round. An agent may correct mistakes within an ongoing round, but failure does not automatically launch another round.

## V2 manager agent

Introduce a manager agent in v2 to help coordinate the agentic work loop. It should be able to connect to a personal messaging platform for owner interaction, inspired by the OpenClaw-style experience described by the user.

The manager operates at the ticket/workflow level: turn owner messages into tickets, clarify requirements, assign agents, monitor rounds, surface blockers, coordinate follow-up work, and bring decisions back to the owner. It does not intervene directly in an ongoing round's model/tool execution; that remains the responsibility of the runner and execution engine.

Supported messaging platforms, permissions, approval authority, and detailed workflow integration remain undecided for v2.

## Still to resolve

The consolidated decision register is [open-decisions.md](open-decisions.md). Engineering validation is sequenced in the implementation plan; the items below are not claims of completed integration.

- OpenRouter web-search integration; skill resource bundles are deferred.
- User confirmation of Cloudflare R2 or Supabase Storage.
- OpenRouter model selection, local credential-storage mechanism, and LangGraph persistence integration.
- Skill management and execution-snapshot integration with each engine.
- OpenCode configuration and capability mapping.
- Direct-host execution integration and worktree setup/cleanup; container isolation is targeted for v2.
- GitHub review/merge synchronization and handling of closed or already-merged PRs.
- Detailed permission and resource-scoping rules.
- Execution limits and remaining usage-accounting decisions; see `usage-accounting.md`.
