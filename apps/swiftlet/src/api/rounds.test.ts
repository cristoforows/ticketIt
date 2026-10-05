import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "./session";
import { attestRoundCessation, fetchRoundActivity, fetchTicketRounds } from "./rounds";
import { GalleyError } from "./http";
import { TicketNotFoundError } from "./tickets";

const usage = {
  observations: 1,
  complete: true,
  estimated: false,
  costUsd: "0.004500",
  inputTokens: { sum: 1200, complete: true, estimated: false },
  outputTokens: { sum: 300, complete: true, estimated: false },
  activeMs: { sum: 2000, complete: true, estimated: false },
};
const STOPPED = {
  id: "66666666-6666-4666-8666-666666666666",
  sequence: 1,
  state: "stopped",
  agent: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" },
  claimedAt: "2026-10-01T10:00:00Z",
  startedAt: null,
  endedAt: "2026-10-01T10:00:30Z",
  outcomeNote: "Stopped before step 1 of 2 on Stop command 55555555-5555-4555-8555-555555555555",
  activity: [{ seq: 1, note: "Reading the Ticket", occurredAt: "2026-10-01T10:00:10Z" }],
  earlierActivityCursor: null,
  questions: [],
  feedback: [],
  permissionRequests: [],
  authorityChecks: [],
  authorityCheckCount: 0, attestation: null, limitBreach: null,
  usage,
  deliverable: null,
};

const QUESTION = { id: "99999999-9999-5999-8999-999999999999", text: "Which region?", askedAt: "2026-10-01T10:00:10Z", answer: null, answeredAt: null };

const FEEDBACK = { id: "13131313-1313-4313-8313-131313131313", body: "Cover Asia too", createdAt: "2026-10-01T10:01:00Z", consumedBy: null };

const REQUEST = { id: "99999999-9999-5999-8999-999999999990", account: "controlled", action: "write_note", resource: "notes/weekly-report", substituteAccount: true, requestedAt: "2026-10-01T10:00:10Z", decision: "approved", decidedAt: "2026-10-01T10:00:12Z", grantId: "12121212-1212-4121-8121-121212121212", renewsGrantId: null };

const DENY = { account: "controlled", action: "write_note", resource: "notes/weekly-report", decision: "deny", grantId: null, expiredGrantId: null, checkedAt: "2026-10-01T10:00:09Z" };
const ALLOW = { ...DENY, decision: "allow", grantId: REQUEST.grantId, checkedAt: "2026-10-01T10:00:13Z" };

const answer = (rounds: unknown[]) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => ({ rounds }) }));

