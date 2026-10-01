import { useCallback, useEffect, useState } from "react";
import { UnauthenticatedError } from "../api/session";
import {
  fetchTicket,
  updateTicket,
  changeTicketStatus,
  acceptTicket,
  assignTicket,
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
  type TicketAssignee,
  type TicketUpdate,
} from "../api/tickets";
import { fetchAgents, type Agent } from "../api/agents";
import { fetchTicketRounds } from "../api/rounds";
import { collectionPath, collectionQuery, fullPageReturnPath, navigate, useEditRequested } from "../router";
import { Link } from "./Link";
import type { RoundRecords } from "./RoundsSection";
import { useRunnerHealth } from "./RunnerHealthPill";
import { TicketDetail } from "./TicketDetail";
import { capsLinkClasses, EmptyMessage, ErrorMessage, LoadingMessage, Paper } from "./ui";
import { sameData, useOpenRoundRefresh } from "./useOpenRoundRefresh";

interface TicketDetailPageProps {
  ticketId: string;
  onUnauthenticated: () => void;
  presentation?: "page" | "modal";
  onCommandSucceeded?: () => void;
  onArchiveSucceeded?: () => void;
}

type DetailState =
  | { kind: "loading" }
  | { kind: "loaded"; ticket: Ticket; refreshError?: string }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

const hasRounds = (ticket: Ticket) => ticket.openRound !== null || ticket.delivery !== null;

export function TicketDetailPage({ ticketId, onUnauthenticated, presentation = "page", onCommandSucceeded, onArchiveSucceeded }: TicketDetailPageProps) {
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [roundRecords, setRoundRecords] = useState<RoundRecords & { ticketId?: string }>({});
  const editRequested = useEditRequested();

  const loaded = state.kind === "loaded";
  const hasOpenRound = state.kind === "loaded" && state.ticket.openRound !== null;
  const { view: runnerHealth } = useRunnerHealth(onUnauthenticated, hasOpenRound);

  const loadRounds = async (isCurrent: () => boolean = () => true) => {
    try {
      const rounds = await fetchTicketRounds(ticketId);
      if (!isCurrent()) return;
      setRoundRecords((current) => (current.ticketId === ticketId && current.error === undefined && sameData(current.rounds, rounds) ? current : { ticketId, rounds }));
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof UnauthenticatedError) {
        onUnauthenticated();
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error loading activity and usage.";
      setRoundRecords((current) => ({ ticketId, rounds: current.ticketId === ticketId ? current.rounds : undefined, error: message }));
    }
  };

  const refreshTicket = async () => {
    try {
      const ticket = await fetchTicket(ticketId);
      setState((current) => {
        if (current.kind !== "loaded" || current.ticket.id !== ticket.id) return current;
        if (sameData(current.ticket, ticket)) return current.refreshError === undefined ? current : { kind: "loaded", ticket: current.ticket };
        return { kind: "loaded", ticket };
      });
      if (hasRounds(ticket)) await loadRounds();
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        onUnauthenticated();
        return;
      }
      const message = error instanceof TicketNotFoundError ? "This ticket could not be found." : error instanceof Error ? error.message : "Unknown error refreshing the ticket.";
      setState((current) => (current.kind === "loaded" ? { ...current, refreshError: message } : current));
    }
  };
  useOpenRoundRefresh(hasOpenRound, refreshTicket);

  useEffect(() => {
    if (!loaded || !editRequested) return;
    const query = new URLSearchParams(window.location.search);
    query.delete("edit");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
  }, [loaded, editRequested]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    fetchTicket(ticketId)
      .then((ticket) => {
        if (cancelled) return;
        setState({ kind: "loaded", ticket });
        if (hasRounds(ticket)) void loadRounds(() => !cancelled);
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

  function assign(assignee: TicketAssignee): Promise<Ticket> {
    return runCommand(() => assignTicket(ticketId, assignee));
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

  const loadAgents = useCallback(async (): Promise<Agent[]> => {
    try {
      return await fetchAgents();
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
      onLoadAgents={loadAgents}
      onCreateBadge={createNewBadge}
      onLoadBadges={loadBadges}
      onAttachBadge={(badgeId) => runCommand(() => attachTicketBadge(ticketId, badgeId))}
      onDetachBadge={(badgeId) => runCommand(() => detachTicketBadge(ticketId, badgeId))}
      onArchive={() => runCommand(() => archiveTicket(ticketId))}
      onRestore={() => runCommand(() => restoreTicket(ticketId))}
      editRequested={editRequested}
      runnerHealth={runnerHealth}
      roundRecords={roundRecords.ticketId === ticketId ? roundRecords : undefined}
      onArchived={() => (onArchiveSucceeded ? onArchiveSucceeded() : navigate(fullPageReturnPath()))}
    />
  );

  return (
    <section
      data-testid={presentation === "page" ? "ticket-detail-page" : "ticket-detail-modal-content"}
      className={presentation === "page" ? "mx-auto w-full max-w-(--size-receipt)" : undefined}
    >
      {presentation === "page" && <p className="mb-4">
        <Link to={`${collectionPath("backlog")}${collectionQuery()}`} data-testid="back-to-backlog-link" className={capsLinkClasses({ tone: "ground" })}>
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
      {state.kind === "loaded" && state.refreshError && (
        <ErrorMessage title="Unable to refresh this ticket." data-testid="ticket-detail-refresh-error" className="mb-4">
          <p data-testid="ticket-detail-refresh-error-message">{state.refreshError}</p>
        </ErrorMessage>
      )}
      {receipt && (presentation === "page" ? <Paper className="p-6">{receipt}</Paper> : receipt)}
    </section>
  );
}
