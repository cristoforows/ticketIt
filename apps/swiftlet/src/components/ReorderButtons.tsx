import type { Ticket, TicketPlacement } from "../api/tickets";
import { cn, SecondaryButton, statusLabel } from "./ui";

export type ReorderDirection = "up" | "down";

type StageMove = { placement: TicketPlacement; reason?: never } | { placement?: never; reason: string };

export function stageMoves(tickets: Ticket[], ticket: Ticket): Record<ReorderDirection, StageMove> {
  const stage = tickets.filter((item) => item.status === ticket.status);
  const index = stage.findIndex((item) => item.id === ticket.id);
  const previous = stage[index - 1];
  const next = stage[index + 1];
  const label = statusLabel(ticket.status);
  return {
    up: previous ? { placement: { before: previous.id } } : { reason: `Already first in ${label}` },
    down: next ? { placement: { after: next.id } } : { reason: `Already last in ${label}` },
  };
}

interface ReorderButtonsProps {
  ticket: Ticket;
  tickets: Ticket[];
  disabled: boolean;
  testIdPrefix: string;
  onReorder: (placement: TicketPlacement, direction: ReorderDirection) => void;
  stacked?: boolean;
  className?: string;
}

const labels: Record<ReorderDirection, { text: string; glyph: string }> = {
  up: { text: "Move up", glyph: "▴" },
  down: { text: "Move down", glyph: "▾" },
};

export function ReorderButtons({ ticket, tickets, disabled, testIdPrefix, onReorder, stacked = false, className }: ReorderButtonsProps) {
  const moves = stageMoves(tickets, ticket);
  return (
    <div role="group" aria-label={`Reorder ${ticket.title}`} className={cn("flex gap-2", stacked && "flex-col", className)}>
      {(["up", "down"] as const).map((direction) => {
        const move = moves[direction];
        return (
          <SecondaryButton
            key={direction}
            data-testid={`${testIdPrefix}-reorder-${direction}`}
            size={stacked ? "md" : "sm"}
            filled={stacked}
            disabled={disabled || !move.placement}
            title={move.reason}
            onClick={() => move.placement && onReorder(move.placement, direction)}
          >
            <span aria-hidden="true">{labels[direction].glyph}</span>
            {labels[direction].text}
          </SecondaryButton>
        );
      })}
    </div>
  );
}

export function focusReorderButton(row: Element | null, testIdPrefix: string, direction: ReorderDirection) {
  const button = (name: ReorderDirection) => row?.querySelector<HTMLButtonElement>(`[data-testid="${testIdPrefix}-reorder-${name}"]`);
  const preferred = button(direction);
  const target = preferred && !preferred.disabled ? preferred : button(direction === "up" ? "down" : "up");
  if (target && !target.disabled) target.focus({ preventScroll: true });
}