describe("fetchTicketRounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a stopped Round's outcome note, activity and usage", async () => {
    answer([STOPPED, { ...STOPPED, id: "77777777-7777-4777-8777-777777777777", state: "running", startedAt: "2026-10-01T10:00:05Z", endedAt: null, outcomeNote: null }]);
    expect(await fetchTicketRounds("t")).toEqual([STOPPED, { ...STOPPED, id: "77777777-7777-4777-8777-777777777777", state: "running", startedAt: "2026-10-01T10:00:05Z", endedAt: null, outcomeNote: null }]);
  });

  it("keeps a Round's questions with their answers, answered or not", async () => {
    const waiting = { ...STOPPED, state: "waiting_for_input", startedAt: "2026-10-01T10:00:05Z", endedAt: null, outcomeNote: null, questions: [{ ...QUESTION, answer: "Europe", answeredAt: "2026-10-01T10:00:20Z" }, { ...QUESTION, id: "88888888-8888-5888-8888-888888888888" }] };
    answer([waiting]);
    expect(await fetchTicketRounds("t")).toEqual([waiting]);
  });

  it("keeps a Round's feedback, waiting or sent to the Round that received it", async () => {
    const delivered = {
      ...STOPPED,
      state: "delivered",
      outcomeNote: null,
      deliverable: { bodyMarkdown: "b", summary: "s", criteriaAssessment: "c" },
      feedback: [
        { ...FEEDBACK, consumedBy: { roundId: "77777777-7777-4777-8777-777777777777", sequence: 2 } },
        { ...FEEDBACK, id: "12121212-1212-4212-8212-121212121212" },
      ],
    };
    answer([delivered]);
    expect(await fetchTicketRounds("t")).toEqual([delivered]);
  });

  it("keeps a Round's Permission requests, its latest authority checks and their count", async () => {
    const withChecks = { ...STOPPED, permissionRequests: [REQUEST], authorityChecks: [DENY, ALLOW], authorityCheckCount: 60, attestation: null };
    answer([withChecks]);
    expect(await fetchTicketRounds("t")).toEqual([withChecks]);
  });

  it("keeps a deny that names the expired grant and the renewal request it raised", async () => {
    const expiredGrantId = "14141414-1414-4141-8141-141414141414";
    const renewal = { ...REQUEST, renewsGrantId: expiredGrantId };
    const withRenewal = { ...STOPPED, permissionRequests: [renewal], authorityChecks: [{ ...DENY, expiredGrantId }, ALLOW], authorityCheckCount: 2, attestation: null };
    answer([withRenewal]);
    expect(await fetchTicketRounds("t")).toEqual([withRenewal]);
  });

  it.each([
    ["failed", "The repository is gone."],
    ["interrupted", "The engine process exited with signal 9."],
  ])("keeps a %s Round's outcome note, activity and usage", async (state, outcomeNote) => {
    const ended = { ...STOPPED, state, startedAt: "2026-10-01T10:00:05Z", outcomeNote };
    answer([ended]);
    expect(await fetchTicketRounds("t")).toEqual([ended]);
  });

  it("keeps the limit breach of a Round a technical limit ended Failed", async () => {
    const failed = { ...STOPPED, state: "failed", outcomeNote: "Technical limit reached: 10 consecutive denied authority checks (limit 10).", limitBreach: { kind: "denial_loop", limit: 10, measured: 10, breachedAt: "2026-10-01T10:00:08Z" } };
    answer([failed]);
    expect(await fetchTicketRounds("t")).toEqual([failed]);
  });

  it.each([
    ["no limitBreach field", { ...STOPPED, limitBreach: undefined }],
    ["a limitBreach of an unknown kind", { ...STOPPED, state: "failed", limitBreach: { kind: "budget", limit: 1, measured: 1, breachedAt: "2026-10-01T10:00:08Z" } }],
    ["a stopped Round without its note", { ...STOPPED, outcomeNote: null }],
    ["a stopped Round with no outcomeNote field", { ...STOPPED, outcomeNote: undefined }],
    ["a running Round with a note", { ...STOPPED, state: "running", endedAt: null }],
    ["a delivered Round with a note", { ...STOPPED, state: "delivered", deliverable: { bodyMarkdown: "b", summary: "s", criteriaAssessment: "c" } }],
    ["a stopped Round with a deliverable", { ...STOPPED, deliverable: { bodyMarkdown: "b", summary: "s", criteriaAssessment: "c" } }],
    ["a failed Round without its note", { ...STOPPED, state: "failed", outcomeNote: null }],
    ["an interrupted Round with no outcomeNote field", { ...STOPPED, state: "interrupted", outcomeNote: undefined }],
    ["a failed Round with a deliverable", { ...STOPPED, state: "failed", deliverable: { bodyMarkdown: "b", summary: "s", criteriaAssessment: "c" } }],
    ["an unknown state", { ...STOPPED, state: "abandoned" }],
    ["no earlierActivityCursor field", { ...STOPPED, earlierActivityCursor: undefined }],
    ["a numeric earlierActivityCursor", { ...STOPPED, earlierActivityCursor: 51 }],
    ["no questions field", { ...STOPPED, questions: undefined }],
    ["a question without askedAt", { ...STOPPED, questions: [{ ...QUESTION, askedAt: undefined }] }],
    ["an answer without answeredAt", { ...STOPPED, questions: [{ ...QUESTION, answer: "Europe" }] }],
    ["no feedback field", { ...STOPPED, feedback: undefined }],
    ["feedback without its body", { ...STOPPED, feedback: [{ ...FEEDBACK, body: undefined }] }],
    ["feedback with no consumedBy field", { ...STOPPED, feedback: [{ ...FEEDBACK, consumedBy: undefined }] }],
    ["feedback consumed by a Round without its sequence", { ...STOPPED, feedback: [{ ...FEEDBACK, consumedBy: { roundId: "77777777-7777-4777-8777-777777777777" } }] }],
    ["no permissionRequests field", { ...STOPPED, permissionRequests: undefined }],
    ["a Permission request approved without its grant", { ...STOPPED, permissionRequests: [{ ...REQUEST, grantId: null }] }],
    ["no authorityChecks field", { ...STOPPED, authorityChecks: undefined }],
    ["an allow without its grant", { ...STOPPED, authorityChecks: [{ ...ALLOW, grantId: null }], authorityCheckCount: 1, attestation: null }],
    ["a deny with a grant", { ...STOPPED, authorityChecks: [{ ...DENY, grantId: REQUEST.grantId }], authorityCheckCount: 1, attestation: null }],
    ["a Permission request without renewsGrantId", { ...STOPPED, permissionRequests: [{ ...REQUEST, renewsGrantId: undefined }] }],
    ["a check without expiredGrantId", { ...STOPPED, authorityChecks: [{ ...DENY, expiredGrantId: undefined }], authorityCheckCount: 1, attestation: null }],
    ["an allow that names an expired grant", { ...STOPPED, authorityChecks: [{ ...ALLOW, expiredGrantId: "14141414-1414-4141-8141-141414141414" }], authorityCheckCount: 1, attestation: null }],
    ["a numeric expiredGrantId", { ...STOPPED, authorityChecks: [{ ...DENY, expiredGrantId: 7 }], authorityCheckCount: 1, attestation: null }],
    ["an unknown decision", { ...STOPPED, authorityChecks: [{ ...DENY, decision: "maybe" }], authorityCheckCount: 1, attestation: null }],
    ["a check without checkedAt", { ...STOPPED, authorityChecks: [{ ...DENY, checkedAt: undefined }], authorityCheckCount: 1, attestation: null }],
    ["no authorityCheckCount field", { ...STOPPED, authorityCheckCount: undefined, attestation: null }],
    ["a count below the checks listed", { ...STOPPED, authorityChecks: [DENY, ALLOW], authorityCheckCount: 1, attestation: null }],
    ["a fractional count", { ...STOPPED, authorityCheckCount: 0.5, attestation: null }],
  ])("refuses %s", async (_name, round) => {
    answer([round]);
    await expect(fetchTicketRounds("t")).rejects.toThrow("Galley's Round list was missing a required field.");
  });
});

