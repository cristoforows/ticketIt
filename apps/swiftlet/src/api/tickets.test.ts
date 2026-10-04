import { afterEach, describe, expect, it, vi } from "vitest";
import { GalleyError } from "./http";
import { addRoundFeedback, answerRoundQuestion, approvePermissionRequest, declinePermissionRequest, fetchTicket } from "./tickets";

const TICKET = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "Write the report",
  status: "InReview",
  permissionGrants: [],
  permissionGrantCount: 0,
  allowedActions: {
    statusChangeRejections: [],
    statusChanges: [],
    accept: { available: true },
    rework: {
      available: false,
      reason: { code: "agent_readiness_incomplete", message: "this Ticket needs a goal", missing: ["goal"] },
    },
    stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } },
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
  const round = { id: "66666666-6666-4666-8666-666666666666", sequence: 1, state: "running", agent, claimedAt: "2026-10-02T10:00:00Z", startedAt: "2026-10-02T10:00:01Z", waitingReason: "working", question: null, permissionRequest: null };

  it.each(["starting", "working", "waiting_for_answer", "waiting_for_permission", "resuming", "stopping", "runner_disconnected"])("keeps Galley's waiting reason %s", async (waitingReason) => {
    const open = { ...TICKET, status: "InProgress", openRound: { ...round, stopRequestedAt: null, waitingReason } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => open }));
    expect((await fetchTicket(TICKET.id)).openRound?.waitingReason).toBe(waitingReason);
  });

  it("reads the Stop availability and when Stop was requested", async () => {
    const stopping = {
      ...TICKET,
      status: "InProgress",
      openRound: { ...round, stopRequestedAt: "2026-10-02T10:00:05Z", waitingReason: "stopping", question: null, permissionRequest: null },
      permissionGrants: [],
      permissionGrantCount: 0,
      allowedActions: { ...TICKET.allowedActions, stop: { available: false, reason: { code: "stop_already_requested", message: "Stop is already requested for this Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => stopping }));
    const ticket = await fetchTicket(TICKET.id);
    expect(ticket.openRound?.stopRequestedAt).toBe("2026-10-02T10:00:05Z");
    expect(ticket.allowedActions.stop).toEqual(stopping.allowedActions.stop);
  });

  const PERMISSION_REQUEST = { id: "99999999-9999-5999-8999-999999999990", account: "controlled", action: "write_note", resource: "notes/weekly-report", substituteAccount: true, requestedAt: "2026-10-02T10:00:03Z", decision: null, decidedAt: null, grantId: null, renewsGrantId: null };
  const GRANT = { id: "12121212-1212-4121-8121-121212121212", agent, account: "controlled", full: false, action: "write_note", resource: "notes/weekly-report", substituteAccount: true, form: "ticket", state: "active", expiresAt: null, remainingSeconds: null, roundId: round.id, createdAt: "2026-10-02T10:00:09Z", approvedAt: "2026-10-02T10:00:09Z" };
  const permissionWaiting = { ...round, state: "waiting_for_input", stopRequestedAt: null, waitingReason: "waiting_for_permission", question: null, permissionRequest: PERMISSION_REQUEST };

  it("reads the Permission request a waiting Round holds, the decision availability and the Ticket's grants", async () => {
    const payload = { ...TICKET, status: "Blocked", openRound: permissionWaiting, permissionGrants: [GRANT], permissionGrantCount: 1, allowedActions: { ...TICKET.allowedActions, permissionDecision: { available: true } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => payload }));
    const ticket = await fetchTicket(TICKET.id);
    expect(ticket.openRound).toEqual(permissionWaiting);
    expect(ticket.permissionGrants).toEqual([GRANT]);
    expect(ticket.allowedActions.permissionDecision).toEqual({ available: true });
  });

  const TIME_GRANT = { ...GRANT, id: "13131313-1313-4131-8131-131313131313", form: "time", expiresAt: "2026-10-02T11:00:09Z", remainingSeconds: 3600 };
  const EXPIRED_GRANT = { ...TIME_GRANT, id: "14141414-1414-4141-8141-141414141414", state: "expired", remainingSeconds: 0 };

  it("reads live and expired time grants, a renewal request and the grant count", async () => {
    const renewal = { ...PERMISSION_REQUEST, renewsGrantId: EXPIRED_GRANT.id };
    const payload = { ...TICKET, status: "Blocked", openRound: { ...permissionWaiting, permissionRequest: renewal }, permissionGrants: [EXPIRED_GRANT, TIME_GRANT, GRANT], permissionGrantCount: 57, allowedActions: { ...TICKET.allowedActions, permissionDecision: { available: true } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => payload }));
    const ticket = await fetchTicket(TICKET.id);
    expect(ticket.openRound?.permissionRequest).toEqual(renewal);
    expect(ticket.permissionGrants).toEqual([EXPIRED_GRANT, TIME_GRANT, GRANT]);
    expect(ticket.permissionGrantCount).toBe(57);
  });

  const FULL_GRANT = { ...TIME_GRANT, id: "15151515-1515-4151-8151-151515151515", full: true, action: null, resource: null };

  it("reads a full-access grant, which names its account and no action or resource", async () => {
    const payload = { ...TICKET, permissionGrants: [FULL_GRANT, GRANT], permissionGrantCount: 2 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => payload }));
    const ticket = await fetchTicket(TICKET.id);
    expect(ticket.permissionGrants).toEqual([FULL_GRANT, GRANT]);
    expect(ticket.permissionGrants.map((grant) => grant.full)).toEqual([true, false]);
  });

  it.each([
    ["a full grant with an action", { ...FULL_GRANT, action: "write_note" }],
    ["a full grant with a resource", { ...FULL_GRANT, resource: "notes/weekly-report" }],
    ["a granular grant without an action", { ...GRANT, action: null }],
    ["a granular grant without a resource", { ...GRANT, resource: null }],
    ["a grant without full", { ...GRANT, full: undefined }],
    ["a grant whose full is not a boolean", { ...FULL_GRANT, full: "true" }],
  ])("rejects a Ticket with %s", async (_name, grant) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => ({ ...TICKET, permissionGrants: [grant], permissionGrantCount: 1 }) }));
    await expect(fetchTicket(TICKET.id)).rejects.toThrow("missing a required field");
  });

  it("keeps an approved request with its grant while the Round resumes", async () => {
    const approved = { ...PERMISSION_REQUEST, decision: "approved", decidedAt: "2026-10-02T10:00:09Z", grantId: GRANT.id };
    const payload = { ...TICKET, status: "Blocked", openRound: { ...permissionWaiting, waitingReason: "resuming", permissionRequest: approved } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => payload }));
    expect((await fetchTicket(TICKET.id)).openRound?.permissionRequest).toEqual(approved);
  });

  const question = { id: "99999999-9999-5999-8999-999999999999", text: "Which region?", askedAt: "2026-10-02T10:00:03Z", answer: null, answeredAt: null };
  const waiting = { ...round, state: "waiting_for_input", stopRequestedAt: null, waitingReason: "waiting_for_answer", question, permissionRequest: null };

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
    ["a waiting Round without its question", { ...TICKET, openRound: { ...waiting, question: null, permissionRequest: null } }],
    ["a running Round with a question", { ...TICKET, openRound: { ...waiting, state: "running", waitingReason: "working" } }],
    ["an open Round with no question field", { ...TICKET, openRound: { ...round, stopRequestedAt: null, question: undefined } }],
    ["a question with an answer but no answeredAt", { ...TICKET, openRound: { ...waiting, question: { ...question, answer: "Yes" } } }],
    ["a question without its text", { ...TICKET, openRound: { ...waiting, question: { ...question, text: undefined } } }],
    ["a waiting Round with both a question and a Permission request", { ...TICKET, openRound: { ...waiting, permissionRequest: PERMISSION_REQUEST } }],
    ["a running Round with a Permission request", { ...TICKET, openRound: { ...round, stopRequestedAt: null, permissionRequest: PERMISSION_REQUEST } }],
    ["an open Round with no permissionRequest field", { ...TICKET, openRound: { ...waiting, permissionRequest: undefined } }],
    ["a Permission request without substituteAccount", { ...TICKET, openRound: { ...permissionWaiting, permissionRequest: { ...PERMISSION_REQUEST, substituteAccount: undefined } } }],
    ["a decision without decidedAt", { ...TICKET, openRound: { ...permissionWaiting, permissionRequest: { ...PERMISSION_REQUEST, decision: "declined" } } }],
    ["an approval without its grant", { ...TICKET, openRound: { ...permissionWaiting, permissionRequest: { ...PERMISSION_REQUEST, decision: "approved", decidedAt: "2026-10-02T10:00:09Z" } } }],
    ["a decline with a grant", { ...TICKET, openRound: { ...permissionWaiting, permissionRequest: { ...PERMISSION_REQUEST, decision: "declined", decidedAt: "2026-10-02T10:00:09Z", grantId: GRANT.id } } }],
    ["an unknown decision", { ...TICKET, openRound: { ...permissionWaiting, permissionRequest: { ...PERMISSION_REQUEST, decision: "deferred", decidedAt: "2026-10-02T10:00:09Z" } } }],
    ["no Permission decision availability", { ...TICKET, allowedActions: { ...TICKET.allowedActions, permissionDecision: undefined } }],
    ["no permissionGrants field", { ...TICKET, permissionGrants: undefined }],
    ["a grant of another form", { ...TICKET, permissionGrants: [{ ...GRANT, form: "always" }], permissionGrantCount: 1 }],
    ["a grant that is not active", { ...TICKET, permissionGrants: [{ ...GRANT, state: "revoked" }], permissionGrantCount: 1 }],
    ["a grant without its Agent", { ...TICKET, permissionGrants: [{ ...GRANT, agent: undefined }], permissionGrantCount: 1 }],
    ["a Permission request without renewsGrantId", { ...TICKET, openRound: { ...permissionWaiting, permissionRequest: { ...PERMISSION_REQUEST, renewsGrantId: undefined } } }],
    ["a numeric renewsGrantId", { ...TICKET, openRound: { ...permissionWaiting, permissionRequest: { ...PERMISSION_REQUEST, renewsGrantId: 7 } } }],
    ["no permissionGrantCount", { ...TICKET, permissionGrantCount: undefined }],
    ["a permissionGrantCount below the grants listed", { ...TICKET, permissionGrants: [GRANT], permissionGrantCount: 0 }],
    ["a fractional permissionGrantCount", { ...TICKET, permissionGrantCount: 0.5 }],
    ["a ticket grant with an expiry", { ...TICKET, permissionGrants: [{ ...GRANT, expiresAt: "2026-10-02T11:00:09Z" }], permissionGrantCount: 1 }],
    ["a ticket grant with remaining time", { ...TICKET, permissionGrants: [{ ...GRANT, remainingSeconds: 60 }], permissionGrantCount: 1 }],
    ["an expired ticket grant", { ...TICKET, permissionGrants: [{ ...GRANT, state: "expired" }], permissionGrantCount: 1 }],
    ["a time grant without its expiry", { ...TICKET, permissionGrants: [{ ...TIME_GRANT, expiresAt: null }], permissionGrantCount: 1 }],
    ["a time grant without remaining time", { ...TICKET, permissionGrants: [{ ...TIME_GRANT, remainingSeconds: null }], permissionGrantCount: 1 }],
    ["an active time grant with none left", { ...TICKET, permissionGrants: [{ ...TIME_GRANT, remainingSeconds: 0 }], permissionGrantCount: 1 }],
    ["an expired time grant with time left", { ...TICKET, permissionGrants: [{ ...TIME_GRANT, state: "expired", remainingSeconds: 5 }], permissionGrantCount: 1 }],
    ["a fractional remaining time", { ...TICKET, permissionGrants: [{ ...TIME_GRANT, remainingSeconds: 1.5 }], permissionGrantCount: 1 }],
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
    const payload = { ...TICKET, allowedActions: { ...TICKET.allowedActions, feedback: { available: true }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } } };
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

