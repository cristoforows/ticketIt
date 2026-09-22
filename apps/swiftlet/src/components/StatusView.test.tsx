import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusView } from "./StatusView";

const SAMPLE_STATUS = {
  application: "galley",
  status: "ok",
  version: "dev",
  environment: "development",
  startedAt: "2026-09-21T10:00:00Z",
};

type MockResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

function jsonResponse(body: unknown, status = 200, statusText = ""): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  };
}

function stubFetchResolved(response: MockResponse) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

function stubFetchRejected(error: Error) {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
}

describe("StatusView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders every field from a successful Galley response, and only those values", async () => {
    stubFetchResolved(jsonResponse(SAMPLE_STATUS));

    render(<StatusView />);

    expect(await screen.findByTestId("status-success")).toBeInTheDocument();
    expect(screen.getByTestId("status-application")).toHaveTextContent(
      SAMPLE_STATUS.application,
    );
    expect(screen.getByTestId("status-status")).toHaveTextContent(SAMPLE_STATUS.status);
    // BREAK-SWIFTLET-TEST: wrong expected value
    expect(screen.getByTestId("status-version")).toHaveTextContent("not-the-real-version");
    expect(screen.getByTestId("status-environment")).toHaveTextContent(
      SAMPLE_STATUS.environment,
    );
    expect(screen.getByTestId("status-started-at")).toHaveTextContent(
      SAMPLE_STATUS.startedAt,
    );
    expect(screen.queryByTestId("status-error")).not.toBeInTheDocument();
  });

  it("renders an explicit error state for a non-2xx response, with no field values", async () => {
    stubFetchResolved(jsonResponse({ error: "boom" }, 503, "Service Unavailable"));

    render(<StatusView />);

    expect(await screen.findByTestId("status-error")).toBeInTheDocument();
    expect(screen.getByTestId("status-error-message")).toHaveTextContent("503");
    expect(screen.queryByTestId("status-success")).not.toBeInTheDocument();
  });

  it("renders an explicit error state when Galley is unreachable", async () => {
    stubFetchRejected(new TypeError("Failed to fetch"));

    render(<StatusView />);

    expect(await screen.findByTestId("status-error")).toBeInTheDocument();
    expect(screen.getByTestId("status-error-message")).toHaveTextContent("unreachable");
    expect(screen.queryByTestId("status-success")).not.toBeInTheDocument();
  });

  it("renders an explicit error state for a malformed (schema-mismatched) response", async () => {
    stubFetchResolved(jsonResponse({ application: "galley" }, 200));

    render(<StatusView />);

    expect(await screen.findByTestId("status-error")).toBeInTheDocument();
    expect(screen.getByTestId("status-error-message")).toHaveTextContent("status");
    expect(screen.queryByTestId("status-success")).not.toBeInTheDocument();
  });

  it("shows a loading state before the fetch settles", () => {
    let settle: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((resolve) => {
          settle = () => resolve(jsonResponse(SAMPLE_STATUS));
        }),
      ),
    );

    render(<StatusView />);

    expect(screen.getByTestId("status-loading")).toBeInTheDocument();

    // Resolve so no dangling promise/timer leaks past this test.
    settle?.();
  });
});
