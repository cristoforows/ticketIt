import { useEffect, useState } from "react";
import { UnauthenticatedError } from "../api/session";
import {
  fetchTicket,
  updateTicket,
  changeTicketStatus,
  acceptTicket,
  assignTicketOwner,
  unassignTicket,
  TicketNotFoundError,
  type Ticket,
  type TicketUpdate,
} from "../api/tickets";
import { Link } from "./Link";
import { TicketDetail } from "./TicketDetail";

interface TicketDetailPageProps {
  ticketId: string;
  onUnauthenticated: () => void;
}

type DetailState =
  | { kind: "loading" }
  | { kind: "loaded"; ticket: Ticket }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/**
 * The canonical full-page Ticket view (issue #57): fetches one Ticket
 * by its public identifier and renders exactly one of loading /
 * TicketDetail / an explicit not-found state / an explicit error
 * state. This is the "container" -- it fetches and knows the route
 * parameter; TicketDetail (the presentation) knows neither. M3's modal
 * gets its own container built the same way (reading the Ticket to
 * show from wherever the modal was opened, rather than a route
 * parameter) but renders the same TicketDetail underneath.
 */
export function TicketDetailPage({ ticketId, onUnauthenticated }: TicketDetailPageProps) {
  const [state, setState] = useState<DetailState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    fetchTicket(ticketId)
      .then((ticket) => {
        if (!cancelled) {
          setState({ kind: "loaded", ticket });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof UnauthenticatedError) {
          onUnauthenticated();
          return;
        }
        if (error instanceof TicketNotFoundError) {
          setState({ kind: "not-found" });
          return;
        }
        const message = error instanceof Error ? error.message : "Unknown error loading the ticket.";
        setState({ kind: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [ticketId, onUnauthenticated]);

  async function runCommand(command: () => Promise<Ticket>): Promise<Ticket> {
    try {
      return await command();
    } catch (error) {
      if (error instanceof UnauthenticatedError) onUnauthenticated();
      throw error;
    }
  }

  // Passed to TicketDetail as `onSave` -- this container is the only
  // place that ever calls updateTicket, keeping TicketDetail itself
  // free of fetching (issue #57's split, preserved by issue #58).
  function saveTicket(update: TicketUpdate): Promise<Ticket> {
    return runCommand(() => updateTicket(ticketId, update));
  }

  // Like saveTicket: the owner commands live here so TicketDetail
  // stays free of fetching.
  function changeStatus(status: Ticket["status"]): Promise<Ticket> {
    return runCommand(() => changeTicketStatus(ticketId, status));
  }

  function accept(): Promise<Ticket> {
    return runCommand(() => acceptTicket(ticketId));
  }

  function assign(): Promise<Ticket> {
    return runCommand(() => assignTicketOwner(ticketId));
  }

  function unassign(): Promise<Ticket> {
    return runCommand(() => unassignTicket(ticketId));
  }

  return (
    <section data-testid="ticket-detail-page">
      <p>
        <Link to="/" data-testid="back-to-backlog-link">
          Back to Backlog
        </Link>
      </p>
      {state.kind === "loading" && (
        <p role="status" data-testid="ticket-detail-loading">
          Loading ticket…
        </p>
      )}
      {state.kind === "not-found" && (
        <div data-testid="ticket-detail-not-found">
          <p>This ticket could not be found.</p>
        </div>
      )}
      {state.kind === "error" && (
        <div role="alert" data-testid="ticket-detail-error">
          <p>Unable to load this ticket.</p>
          <p data-testid="ticket-detail-error-message">{state.message}</p>
        </div>
      )}
      {state.kind === "loaded" && (
        <TicketDetail
          ticket={state.ticket}
          onSave={saveTicket}
          onChangeStatus={changeStatus}
          onAccept={accept}
          onAssign={assign}
          onUnassign={unassign}
        />
      )}
    </section>
  );
}
