import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  allowedActions: { statusChangeRejections: [], statusChanges: ["Ready", "Blocked"], accept: { available: false, reason: { code: "invalid_transition", message: "Accept requires In Review" } } },
  template: "Basic",
  completionCondition: "humanAcceptance",
  assigneeType: "",
  assigneeAgent: null,
  requestingAgentWork: false,
  openRound: null,
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

const AGENTS = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research", createdAt: "2026-09-30T10:00:00Z" }];

const onUnauthenticated = () => {};

/** The receipt loads Agents alongside the Ticket; answering that here keeps each test's mock sequence about the Ticket. */
function stubGalley(fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<MockResponse>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "/api/agents" ? Promise.resolve(jsonResponse({ agents: AGENTS })) : fetchMock(input, init)));
}

function stubFetch(response: MockResponse) {
  stubGalley(vi.fn().mockResolvedValue(response));
}

describe("TicketDetailPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a loading state before the fetch settles", () => {
    stubGalley(vi.fn().mockReturnValue(new Promise(() => {})));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);

    expect(screen.getByTestId("ticket-detail-loading")).toBeInTheDocument();
  });

  it("fetches the Ticket by id and renders TicketDetail with it", async () => {
    stubFetch(jsonResponse(TICKET));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);

    expect(await screen.findByTestId("ticket-detail-title")).toHaveTextContent(TICKET.title);
    expect(fetch).toHaveBeenCalledWith(`/api/tickets/${TICKET_ID}`, undefined);
  });

  it("opens in edit mode when the edit flag is set, unless the Ticket is archived", async () => {
    window.history.replaceState({}, "", `/tickets/${TICKET_ID}?edit=true`);
    stubFetch(jsonResponse(TICKET));
    const { unmount } = render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    expect(await screen.findByTestId("ticket-detail-edit-form")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(""));
    unmount();

    stubFetch(jsonResponse({ ...TICKET, archivedAt: "2026-09-23T00:00:00Z" }));
    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    expect(await screen.findByTestId("ticket-detail-edit-button")).toBeDisabled();
    expect(screen.queryByTestId("ticket-detail-edit-form")).not.toBeInTheDocument();
    window.history.replaceState({}, "", "/");
  });

  it("rejects a Ticket missing Galley's allowed actions or an unavailable Accept reason", async () => {
    for (const payload of [
      { ...TICKET, allowedActions: undefined },
      { ...TICKET, allowedActions: { statusChangeRejections: [], statusChanges: ["Ready"], accept: { available: false } } },
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

  it.each([
    { name: "a kind outside the contract", assigneeAgent: { id: AGENTS[0].id, name: "atlas", kind: "general" } },
    { name: "a missing name", assigneeAgent: { id: AGENTS[0].id, kind: "research" } },
  ])("rejects a Ticket whose assigned Agent has $name", async ({ assigneeAgent }) => {
    stubFetch(jsonResponse({ ...TICKET, assigneeType: "agent", assigneeAgent }));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);

    expect(await screen.findByTestId("ticket-detail-error-message")).toHaveTextContent("Galley's Ticket response was missing a required field.");
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
    stubGalley(fetchMock);

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
    stubGalley(fetchMock);
    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");
    fireEvent.click(screen.getByTestId("ticket-detail-status-button-Ready"));
    expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent("Galley reported no ticket with that identifier.");
  });

  it("shows Galley's 404 reason for a rejected Agent assignment", async () => {
    const rejection = "no ticket or agent with that identifier";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(TICKET))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "not_found", message: rejection } }, 404));
    stubGalley(fetchMock);
    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByRole("option", { name: "atlas" });
    fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: `agent:${AGENTS[0].id}` } });
    fireEvent.click(screen.getByTestId("ticket-detail-assign-button"));
    expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent(rejection);
    expect(screen.getByTestId("ticket-detail-assignee")).toHaveTextContent("Unassigned");
  });

  it.each([
    { name: "no requestingAgentWork", change: { requestingAgentWork: undefined } },
    { name: "statusChangeRejections that are not a list", change: { allowedActions: { ...TICKET.allowedActions, statusChangeRejections: {} } } },
    { name: "a rejection with no reason", change: { allowedActions: { ...TICKET.allowedActions, statusChangeRejections: [{ status: "Ready" }] } } },
    { name: "a missing input outside the contract", change: { allowedActions: { ...TICKET.allowedActions, statusChangeRejections: [{ status: "Ready", reason: { code: "agent_readiness_incomplete", message: "m", missing: ["title"] } }] } } },
  ])("rejects a Ticket response with $name", async ({ change }) => {
    stubFetch(jsonResponse({ ...TICKET, ...change }));
    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    expect(await screen.findByText("Galley's Ticket response was missing a required field.")).toBeInTheDocument();
  });

  it("carries Galley's missing inputs from a rejected Status change to the receipt", async () => {
    const rejection = { code: "agent_readiness_incomplete", message: "this Ticket needs Success Criteria before a research Agent can take it from Ready", missing: ["successCriteria"] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...TICKET, assigneeType: "agent", assigneeAgent: { id: AGENTS[0].id, name: "atlas", kind: "research" } }))
      .mockResolvedValueOnce(jsonResponse({ error: rejection }, 400));
    stubGalley(fetchMock);
    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");

    fireEvent.click(screen.getByTestId("ticket-detail-status-button-Ready"));

    expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent(rejection.message);
    expect(screen.getByTestId("ticket-detail-missing-success-criteria")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-missing-goal")).not.toBeInTheDocument();
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

  it("returns an archive from a Board detail URL opened in a new tab to the filtered Board", async () => {
    window.history.pushState(null, "", `/tickets/${TICKET_ID}?badgeId=first&from=board`);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    stubGalley(vi.fn()
      .mockResolvedValueOnce(jsonResponse(TICKET))
      .mockResolvedValueOnce(jsonResponse({ ...TICKET, archivedAt: "2026-09-29T10:00:00Z" })));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");
    expect(screen.getByTestId("back-to-backlog-link")).toHaveAttribute("href", "/?badgeId=first");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`).toBe("/board?badgeId=first"));
    window.history.pushState({}, "", "/");
  });

  describe("an open Round", () => {
    const agent = { id: AGENTS[0].id, name: "atlas", kind: "research" };
    const claimedRound = { id: "66666666-6666-4666-8666-666666666666", sequence: 1, state: "claimed", agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null };
    const claimed = { ...TICKET, status: "Ready", assigneeType: "agent", assigneeAgent: agent, successCriteria: "done", openRound: claimedRound };

    it("shows Claimed by runner from Galley's openRound", async () => {
      stubFetch(jsonResponse(claimed));
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      expect(await screen.findByTestId("ticket-detail-claimed")).toHaveTextContent("Claimed by runner");
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Ready");
      expect(screen.queryByTestId("ticket-detail-queued")).not.toBeInTheDocument();
    });

    it("shows Galley's round_open rejection on the archive control and stays on the receipt", async () => {
      const rejection = "this Ticket has an open Round; it can be archived once the Round ends";
      vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
      stubGalley(vi.fn()
        .mockResolvedValueOnce(jsonResponse(claimed))
        .mockResolvedValueOnce(jsonResponse({ error: { code: "round_open", message: rejection } }, 400)));
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await screen.findByTestId("ticket-detail-claimed");

      fireEvent.click(screen.getByRole("button", { name: "Archive" }));

      expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent(rejection);
      expect(screen.getByTestId("ticket-detail-claimed")).toBeInTheDocument();
    });

    it.each([
      { name: "no openRound", openRound: undefined },
      { name: "an unknown Round state", openRound: { ...claimedRound, state: "delivered" } },
      { name: "a Round with no Agent", openRound: { ...claimedRound, agent: null } },
      { name: "a Round with no claimedAt", openRound: { ...claimedRound, claimedAt: undefined } },
    ])("rejects a Ticket response with $name", async ({ openRound }) => {
      stubFetch(jsonResponse({ ...claimed, openRound }));
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      expect(await screen.findByText("Galley's Ticket response was missing a required field.")).toBeInTheDocument();
    });
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
    stubGalley(fetchMock);

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
    stubGalley(fetchMock);

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
    stubGalley(fetchMock);

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
    stubGalley(fetchMock);

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");

    fireEvent.click(screen.getByTestId("ticket-detail-accept-button"));

    expect(await screen.findByTestId("ticket-detail-status")).toHaveTextContent("Done");
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/tickets/${TICKET_ID}/accept`, expect.objectContaining({ method: "POST" }));
  });

  it("assigns an Agent, replaces it with the Owner, and unassigns through PUT/DELETE /api/tickets/:id/assignee", async () => {
    const agentAssigned = { ...TICKET, assigneeType: "agent", assigneeAgent: { id: AGENTS[0].id, name: AGENTS[0].name, kind: AGENTS[0].kind } };
    const assigned = { ...TICKET, assigneeType: "owner" };
    const unassigned = { ...TICKET, assigneeType: "" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(TICKET))
      .mockResolvedValueOnce(jsonResponse(agentAssigned))
      .mockResolvedValueOnce(jsonResponse(assigned))
      .mockResolvedValueOnce(jsonResponse(unassigned));
    stubGalley(fetchMock);

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByRole("option", { name: "atlas" });

    fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: `agent:${AGENTS[0].id}` } });
    fireEvent.click(screen.getByTestId("ticket-detail-assign-button"));
    expect(await screen.findByTestId("ticket-detail-assignee")).toHaveTextContent("atlas");
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/tickets/${TICKET_ID}/assignee`, expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ type: "agent", agentId: AGENTS[0].id }),
    }));

    await waitFor(() => expect(screen.getByLabelText("Assign to")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: "owner" } });
    fireEvent.click(screen.getByTestId("ticket-detail-assign-button"));
    await waitFor(() => expect(screen.getByTestId("ticket-detail-assignee")).toHaveTextContent("Owner"));
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/tickets/${TICKET_ID}/assignee`, expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ type: "owner" }),
    }));

    fireEvent.click(screen.getByTestId("ticket-detail-unassign-button"));
    expect(await screen.findByTestId("ticket-detail-assignee")).toHaveTextContent("Unassigned");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/tickets/${TICKET_ID}/assignee`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