describe("fetchRoundActivity", () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (body: unknown, status = 200) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: status < 300, status, statusText: "", json: async () => body });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("asks Galley for the page before the cursor and keeps it as returned", async () => {
    const page = { activity: STOPPED.activity, earlierActivityCursor: "opaque/1" };
    const fetchMock = respond(page);
    expect(await fetchRoundActivity("t 1", "r/1", "opaque/1")).toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/t%201/rounds/r%2F1/activity?before=opaque%2F1", undefined);
  });

  it.each([
    ["no activity array", { earlierActivityCursor: null }],
    ["a note without seq", { activity: [{ note: "n", occurredAt: "2026-10-01T10:00:00Z" }], earlierActivityCursor: null }],
    ["no cursor field", { activity: [] }],
  ])("refuses a page with %s", async (_name, body) => {
    respond(body);
    await expect(fetchRoundActivity("t", "r", "1")).rejects.toThrow("Galley's activity page was missing a required field.");
  });

  it("maps 404 to not found, 401 to unauthenticated, and other failures to Galley's status", async () => {
    respond({ error: { code: "not_found", message: "round not found" } }, 404);
    await expect(fetchRoundActivity("t", "r", "1")).rejects.toBeInstanceOf(TicketNotFoundError);
    respond({}, 401);
    await expect(fetchRoundActivity("t", "r", "1")).rejects.toBeInstanceOf(UnauthenticatedError);
    respond({ error: { code: "invalid_cursor", message: "bad" } }, 400);
    await expect(fetchRoundActivity("t", "r", "1")).rejects.toThrow("400");
  });
});

