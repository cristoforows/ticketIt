# Ticket creation

## Flexible ticket structure

Do not introduce a fixed General/Research/Coding work-type taxonomy. Tickets remain a generic unit of work, and execution-engine capability must not be permanently tied to a ticket category; the native harness is intended to expand beyond research.

Use two built-in ticket templates in v1:

- **Basic:** goal, context, success criteria, and constraints; completion through human acceptance.
- **Coding:** the basic fields plus repository and PR sections; completion through merging the reviewed PR. Select the target repository before execution; the PR is produced during the coding workflow.

Templates determine presentation, required information, and the default completion condition. Retain that condition on the ticket independently of its assigned agent. Both templates create generic tickets rather than permanent work types.

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

Coding tickets also explicitly select one target repository. The runner resolves that repository to a configured local checkout; see `agent-execution.md`.

Readiness establishes that the required information is present; it does not guarantee that the ticket contains every answer an agent may need. Agents investigate available context and make reasonable, reversible assumptions within scope, seeking human input only when necessary.
