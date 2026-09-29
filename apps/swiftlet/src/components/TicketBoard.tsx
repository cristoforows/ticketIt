import { useEffect, useState } from "react";
import { UnauthenticatedError } from "../api/session";
import { fetchTickets, type Ticket } from "../api/tickets";
import { refocusTicketRowIfFocusLost, TicketModalLink, ticketRowTestId } from "./TicketModalLink";

const statuses: { value: Ticket["status"]; label: string }[] = [
  { value: "Backlog", label: "Backlog" },
  { value: "Ready", label: "Ready" },
  { value: "InProgress", label: "In Progress" },
  { value: "Blocked", label: "Blocked" },
  { value: "InReview", label: "In Review" },
  { value: "Done", label: "Done" },
];

type BoardState =
  | { kind: "loading" }
  | { kind: "loaded"; tickets: Ticket[]; refreshKey: number; refreshError?: string }
  | { kind: "error"; message: string };

export function TicketBoard({ onUnauthenticated, refreshKey = 0, focusTicketId }: { onUnauthenticated: () => void; refreshKey?: number; focusTicketId?: string }) {
  const [state, setState] = useState<BoardState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchTickets()
      .then((tickets) => {
        if (tickets.some((ticket) => !statuses.some(({ value }) => value === ticket.status))) {
          throw new Error("Galley returned a Ticket with an unknown Status.");
        }
        if (!cancelled) setState({ kind: "loaded", tickets, refreshKey });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof UnauthenticatedError) {
          onUnauthenticated();
          return;
        }
        const message = error instanceof Error ? error.message : "Unknown error loading tickets.";
        setState((current) => current.kind === "loaded"
          ? { ...current, refreshError: message }
          : { kind: "error", message });
      });
    return () => { cancelled = true; };
  }, [onUnauthenticated, refreshKey]);

  useEffect(() => {
    if (refreshKey > 0 && state.kind === "loaded" && state.refreshKey === refreshKey && focusTicketId) {
      refocusTicketRowIfFocusLost("board", focusTicketId);
    }
  }, [state, refreshKey, focusTicketId]);

  return (
    <section data-testid="ticket-board">
      <h2>Board</h2>
      {state.kind === "loading" && <p role="status" data-testid="ticket-board-loading">Loading tickets…</p>}
      {state.kind === "error" && (
        <div role="alert" data-testid="ticket-board-error">
          <p>Unable to load tickets.</p>
          <p data-testid="ticket-board-error-message">{state.message}</p>
        </div>
      )}
      {state.kind === "loaded" && (
        <div data-testid="board-columns" className="grid grid-flow-col auto-cols-[minmax(12rem,1fr)] gap-4 overflow-x-auto">
          {statuses.map(({ value, label }) => {
            const tickets = state.tickets.filter((ticket) => ticket.status === value);
            return (
              <section key={value} data-testid={`board-status-${value}`} className="min-w-0" aria-labelledby={`board-heading-${value}`}>
                <h3 id={`board-heading-${value}`}>{label}</h3>
                {tickets.length === 0 ? <p>No tickets.</p> : (
                  <ul>
                    {tickets.map((ticket) => (
                      <li key={ticket.id} data-testid={ticketRowTestId("board", ticket.id)}>
                        <TicketModalLink ticketId={ticket.id} view="board">{ticket.title}</TicketModalLink>
                        <p>Template: {ticket.template}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
      {state.kind === "loaded" && state.refreshError && (
        <div role="alert" data-testid="ticket-board-refresh-error">
          <p>Unable to refresh tickets.</p>
          <p data-testid="ticket-board-refresh-error-message">{state.refreshError}</p>
        </div>
      )}
    </section>
  );
}