const ATTESTATION = { attestedAt: "2026-10-01T10:05:00Z", basis: "other", note: "Unplugged it", roundState: "running", claimEpoch: 2, holderLastSeenAt: "2026-10-01T10:04:00Z", holderHealth: "disconnected", reconcileExecution: "unknown" };
const ATTESTED = { ...STOPPED, state: "interrupted", outcomeNote: "Ended by Owner attestation: other.", attestation: ATTESTATION };

describe("a Round ended by attestation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the attestation of an Interrupted Round", async () => {
    const claimed = { ...ATTESTED, attestation: { ...ATTESTATION, basis: "runner_host_off", note: null, roundState: "claimed", holderLastSeenAt: null, holderHealth: "replaced", reconcileExecution: null } };
    answer([ATTESTED, claimed]);
    expect(await fetchTicketRounds("t")).toEqual([ATTESTED, claimed]);
  });

  it.each([
    ["on a Round that did not end Interrupted", { ...STOPPED, attestation: ATTESTATION }],
    ["missing", (({ attestation: _a, ...rest }) => rest)(ATTESTED)],
    ["with an unknown basis", { ...ATTESTED, attestation: { ...ATTESTATION, basis: "timeout" } }],
    ["with Other and no note", { ...ATTESTED, attestation: { ...ATTESTATION, note: null } }],
    ["with an ended Round state", { ...ATTESTED, attestation: { ...ATTESTATION, roundState: "delivered" } }],
    ["with an unknown holder health", { ...ATTESTED, attestation: { ...ATTESTATION, holderHealth: "gone" } }],
    ["with an unknown execution", { ...ATTESTED, attestation: { ...ATTESTATION, reconcileExecution: "maybe" } }],
    ["without a claim epoch", { ...ATTESTED, attestation: { ...ATTESTATION, claimEpoch: "2" } }],
  ])("rejects an attestation %s", async (_name, round) => {
    answer([round]);
    await expect(fetchTicketRounds("t")).rejects.toThrow("Galley's Round list was missing a required field.");
  });
});

describe("attestRoundCessation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the basis and note and returns the attested Round", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => ATTESTED });
    vi.stubGlobal("fetch", fetchFn);
    expect(await attestRoundCessation("t/1", "r 1", { basis: "other", note: "Unplugged it" })).toEqual(ATTESTED);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("/api/tickets/t%2F1/rounds/r%201/attest-cessation");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ basis: "other", note: "Unplugged it" });
  });

  it("throws Galley's refusal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request", json: async () => ({ error: { code: "attestation_not_available", message: "attestation needs an open Round" } }) }));
    const refusal = attestRoundCessation("t", "r", { basis: "runner_host_off" });
    await expect(refusal).rejects.toBeInstanceOf(GalleyError);
    await expect(refusal).rejects.toMatchObject({ code: "attestation_not_available", message: "attestation needs an open Round" });
  });

  it("throws on a Round body that is not a Round", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => ({ ...ATTESTED, attestation: undefined }) }));
    await expect(attestRoundCessation("t", "r", { basis: "runner_host_off" })).rejects.toThrow("Galley's attested Round was missing a required field.");
  });
});
