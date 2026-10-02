import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTicketRounds } from "./rounds";

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
  ])("refuses %s", async (_name, round) => {
    answer([round]);
    await expect(fetchTicketRounds("t")).rejects.toThrow("Galley's Round list was missing a required field.");
  });
});
