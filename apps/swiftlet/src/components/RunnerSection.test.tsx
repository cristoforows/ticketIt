import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RunnerSection } from "./RunnerSection";

type MockResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

function jsonResponse(body: unknown, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body };
}

const TOKEN_A = `tir_${"A".repeat(43)}`;
const TOKEN_B = `tir_${"B".repeat(43)}`;
const NOT_PAIRED = { state: "not_paired", checkedAt: "2026-10-01T12:00:00Z", pairedAt: null, registeredAt: null, lastSeenAt: null, michelinVersion: null, hostname: null };
const PAIRED = { ...NOT_PAIRED, state: "disconnected", pairedAt: "2026-10-01T12:00:00Z" };
const CONNECTED = { ...PAIRED, state: "connected", registeredAt: "2026-10-01T12:00:02Z", lastSeenAt: "2026-10-01T12:00:02Z", michelinVersion: "0.1.0", hostname: "runner-host" };

function stubGalley() {
  let health: object = NOT_PAIRED;
  const tokens = [TOKEN_A, TOKEN_B];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    if (key === "GET /api/runner-health") return Promise.resolve(jsonResponse(health));
    if (key === "POST /api/runner-credential") {
      health = PAIRED;
      return Promise.resolve(jsonResponse({ token: tokens.shift(), health: PAIRED }, 201));
    }
    if (key === "DELETE /api/runner-credential") {
      health = NOT_PAIRED;
      return Promise.resolve({ ok: true, status: 204, statusText: "", json: async () => { throw new Error("no body"); } });
    }
    throw new Error(`unexpected fetch to ${key}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, setHealth: (next: object) => { health = next; } };
}

function renderSection() {
  const onFailed = vi.fn((error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback));
  render(<RunnerSection onUnauthenticated={() => {}} onFailed={onFailed} />);
  return onFailed;
}

describe("RunnerSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pairs, shows the credential once with the .env instruction, and forgets it on Done", async () => {
    const { fetchMock } = stubGalley();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderSection();

    expect(await screen.findByTestId("runner-not-paired")).toHaveTextContent("No runner is paired");
    fireEvent.click(screen.getByRole("button", { name: "Pair runner" }));

    const token = await screen.findByLabelText("Runner credential");
    expect(token).toHaveValue(TOKEN_A);
    expect(token).toHaveAttribute("readonly");
    await waitFor(() => expect(token).toHaveFocus());
    expect(screen.getByTestId("runner-credential")).toHaveTextContent("MICHELIN_RUNNER_TOKEN");
    expect(screen.getByTestId("runner-credential")).toHaveTextContent("chmod 600 .env");
    expect(screen.queryByTestId("runner-previous-revoked")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("runner-health-pill")).toHaveAttribute("data-health", "disconnected"));
    expect(screen.getByTestId("runner-last-seen")).toHaveTextContent("Never connected");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN_A));
    expect(await screen.findByTestId("runner-copy-status")).toHaveTextContent("Copied.");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("runner-credential")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(TOKEN_A);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("selects the credential for manual copy when the clipboard is unavailable", async () => {
    stubGalley();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Pair runner" }));
    const token = await screen.findByLabelText("Runner credential");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByTestId("runner-copy-status")).toHaveTextContent("copy it manually");
    expect((token as HTMLInputElement).selectionEnd).toBe(TOKEN_A.length);
  });

  it("confirms re-pairing in the page and says the previous credential is revoked", async () => {
    const { setHealth } = stubGalley();
    const confirmSpy = vi.spyOn(window, "confirm");
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Pair runner" }));
    await screen.findByLabelText("Runner credential");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    setHealth(CONNECTED);

    fireEvent.click(await screen.findByRole("button", { name: "Pair again" }));
    const confirm = screen.getByRole("group", { name: "Pair a new runner?" });
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByTestId("runner-confirm")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pair again" }));
    fireEvent.click(screen.getByRole("button", { name: "Pair new runner" }));
    expect(await screen.findByLabelText("Runner credential")).toHaveValue(TOKEN_B);
    expect(screen.getByTestId("runner-previous-revoked")).toHaveTextContent("The previous credential is revoked.");
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("revokes only after an in-page confirmation", async () => {
    const { fetchMock, setHealth } = stubGalley();
    setHealth(CONNECTED);
    const confirmSpy = vi.spyOn(window, "confirm");
    renderSection();

    expect(await screen.findByTestId("runner-hostname")).toHaveTextContent("runner-host");
    expect(screen.getByTestId("runner-version")).toHaveTextContent("0.1.0");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(within(screen.getByTestId("runner-confirm")).getByRole("button", { name: "Cancel" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByRole("group", { name: "Revoke the runner credential?" })).toHaveTextContent("Tickets and their Status do not change.");
    fireEvent.click(screen.getByRole("button", { name: "Revoke credential" }));
    expect(await screen.findByTestId("runner-not-paired")).toHaveTextContent("The runner credential is revoked.");
    expect(screen.getByTestId("runner-health-pill")).toHaveAttribute("data-health", "not_paired");
    expect(screen.getByRole("button", { name: "Pair runner" })).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("shows Galley's message when pairing fails", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ error: { code: "database_unavailable", message: "failed to pair the runner" } }, 503));
      return Promise.resolve(jsonResponse(NOT_PAIRED));
    }));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Pair runner" }));
    expect(await screen.findByTestId("runner-error")).toHaveTextContent("failed to pair the runner");
    expect(screen.queryByTestId("runner-credential")).not.toBeInTheDocument();
  });
});
