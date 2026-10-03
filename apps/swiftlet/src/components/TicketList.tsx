import { useCallback, useEffect, useRef, useState } from "react";
import { UnauthenticatedError } from "../api/session";
import { fetchTickets, reorderTicket, type Ticket, type TicketPlacement } from "../api/tickets";
import { focusReorderButton, ReorderButtons, type ReorderDirection } from "./ReorderButtons";
import { ActiveOrder } from "./ActiveOrder";
import { lockedLabel } from "./roundLock";
import { awaitsExecution, sameData, useExecutionRefresh } from "./useExecutionRefresh";
import { refocusTicketRowIfFocusLost, TicketModalLink, ticketRowTestId } from "./TicketModalLink";
import { BadgeList, cn, EmptyMessage, ErrorMessage, LoadingMessage, LockGlyph, LogRow, LogRowMain, LogStatus, Paper, PendingTag, ReceiptTitle, Rule, ticketSerial } from "./ui";

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
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(false);
  const refocus = useRef<{ id: string; direction: ReorderDirection } | null>(null);

  const load = useCallback((keepExisting = false, refreshKey = 0) => {
    const id = ++requestId.current;
    if (!keepExisting) setState({ kind: "loading" });
    return fetchTickets(badgeIds, archived)
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

  const refreshExecution = async () => {
    if (pendingId) return;
    const id = ++requestId.current;
    try {
      const tickets = await fetchTickets(badgeIds, archived);
      if (id !== requestId.current) return;
      setState((current) => {
        if (current.kind !== "loaded") return current;
        if (!sameData(current.tickets, tickets)) return { kind: "loaded", tickets, refreshKey: current.refreshKey };
        return current.refreshError === undefined ? current : { ...current, refreshError: undefined };
      });
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        if (mounted.current) onUnauthenticated();
        return;
      }
      if (id !== requestId.current) return;
      const message = error instanceof Error ? error.message : "Unknown error loading tickets.";
      setState((current) => (current.kind === "loaded" ? { ...current, refreshError: message } : current));
    }
  };
  useExecutionRefresh(state.kind === "loaded" && state.tickets.some(awaitsExecution), refreshExecution);

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

  useEffect(() => {
    if (state.kind !== "loaded" || !refocus.current) return;
    const { id, direction } = refocus.current;
    refocus.current = null;
    focusReorderButton(document.querySelector(`[data-testid="${ticketRowTestId("backlog", id)}"]`), "ticket", direction);
  }, [state]);

  async function reorder(ticket: Ticket, placement: TicketPlacement, direction: ReorderDirection) {
    if (pendingId) return;
    setPendingId(ticket.id);
    setReorderError(null);
    try {
      await reorderTicket(ticket.id, placement);
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        onUnauthenticated();
        return;
      }
      setReorderError(error instanceof Error ? error.message : "Failed to reorder the ticket.");
    } finally {
      setPendingId(null);
    }
    refocus.current = { id: ticket.id, direction };
    await load(true);
  }

  const replaceTicket = (updated: Ticket) => {
    requestId.current++;
    setState((current) => (current.kind === "loaded" ? { ...current, tickets: current.tickets.map((ticket) => (ticket.id === updated.id ? updated : ticket)) } : current));
  };

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
              <LogRow key={ticket.id} data-testid={ticketRowTestId("backlog", ticket.id)} data-active={ticket.openRound ? true : undefined} aria-busy={pendingId === ticket.id} className={cn(ticket.openRound && "bg-rule")}>
                <LogRowMain>
                  <span className={cn("shrink-0", ticket.openRound ? "text-ink" : "text-muted")}>{ticketSerial(ticket.id)}</span>
                  {ticket.openRound && <LockGlyph data-testid="ticket-locked" label={lockedLabel(ticket.openRound)} className="self-center text-ink" />}
                  <TicketModalLink ticketId={ticket.id} view="backlog" variant="log" data-testid="ticket-title" title={ticket.title}>
                    {ticket.title}
                  </TicketModalLink>
                </LogRowMain>
                <BadgeList as="span" data-testid="ticket-badges" badges={ticket.badges} />
                <LogStatus data-testid="ticket-status" status={ticket.status} className={cn(ticket.openRound && "text-ink")} />
                {ticket.openRound && (
                  <ActiveOrder
                    ticket={{ ...ticket, openRound: ticket.openRound }}
                    view="backlog"
                    className="flex-[1_1_100%]"
                    onStopped={replaceTicket}
                    onUnauthenticated={onUnauthenticated}
                  />
                )}
                {!archived && !ticket.openRound && (
                  <ReorderButtons
                    ticket={ticket}
                    tickets={state.tickets}
                    disabled={pendingId !== null}
                    testIdPrefix="ticket"
                    className="flex-[1_1_100%] justify-end"
                    onReorder={(placement, direction) => void reorder(ticket, placement, direction)}
                  />
                )}
                {pendingId === ticket.id && <PendingTag>Moving…</PendingTag>}
              </LogRow>
            ))}
          </ul>
          <p data-testid="ticket-list-total" className="m-0 mt-4 font-bold">TOTAL — {count} {count === 1 ? "order" : "orders"}</p>
        </>
      )}
      {reorderError && <ErrorMessage title={reorderError} data-testid="ticket-list-reorder-error" flat className="mt-4" />}
      {state.kind === "loaded" && state.refreshError && (
        <ErrorMessage title="Unable to refresh tickets." data-testid="ticket-list-refresh-error" flat className="mt-4">
          <p data-testid="ticket-list-refresh-error-message" className="m-0">{state.refreshError}</p>
        </ErrorMessage>
      )}
    </Paper>
  );
}