describe("Permission decisions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("approves with the ticket form on the request's path and returns the Ticket", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => TICKET });
    vi.stubGlobal("fetch", fetchMock);
    expect(await approvePermissionRequest("t1", "r1", "p1", { form: "ticket" })).toEqual(TICKET);
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/t1/rounds/r1/permission-requests/p1/approve", expect.objectContaining({ method: "POST", body: JSON.stringify({ form: "ticket" }) }));
  });

  it("approves with the time form and its expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => TICKET });
    vi.stubGlobal("fetch", fetchMock);
    await approvePermissionRequest("t1", "r1", "p1", { form: "time", expiresAt: "2026-10-02T11:00:00.000Z" });
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ form: "time", expiresAt: "2026-10-02T11:00:00.000Z" }));
  });

  it("approves with full access only when the scope names it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => TICKET });
    vi.stubGlobal("fetch", fetchMock);
    await approvePermissionRequest("t1", "r1", "p1", { form: "ticket", scope: "full" });
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ form: "ticket", scope: "full" }));
  });

  it("declines with no body on the request's path and returns the Ticket", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => TICKET });
    vi.stubGlobal("fetch", fetchMock);
    expect(await declinePermissionRequest("t1", "r1", "p1")).toEqual(TICKET);
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/t1/rounds/r1/permission-requests/p1/decline", expect.objectContaining({ method: "POST" }));
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it.each([
    [404, "not_found", "no ticket, round or Permission request with that identifier"],
    [400, "permission_already_decided", "this Permission request is already decided"],
    [400, "invalid_grant_expiry", "expiresAt must be after the approval and at most 30 days later"],
    [400, "grant_form_conflict", "a ticket grant takes no expiresAt"],
  ])("surfaces Galley's %i %s as its own error", async (status, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, statusText: "", json: async () => ({ error: { code, message } }) }));
    const error = await approvePermissionRequest("t1", "r1", "p1", { form: "ticket" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GalleyError);
    expect(error).toMatchObject({ code, message });
  });
});
