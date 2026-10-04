import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TicketBoard } from "./TicketBoard";
import { TicketList } from "./TicketList";

type MockResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;
const jsonResponse = (body: unknown, status = 200): MockResponse => ({ ok: status >= 200 && status < 300, status, statusText: "", json: async () => body });

const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" };
const locked = { code: "round_open", message: "Locked while atlas works on Round 2", roundId: "66666666-6666-4666-8666-666666666666" };
const unavailable = (code: string) => ({ available: false, reason: { code, message: code } });
const openRound = { id: locked.roundId, sequence: 2, state: "running", agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: "2026-10-01T10:00:01Z", stopRequestedAt: null, waitingReason: "working", question: null };
const ACTIVE = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "Write the report",
  status: "InProgress",
  allowedActions: { statusChangeRejections: [], statusChanges: [], accept: { available: false, reason: locked }, rework: unavailable("rework_not_available"), stop: { available: true }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } } },
  template: "Basic",
  completionCondition: "humanAcceptance",
  assigneeType: "agent",
  assigneeAgent: agent,
  requestingAgentWork: false,
  openRound,
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
const STOPPING = {
  ...ACTIVE,
  openRound: { ...openRound, stopRequestedAt: "2026-10-01T10:00:07Z", waitingReason: "stopping", question: null },
  allowedActions: { ...ACTIVE.allowedActions, stop: unavailable("stop_already_requested") },
};
const IDLE = { ...ACTIVE, id: "55555555-5555-4555-8555-555555555555", title: "Idle order", status: "Backlog", openRound: null, assigneeType: "", assigneeAgent: null, allowedActions: { ...ACTIVE.allowedActions, accept: unavailable("invalid_transition"), stop: unavailable("stop_not_available") } };

