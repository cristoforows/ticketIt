import { cva, type VariantProps } from "class-variance-authority";
import type { AnchorHTMLAttributes } from "react";
import { openTicketModal, ticketDetailPath, type CollectionRoute } from "../router";
import { isPlainLinkClick, Link } from "./Link";
import { cn } from "./ui";

const modalLink = cva("text-ink", {
  variants: {
    variant: {
      log: "block min-w-0 truncate font-bold no-underline hover:underline",
      slip: "font-bold break-words",
    },
  },
});

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

interface TicketModalLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">, Required<VariantProps<typeof modalLink>> {
  ticketId: string;
  view: CollectionRoute;
  disabled?: boolean;
}

export function TicketModalLink({ ticketId, view, variant, disabled = false, className, children, ...rest }: TicketModalLinkProps) {
  return (
    <Link
      to={ticketDetailPath(ticketId, view)}
      aria-disabled={disabled || undefined}
      className={cn(modalLink({ variant }), className)}
      onClick={(event) => {
        if (!isPlainLinkClick(event)) return;
        event.preventDefault();
        if (disabled) return;
        openTicketModal(ticketId, view);
      }}
      {...rest}
    >
      {children}
    </Link>
  );
}
