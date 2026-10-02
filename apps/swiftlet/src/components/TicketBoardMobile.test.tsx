import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TicketBoard } from "./TicketBoard";

const accept = { available: false, reason: { code: "invalid_transition", message: "Unavailable" } };
const rework = { available: false, reason: { code: "rework_not_available", message: "Unavailable" } };
const stop = { available: false, reason: { code: "stop_not_available", message: "Unavailable" } };
const ticket = (id: string, status: string, statusChanges: string[] = [], archivedAt: string | null = null) => ({
  id,
  title: `Ticket ${id}`,
  status,
  template: "Basic",
  allowedActions: { statusChangeRejections: [], statusChanges, accept, rework, stop },
  completionCondition: "humanAcceptance",
  assigneeType: "",
  assigneeAgent: null,
  requestingAgentWork: false,
  openRound: null,
  delivery: null,
  goal: "",
  context: "",
  successCriteria: "",
  constraints: "",
  repository: "",
  createdAt: "2026-09-22T10:00:00Z",
  updatedAt: "2026-09-22T10:00:00Z",
  badges: [],
  archivedAt,
});

function stubMedia(reducedMotion = false) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("width") || (reducedMotion && query.includes("reduced-motion")),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe("TicketBoard on phones", () => {
  beforeEach(() => stubMedia());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
  });

  function stubTickets(tickets: unknown[]) {
    const fetchStub = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ tickets }) });
    vi.stubGlobal("fetch", fetchStub);
    return fetchStub;
  }

  it("offers no archive drop zone, since slips are not draggable", async () => {
    stubTickets([ticket("phone", "Backlog")]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    await screen.findByTestId("board-ticket-phone");

    expect(screen.queryByTestId("board-archive-zone")).not.toBeInTheDocument();
  });

  it("offers no edit, move or reorder on a locked slip, with Galley's reason on Edit", async () => {
    const reason = { code: "round_open", message: "this Ticket has an open Round; it can be changed once the Round ends", roundId: "r1" };
    const agent = { id: "a1", name: "Builder", kind: "coding" };
    const openRound = { id: "r1", sequence: 1, state: "claimed", agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null, stopRequestedAt: null };
    stubTickets([
      { ...ticket("locked", "Backlog"), assigneeType: "agent", assigneeAgent: agent, openRound, allowedActions: { statusChangeRejections: [], statusChanges: [], accept: { available: false, reason }, rework, stop } },
      ticket("next", "Backlog", ["Ready"]),
    ]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    fireEvent.click(within(await screen.findByTestId("board-ticket-locked")).getByTestId("board-slip-toggle"));

    const actions = screen.getByTestId("board-slip-actions");
    expect(within(actions).getByTestId("board-slip-view")).toBeEnabled();
    expect(within(actions).getByTestId("board-slip-edit")).toBeDisabled();
    expect(within(actions).getByTestId("board-slip-edit")).toHaveAttribute("title", reason.message);
    expect(within(actions).getByTestId("board-slip-move")).toBeDisabled();
    expect(within(actions).queryByTestId("board-slip-reorder-up")).not.toBeInTheDocument();
  });

  describe("stage switcher", () => {
    it("steps with Previous and Next, disabling each at its end", async () => {
      stubTickets([ticket("a", "Backlog"), ticket("b", "Ready")]);
      render(<TicketBoard onUnauthenticated={() => {}} />);
      const switcher = await screen.findByTestId("board-stage-switcher");
      expect(within(switcher).getByTestId("board-stage-current")).toHaveTextContent("Backlog1");
      expect(screen.getByTestId("board-stage-prev")).toBeDisabled();
      expect(screen.getByTestId("board-stage-next")).toHaveAccessibleName("Next stage: Ready");

      fireEvent.click(screen.getByTestId("board-stage-next"));
      expect(screen.getByTestId("board-stage-current")).toHaveTextContent("Ready1");
      expect(screen.getByTestId("board-stage-prev")).toHaveAccessibleName("Previous stage: Backlog");
      expect(screen.getByTestId("board-stage-prev")).toBeEnabled();

      fireEvent.click(screen.getByTestId("board-stage-step-Done"));
      expect(screen.getByTestId("board-stage-next")).toBeDisabled();
      expect(screen.getByTestId("board-stage-step-Done")).toHaveAttribute("aria-current", "true");
      expect(screen.getByTestId("board-stage-step-Ready")).not.toHaveAttribute("aria-current");
    });

    it("scrolls smoothly, or instantly under reduced motion", async () => {
      stubTickets([]);
      const scrollTo = vi.fn();
      Element.prototype.scrollTo = scrollTo;
      render(<TicketBoard onUnauthenticated={() => {}} />);
      fireEvent.click(await screen.findByTestId("board-stage-next"));
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "smooth" }));
      stubMedia(true);
      fireEvent.click(screen.getByTestId("board-stage-next"));
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "auto" }));
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    });

    it("follows swipes once scrolling settles", async () => {
      stubTickets([]);
      render(<TicketBoard onUnauthenticated={() => {}} />);
      const columns = await screen.findByTestId("board-columns");
      Array.from(columns.children).forEach((column, index) => {
        column.getBoundingClientRect = () => ({ left: index * 300 - columns.scrollLeft } as DOMRect);
      });
      columns.getBoundingClientRect = () => ({ left: 0 } as DOMRect);
      Object.defineProperty(columns, "scrollLeft", { value: 610, configurable: true });
      fireEvent.scroll(columns);
      await waitFor(() => expect(screen.getByTestId("board-stage-current")).toHaveTextContent("In Progress"));
      expect(screen.getByTestId("board-stage-step-InProgress")).toHaveAttribute("aria-current", "true");
    });

    it("keeps the current stage when the board refreshes", async () => {
      stubTickets([ticket("a", "Backlog")]);
      const { rerender } = render(<TicketBoard onUnauthenticated={() => {}} refreshKey={0} />);
      fireEvent.click(await screen.findByTestId("board-stage-step-InProgress"));
      rerender(<TicketBoard onUnauthenticated={() => {}} refreshKey={1} />);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("board-stage-current")).toHaveTextContent("In Progress");
    });
  });

  describe("slip actions", () => {
    async function renderBoard() {
      stubTickets([ticket("a", "Backlog", ["Ready", "Blocked", "Done"]), ticket("b", "Backlog"), ticket("c", "Backlog", [], "2026-09-23T00:00:00Z")]);
      render(<TicketBoard onUnauthenticated={() => {}} />);
      return screen.findByTestId("board-ticket-a");
    }

    it("selects one slip at a time, greying it and hiding Move to…", async () => {
      const a = await renderBoard();
      expect(within(a).queryByTestId("move-to-trigger")).not.toBeInTheDocument();
      const toggle = within(a).getByTestId("board-slip-toggle");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(toggle).toHaveAttribute("aria-controls", within(a).getByTestId("board-slip-actions").id);
      expect(window.location.pathname).toBe("/");

      const toggleB = within(screen.getByTestId("board-ticket-b")).getByTestId("board-slip-toggle");
      fireEvent.pointerDown(toggleB);
      expect(within(a).getByTestId("board-slip-actions")).toBeInTheDocument();
      fireEvent.click(toggleB);
      expect(screen.getAllByTestId("board-slip-actions")).toHaveLength(1);
      expect(within(a).queryByTestId("board-slip-actions")).not.toBeInTheDocument();
    });

    it("deselects on the same slip, Escape and an outside tap, returning focus on Escape", async () => {
      const a = await renderBoard();
      const toggle = within(a).getByTestId("board-slip-toggle");
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      expect(screen.queryByTestId("board-slip-actions")).not.toBeInTheDocument();

      fireEvent.click(toggle);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("board-slip-actions")).not.toBeInTheDocument();
      expect(toggle).toHaveFocus();

      fireEvent.click(toggle);
      fireEvent.pointerDown(document.body);
      expect(screen.queryByTestId("board-slip-actions")).not.toBeInTheDocument();
    });

    it("View and Edit open the detail modal route, Edit with the edit flag", async () => {
      const a = await renderBoard();
      fireEvent.click(within(a).getByTestId("board-slip-toggle"));
      fireEvent.click(screen.getByTestId("board-slip-view"));
      expect(window.location.pathname + window.location.search).toBe("/tickets/a?from=board");
      expect(window.history.state.ticketModal.background).toBe("board");
      expect(screen.queryByTestId("board-slip-actions")).not.toBeInTheDocument();

      fireEvent.click(within(a).getByTestId("board-slip-toggle"));
      fireEvent.click(screen.getByTestId("board-slip-edit"));
      expect(window.location.search).toBe("?from=board&edit=true");
    });

    it("disables Edit for an archived Ticket and Move stage without targets", async () => {
      await renderBoard();
      fireEvent.click(within(screen.getByTestId("board-ticket-c")).getByTestId("board-slip-toggle"));
      expect(screen.getByTestId("board-slip-edit")).toBeDisabled();
      expect(screen.getByTestId("board-slip-edit")).toHaveAttribute("title", "Unavailable");
      expect(screen.getByTestId("board-slip-move")).toBeDisabled();
    });

    it("Move stage lists the allowed targets without Done and moves through the status command", async () => {
      const original = ticket("a", "Backlog", ["Ready", "Blocked", "Done"]);
      const fetchStub = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: [original] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...original, status: "Ready", allowedActions: { statusChangeRejections: [], statusChanges: ["Backlog"], accept, rework, stop } }) })
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ tickets: [{ ...original, status: "Ready" }] }) });
      vi.stubGlobal("fetch", fetchStub);
      render(<TicketBoard onUnauthenticated={() => {}} />);
      const a = await screen.findByTestId("board-ticket-a");
      fireEvent.click(within(a).getByTestId("board-slip-toggle"));
      fireEvent.click(screen.getByTestId("board-slip-move"));
      expect(screen.getAllByTestId(/^board-slip-move-/).map((button) => button.textContent)).toEqual(["Ready", "Blocked"]);

      await act(async () => { fireEvent.click(screen.getByTestId("board-slip-move-Ready")); });
      expect(fetchStub).toHaveBeenCalledWith("/api/tickets/a/status", expect.objectContaining({ method: "POST", body: JSON.stringify({ status: "Ready" }) }));
      await waitFor(() => expect(screen.getByTestId("board-status-Ready")).toContainElement(screen.getByTestId("board-ticket-a")));
      expect(screen.getByTestId("board-stage-current")).toHaveTextContent("Backlog0");
      expect(screen.queryByTestId("board-slip-actions")).not.toBeInTheDocument();
      expect(screen.getByTestId("board-stage-step-Backlog")).toHaveFocus();
    });

    it("Move up and Move down reorder within the stage, keep the actions open, and disable each end with its reason", async () => {
      const fetchStub = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: [ticket("a", "Backlog"), ticket("r", "Ready"), ticket("b", "Backlog")] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ticket("b", "Backlog") })
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ tickets: [ticket("b", "Backlog"), ticket("a", "Backlog"), ticket("r", "Ready")] }) });
      vi.stubGlobal("fetch", fetchStub);
      render(<TicketBoard onUnauthenticated={() => {}} />);
      fireEvent.click(within(await screen.findByTestId("board-ticket-b")).getByTestId("board-slip-toggle"));
      expect(screen.getByTestId("board-slip-reorder-down")).toBeDisabled();
      expect(screen.getByTestId("board-slip-reorder-down")).toHaveAccessibleDescription("Already last in Backlog");

      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Move up" })); });
      expect(fetchStub).toHaveBeenCalledWith("/api/tickets/b/position", expect.objectContaining({ method: "POST", body: JSON.stringify({ before: "a" }) }));
      await waitFor(() => expect(within(screen.getByTestId("board-status-Backlog")).getAllByTestId(/^board-ticket-/).map((slip) => slip.getAttribute("data-testid")))
        .toEqual(["board-ticket-b", "board-ticket-a"]));
      expect(within(screen.getByTestId("board-ticket-b")).getByTestId("board-slip-actions")).toBeInTheDocument();
      expect(screen.getByTestId("board-slip-reorder-up")).toHaveAccessibleDescription("Already first in Backlog");
      await waitFor(() => expect(screen.getByTestId("board-slip-reorder-down")).toHaveFocus());
    });

    it("offers no reorder buttons on an archived Ticket", async () => {
      await renderBoard();
      fireEvent.click(within(screen.getByTestId("board-ticket-c")).getByTestId("board-slip-toggle"));
      expect(screen.queryByTestId("board-slip-reorder-up")).not.toBeInTheDocument();
    });
  });
});