function stubGalley(tickets: unknown[], stop: () => MockResponse = () => jsonResponse(STOPPING)) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    if (key === "GET /api/tickets") return Promise.resolve(jsonResponse({ tickets }));
    if (key === `POST /api/tickets/${ACTIVE.id}/stop`) return Promise.resolve(stop());
    throw new Error(`unexpected fetch ${key}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const views = [
  { name: "list", prefix: "ticket", row: (id: string) => `ticket-item-${id}`, query: "", render: (onUnauthenticated = () => {}) => render(<TicketList onUnauthenticated={onUnauthenticated} />) },
  { name: "board", prefix: "board", row: (id: string) => `board-ticket-${id}`, query: "?from=board", render: (onUnauthenticated = () => {}) => render(<TicketBoard onUnauthenticated={onUnauthenticated} />) },
] as const;

const INTERACTIVE = "a[href], button, input, select, textarea, [tabindex]";

describe.each(views)("the active order slip on the $name", ({ prefix, row, query, render: renderView }) => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ["starting", "Starting"],
    ["working", "Working"],
    ["stopping", "Stopping"],
    ["runner_disconnected", "Runner disconnected"],
  ])("labels the Galley reason %s as %s, beside a decorative delivery indicator", async (waitingReason, label) => {
    stubGalley([{ ...ACTIVE, openRound: { ...openRound, waitingReason } }]);
    renderView();
    const slip = within(await screen.findByTestId(row(ACTIVE.id)));
    expect(slip.getByTestId(`${prefix}-waiting-reason`)).toHaveTextContent(new RegExp(`^${label}$`));
    const indicator = slip.getByTestId("delivery-indicator");
    expect(indicator).toHaveAttribute("aria-hidden", "true");
    expect(indicator).toHaveAttribute("data-reason", waitingReason);
  });

  it.each([
    ["waiting_for_answer", "Waiting for your answer", null, null],
    ["resuming", "Resuming", "Europe", "2026-10-01T10:00:09Z"],
  ])("labels a Blocked Ticket whose Round waits for input with %s as %s", async (waitingReason, label, answer, answeredAt) => {
    const question = { id: "99999999-9999-5999-8999-999999999999", text: "Which region?", askedAt: "2026-10-01T10:00:05Z", answer, answeredAt };
    stubGalley([{ ...ACTIVE, status: "Blocked", openRound: { ...openRound, state: "waiting_for_input", waitingReason, question } }]);
    renderView();
    const slip = within(await screen.findByTestId(row(ACTIVE.id)));
    expect(slip.getByTestId(`${prefix}-waiting-reason`)).toHaveTextContent(new RegExp(`^${label}$`));
    expect(slip.getByTestId("delivery-indicator")).toHaveAttribute("data-reason", waitingReason);
    expect(slip.getByRole("button", { name: `Stop ${ACTIVE.title}` })).toBeInTheDocument();
  });

  it("is greyed and locked only while the Round is open, in text that keeps AA contrast", async () => {
    stubGalley([ACTIVE, IDLE]);
    renderView();
    const active = await screen.findByTestId(row(ACTIVE.id));
    expect(active).toHaveAttribute("data-active", "true");
    expect(within(active).getByRole("img", { name: "Locked while atlas works on Round 2" })).toBeInTheDocument();
    const greyed = prefix === "board" ? active.querySelector("[data-surface=paper]")! : active;
    expect(greyed).toHaveClass("bg-rule");
    expect(greyed).not.toHaveClass("bg-paper");
    for (const element of active.querySelectorAll("*")) {
      expect(element.getAttribute("class") ?? "").not.toMatch(/\btext-(muted|dim)\b|text-\(--status/);
    }

    const idle = screen.getByTestId(row(IDLE.id));
    expect(idle).not.toHaveAttribute("data-active");
    expect(within(idle).queryByTestId(`${prefix}-active-order`)).not.toBeInTheDocument();
  });

  it("offers View and Stop as keyboard-reachable controls named for the Ticket, none nested in another", async () => {
    stubGalley([ACTIVE]);
    renderView();
    const slip = within(await screen.findByTestId(row(ACTIVE.id)));
    const view = slip.getByRole("link", { name: `View ${ACTIVE.title}` });
    const stop = slip.getByRole("button", { name: `Stop ${ACTIVE.title}` });
    expect(view).toHaveAttribute("href", `/tickets/${ACTIVE.id}${query}`);
    for (const control of [view, stop]) {
      expect(control).not.toHaveAttribute("tabindex", "-1");
      control.focus();
      expect(control).toHaveFocus();
      expect(control.querySelector(INTERACTIVE)).toBeNull();
      expect(control.parentElement!.closest(INTERACTIVE)).toBeNull();
    }
    expect(screen.getByTestId(row(ACTIVE.id))).not.toHaveAttribute("draggable", "true");
  });

  it("offers Stop only while Galley's allowedActions advertise it", async () => {
    stubGalley([STOPPING]);
    renderView();
    const slip = within(await screen.findByTestId(row(ACTIVE.id)));
    expect(slip.getByRole("link", { name: `View ${ACTIVE.title}` })).toBeInTheDocument();
    expect(slip.queryByRole("button", { name: `Stop ${ACTIVE.title}` })).not.toBeInTheDocument();
    expect(slip.getByTestId(`${prefix}-waiting-reason`)).toHaveTextContent("Stopping");
  });

  it("requests Stop through Galley and shows the Round Galley returns", async () => {
    const fetchMock = stubGalley([ACTIVE]);
    renderView();
    const slip = within(await screen.findByTestId(row(ACTIVE.id)));
    await act(async () => { fireEvent.click(slip.getByRole("button", { name: `Stop ${ACTIVE.title}` })); });
    expect(fetchMock).toHaveBeenCalledWith(`/api/tickets/${ACTIVE.id}/stop`, expect.objectContaining({ method: "POST" }));
    const after = within(screen.getByTestId(row(ACTIVE.id)));
    expect(after.getByTestId(`${prefix}-waiting-reason`)).toHaveTextContent("Stopping");
    expect(after.queryByRole("button", { name: `Stop ${ACTIVE.title}` })).not.toBeInTheDocument();
  });

  it("says why Stop failed and keeps the slip as it was", async () => {
    stubGalley([ACTIVE], () => jsonResponse({ error: { code: "stop_not_available", message: "This Ticket has no open Round to stop" } }, 409));
    renderView();
    const slip = within(await screen.findByTestId(row(ACTIVE.id)));
    await act(async () => { fireEvent.click(slip.getByRole("button", { name: `Stop ${ACTIVE.title}` })); });
    expect(slip.getByTestId(`${prefix}-active-stop-error`)).toHaveTextContent("This Ticket has no open Round to stop");
    expect(slip.getByTestId(`${prefix}-waiting-reason`)).toHaveTextContent("Working");
    expect(slip.getByRole("button", { name: `Stop ${ACTIVE.title}` })).toBeEnabled();
  });

  it("hands the Owner to sign-in when Stop comes back unauthenticated", async () => {
    stubGalley([ACTIVE], () => jsonResponse({}, 401));
    const onUnauthenticated = vi.fn();
    renderView(onUnauthenticated);
    const slip = within(await screen.findByTestId(row(ACTIVE.id)));
    await act(async () => { fireEvent.click(slip.getByRole("button", { name: `Stop ${ACTIVE.title}` })); });
    expect(onUnauthenticated).toHaveBeenCalled();
  });
});
