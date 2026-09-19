# Ticket creation

## Flexible ticket structure

Do not introduce a fixed General/Research/Coding work-type taxonomy. Tickets remain a generic unit of work, and execution-engine capability must not be permanently tied to a ticket category; the native harness is intended to expand beyond research.

Use two built-in ticket templates in v1:

- **Basic:** goal, context, success criteria, and constraints; completion through human acceptance.
- **Coding:** the basic fields plus repository and PR sections; completion through merging the reviewed PR. Select the target repository before repository-targeted coding execution; investigation can precede implementation.

Templates determine presentation, required information, and the default completion condition. Retain that condition on the ticket independently of its assigned agent. Both templates create generic tickets rather than permanent work types.

Under the [accepted D3 decision](decisions/d3-agent-template-compatibility.md), the Owner may assign any Agent to either template. A Researcher can investigate a Coding Ticket before a Coder implements it; a Coder can work on a Basic Ticket whose completion remains human acceptance. A Round may contribute without completing the entire Ticket. Relevant repository inputs must be available on either template when needed, using one Ticket repository reference.

Keep the template structure extensible for user-defined templates and more customizable fields and completion rules later. A custom-template editor or full form/workflow designer is deferred beyond v1.

## Quick capture

A title is sufficient to create a ticket. Additional information can be supplied later, before requesting agent work.

## Manual guidance

Offer these prompts when a person fills in a ticket:

| Prompt | Guidance |
| --- | --- |
| Goal | What outcome do you want? |
| Context | Supply relevant background, links, repositories, or examples. |
| Success Criteria | Describe observable conditions that demonstrate the outcome was achieved. |
| Constraints | State what must stay unchanged or remain out of scope. |

Example:

- **Title:** Fix login bug on Safari.
- **Goal:** Restore sign-in for existing users on Safari.
- **Context:** Include the affected page and reproduction steps.
- **Success Criteria:** Existing users can sign in on Safari; invalid passwords still show an error.
- **Constraints:** Preserve the existing login flow.

## Grill Mode

Grill Mode is an optional guided interview during ticket creation. It helps clarify the intended outcome and gather information needed for autonomous work. Manual entry remains available.

Create and save a Backlog ticket before starting the interview. Associate its questions, answers, and preparation usage with that ticket from the beginning. Leaving midway preserves the ticket and conversation so the owner can return later to finish.

Completing the interview does not itself authorize execution. The ticket still needs to satisfy the readiness requirements and be moved to Ready to request agent work.

## Eligibility for agent work

Title-only capture does not authorize agent execution. A goal and success criteria are required before a ticket can be both Ready and assigned to an agent.

This requirement applies regardless of whether the ticket becomes Ready before or after agent assignment. Context and constraints remain optional guidance.

Repository-targeted coding work explicitly selects one target repository regardless of template. The runner resolves it to a configured local checkout; see `agent-execution.md`. A Coding-template research assignment does not need a checkout solely because of its template; actual actions still require their inputs and Permissions. Missing required inputs or an unavailable runtime can prevent execution without creating a template-based assignment prohibition.

Readiness establishes that the required information is present; it does not guarantee that the ticket contains every answer an agent may need. Agents investigate available context and make reasonable, reversible assumptions within scope, seeking human input only when necessary.

Human-assigned Tickets can enter Ready and In Progress with a title alone. Manual Blocked/resume, rework, completion, and rejected status skips follow the [D3 manual transition table](decisions/d3-agent-template-compatibility.md#2-human-assigned-workflow). Human work creates no new Round and retains any history from previous Agent assignments. Reassignment while Ready must still satisfy the Agent-readiness checks above before it requests execution.
