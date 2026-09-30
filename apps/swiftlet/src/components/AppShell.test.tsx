import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppShell } from "./AppShell";

const OWNER = { id: 1, login: "ticketit-test-owner" };

type MockResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

function jsonResponse(body: unknown, status = 200, statusText = ""): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  };
}

/** AppShell also mounts StatusView (/api/status) and TicketList
 * (/api/tickets) — every test here stubs both alongside whatever
 * /api/session response it's exercising, so neither's own request
 * surfaces as noise. */
function stubFetchByPath(routes: Record<string, MockResponse>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      const response = routes[path];
      if (!response) {
        throw new Error(`unexpected fetch to ${path} in this test`);
      }
      return Promise.resolve(response);
    }),
  );
}

const EMPTY_TICKET_LIST = jsonResponse({ tickets: [] });

describe("AppShell", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("shows which Owner is signed in", () => {
    stubFetchByPath({ "/api/status": jsonResponse({ ok: true }), "/api/tickets": EMPTY_TICKET_LIST });

    render(<AppShell owner={OWNER} onSignedOut={() => {}} onUnauthenticated={() => {}} />);

    expect(screen.getByTestId("signed-in-owner")).toHaveTextContent(OWNER.login);
  });

  it("revokes the session through Galley and calls onSignedOut", async () => {
    stubFetchByPath({
      "/api/status": jsonResponse({ ok: true }),
      "/api/tickets": EMPTY_TICKET_LIST,
      "/api/session": jsonResponse(null, 204),
    });
    const onSignedOut = vi.fn();

    render(<AppShell owner={OWNER} onSignedOut={onSignedOut} onUnauthenticated={() => {}} />);
    fireEvent.click(screen.getByTestId("sign-out-button"));

    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledOnce());
  });

  it("shows an inline error and stays in the shell when sign-out fails for a reason other than 401", async () => {
    stubFetchByPath({
      "/api/status": jsonResponse({ ok: true }),
      "/api/tickets": EMPTY_TICKET_LIST,
      "/api/session": jsonResponse({ error: "boom" }, 503, "Service Unavailable"),
    });
    const onSignedOut = vi.fn();

    render(<AppShell owner={OWNER} onSignedOut={onSignedOut} onUnauthenticated={() => {}} />);
    fireEvent.click(screen.getByTestId("sign-out-button"));

    expect(await screen.findByTestId("sign-out-error")).toHaveTextContent("503");
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
  });

  it("renders the Ticket detail page instead of the Backlog list when the route is /tickets/:id", async () => {
    window.history.pushState({}, "", "/tickets/some-ticket-id");
    stubFetchByPath({
      "/api/tickets/some-ticket-id": jsonResponse({
        id: "some-ticket-id",
        title: "Routed ticket",
        status: "Backlog",
        allowedActions: { statusChanges: ["Ready", "Blocked"], accept: { available: false, reason: { code: "invalid_transition", message: "Accept requires In Review" } } },
        template: "Basic",
        completionCondition: "humanAcceptance",
        assigneeType: "",
        assigneeAgent: null,
        goal: "",
        context: "",
        successCriteria: "",
        constraints: "",
        repository: "",
        createdAt: "2026-09-22T10:00:00Z",
        updatedAt: "2026-09-22T10:00:00Z",
        badges: [],
        archivedAt: null,
      }),
    });

    render(<AppShell owner={OWNER} onSignedOut={() => {}} onUnauthenticated={() => {}} />);

    expect(await screen.findByTestId("ticket-detail-page")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-list")).not.toBeInTheDocument();
  });

  it("switches between List and Board in the same signed-in shell and loads /board directly", async () => {
    window.history.pushState({}, "", "/board");
    stubFetchByPath({ "/api/status": jsonResponse({ ok: true }), "/api/tickets": EMPTY_TICKET_LIST });

    render(<AppShell owner={OWNER} onSignedOut={() => {}} onUnauthenticated={() => {}} />);

    expect(await screen.findAllByText("— no orders —")).toHaveLength(6);
    expect(screen.queryByTestId("ticket-capture-form")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("link", { name: "List" }));
    expect(await screen.findByTestId("ticket-list-empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "List" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("link", { name: "Board" }));
    expect(await screen.findAllByText("— no orders —")).toHaveLength(6);
    expect(screen.getByTestId("signed-in-owner")).toHaveTextContent(OWNER.login);
    expect(window.location.pathname).toBe("/board");
  });

  it("links to the Agents page from the shell and loads /agents directly", async () => {
    stubFetchByPath({ "/api/status": jsonResponse({ ok: true }), "/api/tickets": EMPTY_TICKET_LIST, "/api/agents": jsonResponse({ agents: [] }) });

    render(<AppShell owner={OWNER} onSignedOut={() => {}} onUnauthenticated={() => {}} />);
    fireEvent.click(screen.getByRole("link", { name: "Agents" }));

    expect(await screen.findByTestId("agent-list-empty")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/agents");
    expect(screen.getByRole("navigation", { name: "Settings" })).toContainElement(screen.getByRole("link", { name: "Agents" }));
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("ticket-capture-form")).not.toBeInTheDocument();
  });

  it("treats a 401 on sign-out as already signed out", async () => {
    stubFetchByPath({
      "/api/status": jsonResponse({ ok: true }),
      "/api/tickets": EMPTY_TICKET_LIST,
      "/api/session": jsonResponse({ error: { code: "unauthenticated", message: "sign-in required" } }, 401),
    });
    const onSignedOut = vi.fn();

    render(<AppShell owner={OWNER} onSignedOut={onSignedOut} onUnauthenticated={() => {}} />);
    fireEvent.click(screen.getByTestId("sign-out-button"));

    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledOnce());
  });
});
