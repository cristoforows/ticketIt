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
- Before agent execution becomes eligible, require a goal and success criteria. Coding work also selects one target repository, mapped by Michelin to a local checkout.
- Manual-entry guidance covers goal, context, success criteria, and constraints.
- Use a generic ticket model rather than permanent work-type enums.

| Built-in template | Initial structure | Default completion condition |
| --- | --- | --- |
| Basic | Goal, context, success criteria, constraints | Human acceptance |
| Coding | Basic fields plus repository and PR sections | Reviewed PR merged |

The ticket retains its completion condition independently of its assignee. Templates do not permanently bind tickets to execution engines. Supported initial agent/template combinations still need explicit validation rules; see open decisions.

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

Do not automatically launch new rounds after failure, interruption, or stop. Reconnection of intact execution is continuation, not a retry of an ended round. Exact review evidence and exceptional PR cases remain open.

Human-assigned tickets do not trigger agents and are moved into In Progress by the owner. Manual progression must still respect the ticket's completion condition; detailed human/engine compatibility rules are an open decision.

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

Check live authority before subsequent tool actions. Expired authority does not stop otherwise permitted work; request renewal only when necessary. Already-dispatched actions may complete on expiry. In-flight handling of manual revocation remains open.

GitHub OAuth sign-in is separate from authorizing account actions. Michelin uses a locally configured fine-grained PAT and direct GitHub API calls, verifies account identity, and may use separately configured SSH for Git. The development agent's `gh` profile is not a product runtime dependency.

## Deliverables and review

**Native research:** Markdown report in object storage, rendered and downloadable in the round section. Include findings, citations, assessment against success criteria, and uncertainties.

**Coding:** a separate ticket worktree/branch, draft GitHub PR, summary, tests/results, and success-criteria assessment. Rework reuses branch/worktree/PR until merge. Each round retains its delivered commit and result. GitHub comments and Request changes reviews are informational; explicit requeue in ticketIt starts rework.

Completion follows the ticket condition, not the engine. Human review is mandatory in v1. Its concrete evidence for personally authored GitHub PRs must be finalized before coding acceptance.

## Usage

Track all ticket-attributable AI usage: Grill Mode preparation plus every round, including interrupted/failed/stopped work. Archive and rework preserve costs.

Dashboard: date-range tokens/cost/active-time totals; ticket preparation/execution/total cost and round count; per-round agent, model, tokens, cost, active time, and waiting time. Filters cover ticket, agent, model, and date.

Distinguish estimates and reported costs; missing data is unknown rather than zero. Track spending only in v1; budget enforcement is deferred.

## Deferred scope

**Explicit v2 priorities:** container isolation; Manager Agent connected to personal messaging, coordinating tickets and agents without intervening inside ongoing model/tool execution.

**Later, not assigned a release:** booths (zero or one per ticket), sprints, RAG, custom templates/forms/completion rules, recipe/skill editors, skill resource bundles, budget controls, extra account/storage providers, web-managed credentials and multiple owners, remote runners, service/desktop packaging, advanced concurrency and badge automation.

## Acceptance

Both native research and OpenCode coding belong to v1. M7 research and M8 coding can proceed independently after their shared M5/M6 prerequisites; research is not a blocker for coding. See [acceptance-scenarios.md](acceptance-scenarios.md) for complete hosted acceptance in M10. Deployment feasibility checks and integration gates are part of the build plan, not claims that the behavior is already available.
