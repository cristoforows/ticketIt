import type { CSSProperties, DragEvent } from "react";
import type { Ticket } from "../api/tickets";
import { BadgeTag, cx, Rule, shortDate, slipTilt, statusTone, ticketSerial } from "./ui";
import { openTicketModal } from "../router";
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
    <li
      data-testid={ticketRowTestId("board", ticket.id)}
      data-dragging={beingDragged ? "true" : undefined}
      aria-busy={pending}
      draggable={!pending && !phone}
      style={{ "--tilt": `${slipTilt(ticket.id)}deg` } as CSSProperties}
      className={cx("slip", phone && "grid", !pending && !phone && "cursor-grab", beingDragged && "opacity-60")}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div
        data-surface="paper"
        {...statusTone(ticket.status)}
        className={cx(
          "slip-paper col-start-1 row-start-1 flex flex-col gap-2 border-t-4 border-(--status) bg-paper px-3 pt-3 pb-5 text-ink",
          beingDragged && "outline-2 -outline-offset-4 outline-ink outline-dashed",
          pending && "opacity-70",
          selected && "opacity-40 grayscale",
        )}
      >
        <div className="flex justify-between text-label text-muted">
          <span>{ticketSerial(ticket.id)}</span>
          <time dateTime={ticket.createdAt}>{shortDate(ticket.createdAt)}</time>
        </div>
        <TicketModalLink ticketId={ticket.id} view="board" disabled={pending} className="font-bold break-words text-ink">{ticket.title}</TicketModalLink>
        <Rule className="my-0!" />
        <div className="text-label">
          <p>Template: {ticket.template}</p>
          <p>Assignee: {ticket.assigneeType === "owner" ? "Owner" : "Unassigned"}</p>
        </div>
        <p data-testid="board-badges" aria-label={`Badges: ${ticket.badges.map((badge) => badge.name).join(", ") || "none"}`} className="flex flex-wrap gap-1 empty:hidden">
          {ticket.badges.map((badge, index) => (
            <span key={badge.id}>
              {index > 0 && <span className="sr-only">, </span>}
              <BadgeTag>{badge.name}</BadgeTag>
            </span>
          ))}
        </p>
        {pending && <span role="status" className="self-start rounded-tag bg-ink px-2 py-0.5 text-label font-bold tracking-label text-amber uppercase">Moving…</span>}
      </div>
      {phone && !pending && (
        <button
          type="button"
          data-testid="board-slip-toggle"
          aria-label={`Actions for ${ticket.title}`}
          aria-expanded={selected}
          aria-controls={panelId}
          className="z-10 col-start-1 row-start-1 h-full w-full cursor-pointer border-0 bg-transparent p-0"
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
    </li>
  );
}
