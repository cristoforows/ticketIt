import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TicketBoard } from "./TicketBoard";

const ticket = (id: string, status: string, template = "Basic") => ({
  id,
  title: `Ticket ${id}`,
  status,
  template,
  allowedActions: { statusChanges: [], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } } },
  completionCondition: "humanAcceptance",
  assigneeType: "",
  goal: "",
  context: "",
  successCriteria: "",
  constraints: "",
  repository: "",
  createdAt: "2026-09-22T10:00:00Z",
  updatedAt: "2026-09-22T10:00:00Z",
  badges: [],
});

function stubTickets(tickets: unknown[], status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "Service Unavailable",
    json: async () => ({ tickets }),
  }));
}

describe("TicketBoard", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders six ordered Status sections, including empty ones, with each persisted Ticket once and in Galley's order", async () => {
    const tickets = [
      ticket("new-blocked", "Blocked", "Coding"),
      ticket("new-backlog", "Backlog"),
      ticket("old-blocked", "Blocked"),
      ticket("ready", "Ready"),
      ticket("in-progress", "InProgress"),
      ticket("in-review", "InReview"),
      ticket("done", "Done"),
    ];
    stubTickets(tickets);

    render(<TicketBoard onUnauthenticated={() => {}} />);

    const sections = await screen.findAllByTestId(/^board-status-/);
    expect(sections.map((section) => within(section).getByRole("heading").textContent)).toEqual([
      "Backlog", "Ready", "In Progress", "Blocked", "In Review", "Done",
    ]);
    expect(within(sections[3]).getAllByTestId(/^board-ticket-/).map((card) => card.getAttribute("data-testid"))).toEqual([
      "board-ticket-new-blocked", "board-ticket-old-blocked",
    ]);
    expect(screen.getAllByTestId(/^board-ticket-/)).toHaveLength(tickets.length);
    expect(within(sections[3]).getByRole("link", { name: "Ticket new-blocked" })).toHaveAttribute("href", "/tickets/new-blocked");
    expect(within(sections[3]).getByTestId("board-ticket-new-blocked")).toHaveTextContent("Coding");
    expect(fetch).toHaveBeenCalledWith("/api/tickets", undefined);
  });

  it("renders Badge names with an accessible label", async () => {
    const ticketWithBadge = { ...ticket("badged", "Backlog"), badges: [{ id: "badge-1", name: "Urgent" }] };
    stubTickets([ticketWithBadge]);

    render(<TicketBoard onUnauthenticated={() => {}} />);

    const card = await screen.findByTestId("board-ticket-badged");
    expect(within(card).getByTestId("board-badges")).toHaveTextContent("Urgent");
    expect(within(card).getByLabelText("Badges: Urgent")).toBeInTheDocument();
  });

  it("shows empty sections even when there are no Tickets", async () => {
    stubTickets([]);
    render(<TicketBoard onUnauthenticated={() => {}} />);

    expect(await screen.findAllByText("No tickets.")).toHaveLength(6);
    expect(screen.queryByTestId(/^board-ticket-/)).not.toBeInTheDocument();
  });

  it("keeps empty Status sections beside populated ones", async () => {
    stubTickets([ticket("captured", "Backlog"), ticket("reviewing", "InReview")]);
    render(<TicketBoard onUnauthenticated={() => {}} />);

    const sections = await screen.findAllByTestId(/^board-status-/);
    expect(sections.map((section) => within(section).getByRole("heading").textContent)).toEqual([
      "Backlog", "Ready", "In Progress", "Blocked", "In Review", "Done",
    ]);
    for (const [status, id] of [["Backlog", "captured"], ["InReview", "reviewing"]]) {
      const section = within(screen.getByTestId(`board-status-${status}`));
      expect(section.getByTestId(`board-ticket-${id}`)).toBeInTheDocument();
      expect(section.queryByText("No tickets.")).not.toBeInTheDocument();
    }
    for (const status of ["Ready", "InProgress", "Blocked", "Done"]) {
      const section = within(screen.getByTestId(`board-status-${status}`));
      expect(section.getByText("No tickets.")).toBeInTheDocument();
      expect(section.queryByTestId(/^board-ticket-/)).not.toBeInTheDocument();
    }
  });

  it("shows a loading state, then an explicit error instead of partial columns on failure", async () => {
    stubTickets([], 503);
    render(<TicketBoard onUnauthenticated={() => {}} />);

    expect(screen.getByTestId("ticket-board-loading")).toBeInTheDocument();
    expect(await screen.findByTestId("ticket-board-error")).toHaveTextContent("503");
    expect(screen.queryByTestId(/^board-status-/)).not.toBeInTheDocument();
  });

  it("does not silently omit a Ticket whose Status is outside the contract", async () => {
    stubTickets([ticket("unexpected", "Unknown")]);
    render(<TicketBoard onUnauthenticated={() => {}} />);

    expect(await screen.findByTestId("ticket-board-error")).toBeInTheDocument();
    expect(screen.queryByTestId(/^board-status-/)).not.toBeInTheDocument();
  });

  it("returns to sign-in on a 401", async () => {
    stubTickets([], 401);
    const onUnauthenticated = vi.fn();
    render(<TicketBoard onUnauthenticated={onUnauthenticated} />);

    await vi.waitFor(() => expect(onUnauthenticated).toHaveBeenCalledOnce());
  });

  it("highlights only advertised drag targets and sends no disallowed or Done command", async () => {
    stubTickets([{ ...ticket("moving", "Backlog"), allowedActions: { statusChanges: ["Ready", "Blocked", "Done"], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } } } }]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    const card = await screen.findByTestId("board-ticket-moving");
    const trigger = within(card).getByRole("button", { name: "Move to…" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect((await screen.findAllByRole("menuitem")).map((item) => item.getAttribute("data-move-target"))).toEqual(["Ready", "Blocked"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn(), effectAllowed: "move" } });
    expect(screen.getByTestId("board-status-Ready")).toHaveAttribute("data-drop-target", "true");
    expect(screen.getByTestId("board-status-Blocked")).toHaveAttribute("data-drop-target", "true");
    expect(screen.getByTestId("board-status-InReview")).not.toHaveAttribute("data-drop-target", "true");
    expect(screen.getByTestId("board-status-Done")).not.toHaveAttribute("data-drop-target", "true");
    fireEvent.drop(screen.getByTestId("board-status-InReview"));
    fireEvent.drop(screen.getByTestId("board-status-Done"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("waits for Galley's response before moving and uses returned actions", async () => {
    const original = { ...ticket("moving", "Backlog"), allowedActions: { statusChanges: ["Ready"], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } } } };
    const changed = { ...original, status: "Ready", allowedActions: { ...original.allowedActions, statusChanges: ["Backlog", "InProgress"] } };
    let resolveCommand!: (response: unknown) => void;
    const fetchStub = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: [original] }) })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCommand = resolve; }));
    vi.stubGlobal("fetch", fetchStub);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    const card = await screen.findByTestId("board-ticket-moving");
    const trigger = within(card).getByRole("button", { name: "Move to…" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ready" }));
    expect(screen.getByTestId("board-status-Backlog")).toContainElement(card);
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    expect(fetchStub).toHaveBeenLastCalledWith("/api/tickets/moving/status", expect.objectContaining({ method: "POST", body: JSON.stringify({ status: "Ready" }) }));
    resolveCommand({ ok: true, status: 200, json: async () => changed });
    await vi.waitFor(() => expect(screen.getByTestId("board-status-Ready")).toContainElement(screen.getByTestId("board-ticket-moving")));
    const moved = screen.getByTestId("board-ticket-moving");
    await vi.waitFor(() => expect(within(moved).getByRole("button", { name: "Move to…" })).toHaveFocus());
    const nextTrigger = within(moved).getByRole("button", { name: "Move to…" });
    nextTrigger.focus();
    fireEvent.keyDown(nextTrigger, { key: "Enter" });
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Backlog", "In Progress"]);
  });

  it("shows Galley's rejection verbatim without moving the card", async () => {
    const original = { ...ticket("stale", "Backlog"), allowedActions: { statusChanges: ["Ready"], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } } } };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: [original] }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { code: "invalid_transition", message: "Galley stale move reason" } }) }));
    render(<TicketBoard onUnauthenticated={() => {}} />);
    const card = await screen.findByTestId("board-ticket-stale");
    const trigger = within(card).getByRole("button", { name: "Move to…" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ready" }));
    expect(await screen.findByTestId("ticket-board-move-error")).toHaveTextContent("Galley stale move reason");
    expect(screen.getByTestId("board-status-Backlog")).toContainElement(card);
    expect(within(card).getByRole("link")).not.toHaveAttribute("aria-disabled", "true");
    await vi.waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps focus on a moved card after the follow-up read, not on the Ticket whose modal closed earlier", async () => {
    const actions = { statusChanges: ["Ready"], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } } };
    const closed = { ...ticket("closed", "Backlog"), allowedActions: actions };
    const moving = { ...ticket("moving", "Backlog"), allowedActions: actions };
    const changed = { ...moving, status: "Ready", allowedActions: { ...actions, statusChanges: ["Backlog"] } };
    const fetchStub = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: [closed, moving] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => changed })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: [closed, changed] }) });
    vi.stubGlobal("fetch", fetchStub);
    render(<TicketBoard onUnauthenticated={() => {}} refreshKey={1} focusTicketId="closed" />);
    await vi.waitFor(() => expect(within(screen.getByTestId("board-ticket-closed")).getByRole("link")).toHaveFocus());
    const trigger = within(screen.getByTestId("board-ticket-moving")).getByRole("button", { name: "Move to…" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ready" }));
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(screen.getByTestId("board-status-Ready")).toContainElement(screen.getByTestId("board-ticket-moving")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(screen.getByTestId("board-ticket-moving")).getByRole("button", { name: "Move to…" })).toHaveFocus();
  });
});
