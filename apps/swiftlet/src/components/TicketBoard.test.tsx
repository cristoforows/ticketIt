import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { TicketBoard } from "./TicketBoard";

const ticket = (id: string, status: string, template = "Basic") => ({
  id,
  title: `Ticket ${id}`,
  status,
  template,
  permissionGrants: [],
  allowedActions: { statusChangeRejections: [], statusChanges: [], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
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
  archivedAt: null,
});

function stubTickets(tickets: unknown[], status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "Service Unavailable",
    json: async () => ({ tickets }),
  }));
}

function dragMove(card: HTMLElement, status: string) {
  fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn(), effectAllowed: "move" } });
  fireEvent.drop(screen.getByTestId(`board-status-${status}`));
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
    expect(within(sections[3]).getByRole("link", { name: "Ticket new-blocked" })).toHaveAttribute("href", "/tickets/new-blocked?from=board");
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

  it("shows the assigned Agent's name, the Owner, or Unassigned on each slip", async () => {
    stubTickets([
      { ...ticket("agent", "Backlog", "Coding"), assigneeType: "agent", assigneeAgent: { id: "a1", name: "Builder", kind: "coding" } },
      { ...ticket("owner", "Backlog"), assigneeType: "owner" },
      ticket("nobody", "Backlog"),
    ]);

    render(<TicketBoard onUnauthenticated={() => {}} />);

    expect(within(await screen.findByTestId("board-ticket-agent")).getByTestId("board-assignee")).toHaveTextContent("Assignee: Builder");
    expect(within(screen.getByTestId("board-ticket-owner")).getByTestId("board-assignee")).toHaveTextContent("Assignee: Owner");
    expect(within(screen.getByTestId("board-ticket-nobody")).getByTestId("board-assignee")).toHaveTextContent("Assignee: Unassigned");
  });

  it("shows Queued for the Agent only on slips Galley marks as requesting Agent work", async () => {
    const agent = { id: "a1", name: "Builder", kind: "coding" };
    stubTickets([
      { ...ticket("queued", "Ready"), assigneeType: "agent", assigneeAgent: agent, requestingAgentWork: true },
      { ...ticket("not-requested", "Ready"), assigneeType: "agent", assigneeAgent: agent, requestingAgentWork: false },
    ]);

    render(<TicketBoard onUnauthenticated={() => {}} />);

    expect(within(await screen.findByTestId("board-ticket-queued")).getByTestId("board-queued")).toHaveTextContent("Queued for Builder");
    expect(within(screen.getByTestId("board-ticket-not-requested")).queryByTestId("board-queued")).not.toBeInTheDocument();
  });

  it("shows the active slip with Galley's waiting reason only on slips with an open Round", async () => {
    const agent = { id: "a1", name: "Builder", kind: "coding" };
    const round = { id: "r1", sequence: 1, agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null, stopRequestedAt: null, waitingReason: "starting", question: null, permissionRequest: null };
    stubTickets([
      { ...ticket("claimed", "Ready"), assigneeType: "agent", assigneeAgent: agent, openRound: { ...round, state: "claimed" } },
      { ...ticket("running", "Ready"), assigneeType: "agent", assigneeAgent: agent, openRound: { ...round, state: "running", startedAt: "2026-10-01T10:01:00Z", waitingReason: "working" } },
      { ...ticket("queued", "Ready"), assigneeType: "agent", assigneeAgent: agent, requestingAgentWork: true },
    ]);

    render(<TicketBoard onUnauthenticated={() => {}} />);

    const claimed = within(await screen.findByTestId("board-ticket-claimed"));
    expect(claimed.getByTestId("board-waiting-reason")).toHaveTextContent("Starting");
    expect(claimed.queryByTestId("board-queued")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("board-ticket-running")).getByTestId("board-waiting-reason")).toHaveTextContent("Working");
    expect(screen.getByTestId("board-ticket-claimed")).toHaveAttribute("data-active", "true");
    const queued = screen.getByTestId("board-ticket-queued");
    expect(within(queued).queryByTestId("board-active-order")).not.toBeInTheDocument();
    expect(queued).not.toHaveAttribute("data-active");
  });

  it("shows the waiting reason Galley publishes rather than one derived from the Round", async () => {
    const agent = { id: "a1", name: "Builder", kind: "coding" };
    const round = { id: "r1", sequence: 1, agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: "2026-10-01T10:01:00Z", state: "running", stopRequestedAt: null, question: null, permissionRequest: null };
    stubTickets([
      { ...ticket("lost", "InProgress"), assigneeType: "agent", assigneeAgent: agent, openRound: { ...round, waitingReason: "runner_disconnected" } },
      { ...ticket("told", "InProgress"), assigneeType: "agent", assigneeAgent: agent, openRound: { ...round, waitingReason: "stopping" } },
      { ...ticket("claimed", "Ready"), assigneeType: "agent", assigneeAgent: agent, openRound: { ...round, state: "claimed", startedAt: null, waitingReason: "working" } },
    ]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    expect(within(await screen.findByTestId("board-ticket-lost")).getByTestId("board-waiting-reason")).toHaveTextContent("Runner disconnected");
    expect(within(screen.getByTestId("board-ticket-told")).getByTestId("board-waiting-reason")).toHaveTextContent("Stopping");
    expect(within(screen.getByTestId("board-ticket-claimed")).getByTestId("board-waiting-reason")).toHaveTextContent("Working");
  });

  it("marks a Ticket with an open Round, claimed or running, with a named lock glyph and keeps it from being dragged", async () => {
    const agent = { id: "a1", name: "Builder", kind: "coding" };
    const round = { id: "r1", sequence: 3, agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null, stopRequestedAt: null, waitingReason: "starting", question: null, permissionRequest: null };
    stubTickets([
      { ...ticket("claimed", "Ready"), assigneeType: "agent", assigneeAgent: agent, openRound: { ...round, state: "claimed" } },
      { ...ticket("running", "Ready"), assigneeType: "agent", assigneeAgent: agent, openRound: { ...round, state: "running", startedAt: "2026-10-01T10:01:00Z", waitingReason: "working" } },
      { ...ticket("open", "Ready"), assigneeType: "agent", assigneeAgent: agent },
    ]);

    render(<TicketBoard onUnauthenticated={() => {}} />);

    for (const id of ["claimed", "running"]) {
      const slip = await screen.findByTestId(`board-ticket-${id}`);
      expect(within(slip).getByRole("img", { name: "Locked while Builder works on Round 3" })).toBe(within(slip).getByTestId("board-locked"));
      expect(slip).toHaveAttribute("draggable", "false");
    }
    const open = screen.getByTestId("board-ticket-open");
    expect(within(open).queryByTestId("board-locked")).not.toBeInTheDocument();
    expect(open).toHaveAttribute("draggable", "true");
  });

  it("shows empty sections even when there are no Tickets", async () => {
    stubTickets([]);
    render(<TicketBoard onUnauthenticated={() => {}} />);

    expect(await screen.findAllByText("— no orders —")).toHaveLength(6);
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
      expect(section.queryByText("— no orders —")).not.toBeInTheDocument();
    }
    for (const status of ["Ready", "InProgress", "Blocked", "Done"]) {
      const section = within(screen.getByTestId(`board-status-${status}`));
      expect(section.getByText("— no orders —")).toBeInTheDocument();
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
    stubTickets([{ ...ticket("moving", "Backlog"), allowedActions: { statusChangeRejections: [], statusChanges: ["Ready", "Blocked", "Done"], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } } }]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    const card = await screen.findByTestId("board-ticket-moving");
    expect(within(card).queryByTestId("move-to-trigger")).not.toBeInTheDocument();
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
    const original = { ...ticket("moving", "Backlog"), allowedActions: { statusChangeRejections: [], statusChanges: ["Ready"], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } } };
    const changed = { ...original, status: "Ready", allowedActions: { ...original.allowedActions, statusChanges: ["Backlog", "InProgress"] } };
    let resolveCommand!: (response: unknown) => void;
    const fetchStub = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: [original] }) })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCommand = resolve; }));
    vi.stubGlobal("fetch", fetchStub);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    const card = await screen.findByTestId("board-ticket-moving");
    dragMove(card, "Ready");
    expect(screen.getByTestId("board-status-Backlog")).toContainElement(card);
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    expect(fetchStub).toHaveBeenLastCalledWith("/api/tickets/moving/status", expect.objectContaining({ method: "POST", body: JSON.stringify({ status: "Ready" }) }));
    resolveCommand({ ok: true, status: 200, json: async () => changed });
    await vi.waitFor(() => expect(screen.getByTestId("board-status-Ready")).toContainElement(screen.getByTestId("board-ticket-moving")));
    const moved = screen.getByTestId("board-ticket-moving");
    await vi.waitFor(() => expect(within(moved).getByRole("link")).toHaveFocus());
    fireEvent.dragStart(moved, { dataTransfer: { setData: vi.fn(), effectAllowed: "move" } });
    expect(screen.getByTestId("board-status-Backlog")).toHaveAttribute("data-drop-target", "true");
    expect(screen.getByTestId("board-status-InProgress")).toHaveAttribute("data-drop-target", "true");
    expect(screen.getByTestId("board-status-Blocked")).not.toHaveAttribute("data-drop-target", "true");
  });

  describe("archive spike", () => {
    const listResponse = (tickets: unknown[]) => ({ ok: true, status: 200, json: async () => ({ tickets }) });
    const grab = (card: HTMLElement) => fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn(), effectAllowed: "move" } });

    it("appears only while a slip is dragged, highlights on hover, and leaves when the drag ends elsewhere", async () => {
      stubTickets([ticket("cancelled", "Backlog")]);
      render(<TicketBoard onUnauthenticated={() => {}} />);
      const card = await screen.findByTestId("board-ticket-cancelled");
      expect(screen.queryByTestId("board-archive-zone")).not.toBeInTheDocument();

      grab(card);
      const spike = screen.getByTestId("board-archive-zone");
      expect(spike).not.toHaveAttribute("data-over");
      fireEvent.dragOver(spike, { dataTransfer: {} });
      expect(spike).toHaveAttribute("data-over", "true");
      fireEvent.dragEnd(card);

      expect(screen.queryByTestId("board-archive-zone")).not.toBeInTheDocument();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("archives the dropped slip once Galley confirms", async () => {
      const archived = { ...ticket("dumped", "Backlog"), archivedAt: "2026-10-02T09:00:00Z" };
      let resolveArchive!: (response: unknown) => void;
      const fetchStub = vi.fn()
        .mockResolvedValueOnce(listResponse([ticket("dumped", "Backlog"), ticket("kept", "Backlog")]))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveArchive = resolve; }))
        .mockResolvedValue(listResponse([ticket("kept", "Backlog")]));
      vi.stubGlobal("fetch", fetchStub);
      render(<TicketBoard onUnauthenticated={() => {}} />);
      const card = await screen.findByTestId("board-ticket-dumped");

      grab(card);
      fireEvent.drop(screen.getByTestId("board-archive-zone"), { dataTransfer: {} });

      await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
      expect(fetchStub).toHaveBeenLastCalledWith("/api/tickets/dumped/archive", expect.objectContaining({ method: "POST" }));
      expect(screen.queryByTestId("board-archive-zone")).not.toBeInTheDocument();
      expect(screen.getByTestId("board-ticket-dumped")).toBeInTheDocument();
      resolveArchive({ ok: true, status: 200, json: async () => archived });
      await vi.waitFor(() => expect(screen.queryByTestId("board-ticket-dumped")).not.toBeInTheDocument());
      expect(screen.getByTestId("board-ticket-kept")).toBeInTheDocument();
    });

    it("shows Galley's rejection verbatim and keeps the slip on the board", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(listResponse([ticket("stale", "Backlog")]))
        .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: { code: "round_open", message: "Galley archive rejection reason" } }) }));
      render(<TicketBoard onUnauthenticated={() => {}} />);
      const card = await screen.findByTestId("board-ticket-stale");

      grab(card);
      fireEvent.drop(screen.getByTestId("board-archive-zone"), { dataTransfer: {} });

      expect(await screen.findByTestId("ticket-board-move-error")).toHaveTextContent("Galley archive rejection reason");
      expect(screen.getByTestId("board-status-Backlog")).toContainElement(card);
    });
  });

  it("shows Galley's rejection verbatim without moving the card", async () => {
    const original = { ...ticket("stale", "Backlog"), allowedActions: { statusChangeRejections: [], statusChanges: ["Ready"], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } } };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: [original] }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { code: "invalid_transition", message: "Galley stale move reason" } }) }));
    render(<TicketBoard onUnauthenticated={() => {}} />);
    const card = await screen.findByTestId("board-ticket-stale");
    dragMove(card, "Ready");
    expect(await screen.findByTestId("ticket-board-move-error")).toHaveTextContent("Galley stale move reason");
    expect(screen.getByTestId("board-status-Backlog")).toContainElement(card);
    expect(within(card).getByRole("link")).not.toHaveAttribute("aria-disabled", "true");
    await vi.waitFor(() => expect(within(card).getByRole("link")).toHaveFocus());
  });

  it("keeps focus on a moved card after the follow-up read, not on the Ticket whose modal closed earlier", async () => {
    const actions = { statusChangeRejections: [], statusChanges: ["Ready"], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } };
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
    dragMove(screen.getByTestId("board-ticket-moving"), "Ready");
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(screen.getByTestId("board-status-Ready")).toContainElement(screen.getByTestId("board-ticket-moving")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(screen.getByTestId("board-ticket-moving")).getByRole("link")).toHaveFocus();
  });
  describe("reordering within a stage", () => {
    const readyActions = { statusChangeRejections: [], statusChanges: ["Backlog", "InProgress"], accept: { available: false, reason: { code: "invalid_transition", message: "Unavailable" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } };
    const ready = (id: string) => ({ ...ticket(id, "Ready"), allowedActions: readyActions });

    function slipAt(id: string, top: number) {
      const slip = screen.getByTestId(`board-ticket-${id}`);
      vi.spyOn(slip, "getBoundingClientRect").mockReturnValue({ top, height: 100, bottom: top + 100, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) });
      return slip;
    }

    function stubReorder(initial: unknown[], afterwards: unknown[], moved: unknown) {
      const fetchStub = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: initial }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => moved })
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ tickets: afterwards }) });
      vi.stubGlobal("fetch", fetchStub);
      return fetchStub;
    }

    function dragAt(type: "dragOver" | "drop", target: HTMLElement, clientY: number) {
      const event = createEvent[type](target, { dataTransfer: {} });
      Object.defineProperty(event, "clientY", { value: clientY });
      fireEvent(target, event);
    }

    const readyOrder = () => within(screen.getByTestId("board-status-Ready")).getAllByTestId(/^board-ticket-/).map((slip) => slip.getAttribute("data-testid"));

    it.each([
      ["upper half", "before", 10, { before: "r1" }],
      ["lower half", "after", 90, { after: "r1" }],
    ])("dropping on a slip's %s places the Ticket %s it and renders Galley's refetched order", async (_, position, clientY, body) => {
      const fetchStub = stubReorder([ready("r1"), ready("r2"), ready("r3")], [ready("r3"), ready("r1"), ready("r2")], ready("r3"));
      render(<TicketBoard onUnauthenticated={() => {}} />);
      const r3 = await screen.findByTestId("board-ticket-r3");
      fireEvent.dragStart(r3, { dataTransfer: { setData: vi.fn(), effectAllowed: "move" } });
      expect(screen.getByTestId("board-status-Ready")).toHaveTextContent("↕ Reorder");
      const r1 = slipAt("r1", 0);
      dragAt("dragOver", r1, clientY);
      expect(r1).toHaveAttribute("data-drop-position", position);
      dragAt("drop", r1, clientY);

      expect(fetchStub).toHaveBeenNthCalledWith(2, "/api/tickets/r3/position", expect.objectContaining({ method: "POST", body: JSON.stringify(body) }));
      await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(readyOrder()).toEqual(["board-ticket-r3", "board-ticket-r1", "board-ticket-r2"]));
      expect(r1).not.toHaveAttribute("data-drop-position");
      await vi.waitFor(() => expect(within(screen.getByTestId("board-ticket-r3")).getByRole("link")).toHaveFocus());
    });

    it("keeps a drop on another stage a Status move, and offers no reorder slot across stages", async () => {
      const fetchStub = stubReorder([ready("r1"), { ...ticket("b1", "Backlog"), allowedActions: readyActions }], [], ready("r1"));
      render(<TicketBoard onUnauthenticated={() => {}} />);
      const r1 = await screen.findByTestId("board-ticket-r1");
      fireEvent.dragStart(r1, { dataTransfer: { setData: vi.fn(), effectAllowed: "move" } });
      const b1 = slipAt("b1", 0);
      dragAt("dragOver", b1, 10);
      expect(b1).not.toHaveAttribute("data-drop-position");
      fireEvent.drop(screen.getByTestId("board-status-Backlog"));
      expect(fetchStub).toHaveBeenNthCalledWith(2, "/api/tickets/r1/status", expect.objectContaining({ body: JSON.stringify({ status: "Backlog" }) }));
    });

    it("shows Galley's reorder rejection verbatim", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tickets: [ready("r1"), ready("r2")] }) })
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { code: "reorder_anchor_invalid", message: "Galley anchor reason" } }) })
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ tickets: [ready("r1"), ready("r2")] }) }));
      render(<TicketBoard onUnauthenticated={() => {}} />);
      const r2 = await screen.findByTestId("board-ticket-r2");
      fireEvent.dragStart(r2, { dataTransfer: { setData: vi.fn(), effectAllowed: "move" } });
      dragAt("drop", slipAt("r1", 0), 10);
      expect(await screen.findByTestId("ticket-board-move-error")).toHaveTextContent("Galley anchor reason");
    });
  });
});

