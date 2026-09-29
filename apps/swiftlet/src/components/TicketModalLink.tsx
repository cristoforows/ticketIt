import type { AnchorHTMLAttributes } from "react";
import { openTicketModal, type CollectionRoute } from "../router";
import { isPlainLinkClick, Link } from "./Link";

export function ticketRowTestId(view: CollectionRoute, ticketId: string): string {
  return view === "board" ? `board-ticket-${ticketId}` : `ticket-item-${ticketId}`;
}

export function focusTicketRow(view: CollectionRoute, ticketId: string): void {
  document.querySelector<HTMLElement>(`[data-testid="${ticketRowTestId(view, ticketId)}"] a`)?.focus({ preventScroll: true });
}

export function refocusTicketRowIfFocusLost(view: CollectionRoute, ticketId: string): void {
  if (document.activeElement && document.activeElement !== document.body) return;
  focusTicketRow(view, ticketId);
}

interface TicketModalLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> {
  ticketId: string;
  view: CollectionRoute;
}

export function TicketModalLink({ ticketId, view, children, ...rest }: TicketModalLinkProps) {
  return (
    <Link
      to={`/tickets/${encodeURIComponent(ticketId)}`}
      onClick={(event) => {
        if (!isPlainLinkClick(event)) return;
        event.preventDefault();
        openTicketModal(ticketId, view);
      }}
      {...rest}
    >
      {children}
    </Link>
  );
}
