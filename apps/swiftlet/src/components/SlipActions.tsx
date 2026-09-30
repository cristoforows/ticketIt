import { useState } from "react";
import type { Ticket } from "../api/tickets";
import { PrimaryButton, SecondaryButton, statusLabel, statusTone, ticketSerial } from "./ui";

interface SlipActionsProps {
  id: string;
  ticket: Ticket;
  targets: Ticket["status"][];
  disabled: boolean;
  onView: () => void;
  onEdit: () => void;
  onMove: (target: Ticket["status"]) => void;
}

export function SlipActions({ id, ticket, targets, disabled, onView, onEdit, onMove }: SlipActionsProps) {
  const [choosing, setChoosing] = useState(false);
  const archived = ticket.archivedAt !== null;
  const editReason = archived ? ticket.allowedActions.accept.reason?.message ?? "Archived Tickets are read-only." : undefined;
  const listId = `${id}-targets`;
  return (
    <div id={id} data-surface="paper" {...statusTone(ticket.status)} data-testid="board-slip-actions" role="group" aria-label={`Actions for ${ticket.title}`} className="slip-paper pointer-events-none z-20 col-start-1 row-start-1 flex flex-col justify-center gap-2 border-t-4 border-(--status) bg-rail px-3 pt-3 pb-5 text-ink">
      <p className="m-0 text-label text-ink">{ticketSerial(ticket.id)}</p>
      <p className="m-0 font-bold break-words text-ink">{ticket.title}</p>
      <div className="pointer-events-auto flex flex-col gap-2">
        <PrimaryButton data-testid="board-slip-view" onClick={onView}>View</PrimaryButton>
        <SecondaryButton data-testid="board-slip-edit" className="bg-paper!" disabled={archived} title={editReason} onClick={onEdit}>Edit</SecondaryButton>
        <SecondaryButton
          data-testid="board-slip-move"
          aria-expanded={choosing}
          aria-controls={listId}
          className="bg-paper!"
          disabled={targets.length === 0 || disabled}
          onClick={() => setChoosing((open) => !open)}
        >
          Move stage
        </SecondaryButton>
        {choosing && (
          <ul id={listId} aria-label="Move to" className="m-0 flex list-none flex-col gap-2 p-0">
            {targets.map((target) => (
              <li key={target} className="m-0 border-0 p-0">
                <SecondaryButton data-testid={`board-slip-move-${target}`} className="w-full bg-paper!" onClick={() => onMove(target)}>{statusLabel(target)}</SecondaryButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
