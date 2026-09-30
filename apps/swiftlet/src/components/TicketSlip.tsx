import type { DragEvent } from "react";
import type { Ticket } from "../api/tickets";
import { BadgeList, PendingTag, Rule, shortDate, Slip, SlipPaper, SlipToggle, slipTilt, ticketSerial } from "./ui";
import { openTicketModal } from "../router";
import { assigneeLabel } from "./assignee";
import { SlipActions } from "./SlipActions";
import { TicketModalLink, ticketRowTestId } from "./TicketModalLink";

export function TicketSlip({ ticket, phone, pending, anyPending, selected, beingDragged, moveTargets, onToggle, onDismiss, onMove, onDragStart, onDragEnd }: {
  ticket: Ticket;
  phone: boolean;
  pending: boolean;
  anyPending: boolean;
  selected: boolean;
  beingDragged: boolean;
  moveTargets: Ticket["status"][];
  onToggle: () => void;
  onDismiss: () => void;
  onMove: (target: Ticket["status"]) => void;
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
}) {
  const panelId = `board-slip-actions-${ticket.id}`;
  return (
    <Slip
      tilt={slipTilt(ticket.id)}
      stacked={phone}
      dragging={beingDragged}
      selected={selected}
      data-testid={ticketRowTestId("board", ticket.id)}
      aria-busy={pending}
      draggable={!pending && !phone}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <SlipPaper status={ticket.status}>
        <div className="flex justify-between text-label text-muted">
          <span>{ticketSerial(ticket.id)}</span>
          <time dateTime={ticket.createdAt}>{shortDate(ticket.createdAt)}</time>
        </div>
        <TicketModalLink ticketId={ticket.id} view="board" variant="slip" disabled={pending}>{ticket.title}</TicketModalLink>
        <Rule className="my-0" />
        <div className="text-label">
          <p>Template: {ticket.template}</p>
          <p data-testid="board-assignee">Assignee: {assigneeLabel(ticket)}</p>
        </div>
        <BadgeList data-testid="board-badges" badges={ticket.badges} />
        {pending && <PendingTag className="self-start">Moving…</PendingTag>}
      </SlipPaper>
      {phone && !pending && (
        <SlipToggle
          data-testid="board-slip-toggle"
          aria-label={`Actions for ${ticket.title}`}
          aria-expanded={selected}
          aria-controls={panelId}
          onClick={onToggle}
        />
      )}
      {selected && (
        <SlipActions
          id={panelId}
          ticket={ticket}
          targets={moveTargets}
          disabled={anyPending}
          onView={() => { onDismiss(); openTicketModal(ticket.id, "board"); }}
          onEdit={() => { onDismiss(); openTicketModal(ticket.id, "board", true); }}
          onMove={(target) => { onDismiss(); onMove(target); }}
        />
      )}
    </Slip>
  );
}
