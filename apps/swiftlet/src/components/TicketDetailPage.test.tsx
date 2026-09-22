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
};

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

    render(<TicketDetailPage ticketId={TICKET_ID} />);

    expect(screen.getByTestId("ticket-detail-loading")).toBeInTheDocument();
  });

  it("fetches the Ticket by id and renders TicketDetail with it", async () => {
    stubFetch(jsonResponse(TICKET));

    render(<TicketDetailPage ticketId={TICKET_ID} />);

    expect(await screen.findByTestId("ticket-detail-title")).toHaveTextContent(TICKET.title);
    expect(fetch).toHaveBeenCalledWith(`/api/tickets/${TICKET_ID}`, undefined);
  });

  it("renders an explicit not-found state on Galley's 404, not a blank screen or raw error", async () => {
    stubFetch(jsonResponse({ error: { code: "not_found", message: "no ticket with that identifier" } }, 404));

    render(<TicketDetailPage ticketId={TICKET_ID} />);

    expect(await screen.findByTestId("ticket-detail-not-found")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-title")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-error")).not.toBeInTheDocument();
  });

  it("renders an explicit error state for a failure other than 404", async () => {
    stubFetch(jsonResponse({ error: "boom" }, 503, "Service Unavailable"));

    render(<TicketDetailPage ticketId={TICKET_ID} />);

    expect(await screen.findByTestId("ticket-detail-error")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-error-message")).toHaveTextContent("503");
    expect(screen.queryByTestId("ticket-detail-not-found")).not.toBeInTheDocument();
  });

  it("offers a link back to the Backlog", async () => {
    stubFetch(jsonResponse(TICKET));

    render(<TicketDetailPage ticketId={TICKET_ID} />);
    await screen.findByTestId("ticket-detail-title");

    expect(screen.getByTestId("back-to-backlog-link")).toHaveAttribute("href", "/");
  });

  it("re-fetches when the ticketId prop changes", async () => {
    stubFetch(jsonResponse(TICKET));
    const { rerender } = render(<TicketDetailPage ticketId={TICKET_ID} />);
    await screen.findByTestId("ticket-detail-title");

    const otherId = "55555555-5555-4555-8555-555555555555";
    const otherTicket = { ...TICKET, id: otherId, title: "A different ticket" };
    stubFetch(jsonResponse(otherTicket));
    rerender(<TicketDetailPage ticketId={otherId} />);

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

    render(<TicketDetailPage ticketId={TICKET_ID} />);
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
        body: JSON.stringify({
          title: TICKET.title,
          goal: "Ship the report on time.",
          context: "",
          successCriteria: "",
          constraints: "",
          repository: "",
        }),
      }),
    );
  });

  // Proves the wiring from TicketDetail's buttons through to the real
  // request, beyond the presentational behavior TicketDetail.test.tsx
  // already covers.
  it("changes Status through POST /api/tickets/:id/status and shows the updated Ticket", async () => {
    const moved = { ...TICKET, status: "Ready" };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(TICKET)).mockResolvedValueOnce(jsonResponse(moved));
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketDetailPage ticketId={TICKET_ID} />);
    await screen.findByTestId("ticket-detail-title");

    fireEvent.click(screen.getByTestId("ticket-detail-status-button-Ready"));

    expect(await screen.findByTestId("ticket-detail-status")).toHaveTextContent("Ready");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/tickets/${TICKET_ID}/status`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ status: "Ready" }) }),
    );
  });

  it("accepts through POST /api/tickets/:id/accept and shows the Ticket as Done", async () => {
    const inReview = { ...TICKET, status: "InReview" };
    const done = { ...inReview, status: "Done" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(inReview))
      .mockResolvedValueOnce(jsonResponse(done));
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketDetailPage ticketId={TICKET_ID} />);
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

    render(<TicketDetailPage ticketId={TICKET_ID} />);
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
