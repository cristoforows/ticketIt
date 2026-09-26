import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  template: "Basic",
  completionCondition: "humanAcceptance",
  assigneeType: "",
  goal: "",
  context: "",
  successCriteria: "",
  constraints: "",
  repository: "",
  createdAt: "2026-09-22T10:01:00Z",
  updatedAt: "2026-09-22T10:01:00Z",
};
const TICKET_B = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "First captured",
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
const CODING_TICKET = {
  ...TICKET_B,
  id: "66666666-6666-4666-8666-666666666666",
  title: "Coding capture",
  template: "Coding",
  completionCondition: "reviewedPrMerge",
};

function renderTicketList() {
  return render(<TicketList onUnauthenticated={() => {}} />);
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

  it("links each Ticket's title to its full-page detail route", async () => {
    stubFetch({ "GET /api/tickets": jsonResponse({ tickets: [TICKET_A] }) });

    renderTicketList();

    expect(await screen.findByTestId("ticket-title")).toHaveAttribute("href", `/tickets/${TICKET_A.id}`);
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

    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: TICKET_B.title } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    expect(await screen.findByTestId(`ticket-item-${TICKET_B.id}`)).toHaveTextContent(TICKET_B.title);
    expect(screen.queryByTestId("ticket-list-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-title-input")).toHaveValue("");
    expect(screen.queryByTestId("ticket-capture-error")).not.toBeInTheDocument();
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

    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: "   x   " } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    expect(await screen.findByTestId("ticket-capture-error")).toHaveTextContent(
      "must be a non-empty string",
    );
    // No re-fetch was triggered by the failed capture -- the list stays
    // exactly as it was (still empty), not merely "still passes because
    // it happens to match."
    expect(screen.getByTestId("ticket-list-empty")).toBeInTheDocument();
  });
});
