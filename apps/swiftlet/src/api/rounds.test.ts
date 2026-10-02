import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "./session";
import { fetchRoundActivity, fetchTicketRounds } from "./rounds";
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
  usage,
  deliverable: null,
};

const answer = (rounds: unknown[]) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => ({ rounds }) }));

describe("fetchTicketRounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a stopped Round's outcome note, activity and usage", async () => {
    answer([STOPPED, { ...STOPPED, id: "77777777-7777-4777-8777-777777777777", state: "running", startedAt: "2026-10-01T10:00:05Z", endedAt: null, outcomeNote: null }]);
    expect(await fetchTicketRounds("t")).toEqual([STOPPED, { ...STOPPED, id: "77777777-7777-4777-8777-777777777777", state: "running", startedAt: "2026-10-01T10:00:05Z", endedAt: null, outcomeNote: null }]);
  });

  it.each([
    ["failed", "The repository is gone."],
    ["interrupted", "The engine process exited with signal 9."],
  ])("keeps a %s Round's outcome note, activity and usage", async (state, outcomeNote) => {
    const ended = { ...STOPPED, state, startedAt: "2026-10-01T10:00:05Z", outcomeNote };
    answer([ended]);
    expect(await fetchTicketRounds("t")).toEqual([ended]);
  });

  it.each([
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
