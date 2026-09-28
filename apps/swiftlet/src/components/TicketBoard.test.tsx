import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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
});
