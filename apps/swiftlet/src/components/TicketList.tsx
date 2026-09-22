import { useCallback, useEffect, useState } from "react";
import { createTicket, fetchTickets, TICKET_TITLE_MAX_LENGTH, type Ticket } from "../api/tickets";
import { Link } from "./Link";

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; tickets: Ticket[] }
  | { kind: "error"; message: string };

/**
 * The Owner's Backlog: a quick-capture input above the list Galley
 * returns. A successful capture re-fetches the list (Galley, not this
 * component, decides where the new Ticket sorts -- apps/galley/README.md,
 * "Ticket ordering") so a captured Ticket appears with no manual reload.
 */
export function TicketList() {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [title, setTitle] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    fetchTickets()
      .then((tickets) => setState({ kind: "loaded", tickets }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown error loading tickets.";
        setState({ kind: "error", message });
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCapture(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCaptureError(null);
    setCapturing(true);
    try {
      await createTicket(title);
      setTitle("");
      load();
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "Failed to capture the ticket.");
    } finally {
      setCapturing(false);
    }
  }

  return (
    <section data-testid="ticket-list">
      <h2>Backlog</h2>

      <form onSubmit={handleCapture} data-testid="ticket-capture-form">
        <label htmlFor="ticket-title-input">Title</label>
        <input
          id="ticket-title-input"
          data-testid="ticket-title-input"
          value={title}
          maxLength={TICKET_TITLE_MAX_LENGTH}
          onChange={(event) => setTitle(event.target.value)}
          disabled={capturing}
        />
        <button
          type="submit"
          disabled={capturing || title.trim() === ""}
          data-testid="ticket-capture-submit"
        >
          Capture
        </button>
      </form>
      {captureError && (
        <p role="alert" data-testid="ticket-capture-error">
          {captureError}
        </p>
      )}

      {state.kind === "loading" && (
        <p role="status" data-testid="ticket-list-loading">
          Loading tickets…
        </p>
      )}
      {state.kind === "error" && (
        <div role="alert" data-testid="ticket-list-error">
          <p>Unable to load tickets.</p>
          <p data-testid="ticket-list-error-message">{state.message}</p>
        </div>
      )}
      {state.kind === "loaded" && state.tickets.length === 0 && (
        <p data-testid="ticket-list-empty">No tickets yet. Capture your first one above.</p>
      )}
      {state.kind === "loaded" && state.tickets.length > 0 && (
        <ul data-testid="ticket-list-items">
          {state.tickets.map((ticket) => (
            <li key={ticket.id} data-testid={`ticket-item-${ticket.id}`}>
              <Link to={`/tickets/${encodeURIComponent(ticket.id)}`} data-testid="ticket-title">
                {ticket.title}
              </Link>{" "}
              <span data-testid="ticket-status">{ticket.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
