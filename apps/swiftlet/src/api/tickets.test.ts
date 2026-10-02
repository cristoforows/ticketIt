import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTicket } from "./tickets";

const TICKET = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "Write the report",
  status: "InReview",
  allowedActions: {
    statusChangeRejections: [],
    statusChanges: [],
    accept: { available: true },
    rework: {
      available: false,
      reason: { code: "agent_readiness_incomplete", message: "this Ticket needs a goal", missing: ["goal"] },
    },
    stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } },
  },
  template: "Basic",
  completionCondition: "humanAcceptance",
  assigneeType: "agent",
  assigneeAgent: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" },
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

describe("fetchTicket", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the missing inputs on an unavailable rework", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => TICKET }));
    const ticket = await fetchTicket(TICKET.id);
    expect(ticket.allowedActions.rework).toEqual(TICKET.allowedActions.rework);
  });

  const agent = TICKET.assigneeAgent;
  const round = { id: "66666666-6666-4666-8666-666666666666", sequence: 1, state: "running", agent, claimedAt: "2026-10-02T10:00:00Z", startedAt: "2026-10-02T10:00:01Z", waitingReason: "working" };

  it.each(["starting", "working", "stopping", "runner_disconnected"])("keeps Galley's waiting reason %s", async (waitingReason) => {
    const open = { ...TICKET, status: "InProgress", openRound: { ...round, stopRequestedAt: null, waitingReason } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => open }));
    expect((await fetchTicket(TICKET.id)).openRound?.waitingReason).toBe(waitingReason);
  });

  it("reads the Stop availability and when Stop was requested", async () => {
    const stopping = {
      ...TICKET,
      status: "InProgress",
      openRound: { ...round, stopRequestedAt: "2026-10-02T10:00:05Z", waitingReason: "stopping" },
      allowedActions: { ...TICKET.allowedActions, stop: { available: false, reason: { code: "stop_already_requested", message: "Stop is already requested for this Round" } } },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => stopping }));
    const ticket = await fetchTicket(TICKET.id);
    expect(ticket.openRound?.stopRequestedAt).toBe("2026-10-02T10:00:05Z");
    expect(ticket.allowedActions.stop).toEqual(stopping.allowedActions.stop);
  });

  it.each([
    ["an open Round without stopRequestedAt", { ...TICKET, openRound: round }],
    ["a numeric stopRequestedAt", { ...TICKET, openRound: { ...round, stopRequestedAt: 5 } }],
    ["an open Round without waitingReason", { ...TICKET, openRound: { ...round, stopRequestedAt: null, waitingReason: undefined } }],
    ["an unknown waitingReason", { ...TICKET, openRound: { ...round, stopRequestedAt: null, waitingReason: "waiting_for_input" } }],
    ["no Stop availability", { ...TICKET, allowedActions: { ...TICKET.allowedActions, stop: undefined } }],
  ])("rejects a Ticket with %s", async (_name, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => payload }));
    await expect(fetchTicket(TICKET.id)).rejects.toThrow("missing a required field");
  });
});
