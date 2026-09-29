import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { UnauthenticatedError } from "../api/session";
import { changeTicketStatus, fetchTickets, type Ticket } from "../api/tickets";
import { BadgeTag, buttonClasses, cx, EmptyMessage, ErrorMessage, LoadingMessage, Rule, shortDate, slipTilt, statusLabel, statuses, statusTone, ticketSerial } from "./ui";
import { refocusTicketRowIfFocusLost, TicketModalLink, ticketRowTestId } from "./TicketModalLink";

type BoardState =
  | { kind: "loading" }
  | { kind: "loaded"; tickets: Ticket[]; refreshKey: number; refreshError?: string }
  | { kind: "error"; message: string };

export function TicketBoard({ onUnauthenticated, refreshKey = 0, focusTicketId, badgeIds = [] }: { onUnauthenticated: () => void; refreshKey?: number; focusTicketId?: string; badgeIds?: string[] }) {
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
    fetchTickets(badgeIds)
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
  }, [onUnauthenticated, refreshKey, moveRefreshKey, badgeIds.join(",")]);

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

  const slipEdge = "text-label tracking-label uppercase";
  return (
    <section data-testid="ticket-board" className="min-w-0">
      <h2 className="mb-3 text-label tracking-label text-dim uppercase">Board</h2>
      {state.kind === "loading" && <LoadingMessage data-testid="ticket-board-loading">Loading tickets…</LoadingMessage>}
      {state.kind === "error" && (
        <ErrorMessage title="Unable to load tickets." data-testid="ticket-board-error">
          <p data-testid="ticket-board-error-message">{state.message}</p>
        </ErrorMessage>
      )}
      {state.kind === "loaded" && (
        state.tickets.length === 0 && badgeIds.length > 0 && <EmptyMessage data-testid="ticket-board-filter-empty" className="mb-4">No tickets match the selected Badges.</EmptyMessage>
      )}
      {state.kind === "loaded" && (
        <div data-testid="board-columns" className="scroll-hint grid grid-flow-col auto-cols-[minmax(10rem,1fr)] max-md:auto-cols-[minmax(13rem,1fr)] gap-3 overflow-x-auto px-1 pt-3 pb-6">
          {statuses.map(({ value, label }) => {
            const tickets = state.tickets.filter((ticket) => ticket.status === value);
            const dragging = draggingTicket !== undefined;
            const blocked = dragging && !(draggingTicket.status === value) && !canMove(draggingTicket, value);
            const isOrigin = dragging && draggingTicket.status === value;
            const isDropTarget = dragging && canMove(draggingTicket, value);
            return (
              <section
                key={value}
                {...statusTone(value)}
                data-testid={`board-status-${value}`}
                data-drop-target={isDropTarget ? "true" : undefined}
                data-drop-blocked={dragging && !isDropTarget && !isOrigin ? "true" : undefined}
                className={cx(
                  "flex min-w-0 flex-col p-2",
                  isDropTarget && "bg-paper/10 outline-2 -outline-offset-2 outline-(--status-text) outline-dashed",
                )}
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
                <div className="flex items-center justify-between border-b-2 border-(--status) pb-2">
                  <h3 id={`board-heading-${value}`} className="text-label font-bold tracking-label text-(--status-text) uppercase">{label}</h3>
                  <span aria-hidden="true" className="grid size-6 place-items-center rounded-pill bg-(--status-text) text-label font-bold text-ground">{tickets.length}</span>
                </div>
                <p aria-hidden="true" className={cx("mt-2 min-h-4 text-center", slipEdge, isDropTarget ? "font-bold text-(--status-text)" : "text-dim")}>
                  {dragging && (isDropTarget ? "▾ Drop here" : isOrigin ? "● Current" : "✕ Not allowed")}
                </p>
                <div aria-hidden="true" className={cx("mt-4 h-2 rounded-pill bg-linear-to-b from-rail to-rail-shade shadow-inner", blocked && "opacity-40")} />
                {tickets.length === 0 ? <p className="pt-4 text-center text-label text-dim">— no orders —</p> : (
                  <ul className={cx("-mt-3 flex flex-col gap-4 px-1", blocked && "opacity-40")}>
                    {tickets.map((ticket) => {
                      const eligibleTargets = moveTargets(ticket);
                      const pending = pendingId === ticket.id;
                      const beingDragged = draggingId === ticket.id;
                      return (
                        <li
                          key={ticket.id}
                          data-testid={ticketRowTestId("board", ticket.id)}
                          data-dragging={beingDragged ? "true" : undefined}
                          aria-busy={pending}
                          draggable={!pending}
                          style={{ "--tilt": `${slipTilt(ticket.id)}deg` } as CSSProperties}
                          className={cx("slip", !pending && "cursor-grab", beingDragged && "opacity-60")}
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
                          <div
                            data-surface="paper"
                            {...statusTone(ticket.status)}
                            className={cx(
                              "slip-paper flex flex-col gap-2 border-t-4 border-(--status) bg-paper px-3 pt-3 pb-5 text-ink",
                              beingDragged && "outline-2 -outline-offset-4 outline-ink outline-dashed",
                              pending && "opacity-70",
                            )}
                          >
                            <div className="flex justify-between text-label text-muted">
                              <span>{ticketSerial(ticket.id)}</span>
                              <time dateTime={ticket.createdAt}>{shortDate(ticket.createdAt)}</time>
                            </div>
                            <TicketModalLink ticketId={ticket.id} view="board" disabled={pending} className="font-bold break-words text-ink">{ticket.title}</TicketModalLink>
                            <Rule className="my-0!" />
                            <div className="text-label">
                              <p>Template: {ticket.template}</p>
                              <p>Assignee: {ticket.assigneeType === "owner" ? "Owner" : "Unassigned"}</p>
                            </div>
                            <p data-testid="board-badges" aria-label={`Badges: ${ticket.badges.map((badge) => badge.name).join(", ") || "none"}`} className="flex flex-wrap gap-1 empty:hidden">
                              {ticket.badges.map((badge, index) => (
                                <span key={badge.id}>
                                  {index > 0 && <span className="sr-only">, </span>}
                                  <BadgeTag>{badge.name}</BadgeTag>
                                </span>
                              ))}
                            </p>
                            {pending && <span role="status" className="self-start rounded-tag bg-ink px-2 py-0.5 text-label font-bold tracking-label text-amber uppercase">Moving…</span>}
                            {eligibleTargets.length > 0 && (
                              <DropdownMenu.Root modal={false}>
                                <DropdownMenu.Trigger data-testid="move-to-trigger" disabled={pendingId !== null} className={cx(buttonClasses("secondary"), "self-start px-2 py-1 text-label tracking-label uppercase")}>Move to…</DropdownMenu.Trigger>
                                <DropdownMenu.Portal>
                                  <DropdownMenu.Content align="start" sideOffset={4} className="z-50 min-w-40 border-2 border-ink bg-paper p-1 text-ink shadow-paper">
                                    {eligibleTargets.map((target) => (
                                      <DropdownMenu.Item
                                        key={target}
                                        data-move-target={target}
                                        className="cursor-pointer px-2 py-1.5 text-body font-bold outline-none data-[highlighted]:bg-ink data-[highlighted]:text-amber data-[highlighted]:before:mr-1 data-[highlighted]:before:content-['▸']"
                                        onSelect={() => void moveTicket(ticket, target)}
                                      >
                                        {statusLabel(target)}
                                      </DropdownMenu.Item>
                                    ))}
                                  </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                              </DropdownMenu.Root>
                            )}
                          </div>
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
        <ErrorMessage title="Unable to refresh tickets." data-testid="ticket-board-refresh-error" className="mt-4">
          <p data-testid="ticket-board-refresh-error-message">{state.refreshError}</p>
        </ErrorMessage>
      )}
      {moveError && <ErrorMessage title={moveError} data-testid="ticket-board-move-error" className="mt-4" />}
    </section>
  );
}
