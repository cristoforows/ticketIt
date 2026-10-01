import { useState } from "react";
import type { Ticket, TicketPlacement } from "../api/tickets";
import { ReorderButtons, type ReorderDirection } from "./ReorderButtons";
import { PrimaryButton, SecondaryButton, SlipPaper, statusLabel, ticketSerial } from "./ui";

interface SlipActionsProps {
  id: string;
  ticket: Ticket;
  stageTickets: Ticket[];
  targets: Ticket["status"][];
  disabled: boolean;
  onView: () => void;
  onEdit: () => void;
  onMove: (target: Ticket["status"]) => void;
  onReorder: (placement: TicketPlacement, direction: ReorderDirection) => void;
}

export function SlipActions({ id, ticket, stageTickets, targets, disabled, onView, onEdit, onMove, onReorder }: SlipActionsProps) {
  const [choosing, setChoosing] = useState(false);
  const archived = ticket.archivedAt !== null;
  const editReason = archived ? ticket.allowedActions.accept.reason?.message ?? "Archived Tickets are read-only." : undefined;
  const listId = `${id}-targets`;
  return (
    <SlipPaper kind="actions" status={ticket.status} id={id} data-testid="board-slip-actions" role="group" aria-label={`Actions for ${ticket.title}`}>
      <p className="m-0 text-label text-ink">{ticketSerial(ticket.id)}</p>
      <p className="m-0 font-bold break-words text-ink">{ticket.title}</p>
      <div className="pointer-events-auto flex flex-col gap-2">
        <PrimaryButton data-testid="board-slip-view" onClick={onView}>View</PrimaryButton>
        <SecondaryButton data-testid="board-slip-edit" filled disabled={archived} title={editReason} onClick={onEdit}>Edit</SecondaryButton>
        <SecondaryButton
          data-testid="board-slip-move"
          aria-expanded={choosing}
          aria-controls={listId}
          filled
          disabled={targets.length === 0 || disabled}
          onClick={() => setChoosing((open) => !open)}
        >
          Move stage
        </SecondaryButton>
        {!archived && <ReorderButtons ticket={ticket} tickets={stageTickets} disabled={disabled} testIdPrefix="board-slip" stacked onReorder={onReorder} />}
        {choosing && (
          <ul id={listId} aria-label="Move to" className="m-0 flex list-none flex-col gap-2 p-0">
            {targets.map((target) => (
              <li key={target} className="m-0 border-0 p-0">
                <SecondaryButton data-testid={`board-slip-move-${target}`} filled className="w-full" onClick={() => onMove(target)}>{statusLabel(target)}</SecondaryButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SlipPaper>
  );
}
