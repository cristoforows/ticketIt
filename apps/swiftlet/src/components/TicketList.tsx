import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { UnauthenticatedError } from "../api/session";
import { fetchTickets, type Ticket } from "../api/tickets";
import { refocusTicketRowIfFocusLost, TicketModalLink, ticketRowTestId } from "./TicketModalLink";
import { BadgeTag, EmptyMessage, ErrorMessage, LoadingMessage, Paper, Rule, statusLabel, statusTone, ticketSerial } from "./ui";

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

  const inLog = "shadow-none!";
  const count = state.kind === "loaded" ? state.tickets.length : 0;

  return (
    <Paper as="section" data-testid="ticket-list" className="mx-auto p-5 sm:p-6">
      <h2 className="m-0 text-center text-title font-bold tracking-wordmark uppercase">{archived ? "Archived Tickets" : "Backlog"}</h2>
      <Rule className="my-3!" weight="thick" />

      {state.kind === "loading" && (
        <LoadingMessage data-testid="ticket-list-loading" className={inLog}>Loading tickets…</LoadingMessage>
      )}
      {state.kind === "error" && (
        <ErrorMessage title="Unable to load tickets." data-testid="ticket-list-error" className={inLog}>
          <p data-testid="ticket-list-error-message" className="m-0">{state.message}</p>
        </ErrorMessage>
      )}
      {state.kind === "loaded" && count === 0 && (
        <EmptyMessage data-testid="ticket-list-empty" className={inLog}>{archived ? (badgeIds.length ? "No archived tickets match the selected Badges." : "No archived tickets.") : (badgeIds.length ? "No tickets match the selected Badges." : "No tickets yet. Capture your first one above.")}</EmptyMessage>
      )}
      {state.kind === "loaded" && count > 0 && (
        <>
          <ul data-testid="ticket-list-items" className="m-0 list-none p-0">
            {state.tickets.map((ticket) => (
              <li
                key={ticket.id}
                data-testid={ticketRowTestId("backlog", ticket.id)}
                className="mt-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t-0 border-b border-dashed border-rule px-1 py-2 hover:shadow-[inset_3px_0_0_var(--color-amber)] has-focus-visible:shadow-[inset_3px_0_0_var(--color-amber)]"
              >
                <div className="flex min-w-0 flex-[1_1_100%] items-baseline gap-3 sm:flex-[1_1_10rem]">
                  <span className="shrink-0 text-muted">{ticketSerial(ticket.id)}</span>
                  <TicketModalLink ticketId={ticket.id} view="backlog" data-testid="ticket-title" title={ticket.title} className="block min-w-0 truncate font-bold text-ink no-underline hover:underline">
                    {ticket.title}
                  </TicketModalLink>
                </div>
                <span data-testid="ticket-badges" aria-label={`Badges: ${ticket.badges.map((badge) => badge.name).join(", ") || "none"}`} className="inline-flex flex-wrap gap-1">
                  {ticket.badges.map((badge, index) => (
                    <Fragment key={badge.id}>
                      {index > 0 && <span className="sr-only">, </span>}
                      <BadgeTag>{badge.name}</BadgeTag>
                    </Fragment>
                  ))}
                </span>
                <span
                  data-testid="ticket-status"
                  {...statusTone(ticket.status)}
                  className="ml-auto shrink-0 text-right text-label font-bold tracking-label text-(--status-deep) uppercase sm:w-28"
                >
                  {statusLabel(ticket.status)}
                </span>
              </li>
            ))}
          </ul>
          <p data-testid="ticket-list-total" className="m-0 mt-4 font-bold">TOTAL — {count} {count === 1 ? "order" : "orders"}</p>
        </>
      )}
      {state.kind === "loaded" && state.refreshError && (
        <ErrorMessage title="Unable to refresh tickets." data-testid="ticket-list-refresh-error" className={`${inLog} mt-4`}>
          <p data-testid="ticket-list-refresh-error-message" className="m-0">{state.refreshError}</p>
        </ErrorMessage>
      )}
    </Paper>
  );
}
