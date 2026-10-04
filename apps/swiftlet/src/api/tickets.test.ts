import { afterEach, describe, expect, it, vi } from "vitest";
import { GalleyError } from "./http";
import { addRoundFeedback, answerRoundQuestion, fetchTicket } from "./tickets";

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
    stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } },
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
  const round = { id: "66666666-6666-4666-8666-666666666666", sequence: 1, state: "running", agent, claimedAt: "2026-10-02T10:00:00Z", startedAt: "2026-10-02T10:00:01Z", waitingReason: "working", question: null };

  it.each(["starting", "working", "waiting_for_answer", "resuming", "stopping", "runner_disconnected"])("keeps Galley's waiting reason %s", async (waitingReason) => {
    const open = { ...TICKET, status: "InProgress", openRound: { ...round, stopRequestedAt: null, waitingReason } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => open }));
    expect((await fetchTicket(TICKET.id)).openRound?.waitingReason).toBe(waitingReason);
  });

  it("reads the Stop availability and when Stop was requested", async () => {
    const stopping = {
      ...TICKET,
      status: "InProgress",
      openRound: { ...round, stopRequestedAt: "2026-10-02T10:00:05Z", waitingReason: "stopping", question: null },
      allowedActions: { ...TICKET.allowedActions, stop: { available: false, reason: { code: "stop_already_requested", message: "Stop is already requested for this Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } } },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => stopping }));
    const ticket = await fetchTicket(TICKET.id);
    expect(ticket.openRound?.stopRequestedAt).toBe("2026-10-02T10:00:05Z");
    expect(ticket.allowedActions.stop).toEqual(stopping.allowedActions.stop);
  });

  const question = { id: "99999999-9999-5999-8999-999999999999", text: "Which region?", askedAt: "2026-10-02T10:00:03Z", answer: null, answeredAt: null };
  const waiting = { ...round, state: "waiting_for_input", stopRequestedAt: null, waitingReason: "waiting_for_answer", question };

  it("reads the question a waiting Round holds and the Answer availability", async () => {
    const payload = { ...TICKET, status: "Blocked", openRound: waiting, allowedActions: { ...TICKET.allowedActions, answer: { available: true } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => payload }));
    const ticket = await fetchTicket(TICKET.id);
    expect(ticket.openRound).toEqual(waiting);
    expect(ticket.allowedActions.answer).toEqual({ available: true });
  });

  it("keeps an answered question while the Round resumes", async () => {
    const answered = { ...question, answer: "Europe", answeredAt: "2026-10-02T10:00:09Z" };
    const payload = { ...TICKET, status: "Blocked", openRound: { ...waiting, waitingReason: "resuming", question: answered } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => payload }));
    expect((await fetchTicket(TICKET.id)).openRound?.question).toEqual(answered);
  });

  it.each([
    ["an open Round without stopRequestedAt", { ...TICKET, openRound: round }],
    ["a numeric stopRequestedAt", { ...TICKET, openRound: { ...round, stopRequestedAt: 5 } }],
    ["an open Round without waitingReason", { ...TICKET, openRound: { ...round, stopRequestedAt: null, waitingReason: undefined } }],
    ["an unknown waitingReason", { ...TICKET, openRound: { ...round, stopRequestedAt: null, waitingReason: "waiting_for_input" } }],
    ["no Stop availability", { ...TICKET, allowedActions: { ...TICKET.allowedActions, stop: undefined } }],
    ["no Answer availability", { ...TICKET, allowedActions: { ...TICKET.allowedActions, answer: undefined } }],
    ["no Feedback availability", { ...TICKET, allowedActions: { ...TICKET.allowedActions, feedback: undefined } }],
    ["a waiting Round without its question", { ...TICKET, openRound: { ...waiting, question: null } }],
    ["a running Round with a question", { ...TICKET, openRound: { ...waiting, state: "running", waitingReason: "working" } }],
    ["an open Round with no question field", { ...TICKET, openRound: { ...round, stopRequestedAt: null, question: undefined } }],
    ["a question with an answer but no answeredAt", { ...TICKET, openRound: { ...waiting, question: { ...question, answer: "Yes" } } }],
    ["a question without its text", { ...TICKET, openRound: { ...waiting, question: { ...question, text: undefined } } }],
  ])("rejects a Ticket with %s", async (_name, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => payload }));
    await expect(fetchTicket(TICKET.id)).rejects.toThrow("missing a required field");
  });
});

describe("answerRoundQuestion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the answer to the question's path and returns the Ticket", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => TICKET });
    vi.stubGlobal("fetch", fetchMock);
    expect(await answerRoundQuestion("t1", "r1", "q1", "Europe")).toEqual(TICKET);
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/t1/rounds/r1/questions/q1/answer", expect.objectContaining({ method: "POST", body: JSON.stringify({ answer: "Europe" }) }));
  });

  it.each([
    [404, "not_found", "No question with that id waits on this Round"],
    [400, "question_already_answered", "This question already has an answer"],
  ])("surfaces Galley's %i %s as its own error", async (status, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, statusText: "", json: async () => ({ error: { code, message } }) }));
    const error = await answerRoundQuestion("t1", "r1", "q1", "Europe").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GalleyError);
    expect(error).toMatchObject({ code, message });
  });
});

describe("addRoundFeedback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the feedback to the Round's path and returns the Ticket", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, statusText: "", json: async () => TICKET });
    vi.stubGlobal("fetch", fetchMock);
    expect(await addRoundFeedback("t1", "r1", "Cover Asia too")).toEqual(TICKET);
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/t1/rounds/r1/feedback", expect.objectContaining({ method: "POST", body: JSON.stringify({ body: "Cover Asia too" }) }));
  });

  it("reads the Feedback availability", async () => {
    const payload = { ...TICKET, allowedActions: { ...TICKET.allowedActions, feedback: { available: true } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201, statusText: "", json: async () => payload }));
    expect((await addRoundFeedback("t1", "r1", "Cover Asia too")).allowedActions.feedback).toEqual({ available: true });
  });

  it.each([
    [404, "not_found", "no round with that identifier"],
    [400, "feedback_not_available", "Feedback needs a Ticket in In Review or Done (current status Ready)"],
  ])("surfaces Galley's %i %s as its own error", async (status, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, statusText: "", json: async () => ({ error: { code, message } }) }));
    const error = await addRoundFeedback("t1", "r1", "Cover Asia too").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GalleyError);
    expect(error).toMatchObject({ code, message });
  });
});
