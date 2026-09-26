import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import { navigate } from "./router";

type MockResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

function jsonResponse(body: unknown, status = 200, statusText = ""): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  };
}

const SAMPLE_STATUS = {
  application: "galley",
  status: "ok",
  version: "dev",
  environment: "development",
  startedAt: "2026-09-21T10:00:00Z",
};

/** Routes the stubbed global fetch by path, so tests can control the
 * session check independently of StatusView's own /api/status fetch
 * (rendered inside AppShell once signed in). */
function stubFetchByPath(routes: Record<string, MockResponse>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const response = routes[`${init?.method ?? "GET"} ${path}`] ?? routes[path];
      if (!response) {
        throw new Error(`unexpected fetch to ${path} in this test`);
      }
      return Promise.resolve(response);
    }),
  );
}

const TICKET = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "Write the report",
  status: "InReview",
  template: "Basic",
  completionCondition: "humanAcceptance",
  assigneeType: "owner",
  goal: "Original goal",
  context: "",
  successCriteria: "",
  constraints: "",
  repository: "",
  createdAt: "2026-09-22T10:00:00Z",
  updatedAt: "2026-09-22T10:00:00Z",
};

const SIGNED_IN = jsonResponse({ owner: { id: 1, login: "ticketit-test-owner" } });
const UNAUTHENTICATED = jsonResponse({ error: { code: "unauthenticated", message: "sign-in required" } }, 401);

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("shows a loading state before the session check settles", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise(() => {})),
    );

    render(<App />);

    expect(screen.getByRole("heading", { name: "Swiftlet" })).toBeInTheDocument();
    expect(screen.getByTestId("session-loading")).toBeInTheDocument();
  });

  it("renders the sign-in page when there is no session (401)", async () => {
    stubFetchByPath({ "/api/session": jsonResponse({ error: { code: "unauthenticated", message: "sign-in required" } }, 401) });

    render(<App />);

    expect(await screen.findByTestId("sign-in-page")).toBeInTheDocument();
    expect(screen.getByTestId("sign-in-with-github")).toHaveAttribute("href", "/api/auth/github/start");
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
  });

  it("renders an explicit error state when the session check fails for a reason other than 401", async () => {
    stubFetchByPath({ "/api/session": jsonResponse({ error: "boom" }, 503, "Service Unavailable") });

    render(<App />);

    expect(await screen.findByTestId("session-error")).toBeInTheDocument();
    expect(screen.getByTestId("session-error-message")).toHaveTextContent("503");
    expect(screen.queryByTestId("sign-in-page")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
  });

  it("renders the authenticated shell showing the signed-in Owner when a session exists", async () => {
    stubFetchByPath({
      "/api/session": jsonResponse({ owner: { id: 1, login: "ticketit-test-owner" } }),
      "/api/status": jsonResponse(SAMPLE_STATUS),
      "/api/tickets": jsonResponse({ tickets: [] }),
    });

    render(<App />);

    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByTestId("signed-in-owner")).toHaveTextContent("ticketit-test-owner");
    expect(screen.queryByTestId("sign-in-page")).not.toBeInTheDocument();
  });

  it("returns to sign-in when the Ticket list GET returns 401", async () => {
    stubFetchByPath({ "/api/session": SIGNED_IN, "/api/status": jsonResponse(SAMPLE_STATUS), "/api/tickets": UNAUTHENTICATED });

    render(<App />);

    expect(await screen.findByTestId("sign-in-page")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-list-error")).not.toBeInTheDocument();
  });

  it("returns to sign-in when Ticket capture returns 401", async () => {
    stubFetchByPath({
      "/api/session": SIGNED_IN,
      "/api/status": jsonResponse(SAMPLE_STATUS),
      "GET /api/tickets": jsonResponse({ tickets: [] }),
      "POST /api/tickets": UNAUTHENTICATED,
    });
    render(<App />);
    await screen.findByTestId("ticket-list-empty");

    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: "New ticket" } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    expect(await screen.findByTestId("sign-in-page")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-capture-error")).not.toBeInTheDocument();
  });

  it("returns to sign-in when the post-capture list re-fetch returns 401", async () => {
    let listRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session") return Promise.resolve(SIGNED_IN);
      if (path === "/api/status") return Promise.resolve(jsonResponse(SAMPLE_STATUS));
      if (path === "/api/tickets" && init?.method === "POST") return Promise.resolve(jsonResponse(TICKET, 201));
      if (path === "/api/tickets") {
        listRequests += 1;
        return Promise.resolve(listRequests === 1 ? jsonResponse({ tickets: [] }) : UNAUTHENTICATED);
      }
      throw new Error(`unexpected fetch ${path}`);
    }));
    render(<App />);
    await screen.findByTestId("ticket-list-empty");

    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: TICKET.title } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    expect(await screen.findByTestId("sign-in-page")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-list-error")).not.toBeInTheDocument();
  });

  it("returns to sign-in on a delayed 401 from an older list GET", async () => {
    let resolveFirst!: (response: MockResponse) => void;
    const firstList = new Promise<MockResponse>((resolve) => { resolveFirst = resolve; });
    let listRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session") return Promise.resolve(SIGNED_IN);
      if (path === "/api/status") return Promise.resolve(jsonResponse(SAMPLE_STATUS));
      if (path === "/api/tickets" && init?.method === "POST") return Promise.resolve(jsonResponse(TICKET, 201));
      if (path === "/api/tickets") {
        listRequests += 1;
        return listRequests === 1 ? firstList : Promise.resolve(jsonResponse({ tickets: [TICKET] }));
      }
      throw new Error(`unexpected fetch ${path}`);
    }));
    render(<App />);
    await screen.findByTestId("ticket-list-loading");

    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: TICKET.title } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));
    await screen.findByTestId(`ticket-item-${TICKET.id}`);
    await act(async () => { resolveFirst(UNAUTHENTICATED); });

    expect(screen.getByTestId("sign-in-page")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
  });

  it("returns to sign-in when the Ticket detail GET returns 401", async () => {
    window.history.pushState({}, "", `/tickets/${TICKET.id}`);
    stubFetchByPath({ "/api/session": SIGNED_IN, [`/api/tickets/${TICKET.id}`]: UNAUTHENTICATED });

    render(<App />);

    expect(await screen.findByTestId("sign-in-page")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-error")).not.toBeInTheDocument();
  });

  it.each([
    { name: "edit", method: "PATCH", path: "", button: "ticket-detail-save-button" },
    { name: "status", method: "POST", path: "/status", button: "ticket-detail-status-button-InProgress" },
    { name: "accept", method: "POST", path: "/accept", button: "ticket-detail-accept-button" },
    { name: "assign", method: "PUT", path: "/assignee", button: "ticket-detail-assign-button" },
    { name: "unassign", method: "DELETE", path: "/assignee", button: "ticket-detail-unassign-button" },
  ])("returns to sign-in when the Ticket $name command returns 401", async ({ name, method, path, button }) => {
    window.history.pushState({}, "", `/tickets/${TICKET.id}`);
    stubFetchByPath({
      "/api/session": SIGNED_IN,
      [`GET /api/tickets/${TICKET.id}`]: jsonResponse(name === "assign" ? { ...TICKET, assigneeType: "" } : TICKET),
      [`${method} /api/tickets/${TICKET.id}${path}`]: UNAUTHENTICATED,
    });
    render(<App />);
    await screen.findByTestId("ticket-detail-title");

    if (name === "edit") {
      fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
      fireEvent.change(screen.getByTestId("ticket-detail-textarea-goal"), { target: { value: "Updated goal" } });
    }
    fireEvent.click(screen.getByTestId(button));

    expect(await screen.findByTestId("sign-in-page")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-save-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-action-error")).not.toBeInTheDocument();
  });

  it("hides the previous Ticket immediately on navigation to a new detail URL", async () => {
    const other = { ...TICKET, id: "55555555-5555-4555-8555-555555555555", title: "Another ticket" };
    let resolveOther!: (response: MockResponse) => void;
    const pendingOther = new Promise<MockResponse>((resolve) => { resolveOther = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/session") return Promise.resolve(SIGNED_IN);
      if (path === `/api/tickets/${TICKET.id}`) return Promise.resolve(jsonResponse(TICKET));
      if (path === `/api/tickets/${other.id}`) return pendingOther;
      throw new Error(`unexpected fetch ${path}`);
    }));
    window.history.pushState({}, "", `/tickets/${TICKET.id}`);
    render(<App />);
    expect(await screen.findByTestId("ticket-detail-title")).toHaveTextContent(TICKET.title);

    act(() => { navigate(`/tickets/${other.id}`); });

    expect(screen.getByTestId("ticket-detail-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-title")).not.toBeInTheDocument();
    await act(async () => { resolveOther(jsonResponse(other)); });
    expect(screen.getByTestId("ticket-detail-title")).toHaveTextContent(other.title);
  });
});
