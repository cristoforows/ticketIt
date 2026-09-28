import { useEffect, useState } from "react";
import { UnauthenticatedError } from "../api/session";
import { fetchTickets, type Ticket } from "../api/tickets";
import { Link } from "./Link";

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
  | { kind: "loaded"; tickets: Ticket[] }
  | { kind: "error"; message: string };

export function TicketBoard({ onUnauthenticated }: { onUnauthenticated: () => void }) {
  const [state, setState] = useState<BoardState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchTickets()
      .then((tickets) => {
        if (tickets.some((ticket) => !statuses.some(({ value }) => value === ticket.status))) {
          throw new Error("Galley returned a Ticket with an unknown Status.");
        }
        if (!cancelled) setState({ kind: "loaded", tickets });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof UnauthenticatedError) {
          onUnauthenticated();
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Unknown error loading tickets." });
      });
    return () => { cancelled = true; };
  }, [onUnauthenticated]);

  return (
    <section data-testid="ticket-board">
      <h2>Board</h2>
      {state.kind === "loading" && <p role="status" data-testid="ticket-board-loading">Loading tickets…</p>}
      {state.kind === "error" && (
        <div role="alert" data-testid="ticket-board-error">
          <p>Unable to load tickets.</p>
          <p>{state.message}</p>
        </div>
      )}
      {state.kind === "loaded" && (
        <div className="ticket-board-columns">
          {statuses.map(({ value, label }) => {
            const tickets = state.tickets.filter((ticket) => ticket.status === value);
            return (
              <section key={value} data-testid={`board-status-${value}`} aria-labelledby={`board-heading-${value}`}>
                <h3 id={`board-heading-${value}`}>{label}</h3>
                {tickets.length === 0 ? <p>No tickets.</p> : (
                  <ul>
                    {tickets.map((ticket) => (
                      <li key={ticket.id} data-testid={`board-ticket-${ticket.id}`}>
                        <Link to={`/tickets/${encodeURIComponent(ticket.id)}`}>{ticket.title}</Link>
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
    </section>
  );
}
