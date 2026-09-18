# Ticket views

## First iteration

Use a continuous flow of tickets rather than time-boxed sprints. Both views present the same shared collection and ticket identities:

- **List view:** quick capture, prioritization, and filtering.
- **Board view:** tickets arranged by status.

Backlog holds captured work that is not ready to begin. Title-only tickets can be refined here. Agent execution becomes eligible when a ticket is Ready and assigned to an agent, with the goal and success criteria required by `ticket-creation.md`.

Support custom badge creation, manual attachment/removal, and badge filtering in v1. See `ticket-organization.md` for badge membership and future booth organization.

## Ticket details

Give each ticket its own addressable detail page and support viewing the same ticket details in a modal. Reuse the detail content and behaviors across both presentations, including ticket information, the Grill Mode conversation, round activity, reports, and PR links.

Opening a ticket from the board or list defaults to a modal, preserving the underlying view's position. Provide an Open full page action. Opening a direct ticket URL or bookmark renders the dedicated full-page view.

## Active ticket control

Lock an agent-executing ticket while it is In Progress. In the board view, grey out its card and show an overlay with two visible, usable buttons:

- **View:** open the ticket to inspect the work.
- **Stop round:** explicitly request that the current round stop.

Use a food-delivery-themed animation to indicate ongoing agent work. Keep both buttons usable above the greyed-out card treatment. Stopping is an explicit action rather than a side effect of dragging the ticket to another status.

Keep the same locked, greyed-out treatment and animation when the round is Waiting for Input and the ticket is Blocked. Show that it is waiting for input, retaining View and Stop round controls; View provides access to the pending question and response flow.

During a runner disconnection, keep the active ticket locked and display **Runner disconnected**. Loss of contact must not be presented as confirmation that execution stopped.

After Stop round is requested, keep the card locked with a **Stopping…** indicator until the runner confirms that execution has stopped. Then return the ticket to Backlog and add a **Stopped** badge to distinguish it from other backlog tickets. Mark the round Stopped and preserve its history, usage, and available partial results. Returning the ticket to Ready requests another round.

The Stopped badge is removed manually in v1. Starting another round or changing ticket status does not automatically clear it. Removing the badge does not change the previous round's Stopped outcome or history. Automatic badge lifecycle handling may be added later.

While an agent round is open, including while Waiting for Input, ticket fields are read-only. View allows inspection of progress, responses to the agent's questions, permission approvals, and stopping the round. Changing the goal, success criteria, assignee, linked recipes, or other ticket fields requires ending the round first.

The active-round control applies to agent work rather than preventing a person from managing a human-assigned ticket.

## Archiving

Use archiving rather than permanent deletion in v1 for finished or abandoned tickets, including unfinished Grill Mode tickets. Archived tickets are excluded from the default board/list while their rounds, reports, PR links, conversations, and usage history remain available.

Require an open agent round to end before archiving its ticket. This includes rounds Waiting for Input: the owner must use Stop round and wait for confirmation before archiving.

A queued ticket can be archived immediately, withdrawing it from execution eligibility. Archived tickets must not start agent work.

Expose archived tickets through an Archived filter in list view. Restoring a ticket preserves its previous status, except a previously Ready ticket returns to Backlog so restoration does not automatically launch agent work. Previously Done tickets remain Done.

## Future sprints

Sprints are a possible later feature. Keep ticket lifecycle status distinct from future planning-period membership so that adding sprints does not redefine the meaning of Ready or other statuses.

Sprint behavior remains undecided, including what happens to unfinished work when a sprint ends and whether sprint membership affects execution eligibility. The size of a future migration depends on those choices.
