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
  });

  it("shows which Owner is signed in", () => {
    stubFetchByPath({ "/api/status": jsonResponse({ ok: true }), "/api/tickets": EMPTY_TICKET_LIST });

    render(<AppShell owner={OWNER} onSignedOut={() => {}} />);

    expect(screen.getByTestId("signed-in-owner")).toHaveTextContent(OWNER.login);
  });

  it("revokes the session through Galley and calls onSignedOut", async () => {
    stubFetchByPath({
      "/api/status": jsonResponse({ ok: true }),
      "/api/tickets": EMPTY_TICKET_LIST,
      "/api/session": jsonResponse(null, 204),
    });
    const onSignedOut = vi.fn();

    render(<AppShell owner={OWNER} onSignedOut={onSignedOut} />);
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

    render(<AppShell owner={OWNER} onSignedOut={onSignedOut} />);
    fireEvent.click(screen.getByTestId("sign-out-button"));

    expect(await screen.findByTestId("sign-out-error")).toHaveTextContent("503");
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
  });

  it("treats a 401 on sign-out as already signed out", async () => {
    stubFetchByPath({
      "/api/status": jsonResponse({ ok: true }),
      "/api/tickets": EMPTY_TICKET_LIST,
      "/api/session": jsonResponse({ error: { code: "unauthenticated", message: "sign-in required" } }, 401),
    });
    const onSignedOut = vi.fn();

    render(<AppShell owner={OWNER} onSignedOut={onSignedOut} />);
    fireEvent.click(screen.getByTestId("sign-out-button"));

    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledOnce());
  });
});
