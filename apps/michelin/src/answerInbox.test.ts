import { describe, expect, it } from "vitest";
import { AnswerInbox, ApprovalInbox, type ReceivedAnswer } from "./answerInbox.ts";

const answer = (text: string): ReceivedAnswer => ({ text, acknowledge: async () => {} });

describe("AnswerInbox", () => {
  it("hands an answer that arrived first to the later wait, once", async () => {
    const inbox = new AnswerInbox();
    inbox.deliver("q1", answer("first"));
    inbox.deliver("q1", answer("second"));
    expect((await inbox.wait("q1", new AbortController().signal))?.text).toBe("first");
    const later = new AbortController();
    const pending = inbox.wait("q1", later.signal);
    later.abort();
    expect(await pending).toBeUndefined();
  });

  it("resolves a waiting question only with its own answer", async () => {
    const inbox = new AnswerInbox();
    const pending = inbox.wait("q1", new AbortController().signal);
    inbox.deliver("q2", answer("other"));
    inbox.deliver("q1", answer("mine"));
    expect((await pending)?.text).toBe("mine");
    expect((await inbox.wait("q2", new AbortController().signal))?.text).toBe("other");
  });

  it("answers an aborted wait with undefined and keeps a later answer for the next wait", async () => {
    const inbox = new AnswerInbox();
    const aborted = new AbortController();
    aborted.abort();
    expect(await inbox.wait("q1", aborted.signal)).toBeUndefined();
    const stop = new AbortController();
    const pending = inbox.wait("q1", stop.signal);
    stop.abort();
    expect(await pending).toBeUndefined();
    inbox.deliver("q1", answer("late"));
    expect((await inbox.wait("q1", new AbortController().signal))?.text).toBe("late");
  });
});

describe("ApprovalInbox", () => {
  it("resolves a waiting Permission request only with its own approval, once", async () => {
    const inbox = new ApprovalInbox();
    const pending = inbox.wait("r1", new AbortController().signal);
    inbox.deliver("r2", { grantId: "g2", acknowledge: async () => {} });
    inbox.deliver("r1", { grantId: "g1", acknowledge: async () => {} });
    inbox.deliver("r1", { grantId: "again", acknowledge: async () => {} });
    expect((await pending)?.grantId).toBe("g1");
    expect((await inbox.wait("r2", new AbortController().signal))?.grantId).toBe("g2");
    expect((await inbox.wait("r1", new AbortController().signal))?.grantId).toBe("again");
  });
});
