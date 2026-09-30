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
  detachTicketBadge,
  archiveTicket,
  restoreTicket,
  fetchBadges,
  TicketNotFoundError,
  type Ticket,
  type Badge,
  type TicketUpdate,
} from "../api/tickets";
import { collectionQuery, fullPageReturnPath, navigate } from "../router";
import { Link } from "./Link";
import { TicketDetail } from "./TicketDetail";
import { EmptyMessage, ErrorMessage, LoadingMessage, Paper } from "./ui";

interface TicketDetailPageProps {
  ticketId: string;
  onUnauthenticated: () => void;
  presentation?: "page" | "modal";
  onCommandSucceeded?: () => void;
  onArchiveSucceeded?: () => void;
}

type DetailState =
  | { kind: "loading" }
  | { kind: "loaded"; ticket: Ticket }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

export function TicketDetailPage({ ticketId, onUnauthenticated, presentation = "page", onCommandSucceeded, onArchiveSucceeded }: TicketDetailPageProps) {
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

  const receipt = state.kind === "loaded" && (
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
      onDetachBadge={(badgeId) => runCommand(() => detachTicketBadge(ticketId, badgeId))}
      onArchive={() => runCommand(() => archiveTicket(ticketId))}
      onRestore={() => runCommand(() => restoreTicket(ticketId))}
      onArchived={() => (onArchiveSucceeded ? onArchiveSucceeded() : navigate(fullPageReturnPath()))}
    />
  );

  return (
    <section
      data-testid={presentation === "page" ? "ticket-detail-page" : "ticket-detail-modal-content"}
      className={presentation === "page" ? "mx-auto w-full max-w-(--size-receipt)" : undefined}
    >
      {presentation === "page" && <p className="mb-4">
        <Link to={`/${collectionQuery()}`} data-testid="back-to-backlog-link" className="text-label font-bold tracking-label text-amber uppercase">
          Back to Backlog
        </Link>
      </p>}
      {state.kind === "loading" && (
        <LoadingMessage data-testid="ticket-detail-loading">
          Loading ticket…
        </LoadingMessage>
      )}
      {state.kind === "not-found" && (
        <div data-testid="ticket-detail-not-found">
          <EmptyMessage>This ticket could not be found.</EmptyMessage>
        </div>
      )}
      {state.kind === "error" && (
        <ErrorMessage title="Unable to load this ticket." data-testid="ticket-detail-error">
          <p data-testid="ticket-detail-error-message">{state.message}</p>
        </ErrorMessage>
      )}
      {receipt && (presentation === "page" ? <Paper className="p-6">{receipt}</Paper> : receipt)}
    </section>
  );
}
