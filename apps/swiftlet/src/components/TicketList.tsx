import { useCallback, useEffect, useRef, useState } from "react";
import { UnauthenticatedError } from "../api/session";
import { fetchTickets, type Ticket } from "../api/tickets";
import { refocusTicketRowIfFocusLost, TicketModalLink, ticketRowTestId } from "./TicketModalLink";
import { BadgeList, EmptyMessage, ErrorMessage, LoadingMessage, LogRow, LogRowMain, LogStatus, Paper, ReceiptTitle, Rule, ticketSerial } from "./ui";

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; tickets: Ticket[]; refreshKey: number; refreshError?: string }
  | { kind: "error"; message: string };

/**
 * The Owner's order log: the Tickets Galley returns as one receipt.
 * Galley, not this component, decides where a Ticket sorts
 * (apps/galley/README.md, "Ticket ordering"); a bumped `refreshKey`
 * re-fetches without clearing the list.
 */
export function TicketList({ onUnauthenticated, refreshKey = 0, focusTicketId, badgeIds = [], archived = false }: { onUnauthenticated: () => void; refreshKey?: number; focusTicketId?: string; badgeIds?: string[]; archived?: boolean }) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const requestId = useRef(0);
  const mounted = useRef(false);

  const load = useCallback((keepExisting = false, refreshKey = 0) => {
    const id = ++requestId.current;
    if (!keepExisting) setState({ kind: "loading" });
    fetchTickets(badgeIds, archived)
      .then((tickets) => {
        if (id === requestId.current) setState({ kind: "loaded", tickets, refreshKey });
      })
      .catch((error: unknown) => {
        if (error instanceof UnauthenticatedError) {
          if (mounted.current) onUnauthenticated();
          return;
        }
        if (id !== requestId.current) return;
        const message = error instanceof Error ? error.message : "Unknown error loading tickets.";
        setState((current) => current.kind === "loaded"
          ? { ...current, refreshError: message }
          : { kind: "error", message });
      });
  }, [onUnauthenticated, badgeIds.join(","), archived]);

  useEffect(() => {
    mounted.current = true;
    load(refreshKey > 0, refreshKey);
    return () => {
      mounted.current = false;
      requestId.current += 1;
    };
  }, [load, refreshKey]);

  useEffect(() => {
    if (refreshKey > 0 && state.kind === "loaded" && state.refreshKey === refreshKey && focusTicketId) {
      refocusTicketRowIfFocusLost("backlog", focusTicketId);
    }
  }, [state, refreshKey, focusTicketId]);

  const count = state.kind === "loaded" ? state.tickets.length : 0;

  return (
    <Paper as="section" data-testid="ticket-list" className="mx-auto p-5 sm:p-6">
      <ReceiptTitle>{archived ? "Archived Tickets" : "Backlog"}</ReceiptTitle>
      <Rule weight="thick" />

      {state.kind === "loading" && (
        <LoadingMessage data-testid="ticket-list-loading" flat>Loading tickets…</LoadingMessage>
      )}
      {state.kind === "error" && (
        <ErrorMessage title="Unable to load tickets." data-testid="ticket-list-error" flat>
          <p data-testid="ticket-list-error-message" className="m-0">{state.message}</p>
        </ErrorMessage>
      )}
      {state.kind === "loaded" && count === 0 && (
        <EmptyMessage data-testid="ticket-list-empty" flat>{archived ? (badgeIds.length ? "No archived tickets match the selected Badges." : "No archived tickets.") : (badgeIds.length ? "No tickets match the selected Badges." : "No tickets yet. Capture your first one above.")}</EmptyMessage>
      )}
      {state.kind === "loaded" && count > 0 && (
        <>
          <ul data-testid="ticket-list-items" className="m-0 list-none p-0">
            {state.tickets.map((ticket) => (
              <LogRow key={ticket.id} data-testid={ticketRowTestId("backlog", ticket.id)}>
                <LogRowMain>
                  <span className="shrink-0 text-muted">{ticketSerial(ticket.id)}</span>
                  <TicketModalLink ticketId={ticket.id} view="backlog" variant="log" data-testid="ticket-title" title={ticket.title}>
                    {ticket.title}
                  </TicketModalLink>
                </LogRowMain>
                <BadgeList as="span" data-testid="ticket-badges" badges={ticket.badges} />
                <LogStatus data-testid="ticket-status" status={ticket.status} />
              </LogRow>
            ))}
          </ul>
          <p data-testid="ticket-list-total" className="m-0 mt-4 font-bold">TOTAL — {count} {count === 1 ? "order" : "orders"}</p>
        </>
      )}
      {state.kind === "loaded" && state.refreshError && (
        <ErrorMessage title="Unable to refresh tickets." data-testid="ticket-list-refresh-error" flat className="mt-4">
          <p data-testid="ticket-list-refresh-error-message" className="m-0">{state.refreshError}</p>
        </ErrorMessage>
      )}
    </Paper>
  );
}
