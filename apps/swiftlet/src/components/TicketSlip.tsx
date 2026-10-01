import type { DragEvent } from "react";
import type { Ticket, TicketPlacement } from "../api/tickets";
import { BadgeList, ClaimedTag, LockGlyph, PendingTag, QueuedTag, Rule, shortDate, Slip, SlipPaper, SlipToggle, slipTilt, ticketSerial } from "./ui";
import { openTicketModal } from "../router";
import { assigneeLabel } from "./assignee";
import { lockedLabel } from "./roundLock";
import type { ReorderDirection } from "./ReorderButtons";
import { SlipActions } from "./SlipActions";
import { TicketModalLink, ticketRowTestId } from "./TicketModalLink";

export function TicketSlip({ ticket, stageTickets, phone, pending, anyPending, selected, beingDragged, dropPosition, moveTargets, onToggle, onDismiss, onMove, onReorder, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }: {
  ticket: Ticket;
  stageTickets: Ticket[];
  phone: boolean;
  pending: boolean;
  anyPending: boolean;
  selected: boolean;
  beingDragged: boolean;
  dropPosition?: "before" | "after";
  moveTargets: Ticket["status"][];
  onToggle: () => void;
  onDismiss: () => void;
  onMove: (target: Ticket["status"]) => void;
  onReorder: (placement: TicketPlacement, direction: ReorderDirection) => void;
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDragLeave: (event: DragEvent<HTMLLIElement>) => void;
  onDrop: (event: DragEvent<HTMLLIElement>) => void;
}) {
  const panelId = `board-slip-actions-${ticket.id}`;
  return (
    <Slip
      tilt={slipTilt(ticket.id)}
      stacked={phone}
      dragging={beingDragged}
      selected={selected}
      dropPosition={dropPosition}
      data-testid={ticketRowTestId("board", ticket.id)}
      aria-busy={pending}
      draggable={!pending && !phone && !ticket.openRound}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <SlipPaper status={ticket.status}>
        <div className="flex justify-between text-label text-muted">
          <span className="flex items-center gap-1">
            {ticketSerial(ticket.id)}
            {ticket.openRound && <LockGlyph data-testid="board-locked" label={lockedLabel(ticket.openRound)} className="text-ink" />}
          </span>
          <time dateTime={ticket.createdAt}>{shortDate(ticket.createdAt)}</time>
        </div>
        <TicketModalLink ticketId={ticket.id} view="board" variant="slip" disabled={pending}>{ticket.title}</TicketModalLink>
        <Rule className="my-0" />
        <div className="text-label">
          <p>Template: {ticket.template}</p>
          <p data-testid="board-assignee">Assignee: {assigneeLabel(ticket)}</p>
        </div>
        {ticket.requestingAgentWork && ticket.assigneeAgent && (
          <QueuedTag data-testid="board-queued" className="self-start">Queued for {ticket.assigneeAgent.name}</QueuedTag>
        )}
        {ticket.openRound?.state === "claimed" && (
          <ClaimedTag data-testid="board-claimed" className="self-start">Claimed by runner</ClaimedTag>
        )}
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
          stageTickets={stageTickets}
          targets={moveTargets}
          disabled={anyPending}
          onView={() => { onDismiss(); openTicketModal(ticket.id, "board"); }}
          onEdit={() => { onDismiss(); openTicketModal(ticket.id, "board", true); }}
          onMove={(target) => { onDismiss(); onMove(target); }}
          onReorder={onReorder}
        />
      )}
    </Slip>
  );
}
