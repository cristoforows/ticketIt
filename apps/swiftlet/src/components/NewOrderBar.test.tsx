import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewOrderBar } from "./NewOrderBar";

function stubPost(response: { ok: boolean; status: number; body: unknown }) {
  const fetchMock = vi.fn(() => Promise.resolve({ ok: response.ok, status: response.status, statusText: "", json: async () => response.body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const CREATED = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "T",
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

function renderBar(onCreated = vi.fn()) {
  render(<NewOrderBar onCreated={onCreated} onUnauthenticated={() => {}} />);
  return onCreated;
}

describe("NewOrderBar", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the capture modal on Enter, carrying the typed title over", () => {
    renderBar();
    const input = screen.getByTestId("new-order-input");
    fireEvent.change(input, { target: { value: "Fix login" } });
    fireEvent.submit(screen.getByTestId("new-order-bar"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-title-input")).toHaveValue("Fix login");
    expect(screen.getByTestId("ticket-title-input")).toHaveFocus();
  });

  it("shows the Manual guidance prompt for each detail field", () => {
    renderBar();
    fireEvent.click(screen.getByTestId("new-order-button"));

    expect(screen.getByTestId("ticket-capture-guidance-goal")).toHaveTextContent("What outcome do you want?");
    expect(screen.getByTestId("ticket-capture-guidance-context")).toHaveTextContent("Supply relevant background");
    expect(screen.getByTestId("ticket-capture-guidance-success-criteria")).toHaveTextContent("observable conditions");
    expect(screen.getByTestId("ticket-capture-guidance-constraints")).toHaveTextContent("remain out of scope");
  });

  it("sends the title, Template and only the detail fields that were filled in", async () => {
    const fetchMock = stubPost({ ok: true, status: 201, body: CREATED });
    const onCreated = renderBar();
    fireEvent.click(screen.getByTestId("new-order-button"));
    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: "Fix login" } });
    fireEvent.change(screen.getByTestId("ticket-capture-goal"), { target: { value: "Restore sign-in" } });
    fireEvent.change(screen.getByTestId("ticket-capture-context"), { target: { value: "   " } });
    fireEvent.change(screen.getByTestId("ticket-capture-repository"), { target: { value: "owner/repo" } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ title: "Fix login", template: "Basic", goal: "Restore sign-in", repository: "owner/repo" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-order-input")).toHaveValue("");
    expect(screen.getByTestId("new-order-button")).toHaveFocus();
  });

  it("shows Galley's error verbatim and keeps the modal open with the input intact", async () => {
    stubPost({ ok: false, status: 400, body: { error: { code: "invalid_request", message: '"goal" must be at most 2000 characters after trimming' } } });
    const onCreated = renderBar();
    fireEvent.click(screen.getByTestId("new-order-button"));
    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: "Fix login" } });
    fireEvent.change(screen.getByTestId("ticket-capture-goal"), { target: { value: "long" } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    expect(await screen.findByTestId("ticket-capture-error")).toHaveTextContent('"goal" must be at most 2000 characters after trimming');
    expect(screen.getByTestId("ticket-title-input")).toHaveValue("Fix login");
    expect(screen.getByTestId("ticket-capture-goal")).toHaveValue("long");
    expect(screen.getByTestId("ticket-capture-submit")).not.toBeDisabled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("disables every control while the request is pending", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderBar();
    fireEvent.click(screen.getByTestId("new-order-button"));
    fireEvent.change(screen.getByTestId("ticket-title-input"), { target: { value: "Fix login" } });
    fireEvent.click(screen.getByTestId("ticket-capture-submit"));

    await waitFor(() => expect(screen.getByTestId("ticket-capture-submit")).toBeDisabled());
    for (const id of ["ticket-title-input", "ticket-template-select", "ticket-capture-goal", "ticket-capture-repository", "ticket-capture-cancel"]) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
  });

  it("creates nothing on Cancel or Escape and returns focus to the bar's button", async () => {
    const fetchMock = stubPost({ ok: true, status: 201, body: CREATED });
    renderBar();
    fireEvent.change(screen.getByTestId("new-order-input"), { target: { value: "Keep me" } });

    fireEvent.click(screen.getByTestId("new-order-button"));
    fireEvent.click(screen.getByTestId("ticket-capture-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("new-order-button")).toHaveFocus();

    fireEvent.click(screen.getByTestId("new-order-button"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("new-order-button")).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-order-input")).toHaveValue("Keep me");
  });
});
