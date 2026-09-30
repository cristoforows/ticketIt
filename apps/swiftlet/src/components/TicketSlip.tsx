import type { CSSProperties, DragEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { Ticket } from "../api/tickets";
import { BadgeTag, buttonClasses, cx, Rule, shortDate, slipTilt, statusLabel, statusTone, ticketSerial } from "./ui";
import { TicketModalLink, ticketRowTestId } from "./TicketModalLink";

export function TicketSlip({ ticket, pending, anyPending, beingDragged, moveTargets, onMove, onDragStart, onDragEnd }: {
  ticket: Ticket;
  pending: boolean;
  anyPending: boolean;
  beingDragged: boolean;
  moveTargets: Ticket["status"][];
  onMove: (target: Ticket["status"]) => void;
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
}) {
  return (
    <li
      data-testid={ticketRowTestId("board", ticket.id)}
      data-dragging={beingDragged ? "true" : undefined}
      aria-busy={pending}
      draggable={!pending}
      style={{ "--tilt": `${slipTilt(ticket.id)}deg` } as CSSProperties}
      className={cx("slip", !pending && "cursor-grab", beingDragged && "opacity-60")}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div
        data-surface="paper"
        {...statusTone(ticket.status)}
        className={cx(
          "slip-paper flex flex-col gap-2 border-t-4 border-(--status) bg-paper px-3 pt-3 pb-5 text-ink",
          beingDragged && "outline-2 -outline-offset-4 outline-ink outline-dashed",
          pending && "opacity-70",
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
        {moveTargets.length > 0 && (
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger data-testid="move-to-trigger" disabled={anyPending} className={cx(buttonClasses("secondary"), "self-start px-2 py-1 text-label tracking-label uppercase")}>Move to…</DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="start" sideOffset={4} className="z-50 min-w-40 border-2 border-ink bg-paper p-1 text-ink shadow-paper">
                {moveTargets.map((target) => (
                  <DropdownMenu.Item
                    key={target}
                    data-move-target={target}
                    className="cursor-pointer px-2 py-1.5 text-body font-bold outline-none data-[highlighted]:bg-ink data-[highlighted]:text-amber data-[highlighted]:before:mr-1 data-[highlighted]:before:content-['▸']"
                    onSelect={() => onMove(target)}
                  >
                    {statusLabel(target)}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
    </li>
  );
}
