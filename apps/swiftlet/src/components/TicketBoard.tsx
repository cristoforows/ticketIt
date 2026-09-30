import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { UnauthenticatedError } from "../api/session";
import { changeTicketStatus, fetchTickets, type Ticket } from "../api/tickets";
import { BadgeList, BoardColumn, BoardColumns, Caption, ColumnHeader, DropHint, EmptyMessage, ErrorMessage, LoadingMessage, PendingTag, Rail, Rule, shortDate, Slip, SlipList, SlipPaper, SlipToggle, slipTilt, statuses, statusTone, ticketSerial } from "./ui";
import { openTicketModal } from "../router";
import { BoardStageSwitcher } from "./BoardStageSwitcher";
import { SlipActions } from "./SlipActions";
import { scrollBehavior, useIsPhone } from "./usePhone";
import { focusTicketRow, refocusTicketRowIfFocusLost, TicketModalLink, ticketRowTestId } from "./TicketModalLink";

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
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element).closest(`[data-testid="${ticketRowTestId("board", selectedId)}"]`)) setSelectedId(null);
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
                <DropHint hint={dragging ? (isDropTarget ? "target" : isOrigin ? "origin" : "blocked") : undefined} />
                <Rail />
                {tickets.length === 0 ? <p className="pt-4 text-center text-label text-dim">— no orders —</p> : (
                  <SlipList>
                    {tickets.map((ticket) => {
                      const eligibleTargets = moveTargets(ticket);
                      const pending = pendingId === ticket.id;
                      const selected = phone && selectedId === ticket.id;
                      const panelId = `board-slip-actions-${ticket.id}`;
                      const beingDragged = draggingId === ticket.id;
                      return (
                        <Slip
                          key={ticket.id}
                          tilt={slipTilt(ticket.id)}
                          stacked={phone}
                          dragging={beingDragged}
                          selected={selected}
                          data-testid={ticketRowTestId("board", ticket.id)}
                          aria-busy={pending}
                          draggable={!pending && !phone}
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
                          <SlipPaper status={ticket.status}>
                            <div className="flex justify-between text-label text-muted">
                              <span>{ticketSerial(ticket.id)}</span>
                              <time dateTime={ticket.createdAt}>{shortDate(ticket.createdAt)}</time>
                            </div>
                            <TicketModalLink ticketId={ticket.id} view="board" variant="slip" disabled={pending}>{ticket.title}</TicketModalLink>
                            <Rule className="my-0" />
                            <div className="text-label">
                              <p>Template: {ticket.template}</p>
                              <p>Assignee: {ticket.assigneeType === "owner" ? "Owner" : "Unassigned"}</p>
                            </div>
                            <BadgeList data-testid="board-badges" badges={ticket.badges} />
                            {pending && <PendingTag className="self-start">Moving…</PendingTag>}
                          </SlipPaper>
                          {phone && !pending && (
                            <SlipToggle
                              data-testid="board-slip-toggle"
                              aria-label={`Actions for ${ticket.title}`}
                              aria-expanded={selected}
                              aria-controls={panelId}
                              onClick={() => setSelectedId(selected ? null : ticket.id)}
                            />
                          )}
                          {selected && (
                            <SlipActions
                              id={panelId}
                              ticket={ticket}
                              targets={eligibleTargets}
                              disabled={pendingId !== null}
                              onView={() => { setSelectedId(null); openTicketModal(ticket.id, "board"); }}
                              onEdit={() => { setSelectedId(null); openTicketModal(ticket.id, "board", true); }}
                              onMove={(target) => { setSelectedId(null); void moveTicket(ticket, target); }}
                            />
                          )}
                        </Slip>
                      );
                    })}
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
