import { useCallback, useEffect, useState } from "react";
import { UnauthenticatedError } from "../api/session";
import {
  fetchTicket,
  updateTicket,
  changeTicketStatus,
  acceptTicket,
  assignTicketOwner,
  unassignTicket,
  createBadge,
  attachTicketBadge,
  fetchBadges,
  TicketNotFoundError,
  type Ticket,
  type Badge,
  type TicketUpdate,
} from "../api/tickets";
import { Link } from "./Link";
import { TicketDetail } from "./TicketDetail";

interface TicketDetailPageProps {
  ticketId: string;
  onUnauthenticated: () => void;
  presentation?: "page" | "modal";
  onCommandSucceeded?: () => void;
}

type DetailState =
  | { kind: "loading" }
  | { kind: "loaded"; ticket: Ticket }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

export function TicketDetailPage({ ticketId, onUnauthenticated, presentation = "page", onCommandSucceeded }: TicketDetailPageProps) {
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
      const ticket = await command();
      onCommandSucceeded?.();
      return ticket;
    } catch (error) {
      if (error instanceof UnauthenticatedError) onUnauthenticated();
      throw error;
    }
  }

  function saveTicket(update: TicketUpdate): Promise<Ticket> {
    return runCommand(() => updateTicket(ticketId, update));
  }

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

  async function createNewBadge(name: string): Promise<Badge> {
    try {
      return await createBadge(name);
    } catch (error) {
      if (error instanceof UnauthenticatedError) onUnauthenticated();
      throw error;
    }
  }

  const loadBadges = useCallback(async (): Promise<Badge[]> => {
    try {
      return await fetchBadges();
    } catch (error) {
      if (error instanceof UnauthenticatedError) onUnauthenticated();
      throw error;
    }
  }, [onUnauthenticated]);

  return (
    <section data-testid={presentation === "page" ? "ticket-detail-page" : "ticket-detail-modal-content"}>
      {presentation === "page" && <p>
        <Link to="/" data-testid="back-to-backlog-link">
          Back to Backlog
        </Link>
      </p>}
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
          onCreateBadge={createNewBadge}
          onLoadBadges={loadBadges}
          onAttachBadge={(badgeId) => runCommand(() => attachTicketBadge(ticketId, badgeId))}
        />
      )}
    </section>
  );
}
