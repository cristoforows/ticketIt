import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { UnauthenticatedError } from "../api/session";
import { changeTicketStatus, fetchTickets, type Ticket } from "../api/tickets";
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
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [moveRefreshKey, setMoveRefreshKey] = useState(0);
  const commandPending = useRef(false);
  const requestId = useRef(0);
  const focusMovedTicketId = useRef<string | null>(null);
  const focusedRefreshKey = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const id = ++requestId.current;
    fetchTickets()
      .then((tickets) => {
        if (tickets.some((ticket) => !statuses.some(({ value }) => value === ticket.status))) {
          throw new Error("Galley returned a Ticket with an unknown Status.");
        }
        if (!cancelled && id === requestId.current) setState({ kind: "loaded", tickets, refreshKey });
      })
      .catch((error: unknown) => {
        if (cancelled || id !== requestId.current) return;
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
  }, [onUnauthenticated, refreshKey, moveRefreshKey]);

  useEffect(() => {
    if (refreshKey > focusedRefreshKey.current && state.kind === "loaded" && state.refreshKey === refreshKey && focusTicketId) {
      focusedRefreshKey.current = refreshKey;
      refocusTicketRowIfFocusLost("board", focusTicketId);
    }
  }, [state, refreshKey, focusTicketId]);

  useEffect(() => {
    if (state.kind !== "loaded" || !focusMovedTicketId.current) return;
    const id = focusMovedTicketId.current;
    focusMovedTicketId.current = null;
    const card = document.querySelector<HTMLElement>(`[data-testid="board-ticket-${id}"]`);
    (card?.querySelector<HTMLElement>('[data-testid="move-to-trigger"]') ?? card?.querySelector<HTMLElement>("a"))?.focus({ preventScroll: true });
  }, [state, pendingId]);

  const draggingTicket = state.kind === "loaded" ? state.tickets.find((ticket) => ticket.id === draggingId) : undefined;
  const moveTargets = (ticket: Ticket): Ticket["status"][] =>
    ticket.allowedActions.statusChanges.filter((target) => target !== "Done");
  const canMove = (ticket: Ticket, target: Ticket["status"]) => moveTargets(ticket).includes(target);

  async function moveTicket(ticket: Ticket, target: Ticket["status"]) {
    if (commandPending.current || !canMove(ticket, target)) return;
    commandPending.current = true;
    setPendingId(ticket.id);
    setMoveError(null);
    try {
      const updated = await changeTicketStatus(ticket.id, target);
      requestId.current += 1;
      focusMovedTicketId.current = ticket.id;
      setState((current) => current.kind === "loaded"
        ? { ...current, tickets: current.tickets.map((item) => item.id === ticket.id ? updated : item) }
        : current);
      setMoveRefreshKey((key) => key + 1);
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        onUnauthenticated();
        return;
      }
      focusMovedTicketId.current = ticket.id;
      setMoveError(error instanceof Error ? error.message : "Failed to move the ticket.");
    } finally {
      commandPending.current = false;
      setPendingId(null);
    }
  }

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
            const isDropTarget = draggingTicket !== undefined && canMove(draggingTicket, value);
            return (
              <section
                key={value}
                data-testid={`board-status-${value}`}
                data-drop-target={isDropTarget ? "true" : undefined}
                className={`min-w-0${isDropTarget ? " -outline-offset-2 bg-blue-600/10 outline-2 outline-dashed outline-current" : ""}`}
                aria-labelledby={`board-heading-${value}`}
                onDragOver={(event) => {
                  if (!isDropTarget) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggingTicket) void moveTicket(draggingTicket, value);
                  setDraggingId(null);
                }}
              >
                <h3 id={`board-heading-${value}`}>{label}</h3>
                {tickets.length === 0 ? <p>No tickets.</p> : (
                  <ul>
                    {tickets.map((ticket) => {
                      const eligibleTargets = moveTargets(ticket);
                      const pending = pendingId === ticket.id;
                      return (
                        <li
                          key={ticket.id}
                          data-testid={ticketRowTestId("board", ticket.id)}
                          aria-busy={pending}
                          draggable={!pending}
                          className={pending ? undefined : "cursor-grab"}
                          onDragStart={(event) => {
                            if (commandPending.current) {
                              event.preventDefault();
                              return;
                            }
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("application/x-ticketit-ticket", ticket.id);
                            setDraggingId(ticket.id);
                          }}
                          onDragEnd={() => setDraggingId(null)}
                        >
                          <TicketModalLink ticketId={ticket.id} view="board" disabled={pending}>{ticket.title}</TicketModalLink>
                          <p>Template: {ticket.template}</p>
                          <p data-testid="board-badges">{ticket.badges.map((badge) => badge.name).join(", ")}</p>
                          {pending && <span role="status">Moving…</span>}
                          {eligibleTargets.length > 0 && (
                            <DropdownMenu.Root modal={false}>
                              <DropdownMenu.Trigger data-testid="move-to-trigger" disabled={pendingId !== null}>Move to…</DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content align="start" sideOffset={4} className="z-50 min-w-32 rounded border border-solid border-gray-400 bg-[Canvas] p-1 text-[CanvasText] shadow-lg">
                                  {eligibleTargets.map((target) => (
                                    <DropdownMenu.Item
                                      key={target}
                                      data-move-target={target}
                                      className="cursor-pointer rounded px-2 py-1 outline-none data-[highlighted]:bg-blue-600/10"
                                      onSelect={() => void moveTicket(ticket, target)}
                                    >
                                      {statuses.find(({ value }) => value === target)?.label ?? target}
                                    </DropdownMenu.Item>
                                  ))}
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          )}
                        </li>
                      );
                    })}
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
      {moveError && <p role="alert" data-testid="ticket-board-move-error">{moveError}</p>}
    </section>
  );
}
