import { useState } from "react";
import { UnauthenticatedError } from "../api/session";
import { requestTicketStop, type Ticket } from "../api/tickets";
import type { CollectionRoute } from "../router";
import { TicketModalLink } from "./TicketModalLink";
import { buttonClasses, cn, InlineError, SecondaryButton } from "./ui";

export type WaitingReason = NonNullable<Ticket["openRound"]>["waitingReason"];

export const waitingReasonLabels: Record<WaitingReason, string> = {
  starting: "Starting",
  working: "Working",
  waiting_for_answer: "Waiting for your answer",
  waiting_for_permission: "Waiting for a Permission",
  resuming: "Resuming",
  stopping: "Stopping",
  runner_disconnected: "Runner disconnected",
  reconciling: "Reconciling with the runner",
  execution_unknown: "Runner cannot confirm execution",
};

export function DeliveryIndicator({ reason, className }: { reason: WaitingReason; className?: string }) {
  return (
    <span aria-hidden="true" data-reason={reason} data-testid="delivery-indicator" className={cn("delivery relative block h-5 w-24 shrink-0", className)}>
      <span className="absolute inset-x-0 bottom-1 border-b-2 border-dashed border-ink" />
      <svg viewBox="0 0 20 16" fill="none" stroke="currentColor" strokeWidth={1.5} className="delivery-rider absolute bottom-1.5 size-5 text-ink">
        <rect x="1" y="2" width="7" height="6" rx="1" />
        <path d="M8 8h6l2-4M14 4h3" />
        <circle cx="4" cy="12" r="2.25" />
        <circle cx="16" cy="12" r="2.25" />
      </svg>
    </span>
  );
}

export function ActiveOrder({ ticket, view, onStopped, onUnauthenticated, className }: {
  ticket: Ticket & { openRound: NonNullable<Ticket["openRound"]> };
  view: CollectionRoute;
  onStopped: (ticket: Ticket) => void;
  onUnauthenticated: () => void;
  className?: string;
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = ticket.openRound.waitingReason;
  const prefix = view === "board" ? "board" : "ticket";

  async function stop() {
    setStopping(true);
    setError(null);
    try {
      onStopped(await requestTicketStop(ticket.id));
    } catch (failure) {
      if (failure instanceof UnauthenticatedError) {
        onUnauthenticated();
        return;
      }
      setError(failure instanceof Error ? failure.message : "Unable to stop the Round.");
    } finally {
      setStopping(false);
    }
  }

  return (
    <div data-testid={`${prefix}-active-order`} data-reason={reason} className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <DeliveryIndicator reason={reason} />
        <p data-testid={`${prefix}-waiting-reason`} className="m-0 text-label font-bold tracking-label text-ink uppercase">
          {waitingReasonLabels[reason]}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <TicketModalLink
          ticketId={ticket.id}
          view={view}
          variant="action"
          data-testid={`${prefix}-active-view`}
          aria-label={`View ${ticket.title}`}
          className={buttonClasses({ variant: "secondary", tone: "paper", size: "sm", filled: true })}
        >
          View
        </TicketModalLink>
        {ticket.allowedActions.stop.available && (
          <SecondaryButton
            size="sm"
            filled
            data-testid={`${prefix}-active-stop`}
            aria-label={`Stop ${ticket.title}`}
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? "Stopping…" : "Stop"}
          </SecondaryButton>
        )}
      </div>
      {error && <InlineError data-testid={`${prefix}-active-stop-error`}>{error}</InlineError>}
    </div>
  );
}