describe("TicketBoard refreshing while a Ticket awaits execution", () => {
  const agent = { id: "a1", name: "Builder", kind: "coding" };
  const round = { id: "r1", sequence: 1, state: "claimed", agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null, stopRequestedAt: null, waitingReason: "starting", question: null, permissionRequest: null };
  const claimed = { ...ticket("work", "Ready"), assigneeType: "agent", assigneeAgent: agent, openRound: round };
  const running = { ...claimed, status: "InProgress", openRound: { ...round, state: "running", startedAt: "2026-10-01T10:00:05Z", waitingReason: "working" } };
  const settled = { ...claimed, openRound: null };
  const queued = { ...settled, requestingAgentWork: true };
  const other = ticket("other", "Backlog");

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  type Reply = () => Promise<{ ok: boolean; status: number; statusText?: string; json: () => Promise<unknown> }>;
  const list = (...tickets: unknown[]): Reply => () => Promise.resolve({ ok: true, status: 200, json: async () => ({ tickets }) });

  function stubLists(replies: Reply[]) {
    const queue = [...replies];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) !== "/api/tickets") throw new Error(`unexpected fetch ${String(input)}`);
      return (queue.length > 1 ? queue.shift() : queue[0])!();
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("moves the slip to In Review with the delivering Agent when the Round delivers during a refresh, unlocked, and stops refetching", async () => {
    const delivered = { ...running, status: "InReview", openRound: null, delivery: { roundId: round.id, sequence: 1, agent, deliveredAt: "2026-10-01T10:00:09Z" } };
    const fetchMock = stubLists([list(running, other), list(delivered, other)]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    await flush();
    expect(within(screen.getByTestId("board-ticket-work")).queryByTestId("board-delivered")).not.toBeInTheDocument();

    await flush(3000);
    const slip = within(screen.getByTestId("board-status-InReview")).getByTestId("board-ticket-work");
    expect(within(slip).getByTestId("board-delivered")).toHaveTextContent("Delivered by Builder");
    expect(within(slip).queryByTestId("board-locked")).not.toBeInTheDocument();
    expect(slip).toHaveAttribute("draggable", "true");

    await flush(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refetches every 3 seconds and moves the slip to In Progress with its Agent, locked and Working", async () => {
    const fetchMock = stubLists([list(claimed, other), list(running, other)]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    await flush();
    expect(within(screen.getByTestId("board-status-Ready")).getByTestId("board-ticket-work")).toBeInTheDocument();
    expect(within(screen.getByTestId("board-ticket-work")).getByTestId("board-waiting-reason")).toHaveTextContent("Starting");

    await flush(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("ticket-board-loading")).not.toBeInTheDocument();
    const slip = within(screen.getByTestId("board-status-InProgress")).getByTestId("board-ticket-work");
    expect(within(slip).getByTestId("board-assignee")).toHaveTextContent("Assignee: Builder");
    expect(within(slip).getByRole("img", { name: "Locked while Builder works on Round 1" })).toBeInTheDocument();
    expect(within(slip).getByTestId("board-waiting-reason")).toHaveTextContent("Working");
    expect(slip).toHaveAttribute("draggable", "false");
    expect(within(screen.getByTestId("board-status-Ready")).queryByTestId("board-ticket-work")).not.toBeInTheDocument();
  });

  it("shows Stopping on the locked slip once Galley reports the Stop request, still in its Status column", async () => {
    const stopping = { ...running, openRound: { ...running.openRound, stopRequestedAt: "2026-10-01T10:00:07Z", waitingReason: "stopping", question: null, permissionRequest: null } };
    stubLists([list(running, other), list(stopping, other)]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    await flush();
    expect(within(screen.getByTestId("board-ticket-work")).getByTestId("board-waiting-reason")).toHaveTextContent("Working");

    await flush(3000);
    const slip = within(screen.getByTestId("board-status-InProgress")).getByTestId("board-ticket-work");
    expect(within(slip).getByTestId("board-waiting-reason")).toHaveTextContent("Stopping");
    expect(within(slip).getByTestId("board-locked")).toBeInTheDocument();
    expect(slip).toHaveAttribute("draggable", "false");
    expect(within(screen.getByTestId("board-ticket-other")).queryByTestId("board-active-order")).not.toBeInTheDocument();
  });

  it("keeps the board on screen while a refetch is pending and never overlaps refetches", async () => {
    const fetchMock = stubLists([list(claimed), () => new Promise(() => {})]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    await flush();
    await flush(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("ticket-board-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("board-ticket-work")).toBeInTheDocument();
  });

  it("stops refetching once no Ticket has an open Round or is queued", async () => {
    const fetchMock = stubLists([list(claimed), list(settled)]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    await flush();
    await flush(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("board-locked")).not.toBeInTheDocument();
    await flush(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps refetching a queued Ticket that has no open Round, and stops once it is neither queued nor claimed", async () => {
    const fetchMock = stubLists([list(queued), list(queued), list(settled)]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    await flush();
    await flush(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await flush(3000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await flush(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never refetches a board in which no Ticket has an open Round or is queued", async () => {
    const fetchMock = stubLists([list(other)]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    await flush(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops refetching on unmount", async () => {
    const fetchMock = stubLists([list(claimed)]);
    const { unmount } = render(<TicketBoard onUnauthenticated={() => {}} />);
    await flush();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await flush(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the board and says the refresh failed, then clears the note once a refetch succeeds", async () => {
    stubLists([list(claimed), () => Promise.resolve({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) }), list(claimed), list(running)]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    await flush();
    await flush(3000);
    expect(screen.getByTestId("ticket-board-refresh-error-message")).toHaveTextContent("Galley returned an error response: 503");
    expect(screen.getByTestId("board-ticket-work")).toBeInTheDocument();
    await flush(3000);
    expect(screen.queryByTestId("ticket-board-refresh-error")).not.toBeInTheDocument();
    await flush(3000);
    expect(within(screen.getByTestId("board-status-InProgress")).getByTestId("board-ticket-work")).toBeInTheDocument();
  });

  it("rejects a refetched Ticket with an unknown Status and keeps the previous board", async () => {
    stubLists([list(claimed), list({ ...claimed, status: "Archived" })]);
    render(<TicketBoard onUnauthenticated={() => {}} />);
    await flush();
    await flush(3000);
    expect(screen.getByTestId("ticket-board-refresh-error-message")).toHaveTextContent("unknown Status");
    expect(within(screen.getByTestId("board-status-Ready")).getByTestId("board-ticket-work")).toBeInTheDocument();
  });

  it("hands the Owner to sign-in when a refetch comes back unauthenticated", async () => {
    const onUnauthenticated = vi.fn();
    stubLists([list(claimed), () => Promise.resolve({ ok: false, status: 401, statusText: "", json: async () => ({}) })]);
    render(<TicketBoard onUnauthenticated={onUnauthenticated} />);
    await flush();
    await flush(3000);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });
});
