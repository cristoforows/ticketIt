import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RunnerHealthPill } from "./RunnerHealthPill";
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
  allowedActions: { statusChangeRejections: [], statusChanges: ["Ready", "Blocked"], accept: { available: false, reason: { code: "invalid_transition", message: "Accept requires In Review" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } } },
  template: "Basic",
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
};

const AGENTS = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research", createdAt: "2026-09-30T10:00:00Z" }];

const onUnauthenticated = () => {};

/** The receipt loads Agents and the Round list alongside the Ticket; answering those here keeps each test's mock sequence about the Ticket. */
function stubGalley(fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<MockResponse>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/agents") return Promise.resolve(jsonResponse({ agents: AGENTS }));
    if (String(input).endsWith("/rounds")) return Promise.resolve(jsonResponse({ rounds: [] }));
    return fetchMock(input, init);
  }));
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
      { ...TICKET, allowedActions: { statusChangeRejections: [], statusChanges: ["Ready"], accept: { available: false }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } } } },
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
    ...["accept", "rework"].flatMap((command) => [
      { name: `${command} available with a reason`, change: { allowedActions: { ...TICKET.allowedActions, [command]: { available: true, reason: { code: "x", message: "m" } } } } },
      { name: `${command} unavailable without a reason`, change: { allowedActions: { ...TICKET.allowedActions, [command]: { available: false } } } },
      { name: `${command} with a malformed reason`, change: { allowedActions: { ...TICKET.allowedActions, [command]: { available: false, reason: { code: "x" } } } } },
      { name: `${command} with a missing input outside the contract`, change: { allowedActions: { ...TICKET.allowedActions, [command]: { available: false, reason: { code: "x", message: "m", missing: ["title"] } } } } },
    ]),
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

    expect(screen.getByTestId("back-to-backlog-link")).toHaveAttribute("href", "/list");
  });

  it("returns to the Backlog with the selected Badge filter", async () => {
    window.history.pushState({}, "", `/tickets/${TICKET_ID}?badgeId=first&badgeId=second`);
    stubFetch(jsonResponse(TICKET));

    render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
    await screen.findByTestId("ticket-detail-title");

    expect(screen.getByTestId("back-to-backlog-link")).toHaveAttribute("href", "/list?badgeId=first&badgeId=second");
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
    expect(screen.getByTestId("back-to-backlog-link")).toHaveAttribute("href", "/list?badgeId=first");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`).toBe("/board?badgeId=first"));
    window.history.pushState({}, "", "/");
  });

  describe("an open Round", () => {
    const agent = { id: AGENTS[0].id, name: "atlas", kind: "research" };
    const claimedRound = { id: "66666666-6666-4666-8666-666666666666", sequence: 1, state: "claimed", agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null, stopRequestedAt: null, waitingReason: "starting" };
    const claimed = { ...TICKET, status: "Ready", assigneeType: "agent", assigneeAgent: agent, successCriteria: "done", openRound: claimedRound };

    it("shows Claimed by runner from Galley's openRound", async () => {
      stubFetch(jsonResponse(claimed));
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      expect(await screen.findByTestId("ticket-detail-claimed")).toHaveTextContent("Claimed by runner");
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Ready");
      expect(screen.queryByTestId("ticket-detail-queued")).not.toBeInTheDocument();
    });

    it("shows Galley's round_open rejection when a claim lands after the receipt loaded", async () => {
      const rejection = "this Ticket has an open Round; it can be changed once the Round ends";
      vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
      stubGalley(vi.fn()
        .mockResolvedValueOnce(jsonResponse({ ...claimed, openRound: null }))
        .mockResolvedValueOnce(jsonResponse({ error: { code: "round_open", message: rejection, roundId: claimedRound.id } }, 400)));
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await screen.findByTestId("ticket-detail-title");

      fireEvent.click(screen.getByRole("button", { name: "Archive" }));

      expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent(rejection);
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Ready");
    });

    it("renders the receipt read-only with the lock copy from Galley's openRound", async () => {
      const reason = { code: "round_open", message: "this Ticket has an open Round; it can be changed once the Round ends", roundId: claimedRound.id };
      stubFetch(jsonResponse({ ...claimed, openRound: { ...claimedRound, sequence: 2 }, allowedActions: { statusChanges: [], statusChangeRejections: [], accept: { available: false, reason }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } } } }));
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      expect(await screen.findByTestId("ticket-detail-locked")).toHaveTextContent("Locked while atlas works on Round 2");
      for (const name of ["Edit", "Archive", "Add badge", "Unassign", "Assign"]) {
        expect(screen.getByRole("button", { name })).toBeDisabled();
      }
    });

    it.each([
      { name: "no openRound", openRound: undefined },
      { name: "an unknown Round state", openRound: { ...claimedRound, state: "delivered" } },
      { name: "a Round with no Agent", openRound: { ...claimedRound, agent: null } },
      { name: "a Round with no claimedAt", openRound: { ...claimedRound, claimedAt: undefined } },
      { name: "a running Round that has not started", openRound: { ...claimedRound, state: "running", startedAt: null } },
      { name: "a claimed Round that has started", openRound: { ...claimedRound, startedAt: "2026-10-01T10:01:00Z" } },
      { name: "a running Round with a numeric startedAt", openRound: { ...claimedRound, state: "running", startedAt: 5 } },
    ])("rejects a Ticket response with $name", async ({ openRound }) => {
      stubFetch(jsonResponse({ ...claimed, openRound }));
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      expect(await screen.findByText("Galley's Ticket response was missing a required field.")).toBeInTheDocument();
    });
  });

  describe("refreshing while execution may change the Ticket", () => {
    const agent = { id: AGENTS[0].id, name: "atlas", kind: "research" };
    const round = { id: "66666666-6666-4666-8666-666666666666", sequence: 1, state: "claimed", agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null, stopRequestedAt: null, waitingReason: "starting" };
    const lockedActions = { statusChanges: [], statusChangeRejections: [], accept: { available: false, reason: { code: "round_open", message: "locked", roundId: round.id } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } } };
    const claimed = { ...TICKET, status: "Ready", assigneeType: "agent", assigneeAgent: agent, openRound: round, allowedActions: lockedActions };
    const running = { ...claimed, status: "InProgress", openRound: { ...round, state: "running", startedAt: "2026-10-01T10:00:05Z", waitingReason: "working" }, updatedAt: "2026-10-01T10:00:05Z" };
    const closed = { ...TICKET, status: "InReview", assigneeType: "agent", assigneeAgent: agent, updatedAt: "2026-10-01T10:05:00Z" };
    const CONNECTED = { state: "connected", checkedAt: "2026-10-01T10:00:10Z", pairedAt: "2026-10-01T09:00:00Z", registeredAt: "2026-10-01T09:00:00Z", lastSeenAt: "2026-10-01T10:00:05Z", michelinVersion: "0.1.0", hostname: "runner-host" };

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    const reportRendererLoaded = () => act(async () => { await import("./ui/MarkdownRenderer"); });

    const unknownUsage = { sum: null, complete: false, estimated: false };
    const record = (activity: unknown[] = [], usage: unknown = { observations: 0, complete: false, estimated: false, costUsd: null, inputTokens: unknownUsage, outputTokens: unknownUsage, activeMs: unknownUsage }) => ({
      ...running.openRound,
      endedAt: null,
      outcomeNote: null,
      activity,
      earlierActivityCursor: null,
      usage,
      deliverable: null,
    });
    const claimedRecord = { ...record(), state: "claimed", startedAt: null };
    const roundsOf = (...records: unknown[]) => () => Promise.resolve(jsonResponse({ rounds: records }));

    function stubRound(tickets: (() => Promise<MockResponse>)[], health: () => MockResponse = () => jsonResponse(CONNECTED), rounds: (() => Promise<MockResponse>)[] = [roundsOf(record())], activity?: (before: string) => Promise<MockResponse>) {
      const queue = [...tickets];
      const roundQueue = [...rounds];
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/agents") return Promise.resolve(jsonResponse({ agents: AGENTS }));
        if (path === "/api/runner-health") return Promise.resolve(health());
        if (path === `/api/tickets/${TICKET_ID}/rounds`) return (roundQueue.length > 1 ? roundQueue.shift() : roundQueue[0])!();
        if (path === `/api/tickets/${TICKET_ID}`) return (queue.length > 1 ? queue.shift() : queue[0])!();
        if (activity && path.startsWith(`/api/tickets/${TICKET_ID}/rounds/${round.id}/activity?before=`)) return activity(decodeURIComponent(path.split("before=")[1]));
        throw new Error(`unexpected fetch ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }
    const answer = (body: unknown, status = 200) => () => Promise.resolve(jsonResponse(body, status));
    const ticketFetches = (fetchMock: ReturnType<typeof stubRound>) => fetchMock.mock.calls.filter(([path]) => String(path) === `/api/tickets/${TICKET_ID}`).length;
    const healthFetches = (fetchMock: ReturnType<typeof stubRound>) => fetchMock.mock.calls.filter(([path]) => String(path) === "/api/runner-health").length;
    const roundFetches = (fetchMock: ReturnType<typeof stubRound>) => fetchMock.mock.calls.filter(([path]) => String(path) === `/api/tickets/${TICKET_ID}/rounds`).length;

    it("refetches every 3 seconds and shows what Galley now reports, never returning to the loading state", async () => {
      const fetchMock = stubRound([answer(claimed), answer(running)], undefined, [roundsOf(claimedRecord), roundsOf(record())]);
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await flush();
      expect(screen.getByTestId("ticket-detail-claimed")).toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-round-state")).toHaveTextContent("Claimed, waiting for the runner to start");
      expect(ticketFetches(fetchMock)).toBe(1);

      await flush(2999);
      expect(ticketFetches(fetchMock)).toBe(1);
      await flush(1);
      expect(ticketFetches(fetchMock)).toBe(2);
      expect(screen.queryByTestId("ticket-detail-loading")).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Progress");
      expect(screen.getByTestId("ticket-detail-round-started")).toHaveTextContent("01 Oct 2026 15:30:05 UTC+05:30");
      expect(screen.queryByTestId("ticket-detail-claimed")).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-round-state")).toHaveTextContent("Running");

      await flush(3000);
      expect(ticketFetches(fetchMock)).toBe(3);
      expect(screen.getByTestId("ticket-detail-title")).toBeInTheDocument();
    });

    it("keeps showing the previous receipt while a refetch is pending", async () => {
      let release: (response: MockResponse) => void = () => {};
      stubRound([answer(claimed), () => new Promise<MockResponse>((resolve) => { release = resolve; })], undefined, [roundsOf(claimedRecord), roundsOf(record())]);
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await flush();
      await flush(3000);
      expect(screen.queryByTestId("ticket-detail-loading")).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-round-state")).toHaveTextContent("Claimed, waiting for the runner to start");
      release(jsonResponse(running));
      await flush();
      expect(screen.getByTestId("ticket-detail-round-started")).toBeInTheDocument();
    });

    it("never overlaps refetches: a slow one is waited for", async () => {
      const fetchMock = stubRound([answer(claimed), () => new Promise<MockResponse>(() => {})]);
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await flush();
      await flush(30_000);
      expect(ticketFetches(fetchMock)).toBe(2);
    });

    it("stops refetching once the Round has closed, and stops asking about the runner", async () => {
      const fetchMock = stubRound([answer(running), answer(closed)], undefined, [roundsOf(record()), roundsOf()]);
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await flush();
      await flush(3000);
      expect(ticketFetches(fetchMock)).toBe(2);
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Review");
      expect(screen.queryByTestId("ticket-detail-rounds")).not.toBeInTheDocument();
      const healthBefore = healthFetches(fetchMock);

      await flush(120_000);
      expect(ticketFetches(fetchMock)).toBe(2);
      expect(healthFetches(fetchMock)).toBe(healthBefore);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("refetches a queued Ticket that has no open Round, and stops once it is neither queued nor claimed", async () => {
      const queued = { ...TICKET, status: "Ready", assigneeType: "agent", assigneeAgent: agent, requestingAgentWork: true };
      const fetchMock = stubRound([answer(queued), answer(queued), answer({ ...queued, requestingAgentWork: false, status: "Backlog" })]);
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await flush();
      expect(ticketFetches(fetchMock)).toBe(1);
      await flush(3000);
      expect(ticketFetches(fetchMock)).toBe(2);
      await flush(3000);
      expect(ticketFetches(fetchMock)).toBe(3);
      expect(screen.queryByTestId("ticket-detail-queued")).not.toBeInTheDocument();

      await flush(120_000);
      expect(ticketFetches(fetchMock)).toBe(3);
      expect(healthFetches(fetchMock)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("requests Stop through POST /api/tickets/:id/stop, shows Stopping, and keeps refreshing the still-open Round", async () => {
      const stoppable = { ...running, allowedActions: { ...lockedActions, stop: { available: true } } };
      const stopping = { ...running, openRound: { ...running.openRound, stopRequestedAt: "2026-10-01T10:00:07Z", waitingReason: "stopping" }, allowedActions: { ...lockedActions, stop: { available: false, reason: { code: "stop_already_requested", message: "Stop is already requested for this Round" } } } };
      const fetchMock = stubRound([answer(stoppable), answer(stopping)]);
      const posts = vi.fn();
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== `/api/tickets/${TICKET_ID}/stop`) return fetchMock(input);
        posts(init?.method, init?.body);
        return Promise.resolve(jsonResponse(stopping));
      }));
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await flush();
      expect(screen.queryByTestId("ticket-detail-stopping")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("ticket-detail-stop-button"));
      await flush();
      expect(posts).toHaveBeenCalledExactlyOnceWith("POST", undefined);
      expect(screen.getByTestId("ticket-detail-stopping")).toHaveTextContent("Stopping…");
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Progress");
      expect(screen.queryByTestId("ticket-detail-stop-button")).not.toBeInTheDocument();

      const before = ticketFetches(fetchMock);
      await flush(3000);
      expect(ticketFetches(fetchMock)).toBe(before + 1);
      expect(screen.getByTestId("ticket-detail-stopping")).toBeInTheDocument();
    });

    it("keeps a command's Ticket when an earlier refetch resolves after it", async () => {
      const queued = { ...TICKET, status: "Ready", assigneeType: "agent", assigneeAgent: agent, requestingAgentWork: true, allowedActions: { ...TICKET.allowedActions, statusChanges: ["Backlog"] } };
      const backlog = { ...TICKET, assigneeType: "agent", assigneeAgent: agent, updatedAt: "2026-10-01T10:00:04Z" };
      let release: (response: MockResponse) => void = () => {};
      const fetchMock = stubRound([answer(queued), () => new Promise<MockResponse>((resolve) => { release = resolve; })]);
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
        String(input) === `/api/tickets/${TICKET_ID}/status` ? Promise.resolve(jsonResponse(backlog)) : fetchMock(input)));
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await flush();
      await flush(3000);
      expect(ticketFetches(fetchMock)).toBe(2);

      fireEvent.click(screen.getByTestId("ticket-detail-status-button-Backlog"));
      await flush();
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Backlog");

      release(jsonResponse(queued));
      await flush();
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Backlog");
      expect(screen.queryByTestId("ticket-detail-queued")).not.toBeInTheDocument();
    });

    describe("delivery", () => {
      const deliverable = { bodyMarkdown: "# Result\n\n- Found the cause\n", summary: "Found the cause.", criteriaAssessment: "A written cause: met." };
      const delivery = { roundId: round.id, sequence: 1, agent, deliveredAt: "2026-10-01T10:00:09Z" };
      const delivered = { ...running, status: "InReview", openRound: null, delivery, updatedAt: "2026-10-01T10:00:09Z", allowedActions: { statusChanges: [], statusChangeRejections: [], accept: { available: true }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } } } };
      const deliveredRecord = { ...record([{ seq: 1, note: "Reading the Ticket", occurredAt: "2026-10-01T10:00:06Z" }]), state: "delivered", endedAt: "2026-10-01T10:00:09Z", deliverable };

      it("picks up In Review, the delivering Agent and the deliverable on the same tick, then stops refreshing", async () => {
        const fetchMock = stubRound([answer(running), answer(delivered)], undefined, [roundsOf(record()), roundsOf(deliveredRecord)]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(screen.getByTestId("ticket-detail-round-started")).toBeInTheDocument();
        expect(screen.getByTestId("ticket-detail-round-state")).toHaveTextContent("Running");

        await flush(3000);
        expect(ticketFetches(fetchMock)).toBe(2);
        expect(roundFetches(fetchMock)).toBe(2);
        expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Review");
        expect(screen.getByTestId("ticket-detail-delivered")).toHaveTextContent("Delivered by atlas");
        expect(screen.queryByTestId("ticket-detail-locked")).not.toBeInTheDocument();
        const receipt = within(screen.getByTestId("ticket-detail-round"));
        expect(receipt.getByTestId("ticket-detail-round-state")).toHaveTextContent("Delivered by atlas");
        expect(receipt.getByTestId("ticket-detail-round-agent")).toHaveTextContent("atlas");
        expect(receipt.getByTestId("ticket-detail-round-delivered-at")).toHaveTextContent("01 Oct 2026 15:30:09 UTC+05:30");
        expect(receipt.getByTestId("ticket-detail-round-summary")).toHaveTextContent("Found the cause.");
        expect(receipt.getByTestId("ticket-detail-round-assessment")).toHaveTextContent("A written cause: met.");
        await reportRendererLoaded();
        expect(within(receipt.getByTestId("ticket-detail-round-body")).getByRole("heading", { level: 1, name: "Result" })).toBeInTheDocument();
        expect(receipt.getAllByTestId("ticket-detail-round-note").map((item) => item.textContent)).toEqual(["01 Oct 2026 15:30:06 UTC+05:30Reading the Ticket"]);
        expect(screen.getByTestId("ticket-detail-accept-button")).toBeEnabled();

        await flush(120_000);
        expect(ticketFetches(fetchMock)).toBe(2);
        expect(roundFetches(fetchMock)).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
      });

      it("loads a delivered Ticket's Rounds once on open, without refreshing", async () => {
        const fetchMock = stubRound([answer(delivered)], undefined, [roundsOf(deliveredRecord)]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(screen.getByTestId("ticket-detail-round-summary")).toHaveTextContent("Found the cause.");
        await flush(60_000);
        expect(ticketFetches(fetchMock)).toBe(1);
        expect(roundFetches(fetchMock)).toBe(1);
        expect(healthFetches(fetchMock)).toBe(0);
      });

      it.each([
        { name: "a delivered Round without its deliverable", round: { ...deliveredRecord, deliverable: null } },
        { name: "a delivered Round with a partial deliverable", round: { ...deliveredRecord, deliverable: { bodyMarkdown: "b", summary: "s" } } },
        { name: "an open Round with a deliverable", round: { ...record(), deliverable } },
        { name: "an unknown Round state", round: { ...deliveredRecord, state: "stopped" } },
      ])("refuses $name", async ({ round: bad }) => {
        stubRound([answer(delivered)], undefined, [roundsOf(bad)]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(screen.getByTestId("ticket-detail-round-records-error")).toHaveTextContent("missing a required field");
        expect(screen.queryByTestId("ticket-detail-round")).not.toBeInTheDocument();
      });

      it.each([
        { name: "no delivery", delivery: undefined },
        { name: "a delivery with no Agent", delivery: { ...delivery, agent: null } },
        { name: "a delivery with no deliveredAt", delivery: { ...delivery, deliveredAt: undefined } },
      ])("rejects a Ticket response with $name", async ({ delivery: bad }) => {
        stubRound([answer({ ...delivered, delivery: bad })]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(screen.getByTestId("ticket-detail-error-message")).toHaveTextContent("missing a required field");
      });

      describe("rework", () => {
        const reviewable = { ...delivered, allowedActions: { ...delivered.allowedActions, rework: { available: true } } };
        const queuedAgain = { ...delivered, status: "Ready", requestingAgentWork: true, allowedActions: { statusChanges: [], statusChangeRejections: [], accept: delivered.allowedActions.accept, rework: delivered.allowedActions.rework, stop: delivered.allowedActions.stop } };
        const round2 = { ...round, id: "88888888-8888-4888-8888-888888888888", sequence: 2 };
        const claimed2 = { ...queuedAgain, requestingAgentWork: false, delivery: null, openRound: round2, allowedActions: lockedActions };
        const running2 = { ...claimed2, status: "InProgress", openRound: { ...round2, state: "running", startedAt: "2026-10-01T10:10:05Z", waitingReason: "working" } };
        const deliveredTwo = { ...reviewable, delivery: { ...delivery, roundId: round2.id, sequence: 2, deliveredAt: "2026-10-01T10:10:09Z" } };
        const record2 = (fields: Record<string, unknown>) => ({ ...record(), ...round2, state: "running", startedAt: "2026-10-01T10:10:05Z", ...fields });
        const delivered2 = record2({ state: "delivered", endedAt: "2026-10-01T10:10:09Z", deliverable: { ...deliverable, summary: "Second pass." } });

        it("goes from In Review to a second delivered Round, keeping the first listed and collapsed", async () => {
          const fetchMock = stubRound(
            [answer(reviewable), answer(queuedAgain), answer(claimed2), answer(running2), answer(deliveredTwo)],
            undefined,
            [roundsOf(deliveredRecord), roundsOf(deliveredRecord), roundsOf(record2({ state: "claimed", startedAt: null }), deliveredRecord), roundsOf(record2({}), deliveredRecord), roundsOf(delivered2, deliveredRecord)],
          );
          const posts = vi.fn();
          vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input) !== `/api/tickets/${TICKET_ID}/rework`) return fetchMock(input);
            posts(init?.method);
            return Promise.resolve(jsonResponse(queuedAgain));
          }));
          render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
          await flush(10_000);
          expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Review");

          fireEvent.click(screen.getByTestId("ticket-detail-rework-button"));
          await flush();
          expect(posts).toHaveBeenCalledWith("POST");
          expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Ready");
          expect(screen.getByTestId("ticket-detail-queued")).toHaveTextContent("Queued for atlas");
          expect(screen.getAllByTestId("ticket-detail-round")).toHaveLength(1);

          await flush(3000);
          expect(screen.getByTestId("ticket-detail-queued")).toBeInTheDocument();
          await flush(3000);
          expect(screen.getByTestId("ticket-detail-claimed")).toBeInTheDocument();
          expect(screen.getAllByTestId("ticket-detail-round").map((entry) => entry.getAttribute("data-round-id"))).toEqual([round2.id, round.id]);
          expect(within(screen.getAllByTestId("ticket-detail-round")[0]).getByTestId("ticket-detail-round-state")).toHaveTextContent("Claimed, waiting for the runner to start");

          await flush(3000);
          expect(within(screen.getAllByTestId("ticket-detail-round")[0]).getByTestId("ticket-detail-round-state")).toHaveTextContent("Running");

          await flush(3000);
          await reportRendererLoaded();
          const entries = screen.getAllByTestId("ticket-detail-round");
          expect(entries.map((entry) => entry.getAttribute("data-round-id"))).toEqual([round2.id, round.id]);
          expect(entries.map((entry) => (entry.querySelector("details") as HTMLDetailsElement).open)).toEqual([true, false]);
          expect(within(entries[0]).getByTestId("ticket-detail-round-summary")).toHaveTextContent("Second pass.");
          expect(within(entries[1]).getByTestId("ticket-detail-round-summary")).toHaveTextContent("Found the cause.");
          expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Review");

          await flush(120_000);
          expect(vi.getTimerCount()).toBe(0);
        });
      });
    });

    it("never refetches, or asks about the runner, for a Ticket with no open Round", async () => {
      const fetchMock = stubRound([answer(TICKET)], undefined, [roundsOf()]);
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await flush(120_000);
      expect(ticketFetches(fetchMock)).toBe(1);
      expect(healthFetches(fetchMock)).toBe(0);
      expect(screen.queryByTestId("ticket-detail-rounds")).not.toBeInTheDocument();
    });

    it("stops refetching on unmount", async () => {
      const fetchMock = stubRound([answer(claimed)]);
      const { unmount } = render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await flush();
      unmount();
      await flush();
      expect(vi.getTimerCount()).toBe(0);
      await flush(60_000);
      expect(ticketFetches(fetchMock)).toBe(1);
    });

    it("keeps the receipt and says the refresh failed, then clears the note once a refetch succeeds", async () => {
      stubRound([answer(claimed), answer({ error: { code: "database_unavailable", message: "x" } }, 503), answer(claimed), answer(running)], undefined, [roundsOf(claimedRecord), roundsOf(claimedRecord), roundsOf(record())]);
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
      await flush();
      await flush(3000);
      expect(screen.getByTestId("ticket-detail-refresh-error")).toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-refresh-error-message")).toHaveTextContent("Galley returned an error response: 503");
      expect(screen.getByTestId("ticket-detail-round-state")).toHaveTextContent("Claimed, waiting for the runner to start");

      await flush(3000);
      expect(screen.queryByTestId("ticket-detail-refresh-error")).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-round-state")).toHaveTextContent("Claimed, waiting for the runner to start");

      await flush(3000);
      expect(screen.getByTestId("ticket-detail-round-started")).toBeInTheDocument();
    });

    it("hands the Owner to sign-in when a refetch comes back unauthenticated", async () => {
      const onSignedOut = vi.fn();
      stubRound([answer(claimed), answer({ error: { code: "unauthenticated", message: "sign-in required" } }, 401)]);
      render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onSignedOut} />);
      await flush();
      await flush(3000);
      expect(onSignedOut).toHaveBeenCalled();
    });

    describe("activity and usage", () => {
      const note = (seq: number, text: string) => ({ seq, note: text, occurredAt: `2026-10-01T10:00:0${seq}Z` });
      const count = (sum: number | null, complete = true, estimated = false) => ({ sum, complete, estimated });
      const usage = (fields: Record<string, unknown>) => ({ observations: 1, complete: true, estimated: false, costUsd: "0.004500", inputTokens: count(1200), outputTokens: count(300), activeMs: count(2000), ...fields });
      const usageText = (figure: string) => screen.getByTestId(`ticket-detail-round-usage-${figure}`).textContent;
      const notes = () => screen.queryAllByTestId("ticket-detail-round-note").map((item) => item.textContent);

      const seqNotes = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => ({ seq: first + index, note: `note ${first + index}`, occurredAt: "2026-10-01T10:00:00Z" }));
      const shownSeqs = () => screen.queryAllByTestId("ticket-detail-round-note").map((item) => Number(item.getAttribute("data-seq")));
      const range = (first: number, last: number) => seqNotes(first, last).map((item) => item.seq);
      const windowOf = (first: number, last: number, cursor: string | null) => ({ ...record(seqNotes(first, last)), earlierActivityCursor: cursor });
      const pageOf = (first: number, last: number, cursor: string | null) => Promise.resolve(jsonResponse({ activity: seqNotes(first, last), earlierActivityCursor: cursor }));
      const loadEarlier = () => act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load earlier activity for Round 1" })); await vi.advanceTimersByTimeAsync(0); });

      it("pages back past the latest 50 notes with Load earlier until Galley has no earlier page", async () => {
        const pages: Record<string, () => Promise<MockResponse>> = { c71: () => pageOf(21, 70, "c21"), c21: () => pageOf(1, 20, null) };
        const asked: string[] = [];
        stubRound([answer(running)], undefined, [roundsOf(windowOf(71, 120, "c71"))], (before) => { asked.push(before); return pages[before]!(); });
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(shownSeqs()).toEqual(range(71, 120));

        await loadEarlier();
        expect(shownSeqs()).toEqual(range(21, 120));
        await loadEarlier();
        expect(shownSeqs()).toEqual(range(1, 120));
        expect(asked).toEqual(["c71", "c21"]);
        expect(screen.queryByTestId("ticket-detail-round-load-earlier")).not.toBeInTheDocument();
      });

      it("keeps earlier notes when a refresh moves the latest window forward, and pages on from the oldest shown", async () => {
        const asked: string[] = [];
        stubRound([answer(running)], undefined, [roundsOf(windowOf(71, 120, "c71")), roundsOf(windowOf(76, 125, "c76"))], (before) => {
          asked.push(before);
          return before === "c71" ? pageOf(21, 70, "c21") : pageOf(1, 20, null);
        });
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        await loadEarlier();
        await flush(3000);
        expect(shownSeqs()).toEqual(range(21, 125));
        await loadEarlier();
        expect(asked).toEqual(["c71", "c21"]);
        expect(shownSeqs()).toEqual(range(1, 125));
      });

      it("back-fills the notes a refresh skipped when more than 50 arrived between refreshes", async () => {
        const asked: string[] = [];
        stubRound([answer(running)], undefined, [roundsOf(windowOf(1, 50, null)), roundsOf(windowOf(111, 160, "c111"))], (before) => {
          asked.push(before);
          return before === "c111" ? pageOf(61, 110, "c61") : pageOf(11, 60, "c11");
        });
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(screen.queryByTestId("ticket-detail-round-load-earlier")).not.toBeInTheDocument();
        await flush(3000);
        await flush();
        expect(asked).toEqual(["c111", "c61"]);
        expect(shownSeqs()).toEqual(range(1, 160));
        expect(screen.queryByTestId("ticket-detail-round-load-earlier")).not.toBeInTheDocument();
      });

      it("says Load earlier failed and keeps the notes and the control", async () => {
        stubRound([answer(running)], undefined, [roundsOf(windowOf(71, 120, "c71"))], () => Promise.resolve(jsonResponse({ error: { code: "database_unavailable", message: "x" } }, 503)));
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        await loadEarlier();
        expect(screen.getByTestId("ticket-detail-round-load-earlier-error")).toHaveTextContent("Unable to load earlier activity");
        expect(shownSeqs()).toEqual(range(71, 120));
        expect(screen.getByRole("button", { name: "Load earlier activity for Round 1" })).toBeEnabled();
      });

      it("loads with the Ticket and shows no activity and usage as Unknown, never as zero", async () => {
        const fetchMock = stubRound([answer(running)]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(roundFetches(fetchMock)).toBe(1);
        expect(screen.getByTestId("ticket-detail-round-activity-empty")).toHaveTextContent("No activity yet.");
        for (const figure of ["cost", "input-tokens", "output-tokens", "active-time"]) {
          expect(usageText(figure)).toBe("Unknown");
        }
        expect(screen.queryByText("est.")).not.toBeInTheDocument();
        expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
      });

      it("refreshes on the same 3-second tick as the Ticket, showing new notes oldest first and the usage so far", async () => {
        const fetchMock = stubRound([answer(running)], undefined, [
          roundsOf(record([note(1, "Reading the Ticket")])),
          roundsOf(record([note(1, "Reading the Ticket"), note(2, "Working towards the goal")], usage({}))),
        ]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(notes()).toEqual(["01 Oct 2026 15:30:01 UTC+05:30Reading the Ticket"]);

        await flush(2999);
        expect(roundFetches(fetchMock)).toBe(1);
        await flush(1);
        expect(roundFetches(fetchMock)).toBe(2);
        expect(ticketFetches(fetchMock)).toBe(2);
        expect(notes()).toEqual(["01 Oct 2026 15:30:01 UTC+05:30Reading the Ticket", "01 Oct 2026 15:30:02 UTC+05:30Working towards the goal"]);
        expect(usageText("cost")).toBe("$0.0045");
        expect(usageText("input-tokens")).toBe("1,200");
        expect(usageText("output-tokens")).toBe("300");
        expect(usageText("active-time")).toBe("2.0 s");

        await flush(3000);
        expect(roundFetches(fetchMock)).toBe(ticketFetches(fetchMock));
      });

      it.each([
        ["complete and reported", usage({}), { cost: "$0.0045", "input-tokens": "1,200" }],
        ["complete with an estimated cost", usage({ estimated: true, inputTokens: count(1200, true, true) }), { cost: "$0.0045 est.", "input-tokens": "1,200 est." }],
        ["incomplete: one cost unknown", usage({ observations: 2, complete: false, costUsd: "0.300000", inputTokens: count(10, false) }), { cost: "≥ $0.30 (incomplete)", "input-tokens": "≥ 10 (incomplete)" }],
        ["incomplete and estimated", usage({ observations: 2, complete: false, estimated: true, costUsd: "1000123.750000" }), { cost: "≥ $1,000,123.75 (incomplete) est." }],
        ["observed but every cost unknown", usage({ complete: false, costUsd: null, inputTokens: count(null, false), activeMs: count(65_000) }), { cost: "Unknown", "input-tokens": "Unknown", "active-time": "1 min 5 s" }],
      ])("shows usage %s as Galley summarised it", async (_name, summary, expected) => {
        stubRound([answer(running)], undefined, [roundsOf(record([], summary))]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        for (const [figure, text] of Object.entries(expected)) {
          expect(usageText(figure)).toBe(text);
        }
      });

      it("shows each Round's own activity under that Round", async () => {
        const ended = { ...record([note(1, "An earlier Round")]), id: "77777777-7777-4777-8777-777777777777", sequence: 0, endedAt: "2026-10-01T09:00:00Z" };
        stubRound([answer(running)], undefined, [roundsOf(record([note(1, "This Round")]), ended)]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        const [current, earlier] = screen.getAllByTestId("ticket-detail-round");
        expect(within(current).getAllByTestId("ticket-detail-round-note").map((item) => item.textContent)).toEqual(["01 Oct 2026 15:30:01 UTC+05:30This Round"]);
        expect(within(earlier).getAllByTestId("ticket-detail-round-note").map((item) => item.textContent)).toEqual(["01 Oct 2026 15:30:01 UTC+05:30An earlier Round"]);
      });

      it("keeps the last activity when a refresh fails, says so, and clears the note once one succeeds", async () => {
        stubRound([answer(running)], undefined, [
          roundsOf(record([note(1, "Reading the Ticket")])),
          answer({ error: { code: "database_unavailable", message: "x" } }, 503),
          roundsOf(record([note(1, "Reading the Ticket"), note(2, "Next")])),
        ]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        await flush(3000);
        expect(screen.getByTestId("ticket-detail-round-records-error")).toHaveTextContent("Unable to refresh activity and usage: Galley returned an error response: 503");
        expect(notes()).toHaveLength(1);
        await flush(3000);
        expect(screen.queryByTestId("ticket-detail-round-records-error")).not.toBeInTheDocument();
        expect(notes()).toHaveLength(2);
      });

      it.each([
        ["a note without seq", record([{ note: "x", occurredAt: "t" }])],
        ["usage without a cost field", record([], { observations: 0, complete: false, estimated: false, inputTokens: unknownUsage, outputTokens: unknownUsage, activeMs: unknownUsage })],
        ["a numeric cost", record([], usage({ costUsd: 0.0045 }))],
        ["a count without complete", record([], usage({ activeMs: { sum: 1, estimated: false } }))],
        ["no activity array", { ...record(), activity: undefined }],
      ])("rejects a Round list with %s rather than showing part of it", async (_name, bad) => {
        stubRound([answer(running)], undefined, [roundsOf(bad)]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(screen.getByTestId("ticket-detail-round-records-error")).toHaveTextContent("Galley's Round list was missing a required field.");
        expect(screen.queryByTestId("ticket-detail-round-usage")).not.toBeInTheDocument();
      });

      it("hands the Owner to sign-in when the Round list comes back unauthenticated", async () => {
        const onSignedOut = vi.fn();
        stubRound([answer(running)], undefined, [answer({ error: { code: "unauthenticated", message: "sign-in required" } }, 401)]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onSignedOut} />);
        await flush();
        expect(onSignedOut).toHaveBeenCalled();
      });

      it("fetches the Round list on open and on the refresh that sees the Round stop, then never again", async () => {
        const stoppedTicket = { ...running, status: "Backlog", openRound: null, badges: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Stopped" }], updatedAt: "2026-10-01T10:05:00Z", allowedActions: TICKET.allowedActions };
        const stoppedRecord = { ...record([note(1, "Reading the Ticket")]), state: "stopped", endedAt: "2026-10-01T10:05:00Z", outcomeNote: "Stopped before step 2 of 2 on Stop command x" };
        const fetchMock = stubRound([answer(running), answer(stoppedTicket)], undefined, [roundsOf(record([note(1, "Reading the Ticket")])), roundsOf(stoppedRecord)]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(roundFetches(fetchMock)).toBe(1);
        await flush(3000);
        expect(roundFetches(fetchMock)).toBe(2);
        expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Backlog");
        expect(screen.getByTestId("ticket-detail-round-stopped")).toHaveTextContent("Stopped");
        expect(screen.getByTestId("ticket-detail-round-outcome-note")).toHaveTextContent(stoppedRecord.outcomeNote);
        expect(screen.getByTestId("ticket-detail-round-note")).toHaveTextContent("Reading the Ticket");
        expect(screen.queryByTestId("ticket-detail-stopping")).not.toBeInTheDocument();
        await flush(60_000);
        expect(roundFetches(fetchMock)).toBe(2);

        cleanup();
        const reopened = stubRound([answer(stoppedTicket)], undefined, [roundsOf(stoppedRecord)]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush(60_000);
        expect(roundFetches(reopened)).toBe(1);
        expect(screen.getByTestId("ticket-detail-round-stopped")).toBeInTheDocument();

        cleanup();
        const idle = stubRound([answer(TICKET)], undefined, [roundsOf()]);
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush(60_000);
        expect(roundFetches(idle)).toBe(1);
        expect(screen.queryByTestId("ticket-detail-rounds")).not.toBeInTheDocument();
      });
    });

    describe("with the runner's health", () => {
      it("overlays Runner disconnected when Galley says the runner is not Connected", async () => {
        stubRound([answer(running)], () => jsonResponse({ ...CONNECTED, state: "disconnected" }));
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(screen.getByTestId("ticket-detail-runner-disconnected")).toHaveTextContent("Runner disconnected");
        expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Progress");
      });

      it("shows no overlay while the runner is Connected, and shows it when a later check says otherwise", async () => {
        const states = [CONNECTED, { ...CONNECTED, state: "disconnected" }];
        stubRound([answer(running)], () => jsonResponse(states.length > 1 ? states.shift() : states[0]));
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(screen.queryByTestId("ticket-detail-runner-disconnected")).not.toBeInTheDocument();
        await flush(10_000);
        expect(screen.getByTestId("ticket-detail-runner-disconnected")).toBeInTheDocument();
      });

      it("shows Runner disconnected on the same check as the header, even when the receipt opens between checks", async () => {
        const states = [CONNECTED, { ...CONNECTED, state: "disconnected" }];
        const fetchMock = stubRound([answer(running)], () => jsonResponse(states.length > 1 ? states.shift() : states[0]));
        const header = <RunnerHealthPill onUnauthenticated={onUnauthenticated} />;
        const { rerender } = render(header);
        await flush(5_000);
        rerender(<>{header}<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} /></>);
        await flush();
        expect(screen.getByTestId("runner-health-pill")).toHaveAttribute("data-health", "connected");
        expect(screen.queryByTestId("ticket-detail-runner-disconnected")).not.toBeInTheDocument();
        expect(healthFetches(fetchMock)).toBe(1);

        await flush(5_000);
        expect(screen.getByTestId("runner-health-pill")).toHaveAttribute("data-health", "disconnected");
        expect(screen.getByTestId("ticket-detail-runner-disconnected")).toBeInTheDocument();
        expect(healthFetches(fetchMock)).toBe(2);
      });

      it("reuses the header's runner health request and shows no overlay when it fails", async () => {
        const fetchMock = stubRound([answer(running)], () => jsonResponse({ error: { code: "database_unavailable", message: "x" } }, 503));
        render(<TicketDetailPage ticketId={TICKET_ID} onUnauthenticated={onUnauthenticated} />);
        await flush();
        expect(fetchMock).toHaveBeenCalledWith("/api/runner-health", undefined);
        expect(screen.getByTestId("ticket-detail-rounds")).toBeInTheDocument();
        expect(screen.queryByTestId("ticket-detail-runner-disconnected")).not.toBeInTheDocument();
      });
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
