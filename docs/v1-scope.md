# V1 scope

Consolidated approved design, published as [v1 spec #1](https://github.com/cristoforows/ticketIt/issues/1). This document describes intended behavior, not completed software. Unresolved choices are tracked in [open-decisions.md](open-decisions.md); the approved ten-milestone delivery sequence is in [implementation-plan.md](implementation-plan.md).

## Purpose

A personal task tracker inspired by Jira's board and list workflows, where the owner can delegate tickets to configurable agents, review their deliverables, and inspect the time and AI usage consumed.

One owner per deployment. One shared ticket collection in v1. The service theme uses Tickets, Badges, Recipes, and Rounds; future project-like groups are Booths. See the [glossary](../CONTEXT.md).

## Architecture and operating constraints

| Component | Approved choice |
| --- | --- |
| Frontend | React application `apps/swiftlet` |
| Backend | Go application `apps/galley` |
| Processing | TypeScript/Node.js application `apps/michelin` |
| Repository | One monorepo; independent application builds/tests and explicit APIs |
| Initial deployment | Swiftlet and Galley hosted together; Michelin started manually in a local terminal |
| Authoritative state | Galley and PostgreSQL |
| Documents | S3-compatible object storage: R2 or Supabase Storage, provider pending |
| Native execution | LangChain TypeScript `createAgent` with LangGraph; initially research |
| Native model/search provider | OpenRouter and its built-in web search |
| Coding execution | Headless OpenCode process supervised by Michelin |
| Owner sign-in | GitHub OAuth; owner identity independent of login provider |
| Runtime credentials | Local OpenRouter key and local fine-grained GitHub PAT; separate runner authentication |
| Cost target | App hosting, PostgreSQL, and object storage below $10/month, excluding OpenRouter usage |
| Availability | Free tiers, sleep, and cold starts accepted if data persists |

Michelin connects outward to Galley. Closing the browser does not stop a live runner. The native research harness, coding execution, and AI-powered Grill Mode need the local processing service under this split.

Coding runs directly on the host in per-ticket Git worktrees. This is not a complete filesystem/network sandbox. Container isolation is explicitly targeted for v2.

## Tickets and templates

- A title is sufficient to capture a Backlog ticket.
- A ticket may be assigned to the owner or an agent.
- Before agent execution becomes eligible, require a goal and success criteria. Repository-targeted coding work also selects one target repository, mapped by Michelin to a local checkout, regardless of template.
- Manual-entry guidance covers goal, context, success criteria, and constraints.
- Use a generic ticket model rather than permanent work-type enums.

| Built-in template | Initial structure | Default completion condition |
| --- | --- | --- |
| Basic | Goal, context, success criteria, constraints | Human acceptance |
| Coding | Basic fields plus repository and PR sections | Reviewed PR merged |

The ticket retains its completion condition independently of its assignee. The [accepted D3 decision](decisions/d3-agent-template-compatibility.md) permits any Agent on either template: validate required inputs and actual action prerequisites rather than a template/capability whitelist. A Researcher may contribute to a Coding Ticket before implementation; a Coder may work on a Basic Ticket with human-acceptance completion. Relevant repository inputs are available on either template when needed. Temporary MVP gaps must be documented as implementation limitations with follow-up work, not permanent assignment restrictions.

## Board, list, and details

- Continuous flow rather than sprints.
- List and status-column board present the same collection.
- Custom badges support manual creation, attachment/removal, and filtering.
- Each ticket has a dedicated URL and full page. Opening from board/list defaults to a modal that preserves the underlying position, with an Open full page action.
- Details include the work request, Grill Mode conversation, round activity, reports, and PR links.

## Lifecycle

Ticket status, round outcome, and archive visibility are separate concepts.

| Event | Ticket behavior | Round behavior |
| --- | --- | --- |
| Capture | Backlog | No execution round |
| Valid, unarchived ticket becomes Ready and agent-assigned, in either order | Ready, waiting for execution | Work requested, not falsely shown as running |
| Michelin begins work | In Progress; locked | Execution starts |
| Necessary answer or permission needed | Blocked; still locked | Waiting for Input; same round remains open |
| Answer/approval permits continuation | In Progress | Same round continues |
| Agent delivers result | In Review | Delivery preserved for review |
| Owner explicitly requests rework in ticketIt | Ready | Subsequent execution starts a new round |
| Human acceptance for a ticket with that completion condition | Done | History retained |
| Reviewed PR merges for a ticket requiring merge | Done | History retained |
| Owner requests stop | Locked, Stopping until confirmed | Stop requested, not yet assumed complete |
| Michelin confirms stop | Backlog + Stopped badge | Stopped; usage and partial results retained |
| Agent cannot complete after reasonable attempts | Blocked | Failed; explanation and partial work retained |
| Execution actually stops unexpectedly | Blocked | Interrupted; explicit recovery required |
| Michelin loses contact with Galley | Locked, Runner disconnected | Pause new actions; intact state may continue on reconnect |

Do not automatically launch new rounds after failure, interruption, or stop. Reconnection of intact execution is continuation, not a retry of an ended round. A round whose runner never returns stays open and locked until the owner attests that its execution ceased; it then ends Interrupted ([D5](open-decisions.md)). Per round, Galley limits active time and consecutive denied actions; a breach requests Stop and the round ends Failed ([D8](open-decisions.md)). An agent ticket in Done is reopened by returning it to Ready; round feedback added in In Review or Done reaches the next round once, whether it comes from rework or reopening. Exact review evidence and exceptional PR cases remain open.

Human-assigned tickets do not trigger agents and are moved into In Progress by the owner. Title alone is sufficient for human Ready/In Progress; the owner may manually mark their own work Blocked and resume it. Manual progression, rework, and rejected status skips follow [D3](decisions/d3-agent-template-compatibility.md#2-human-assigned-workflow) and retain the completion condition. Human work creates no new Round but preserves earlier Agent history. Reviewed-merge evidence remains D2's decision and is implemented in M8 for both assignee kinds; no early manual Done shortcut is introduced.

### Active ticket presentation

Grey out and lock an active agent ticket with a food-delivery-themed animation and View/Stop round buttons. Keep this treatment while Waiting for Input, with an explicit waiting indicator.

Ticket fields are read-only while a round is open. The owner can inspect work, answer questions, approve permissions, or stop. Profile edits can be saved, but affect subsequent rounds only. The Stopped badge is manually removed in v1 and never erases the round's outcome.

### Archive

Archive rather than permanently delete tickets. Preserve conversations, rounds, documents, PR links, and usage. End any open round before archiving; a queued ticket can be archived and withdrawn immediately.

Archived tickets cannot execute and are available through an Archived list filter. Restore their previous status, except Ready restores to Backlog to avoid unintended execution; Done remains Done.

## Agents, recipes, and skills

- A basic reusable agent editor exists in v1, even if some fields initially have one supported choice.
- Settings include name, instructions, engine, provider/model, skills, tools, and resource permissions. Start from Researcher and Coder presets.
- Each round fixes the model, instructions, and skill versions used. Permissions remain live.
- Recipes are reusable Markdown background documents in a shared library, explicitly linked to tickets. Each round uses fixed recipe versions; later rounds use current versions.
- Skills are reusable work instructions assigned to agents, following self-contained `SKILL.md` conventions. Skills and recipes do not grant authority.
- Upload, preview, and replace recipes/skills as new versions. In-app editing and companion-file bundles are deferred.
- V1 agents stay scoped to their assigned ticket; suggest follow-ups in their deliverables.
- Work autonomously within scope, investigating context and making reasonable reversible assumptions. Ask only for materially necessary information, unavailable access, or decisions outside scope.

Initial scheduling favors simplicity: one active round globally across engines. A round waiting for input retains that slot. This is not a permanent concurrency constraint.

## Grill Mode

An optional guided interview during creation. Save the Backlog ticket before starting; keep questions, answers, and preparation usage if the owner leaves midway. Manual filling remains available. Finishing the interview does not itself start agent execution.

## Permissions and accounts

Use scoped capabilities packaged into presets. Support granular account/action/resource grants and explicit full connected-account access, bounded by the connection's authenticated and supported capabilities.

Temporary grants have exactly two distinct forms:

| Form | Scope and lifetime |
| --- | --- |
| Ticket-based | Specified agent and ticket; survives review/rework, permanently ends at Done; reopening does not restore it |
| Time-based | Specified agent across tickets within authorized scope, until expiry regardless of individual completion |

Never combine ticket and time restrictions into a single grant. Default requests to the current ticket; owner can choose time-based access. Either can be manually revoked. Repeated actions are allowed while the grant is valid.

Check live authority before subsequent tool actions. Expired authority does not stop otherwise permitted work; request renewal only when necessary. Already-dispatched actions may complete on expiry. Manual revocation denies every later check at once and requests Stop of each open round the grant covers; an action already allowed may complete, and nothing completed is undone ([D8](open-decisions.md)).

GitHub OAuth sign-in is separate from authorizing account actions. Michelin uses a locally configured fine-grained PAT and direct GitHub API calls, verifies account identity, and may use separately configured SSH for Git. The development agent's `gh` profile is not a product runtime dependency.

## Deliverables and review

**Native research:** Markdown report in object storage, rendered and downloadable in the round section. Include findings, citations, assessment against success criteria, and uncertainties.

**Coding:** a separate ticket worktree/branch, draft GitHub PR, summary, tests/results, and success-criteria assessment. Rework reuses branch/worktree/PR until merge. Each round retains its delivered commit and result. GitHub comments and Request changes reviews are informational; explicit requeue in ticketIt starts rework.

Completion follows the ticket condition, not the engine. Human review is mandatory in v1. Its concrete evidence for personally authored GitHub PRs must be finalized before coding acceptance.

## Usage

Track all ticket-attributable AI usage: Grill Mode preparation plus every round, including interrupted/failed/stopped work. Archive and rework preserve costs.

Dashboard: date-range tokens/cost/active-time totals; ticket preparation/execution/total cost and round count; per-round agent, model, tokens, cost, active time, and waiting time. Filters cover ticket, agent, model, and date.

Distinguish estimates and reported costs; missing data is unknown rather than zero. Track spending only in v1; budget enforcement is deferred, separately from the technical limits above.

## Deferred scope

**Explicit v2 priorities:** container isolation; Manager Agent connected to personal messaging, coordinating tickets and agents without intervening inside ongoing model/tool execution.

**Later, not assigned a release:** booths (zero or one per ticket), sprints, RAG, custom templates/forms/completion rules, recipe/skill editors, skill resource bundles, budget controls, extra account/storage providers, web-managed credentials and multiple owners, remote runners, service/desktop packaging, advanced concurrency and badge automation.

Later Booth views may filter Tickets by Booth and Assignee.

### Multi-user boards (v2 direction, not assigned)

A board is an isolated context and always belongs to a team. A user who wants a board of their own creates a team, and the board comes with it. Any authenticated user with permission on the team's board can open it. v1's one owner per deployment is the single-user case.

A board can be served by several runners. Each runner is paired to its board the way v1 pairs one, and each holds its own runner credential, scoped to runner calls on that board and not to a user's session. Data isolation rests on the board boundary: a runner only ever holds the data of the one board it is paired to.

Anyone with permission on the board can move a Ticket to Ready, and a runner picks it up like any other eligible Ticket. There is no separate Ready permission.

A board's data is keyed by a board identifier, which replaces the Owner as the scope of every record and query. A Ticket's `owner_id` stays as ordinary metadata (who owns the Ticket) and no longer scopes access. The team pairs and runs its own Michelin runners; v2 does not host runners.

The team and its board own the workflow, so usage, cost and the dashboard are scoped per board. Usage is not attributed to individual users.

A runner is a machine that takes work. A Ticket is claimed by exactly one runner, and each runner holds at most one open Round at a time. Runners on the same board work in parallel on different Tickets, so a board has as many open Rounds as it has busy runners. v1's single open Round per Owner is this rule with one runner, and v1 keeps one runner.

A provider API key (OpenRouter now, other providers later) belongs to a runner, not to the board. Two runners on one board may use different keys or the same key. The key is stored in Galley and set through Swiftlet, and Galley hands it to the runner it belongs to. Pairing a runner stays a manual step: the runner credential is copied between Swiftlet and Michelin as in v1. The claim, heartbeats and Round fencing use the runner's own identity, never a provider key. Health is per runner: a runner that fails is unhealthy on its own. A provider outage is a separate condition that makes every runner using that key fail to execute without any of them being unhealthy.

v1 already scopes every record and query to the Owner, fences a Round to the runner that claimed it, and keeps credential resolution behind a boundary. See [open-decisions.md](open-decisions.md) for the credential direction.

## Acceptance

Both native research and OpenCode coding belong to v1. M7 research and M8 coding can proceed independently after their shared M5/M6 prerequisites; research is not a blocker for coding. See [acceptance-scenarios.md](acceptance-scenarios.md) for complete hosted acceptance in M10. Deployment feasibility checks and integration gates are part of the build plan, not claims that the behavior is already available.
