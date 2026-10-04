import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NewOrderBar } from "./NewOrderBar";
import { TicketList } from "./TicketList";

type MockResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

function jsonResponse(body: unknown, status = 200, statusText = ""): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  };
}

const TICKET_A = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Second captured",
  status: "Backlog",
  permissionGrants: [],
  allowedActions: { statusChangeRejections: [], statusChanges: ["Ready", "Blocked"], accept: { available: false, reason: { code: "invalid_transition", message: "Accept requires In Review" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
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
  createdAt: "2026-09-22T10:01:00Z",
  updatedAt: "2026-09-22T10:01:00Z",
  badges: [],
  archivedAt: null,
};
const TICKET_B = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "First captured",
  status: "Backlog",
  permissionGrants: [],
  allowedActions: { statusChangeRejections: [], statusChanges: ["Ready", "Blocked"], accept: { available: false, reason: { code: "invalid_transition", message: "Accept requires In Review" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
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
const CODING_TICKET = {
  ...TICKET_B,
  id: "66666666-6666-4666-8666-666666666666",
  title: "Coding capture",
  template: "Coding",
  completionCondition: "reviewedPrMerge",
};

function OrderLog({ refreshKey = 0, focusTicketId }: { refreshKey?: number; focusTicketId?: string }) {
  const [created, setCreated] = useState(0);
  return (
    <>
      <NewOrderBar onUnauthenticated={() => {}} onCreated={() => setCreated((count) => count + 1)} />
      <TicketList onUnauthenticated={() => {}} refreshKey={refreshKey + created} focusTicketId={focusTicketId} />
    </>
  );
}

function renderTicketList() {
  return render(<OrderLog />);
}

function openCaptureModal(typedTitle?: string) {
  if (typedTitle !== undefined) fireEvent.change(screen.getByTestId("new-order-input"), { target: { value: typedTitle } });
  fireEvent.click(screen.getByTestId("new-order-button"));
}

/** Routes by method + path, and can be reprogrammed mid-test (via `set`)
 * so a spec can return a different list after a capture re-fetches it. */
function stubFetch(initial: Record<string, MockResponse>) {
  const routes = { ...initial };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(input)}`;
      const response = routes[key];
      if (!response) {
        throw new Error(`unexpected fetch ${key} in this test`);
      }
      return Promise.resolve(response);
    }),
  );
  return {
    set(key: string, response: MockResponse) {
      routes[key] = response;
    },
  };
}

describe("TicketList", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a loading state before the initial fetch settles", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    renderTicketList();

    expect(screen.getByTestId("ticket-list-loading")).toBeInTheDocument();
  });

  it("shows an empty state when the Owner has no Tickets", async () => {
    stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [] }) });

    renderTicketList();

    expect(await screen.findByTestId("ticket-list-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-list-items")).not.toBeInTheDocument();
  });

  it("requests only archived Tickets from Galley and hides capture while browsing them", async () => {
    const archive = { ...TICKET_A, archivedAt: "2026-09-29T10:00:00Z" };
    stubFetch({ "GET /api/tickets?archived=true&badgeId=selected": jsonResponse({ tickets: [archive] }) });
    render(<TicketList archived badgeIds={["selected"]} onUnauthenticated={() => {}} />);
    expect(await screen.findByTestId(`ticket-item-${archive.id}`)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Archived Tickets" })).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-capture-form")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-reorder-up")).not.toBeInTheDocument();
  });

  it("marks a locked Ticket with a named lock glyph and offers no reorder for it", async () => {
    const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" };
    const locked = { ...TICKET_A, assigneeType: "agent", assigneeAgent: agent, openRound: { id: "77777777-7777-4777-8777-777777777777", sequence: 2, state: "claimed", agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null, stopRequestedAt: null, waitingReason: "starting", question: null, permissionRequest: null } };
    stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [locked, TICKET_B] }) });
    render(<TicketList onUnauthenticated={() => {}} />);
    const lockedRow = within(await screen.findByTestId(`ticket-item-${locked.id}`));
    expect(lockedRow.getByRole("img", { name: "Locked while atlas works on Round 2" })).toBe(lockedRow.getByTestId("ticket-locked"));
    expect(lockedRow.queryByTestId("ticket-reorder-up")).not.toBeInTheDocument();
    const openRow = within(screen.getByTestId(`ticket-item-${TICKET_B.id}`));
    expect(openRow.queryByTestId("ticket-locked")).not.toBeInTheDocument();
    expect(openRow.getByTestId("ticket-reorder-up")).toBeInTheDocument();
  });

  describe("refreshing while a Ticket awaits execution", () => {
    const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" };
    const round = { id: "77777777-7777-4777-8777-777777777777", sequence: 1, state: "claimed", agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null, stopRequestedAt: null, waitingReason: "starting", question: null, permissionRequest: null };
    const claimed = { ...TICKET_A, status: "Ready", assigneeType: "agent", assigneeAgent: agent, openRound: round };
    const running = { ...claimed, status: "InProgress", openRound: { ...round, state: "running", startedAt: "2026-10-01T10:00:05Z", waitingReason: "working" } };
    const settled = { ...claimed, openRound: null };
    const queued = { ...settled, requestingAgentWork: true };

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    function stubLists(lists: (() => Promise<MockResponse>)[]) {
      const queue = [...lists];
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        if (String(input) !== "/api/tickets") throw new Error(`unexpected fetch ${String(input)}`);
        return (queue.length > 1 ? queue.shift() : queue[0])!();
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }
    const list = (...tickets: unknown[]) => () => Promise.resolve(jsonResponse({ tickets }));

    it("refetches every 3 seconds and shows the Status Galley now reports, without a loading state", async () => {
      const fetchMock = stubLists([list(claimed, TICKET_B), list(running, TICKET_B)]);
      render(<TicketList onUnauthenticated={() => {}} />);
      await flush();
      expect(within(screen.getByTestId(`ticket-item-${claimed.id}`)).getByTestId("ticket-status")).toHaveTextContent("Ready");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await flush(2999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await flush(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("ticket-list-loading")).not.toBeInTheDocument();
      expect(within(screen.getByTestId(`ticket-item-${claimed.id}`)).getByTestId("ticket-status")).toHaveTextContent("In Progress");
      expect(within(screen.getByTestId(`ticket-item-${claimed.id}`)).getByTestId("ticket-locked")).toBeInTheDocument();
      expect(screen.getByTestId("ticket-list-total")).toHaveTextContent("TOTAL — 2 orders");
    });

    it("keeps the list on screen while a refetch is pending and never overlaps refetches", async () => {
      const fetchMock = stubLists([list(claimed), () => new Promise<MockResponse>(() => {})]);
      render(<TicketList onUnauthenticated={() => {}} />);
      await flush();
      await flush(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("ticket-list-loading")).not.toBeInTheDocument();
      expect(screen.getByTestId(`ticket-item-${claimed.id}`)).toBeInTheDocument();
    });

    it("stops refetching once no Ticket has an open Round or is queued", async () => {
      const fetchMock = stubLists([list(claimed), list(settled)]);
      render(<TicketList onUnauthenticated={() => {}} />);
      await flush();
      await flush(3000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("ticket-locked")).not.toBeInTheDocument();
      await flush(120_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps refetching a queued Ticket that has no open Round, and stops once it is neither queued nor claimed", async () => {
      const fetchMock = stubLists([list(queued), list(queued), list(settled)]);
      render(<TicketList onUnauthenticated={() => {}} />);
      await flush();
      await flush(3000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await flush(3000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await flush(120_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("never refetches a list in which no Ticket has an open Round or is queued", async () => {
      const fetchMock = stubLists([list(TICKET_A, TICKET_B)]);
      render(<TicketList onUnauthenticated={() => {}} />);
      await flush(120_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops refetching on unmount", async () => {
      const fetchMock = stubLists([list(claimed)]);
      const { unmount } = render(<TicketList onUnauthenticated={() => {}} />);
      await flush();
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      await flush(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("keeps the list and says the refresh failed, then clears the note once a refetch succeeds", async () => {
      stubLists([list(claimed), () => Promise.resolve(jsonResponse({ error: { code: "database_unavailable", message: "x" } }, 503, "Service Unavailable")), list(claimed), list(running)]);
      render(<TicketList onUnauthenticated={() => {}} />);
      await flush();
      await flush(3000);
      expect(screen.getByTestId("ticket-list-refresh-error-message")).toHaveTextContent("Galley returned an error response: 503");
      expect(screen.getByTestId(`ticket-item-${claimed.id}`)).toBeInTheDocument();
      await flush(3000);
      expect(screen.queryByTestId("ticket-list-refresh-error")).not.toBeInTheDocument();
      await flush(3000);
      expect(within(screen.getByTestId(`ticket-item-${claimed.id}`)).getByTestId("ticket-status")).toHaveTextContent("In Progress");
    });

    it("hands the Owner to sign-in when a refetch comes back unauthenticated", async () => {
      const onUnauthenticated = vi.fn();
      stubLists([list(claimed), () => Promise.resolve(jsonResponse({ error: { code: "unauthenticated", message: "sign-in required" } }, 401))]);
      render(<TicketList onUnauthenticated={onUnauthenticated} />);
      await flush();
      await flush(3000);
      expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    });

    it("refetches with the same filters the list was loaded with", async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        if (String(input) !== "/api/tickets?badgeId=b1") throw new Error(`unexpected fetch ${String(input)}`);
        return Promise.resolve(jsonResponse({ tickets: [claimed] }));
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<TicketList badgeIds={["b1"]} onUnauthenticated={() => {}} />);
      await flush();
      await flush(6000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("reordering", () => {
    const ready = (id: string, title: string) => ({ ...TICKET_B, id, title, status: "Ready" });
    const R1 = ready("33333333-3333-4333-8333-333333333333", "Ready first");
    const R2 = ready("44444444-4444-4444-8444-444444444444", "Ready second");
    const row = (ticket: { id: string }) => screen.getByTestId(`ticket-item-${ticket.id}`);
    const listedIds = () => screen.getAllByTestId(/^ticket-item-/).map((item) => item.getAttribute("data-testid"));

    it("sends Move up relative to the same-Status neighbour and renders Galley's refetched order", async () => {
      const routes = stubFetch({
        "GET /api/tickets": jsonResponse({ tickets: [R1, TICKET_A, R2] }),
        [`POST /api/tickets/${R2.id}/position`]: jsonResponse(R2),
      });
      render(<TicketList onUnauthenticated={() => {}} />);
      await screen.findByTestId(`ticket-item-${R2.id}`);
      expect(within(row(R1)).getByTestId("ticket-reorder-up")).toHaveAccessibleDescription("Already first in Ready");
      expect(within(row(TICKET_A)).getByTestId("ticket-reorder-down")).toHaveAccessibleDescription("Already last in Backlog");

      routes.set("GET /api/tickets", jsonResponse({ tickets: [R2, TICKET_A, R1] }));
      await act(async () => { fireEvent.click(within(row(R2)).getByRole("button", { name: "Move up" })); });

      expect(fetch).toHaveBeenCalledWith(`/api/tickets/${R2.id}/position`, expect.objectContaining({ method: "POST", body: JSON.stringify({ before: R1.id }) }));
      await vi.waitFor(() => expect(listedIds()).toEqual([`ticket-item-${R2.id}`, `ticket-item-${TICKET_A.id}`, `ticket-item-${R1.id}`]));
      await vi.waitFor(() => expect(within(row(R2)).getByTestId("ticket-reorder-down")).toHaveFocus());
    });

    it("sends Move down as after the next same-Status neighbour and keeps focus on Move down", async () => {
      const R3 = ready("55555555-5555-4555-8555-555555555555", "Ready third");
      const routes = stubFetch({
        "GET /api/tickets": jsonResponse({ tickets: [R1, R2, R3] }),
        [`POST /api/tickets/${R1.id}/position`]: jsonResponse(R1),
      });
      render(<TicketList onUnauthenticated={() => {}} />);
      await screen.findByTestId(`ticket-item-${R1.id}`);
      routes.set("GET /api/tickets", jsonResponse({ tickets: [R2, R1, R3] }));
      await act(async () => { fireEvent.click(within(row(R1)).getByRole("button", { name: "Move down" })); });

      expect(fetch).toHaveBeenCalledWith(`/api/tickets/${R1.id}/position`, expect.objectContaining({ body: JSON.stringify({ after: R2.id }) }));
      await vi.waitFor(() => expect(listedIds()).toEqual([`ticket-item-${R2.id}`, `ticket-item-${R1.id}`, `ticket-item-${R3.id}`]));
      await vi.waitFor(() => expect(within(row(R1)).getByTestId("ticket-reorder-down")).toHaveFocus());
    });

    it("shows Galley's rejection verbatim and refetches the order", async () => {
      const routes = stubFetch({
        "GET /api/tickets": jsonResponse({ tickets: [R1, R2] }),
        [`POST /api/tickets/${R2.id}/position`]: jsonResponse({ error: { code: "reorder_anchor_invalid", message: "Galley anchor reason" } }, 400),
      });
      render(<TicketList onUnauthenticated={() => {}} />);
      await screen.findByTestId(`ticket-item-${R2.id}`);
      routes.set("GET /api/tickets", jsonResponse({ tickets: [R2, R1] }));
      await act(async () => { fireEvent.click(within(row(R2)).getByRole("button", { name: "Move up" })); });

      expect(await screen.findByTestId("ticket-list-reorder-error")).toHaveTextContent("Galley anchor reason");
      await vi.waitFor(() => expect(listedIds()).toEqual([`ticket-item-${R2.id}`, `ticket-item-${R1.id}`]));
    });
  });

  it("renders every Ticket Galley returns, in the order returned", async () => {
    stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [TICKET_A, TICKET_B] }) });

    renderTicketList();

    const items = await screen.findAllByTestId(/^ticket-item-/);
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("data-testid", `ticket-item-${TICKET_A.id}`);
    expect(items[1]).toHaveAttribute("data-testid", `ticket-item-${TICKET_B.id}`);
    expect(screen.getAllByTestId("ticket-title")[0]).toHaveTextContent(TICKET_A.title);
    expect(screen.getAllByTestId("ticket-status")[0]).toHaveTextContent("Backlog");
  });

  it("renders Badge names with an accessible label", async () => {
    const ticket = { ...TICKET_A, badges: [{ id: "badge-1", name: "Urgent" }] };
    stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [ticket] }) });

    renderTicketList();

    const item = await screen.findByTestId(`ticket-item-${ticket.id}`);
    expect(within(item).getByTestId("ticket-status")).toHaveTextContent("Backlog");
    expect(within(item).getByTestId("ticket-badges")).toHaveTextContent("Urgent");
    expect(within(item).getByLabelText("Badges: Urgent")).toBeInTheDocument();
  });

  it("links each Ticket's title to its full-page detail route", async () => {
    stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [TICKET_A] }) });

    renderTicketList();

    expect(await screen.findByTestId("ticket-title")).toHaveAttribute("href", `/tickets/${TICKET_A.id}`);
  });

  it("refocuses the closed modal's Ticket after a refresh when focus was lost", async () => {
    stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [TICKET_A, TICKET_B] }) });
    const { rerender } = renderTicketList();
    await screen.findAllByTestId("ticket-title");

    rerender(<OrderLog refreshKey={1} focusTicketId={TICKET_B.id} />);

    await vi.waitFor(() => expect(screen.getAllByTestId("ticket-title")[1]).toHaveFocus());
  });

  it("does not take focus from where the Owner moved it before a late refresh settles", async () => {
    stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [TICKET_A, TICKET_B] }) });
    const { rerender } = renderTicketList();
    await screen.findAllByTestId("ticket-title");
    screen.getByTestId("new-order-input").focus();

    rerender(<OrderLog refreshKey={1} focusTicketId={TICKET_B.id} />);
    await act(async () => {});

    expect(screen.getByTestId("new-order-input")).toHaveFocus();
  });

  it("keeps the last loaded Tickets and reports a failed refresh separately", async () => {
    const api = stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [TICKET_A] }) });
    const { rerender } = renderTicketList();
    await screen.findByTestId("ticket-title");
    api.set("GET /api/tickets", jsonResponse({ error: "boom" }, 503, "Service Unavailable"));

    rerender(<OrderLog refreshKey={1} />);

    expect(await screen.findByTestId("ticket-list-refresh-error-message")).toHaveTextContent("503");
    expect(screen.getByTestId("ticket-title")).toHaveTextContent(TICKET_A.title);
    expect(screen.queryByTestId("ticket-list-error")).not.toBeInTheDocument();
  });

  it("renders an explicit error state when the initial fetch fails", async () => {
    stubFetch({ "GET /api/tickets": jsonResponse({ error: "boom" }, 503, "Service Unavailable") });

    renderTicketList();

    expect(await screen.findByTestId("ticket-list-error")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-list-error-message")).toHaveTextContent("503");
  });

  it("disables the capture button until a non-blank title is entered", async () => {
    stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [] }) });

    renderTicketList();
    await screen.findByTestId("ticket-list-empty");

    openCaptureModal();
    const submit = screen.getByTestId("ticket-capture-submit");
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: "   " } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: "Write the report" } });
    expect(submit).not.toBeDisabled();
  });

  it("captures a Ticket, clears the input, and shows the refreshed list with no manual reload", async () => {
    const routes = stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [] }) });

    renderTicketList();
    await screen.findByTestId("ticket-list-empty");

    routes.set("POST /api/tickets", jsonResponse(TICKET_B, 201));
    routes.set("GET /api/tickets", jsonResponse({ tickets: [TICKET_B] }));

    openCaptureModal();
    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: TICKET_B.title } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    expect(await screen.findByTestId(`ticket-item-${TICKET_B.id}`)).toHaveTextContent(TICKET_B.title);
    expect(screen.queryByTestId("ticket-list-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-order-input")).toHaveValue("");
    expect(screen.queryByTestId("ticket-capture-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-order-button")).toHaveFocus();
  });

  it("ignores an older list response after a capture re-fetch completes", async () => {
    let resolveFirst!: (response: MockResponse) => void;
    const firstList = new Promise<MockResponse>((resolve) => { resolveFirst = resolve; });
    let listRequests = 0;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse(TICKET_B, 201));
      listRequests += 1;
      return listRequests === 1 ? firstList : Promise.resolve(jsonResponse({ tickets: [TICKET_B] }));
    }));

    renderTicketList();
    expect(screen.getByTestId("ticket-list-loading")).toBeInTheDocument();
    openCaptureModal();
    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: TICKET_B.title } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    expect(await screen.findByTestId(`ticket-item-${TICKET_B.id}`)).toBeInTheDocument();
    await act(async () => { resolveFirst(jsonResponse({ tickets: [] })); });

    expect(screen.getByTestId(`ticket-item-${TICKET_B.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-list-empty")).not.toBeInTheDocument();
  });

  it("defaults the Template selector to Basic and submits it on capture (issue #59)", async () => {
    const routes = stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [] }) });

    renderTicketList();
    await screen.findByTestId("ticket-list-empty");

    openCaptureModal();
    expect(screen.getByTestId("ticket-template-select")).toHaveValue("Basic");

    routes.set("POST /api/tickets", jsonResponse(TICKET_B, 201));
    routes.set("GET /api/tickets", jsonResponse({ tickets: [TICKET_B] }));

    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: TICKET_B.title } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    await screen.findByTestId(`ticket-item-${TICKET_B.id}`);
    expect(fetch).toHaveBeenCalledWith(
      "/api/tickets",
      expect.objectContaining({ body: JSON.stringify({ title: TICKET_B.title, template: "Basic" }) }),
    );
  });

  it("submits the Owner's chosen Coding Template on capture (issue #59)", async () => {
    const routes = stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [] }) });

    renderTicketList();
    await screen.findByTestId("ticket-list-empty");

    routes.set("POST /api/tickets", jsonResponse(CODING_TICKET, 201));
    routes.set("GET /api/tickets", jsonResponse({ tickets: [CODING_TICKET] }));

    openCaptureModal();
    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: CODING_TICKET.title } });
    fireEvent.change(screen.getByTestId("ticket-template-select"), { target: { value: "Coding" } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    expect(await screen.findByTestId(`ticket-item-${CODING_TICKET.id}`)).toHaveTextContent(CODING_TICKET.title);
    expect(fetch).toHaveBeenCalledWith(
      "/api/tickets",
      expect.objectContaining({ body: JSON.stringify({ title: CODING_TICKET.title, template: "Coding" }) }),
    );
  });

  it("shows Galley's own validation message and leaves the list unchanged when capture is rejected", async () => {
    const routes = stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [] }) });

    renderTicketList();
    await screen.findByTestId("ticket-list-empty");

    routes.set(
      "POST /api/tickets",
      jsonResponse({ error: { code: "invalid_request", message: '"title" must be a non-empty string' } }, 400),
    );

    openCaptureModal();
    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: "   x   " } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    expect(await screen.findByTestId("ticket-capture-error")).toHaveTextContent(
      "must be a non-empty string",
    );
    // No re-fetch was triggered by the failed capture -- the list stays
    // exactly as it was (still empty), not merely "still passes because
    // it happens to match."
    expect(screen.getByTestId("ticket-list-empty")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-title-input")).toHaveValue("   x   ");
  });
});
