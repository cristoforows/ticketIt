import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { UnauthenticatedError } from "../api/session";
import { changeTicketStatus, fetchTickets, reorderTicket, type Ticket, type TicketPlacement } from "../api/tickets";
import { BoardColumn, BoardColumns, Caption, ColumnHeader, DropHint, EmptyMessage, ErrorMessage, LoadingMessage, Rail, SlipList, statuses, statusTone } from "./ui";
import { BoardStageSwitcher } from "./BoardStageSwitcher";
import { scrollBehavior, useIsPhone } from "./usePhone";
import { focusReorderButton, type ReorderDirection } from "./ReorderButtons";
import { focusTicketRow, refocusTicketRowIfFocusLost, ticketRowTestId } from "./TicketModalLink";
import { TicketSlip } from "./TicketSlip";

type BoardState =
  | { kind: "loading" }
  | { kind: "loaded"; tickets: Ticket[]; refreshKey: number; refreshError?: string }
  | { kind: "error"; message: string };

export function TicketBoard({ onUnauthenticated, refreshKey = 0, focusTicketId, badgeIds = [] }: { onUnauthenticated: () => void; refreshKey?: number; focusTicketId?: string; badgeIds?: string[] }) {
  const [state, setState] = useState<BoardState>({ kind: "loading" });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropSlot, setDropSlot] = useState<{ id: string; placement: "before" | "after" } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [moveRefreshKey, setMoveRefreshKey] = useState(0);
  const commandPending = useRef(false);
  const requestId = useRef(0);
  const focusMovedTicketId = useRef<string | null>(null);
  const focusReorder = useRef<{ id: string; direction?: ReorderDirection } | null>(null);
  const focusedRefreshKey = useRef(0);
  const phone = useIsPhone();
  const [stage, setStage] = useState(() => {
    const index = statuses.findIndex(({ value }) => value === new URLSearchParams(window.location.search).get("stage"));
    return Math.max(index, 0);
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const columnLeft = (index: number) => {
    const container = columnsRef.current;
    const column = container?.children[index];
    if (!container || !column) return 0;
    return column.getBoundingClientRect().left - container.getBoundingClientRect().left + container.scrollLeft;
  };

  const rememberStage = (index: number) => {
    if (window.location.pathname !== "/board") return;
    const query = new URLSearchParams(window.location.search);
    if (index === 0) query.delete("stage");
    else query.set("stage", statuses[index].value);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
  };

  const goToStage = useCallback((index: number) => {
    setStage(index);
    rememberStage(index);
    setSelectedId(null);
    columnsRef.current?.scrollTo?.({ left: columnLeft(index), behavior: scrollBehavior() });
  }, []);

  function syncStageFromScroll() {
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      const container = columnsRef.current;
      if (!container) return;
      let nearest = 0;
      for (let index = 1; index < container.children.length; index++) {
        if (Math.abs(columnLeft(index) - container.scrollLeft) < Math.abs(columnLeft(nearest) - container.scrollLeft)) nearest = index;
      }
      setStage((current) => {
        if (current !== nearest) setSelectedId(null);
        return nearest;
      });
      rememberStage(nearest);
    }, 100);
  }

  useEffect(() => () => clearTimeout(scrollTimer.current), []);

  const loaded = state.kind === "loaded";
  useLayoutEffect(() => {
    if (!loaded || !phone || stage === 0) return;
    columnsRef.current?.scrollTo?.({ left: columnLeft(stage), behavior: "instant" });
  }, [loaded, phone]);

  useEffect(() => {
    if (!phone || !selectedId) return;
    const toggle = () => document.querySelector<HTMLElement>(`[data-testid="${ticketRowTestId("board", selectedId)}"] [data-testid="board-slip-toggle"]`);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelectedId(null);
      toggle()?.focus({ preventScroll: true });
    };
    // Another slip's toggle switches the selection on click; collapsing the
    // open panel on pointerdown would shift that toggle out from under the
    // pointer before the click lands.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest(`[data-testid="${ticketRowTestId("board", selectedId)}"]`) || target.closest('[data-testid="board-slip-toggle"]')) return;
      setSelectedId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [phone, selectedId]);

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
    if (state.kind !== "loaded" || !focusReorder.current) return;
    const { id, direction } = focusReorder.current;
    focusReorder.current = null;
    if (direction) focusReorderButton(document.querySelector(`[data-testid="${ticketRowTestId("board", id)}"]`), "board-slip", direction);
    else focusTicketRow("board", id);
  }, [state]);

  useEffect(() => {
    if (state.kind !== "loaded" || !focusMovedTicketId.current) return;
    const id = focusMovedTicketId.current;
    focusMovedTicketId.current = null;
    if (phone) {
      document.querySelector<HTMLElement>(`[data-testid="board-stage-step-${statuses[stage].value}"]`)?.focus({ preventScroll: true });
      return;
    }
    focusTicketRow("board", id);
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

  async function reorderOnBoard(ticket: Ticket, placement: TicketPlacement, direction?: ReorderDirection) {
    if (commandPending.current) return;
    commandPending.current = true;
    setPendingId(ticket.id);
    setMoveError(null);
    try {
      await reorderTicket(ticket.id, placement);
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        onUnauthenticated();
        return;
      }
      setMoveError(error instanceof Error ? error.message : "Failed to reorder the ticket.");
    } finally {
      commandPending.current = false;
      setPendingId(null);
    }
    focusReorder.current = { id: ticket.id, direction };
    setMoveRefreshKey((key) => key + 1);
  }

  const dropPlacement = (event: DragEvent<HTMLLIElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? "before" : "after";
  };

  const reorderDropHandlers = (ticket: Ticket) => {
    const reorderable = draggingTicket !== undefined && draggingTicket.status === ticket.status && draggingTicket.id !== ticket.id;
    return {
      onDragOver: (event: DragEvent<HTMLLIElement>) => {
        if (!reorderable) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const placement = dropPlacement(event);
        if (dropSlot?.id !== ticket.id || dropSlot.placement !== placement) setDropSlot({ id: ticket.id, placement });
      },
      onDragLeave: (event: DragEvent<HTMLLIElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropSlot(null);
      },
      onDrop: (event: DragEvent<HTMLLIElement>) => {
        if (!reorderable) return;
        event.preventDefault();
        event.stopPropagation();
        const placement = dropPlacement(event);
        setDraggingId(null);
        setDropSlot(null);
        void reorderOnBoard(draggingTicket, placement === "before" ? { before: ticket.id } : { after: ticket.id });
      },
    };
  };

  return (
    <section data-testid="ticket-board" className="min-w-0">
      <Caption as="h2" tone="ground" className="mb-3">Board</Caption>
      {state.kind === "loading" && <LoadingMessage data-testid="ticket-board-loading">Loading tickets…</LoadingMessage>}
      {state.kind === "error" && (
        <ErrorMessage title="Unable to load tickets." data-testid="ticket-board-error">
          <p data-testid="ticket-board-error-message">{state.message}</p>
        </ErrorMessage>
      )}
      {state.kind === "loaded" && (
        state.tickets.length === 0 && badgeIds.length > 0 && <EmptyMessage data-testid="ticket-board-filter-empty" className="mb-4">No tickets match the selected Badges.</EmptyMessage>
      )}
      {state.kind === "loaded" && phone && (
        <BoardStageSwitcher
          stages={statuses.map(({ value, label }) => ({ value, label, count: state.tickets.filter((ticket) => ticket.status === value).length }))}
          current={stage}
          onSelect={goToStage}
        />
      )}
      {state.kind === "loaded" && (
        <BoardColumns ref={columnsRef} data-testid="board-columns" onScroll={phone ? syncStageFromScroll : undefined}>
          {statuses.map(({ value, label }, columnIndex) => {
            const tickets = state.tickets.filter((ticket) => ticket.status === value);
            const dragging = draggingTicket !== undefined;
            const blocked = dragging && !(draggingTicket.status === value) && !canMove(draggingTicket, value);
            const isOrigin = dragging && draggingTicket.status === value;
            const isDropTarget = dragging && canMove(draggingTicket, value);
            return (
              <BoardColumn
                key={value}
                {...statusTone(value)}
                inert={phone && columnIndex !== stage}
                data-testid={`board-status-${value}`}
                data-drop-target={isDropTarget ? "true" : undefined}
                data-drop-blocked={blocked ? "true" : undefined}
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
                <ColumnHeader id={`board-heading-${value}`} label={label} count={tickets.length} />
                <DropHint hint={dragging ? (isDropTarget ? "target" : isOrigin ? (tickets.length > 1 ? "reorder" : "origin") : "blocked") : undefined} />
                <Rail />
                {tickets.length === 0 ? <p className="pt-4 text-center text-label text-dim">— no orders —</p> : (
                  <SlipList>
                    {tickets.map((ticket) => (
                      <TicketSlip
                        key={ticket.id}
                        ticket={ticket}
                        stageTickets={tickets}
                        phone={phone}
                        pending={pendingId === ticket.id}
                        anyPending={pendingId !== null}
                        selected={phone && selectedId === ticket.id}
                        beingDragged={draggingId === ticket.id}
                        moveTargets={moveTargets(ticket)}
                        onToggle={() => setSelectedId(selectedId === ticket.id ? null : ticket.id)}
                        onDismiss={() => setSelectedId(null)}
                        onMove={(target) => void moveTicket(ticket, target)}
                        onReorder={(placement, direction) => void reorderOnBoard(ticket, placement, direction)}
                        dropPosition={dropSlot?.id === ticket.id ? dropSlot.placement : undefined}
                        {...reorderDropHandlers(ticket)}
                        onDragStart={(event) => {
                          if (commandPending.current) {
                            event.preventDefault();
                            return;
                          }
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("application/x-ticketit-ticket", ticket.id);
                          setDraggingId(ticket.id);
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDropSlot(null);
                        }}
                      />
                    ))}
                  </SlipList>
                )}
              </BoardColumn>
            );
          })}
        </BoardColumns>
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
