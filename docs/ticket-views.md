# Ticket views

## First iteration

Use a continuous flow of tickets rather than time-boxed sprints. Both views present the same shared collection and ticket identities:

- **List view:** quick capture and filtering, in the Owner's priority order.
- **Board view:** tickets arranged by status, each stage in the same priority order.

### Priority order

Each Owner has one persisted priority order across all of their Tickets ([#131](https://github.com/cristoforows/ticketIt/issues/131)). It is the order M4.6's claims follow: the first eligible Ready Ticket is claimed first ([#108](https://github.com/cristoforows/ticketIt/issues/108)).

- A capture goes to the top.
- Entering Ready goes to the bottom, so newly ready work queues behind work already waiting.
- Every other Status change, archive and restore keep the position.
- The Owner reorders within a stage: Move up and Move down in the list and on the phone board, or dragging onto the upper or lower half of a slip in the same stage on the desktop board. Dragging to another stage is still a Status move.
- Archived Tickets cannot be moved and cannot be an anchor. The Archived filter lists most recently archived first.

Galley owns the order, and Swiftlet renders what Galley returns after each move.

Backlog holds captured work that is not ready to begin. Title-only tickets can be refined here. Agent execution becomes eligible when a ticket is Ready and assigned to an agent, with the goal and success criteria required by `ticket-creation.md`.

Support custom badge creation, manual attachment/removal, and badge filtering in v1. Booth membership is defined in [CONTEXT.md](../CONTEXT.md); Booth organization is deferred in [v1-scope.md](v1-scope.md).

In M3, custom Badges have immutable names only. Selecting multiple Badges matches any selected Badge (OR) on both list and board. Badge rename, delete, and colour are not approved v1 behavior; the built-in Stopped Badge belongs to M5.

## Ticket details

Give each ticket its own addressable detail page and support viewing the same ticket details in a modal. Reuse the detail content and behaviors across both presentations, including ticket information, the Grill Mode conversation, round activity, reports, and PR links.

Opening a ticket from the board or list defaults to a modal, preserving the underlying view's position. Provide an Open full page action. Opening a direct ticket URL or bookmark renders the dedicated full-page view.

M3's board allows advertised Status moves by drag or keyboard; Done is reachable only through Accept, not a plain board move. Galley computes available actions from the same rules its commands enforce. Modal links use canonical Ticket URLs; a reload presents the full page.

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

M3's archived Ticket details remain available directly and from the Archived list filter but are read-only until Restore; Galley rejects direct mutation requests too. Archived and Badge list filters compose, while the board continues showing only active Tickets. Exclusion from future execution claims and open-Round archive restrictions require M4/M5 enforcement.

## Future sprints

Sprints are a possible later feature. Keep ticket lifecycle status distinct from future planning-period membership so that adding sprints does not redefine the meaning of Ready or other statuses.

Sprint behavior remains undecided, including what happens to unfinished work when a sprint ends and whether sprint membership affects execution eligibility. The size of a future migration depends on those choices.
