# Usage accounting

## Ticket totals

Include all AI usage attributable to a ticket in its token and cost totals, including preparation and execution.

Present separate breakdowns:

- **Preparation:** Grill Mode usage associated with the ticket.
- **Execution:** usage for each agent round, including interrupted rounds.
- **Total:** preparation plus execution usage.

Preserve earlier usage when another round begins; retries and rework must not overwrite the cost of previous work.

Grill Mode creates a Backlog ticket before the interview begins, so preparation usage is attributed to that ticket even if the owner leaves the interview unfinished. Preserve its conversation and usage for later continuation.

Archiving a ticket preserves its recorded usage and costs; hiding it from default board/list views does not erase spending history.

## Timing

Distinguish time waiting for human input from active agent work time, as specified in `agent-execution.md`.

## First dashboard

- Overview totals for tokens, cost, and active agent time over a selected date range.
- A ticket table with preparation cost, execution cost, total cost, and round count.
- Per-round detail with agent, model, tokens, cost, active time, and waiting time.
- Filters for ticket, agent, model, and date range.

Distinguish reported costs from estimates. Unavailable usage is unknown, not zero; totals must not imply complete accounting when contributing usage is missing.

## Spending controls

Track spending only in the first iteration. Budget configuration and spending-triggered pauses are deferred.

Keep room for optional per-round budgets later, without treating missing budgets as zero or coupling usage history to budget enforcement. No budget controls are required in the initial UI.

## Open decisions

- Future budget enforcement and behavior when a limit is reached.
- Model/provider pricing, reported usage, estimates, and incomplete accounting.
