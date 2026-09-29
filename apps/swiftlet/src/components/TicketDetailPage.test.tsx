import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TicketDetailPage } from "./TicketDetailPage";

type MockResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

function jsonResponse(body: unknown, status = 200, statusText = ""): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  };
}

const TICKET_ID = "44444444-4444-4444-8444-444444444444";
const TICKET = {
  id: TICKET_ID,
  title: "Write the report",
  status: "Backlog",
  allowedActions: { statusChanges: ["Ready", "Blocked"], accept: { available: false, reason: { code: "invalid_transition", message: "Accept requires In Review" } } },
  template: "Basic",
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
  archivedAt: null,
};

const onUnauthenticated = () => {};

function stubFetch(response: MockResponse) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

describe("TicketDetailPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a loading state before the fetch settles", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);

    expect(screen.getByTestId("ticket-detail-loading")).toBeInTheDocument();
  });

  it("fetches the Ticket by id and renders TicketDetail with it", async () => {
    stubFetch(jsonResponse(TICKET));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);

    expect(await screen.findByTestId("ticket-detail-title")).toHaveTextContent(TICKET.title);
    expect(fetch).toHaveBeenCalledWith(`/api/tickets/${TICKET_ID}`, undefined);
  });

  it("rejects a Ticket missing Galley's allowed actions or an unavailable Accept reason", async () => {
    for (const payload of [
      { ...TICKET, allowedActions: undefined },
      { ...TICKET, allowedActions: { statusChanges: ["Ready"], accept: { available: false } } },
    ]) {
      stubFetch(jsonResponse(payload));
      const { unmount } = render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      expect(await screen.findByTestId("ticket-detail-error")).toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-title")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("renders an explicit not-found state on Galley's 404, not a blank screen or raw error", async () => {
    stubFetch(jsonResponse({ error: { code: "not_found", message: "no ticket with that identifier" } }, 404));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);

    expect(await screen.findByTestId("ticket-detail-not-found")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-title")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-error")).not.toBeInTheDocument();
  });

  it("renders an explicit error state for a failure other than 404", async () => {
    stubFetch(jsonResponse({ error: "boom" }, 503, "Service Unavailable"));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);

    expect(await screen.findByTestId("ticket-detail-error")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-error-message")).toHaveTextContent("503");
    expect(screen.queryByTestId("ticket-detail-not-found")).not.toBeInTheDocument();
  });

  it("shows Galley's Badge-specific 404 reason for a rejected attach", async () => {
    const badge = { id: "11111111-1111-4111-8111-111111111111", name: "Review", createdAt: TICKET.createdAt };
    const rejection = "no ticket or badge with that identifier";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(TICKET))
      .mockResolvedValueOnce(jsonResponse({ badges: [badge] }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "not_found", message: rejection } }, 404));
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");
    fireEvent.click(screen.getByTestId("badge-picker-toggle"));
    await screen.findByRole("option", { name: badge.name });
    fireEvent.change(screen.getByTestId("badge-picker-select"), { target: { value: badge.id } });
    fireEvent.click(screen.getByRole("button", { name: "Attach badge" }));

    expect(await screen.findByTestId("badge-picker-error")).toHaveTextContent(rejection);
    expect(screen.getByTestId("ticket-detail-badges").querySelectorAll("li")).toHaveLength(0);
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/tickets/${TICKET_ID}/badges/${badge.id}`, { method: "PUT" });
  });

  it("retains established non-Badge command 404 semantics", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(TICKET))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "not_found", message: "a different Galley reason" } }, 404));
    vi.stubGlobal("fetch", fetchMock);
    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");
    fireEvent.click(screen.getByTestId("ticket-detail-status-button-Ready"));
    expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent("Galley reported no ticket with that identifier.");
  });

  it("offers a link back to the Backlog", async () => {
    stubFetch(jsonResponse(TICKET));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");

    expect(screen.getByTestId("back-to-backlog-link")).toHaveAttribute("href", "/");
  });

  it("returns to the Backlog with the selected Badge filter", async () => {
    window.history.pushState({}, "", `/tickets/${TICKET_ID}?badgeId=first&badgeId=second`);
    stubFetch(jsonResponse(TICKET));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");

    expect(screen.getByTestId("back-to-backlog-link")).toHaveAttribute("href", "/?badgeId=first&badgeId=second");
    window.history.pushState({}, "", "/");
  });

  it("re-fetches when the ticketId prop changes", async () => {
    stubFetch(jsonResponse(TICKET));
    const { rerender } = render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");

    const otherId = "55555555-5555-4555-8555-555555555555";
    const otherTicket = { ...TICKET, id: otherId, title: "A different ticket" };
    stubFetch(jsonResponse(otherTicket));
    rerender(<TicketDetailPage ticketId={otherId} onUnauthenticated={onUnauthenticated} />);

    expect(await screen.findByTestId("ticket-detail-title")).toHaveTextContent(otherTicket.title);
    expect(fetch).toHaveBeenCalledWith(`/api/tickets/${otherId}`, undefined);
  });

  it("saves an edit through PATCH /api/tickets/:id and shows the updated Ticket", async () => {
    const updated = { ...TICKET, goal: "Ship the report on time." };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(TICKET))
      .mockResolvedValueOnce(jsonResponse(updated));
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");

    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
    fireEvent.change(screen.getByTestId("ticket-detail-textarea-goal"), {
      target: { value: "Ship the report on time." },
    });
    fireEvent.click(screen.getByTestId("ticket-detail-save-button"));

    expect(await screen.findByTestId("ticket-detail-field-goal")).toHaveTextContent(
      "Ship the report on time.",
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/tickets/${TICKET_ID}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ goal: "Ship the report on time." }),
      }),
    );
  });

  it("keeps a disjoint edit made in another tab when saving a field from this tab", async () => {
    const loaded = { ...TICKET, context: "Original context" };
    const concurrentlyEdited = { ...loaded, context: "Other tab's context" };
    const saved = { ...concurrentlyEdited, goal: "My new goal" };
    const stored = { ...loaded };
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init) return Promise.resolve(jsonResponse(loaded));
      const update = JSON.parse(String(init.body)) as Record<string, string>;
      Object.assign(stored, update);
      return Promise.resolve(jsonResponse(stored));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");
    Object.assign(stored, { context: concurrentlyEdited.context });
    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
    fireEvent.change(screen.getByTestId("ticket-detail-textarea-goal"), { target: { value: "My new goal" } });
    fireEvent.click(screen.getByTestId("ticket-detail-save-button"));

    expect(await screen.findByTestId("ticket-detail-field-goal")).toHaveTextContent(saved.goal);
    expect(screen.getByTestId("ticket-detail-field-context")).toHaveTextContent(saved.context);
    expect(stored).toEqual(saved);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/tickets/${TICKET_ID}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ goal: "My new goal" }) }),
    );
  });

  // Proves the wiring from TicketDetail's buttons through to the real
  // request, beyond the presentational behavior TicketDetail.test.tsx
  // already covers.
  it("changes Status through POST /api/tickets/:id/status and shows the updated Ticket", async () => {
    const moved = { ...TICKET, status: "Ready" };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(TICKET)).mockResolvedValueOnce(jsonResponse(moved));
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");

    fireEvent.click(screen.getByTestId("ticket-detail-status-button-Ready"));

    expect(await screen.findByTestId("ticket-detail-status")).toHaveTextContent("Ready");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/tickets/${TICKET_ID}/status`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ status: "Ready" }) }),
    );
  });

  it("accepts through POST /api/tickets/:id/accept and shows the Ticket as Done", async () => {
    const inReview = { ...TICKET, status: "InReview", allowedActions: { ...TICKET.allowedActions, accept: { available: true } } };
    const done = { ...inReview, status: "Done", allowedActions: TICKET.allowedActions };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(inReview))
      .mockResolvedValueOnce(jsonResponse(done));
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");

    fireEvent.click(screen.getByTestId("ticket-detail-accept-button"));

    expect(await screen.findByTestId("ticket-detail-status")).toHaveTextContent("Done");
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/tickets/${TICKET_ID}/accept`, expect.objectContaining({ method: "POST" }));
  });

  it("assigns and unassigns the Owner through PUT/DELETE /api/tickets/:id/assignee", async () => {
    const assigned = { ...TICKET, assigneeType: "owner" };
    const unassigned = { ...TICKET, assigneeType: "" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(TICKET))
      .mockResolvedValueOnce(jsonResponse(assigned))
      .mockResolvedValueOnce(jsonResponse(unassigned));
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");

    fireEvent.click(screen.getByTestId("ticket-detail-assign-button"));
    expect(await screen.findByTestId("ticket-detail-assignee")).toHaveTextContent("Owner");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/tickets/${TICKET_ID}/assignee`,
      expect.objectContaining({ method: "PUT" }),
    );

    fireEvent.click(screen.getByTestId("ticket-detail-unassign-button"));
    expect(await screen.findByTestId("ticket-detail-assignee")).toHaveTextContent("Unassigned");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/tickets/${TICKET_ID}/assignee`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
