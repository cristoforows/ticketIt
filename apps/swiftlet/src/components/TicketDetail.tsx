import type { Ticket } from "../api/tickets";

interface TicketDetailProps {
  ticket: Ticket;
}

/**
 * Pure presentation of one already-fetched Ticket's detail content:
 * title, Status, and timestamps only -- no Rounds, Reports, PR links,
 * or Grill Mode, since none of those exist yet
 * (docs/ticket-views.md, "Ticket details"). Takes a Ticket as a prop
 * and neither fetches nor routes itself, so M3's modal presentation
 * can render this exact component inside its own container without a
 * second implementation of the detail content (issue #57's acceptance
 * criterion) -- only TicketDetailPage (the full-page container) has a
 * modal-shaped counterpart to build; this component does not change.
 */
export function TicketDetail({ ticket }: TicketDetailProps) {
  return (
    <article data-testid="ticket-detail">
      <h2 data-testid="ticket-detail-title">{ticket.title}</h2>
      <dl>
        <dt>Status</dt>
        <dd data-testid="ticket-detail-status">{ticket.status}</dd>
        <dt>Created</dt>
        <dd data-testid="ticket-detail-created-at">{ticket.createdAt}</dd>
        <dt>Updated</dt>
        <dd data-testid="ticket-detail-updated-at">{ticket.updatedAt}</dd>
      </dl>
    </article>
  );
}
