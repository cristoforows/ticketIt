import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import App from "./App";

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

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
    });

    render(<App />);

    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByTestId("signed-in-owner")).toHaveTextContent("ticketit-test-owner");
    expect(screen.queryByTestId("sign-in-page")).not.toBeInTheDocument();
  });
});
