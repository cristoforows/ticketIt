import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { RUNNER_HEALTH_CHANGED } from "../api/runner";
import { RunnerHealthPill } from "./RunnerHealthPill";

type MockResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

function jsonResponse(body: unknown, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body };
}

const NOT_PAIRED = { state: "not_paired", checkedAt: "2026-10-01T12:00:00Z", pairedAt: null, registeredAt: null, lastSeenAt: null, michelinVersion: null, hostname: null };
const CONNECTED = { state: "connected", checkedAt: "2026-10-01T12:00:10Z", pairedAt: "2026-10-01T11:00:00Z", registeredAt: "2026-10-01T11:00:00Z", lastSeenAt: "2026-10-01T12:00:05Z", michelinVersion: "0.1.0", hostname: "runner-host" };
const DISCONNECTED = { ...CONNECTED, state: "disconnected", checkedAt: "2026-10-01T12:02:05Z" };

function stubHealth(responses: MockResponse[]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input) !== "/api/runner-health") throw new Error(`unexpected fetch to ${String(input)}`);
    return Promise.resolve(responses.length > 1 ? responses.shift()! : responses[0]!);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe("RunnerHealthPill", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows each state Galley reports, with last-seen only when disconnected", async () => {
    stubHealth([jsonResponse(NOT_PAIRED), jsonResponse(CONNECTED), jsonResponse(DISCONNECTED)]);
    render(<RunnerHealthPill onUnauthenticated={() => {}} />);
    await flush();
    const pill = screen.getByTestId("runner-health-pill");
    expect(pill).toHaveAttribute("data-health", "not_paired");
    expect(screen.getByRole("status")).toHaveTextContent("Runner not paired");
    expect(screen.queryByTestId("runner-health-last-seen")).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(pill).toHaveAttribute("data-health", "connected");
    expect(screen.getByRole("status")).toHaveTextContent("Runner connected");
    expect(screen.queryByTestId("runner-health-last-seen")).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(pill).toHaveAttribute("data-health", "disconnected");
    expect(screen.getByRole("status")).toHaveTextContent("Runner disconnected");
    expect(screen.getByTestId("runner-health-last-seen")).toHaveTextContent("last seen 2 min ago");
  });

  it("refreshes every 10 seconds, and at once when pairing changes", async () => {
    const fetchMock = stubHealth([jsonResponse(CONNECTED)]);
    render(<RunnerHealthPill onUnauthenticated={() => {}} />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new CustomEvent(RUNNER_HEALTH_CHANGED)); await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops polling when unmounted", async () => {
    const fetchMock = stubHealth([jsonResponse(CONNECTED)]);
    const { unmount } = render(<RunnerHealthPill onUnauthenticated={() => {}} />);
    await flush();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says the status is unavailable when Galley fails, and recovers", async () => {
    stubHealth([jsonResponse({ error: { code: "database_unavailable", message: "x" } }, 503), jsonResponse(CONNECTED)]);
    render(<RunnerHealthPill onUnauthenticated={() => {}} />);
    await flush();
    expect(screen.getByTestId("runner-health-pill")).toHaveAttribute("data-health", "unknown");
    expect(screen.getByRole("status")).toHaveTextContent("Runner status unavailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("status")).toHaveTextContent("Runner connected");
  });

  it("returns to sign-in on a 401", async () => {
    stubHealth([jsonResponse({ error: { code: "unauthenticated", message: "sign-in required" } }, 401)]);
    const onUnauthenticated = vi.fn();
    render(<RunnerHealthPill onUnauthenticated={onUnauthenticated} />);
    await flush();
    expect(onUnauthenticated).toHaveBeenCalled();
  });

  it("uses the order-rail tokens for each state and no animation", async () => {
    stubHealth([jsonResponse(CONNECTED)]);
    render(<RunnerHealthPill onUnauthenticated={() => {}} />);
    await flush();
    const pill = screen.getByTestId("runner-health-pill");
    expect(pill.className).toContain("text-status-done-text");
    expect(pill.className).toContain("rounded-pill");
    expect(pill.outerHTML).not.toMatch(/animate-|transition/);
  });
});
