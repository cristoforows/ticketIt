import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StubModelServer,
  listPending,
  replyQuestion,
  scriptQuestionToolCall,
  scriptTextTurn,
  startManagedOpenCode,
  subscribeEvents,
} from "../src/index.js";

/**
 * M1.6 test 2 (question round trip). The pinned version (opencode-ai /
 * @opencode-ai/sdk 1.18.31) DOES expose a question mechanism: a built-in
 * `"question"` tool (confirmed via `client.tool.ids()`/`client.tool.list()`
 * against a running instance — see docs/evidence/m1/17-opencode-questions.md),
 * a `question.asked`/`question.replied` event pair on the live event
 * stream, and query/reply REST endpoints (`GET /question`,
 * `POST /question/{requestID}/reply`) exposed by the `/v2` SDK client as
 * `client.question.list()`/`.reply()`. This test scripts that tool,
 * observes the request both ways, answers it, and verifies the answer is
 * delivered back to the model exactly once.
 */
test("question round trip: observed via events and listPending, answered, continuation includes the answer once", async () => {
  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [
      scriptQuestionToolCall({
        questions: [
          {
            question: "Which approach do you want?",
            header: "Approach",
            options: [
              { label: "Option A", description: "First approach" },
              { label: "Option B", description: "Second approach" },
            ],
          },
        ],
      }),
      scriptTextTurn("Thanks, continuing after your answer."),
    ],
  });
  await stub.start();

  const managed = await startManagedOpenCode({ stub: { baseUrl: `${stub.url}/v1` } });

  try {
    const session = await managed.session.create("m1-17 question round trip");

    const subscription = await subscribeEvents(managed.client);
    try {
      const promptPromise = managed.session.promptText(session.id, "please ask me a question");

      let pending = await listPending(managed.v2Client, session.id);
      for (let i = 0; i < 40 && pending.questions.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        pending = await listPending(managed.v2Client, session.id);
      }
      assert.equal(pending.questions.length, 1, "listPending should observe exactly one pending question request");
      const questionRequest = pending.questions[0]!;
      assert.equal(questionRequest.sessionID, session.id);

      const questionEvent = subscription.events.find(
        (entry) =>
          typeof entry.event === "object" &&
          entry.event !== null &&
          (entry.event as { type?: string }).type === "question.asked" &&
          (entry.event as { properties?: { id?: string } }).properties?.id === questionRequest.id,
      );
      assert.ok(questionEvent, "the pending question request should also have been observed via the event stream (question.asked)");

      const replyResult = await replyQuestion(managed.v2Client, questionRequest.id, [["Option A"]]);
      assert.equal(replyResult.ok, true, `answering the question should succeed: ${JSON.stringify(replyResult.error)}`);

      await promptPromise;

      const messages = (await managed.session.messages(session.id)) as Array<{ parts: Array<Record<string, unknown>> }>;
      const messagesJson = JSON.stringify(messages);
      assert.ok(messagesJson.includes("Thanks, continuing after your answer."), "the session should continue to the scripted follow-up turn");

      // The answer must be delivered to the model exactly once: exactly one
      // "tool" part for this call id (no duplicate execution/delivery), and
      // its recorded answer metadata is exactly the single answer given.
      const toolParts = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && (part as { callID?: string }).callID === (questionRequest.tool as { callID?: string } | undefined)?.callID);
      assert.equal(toolParts.length, 1, `expected exactly one tool part for the question's callID, found ${toolParts.length}`);
      const state = (toolParts[0] as { state?: { status?: string; metadata?: { answers?: unknown } } }).state;
      assert.equal(state?.status, "completed", "the question tool call should have completed exactly once");
      assert.deepEqual(state?.metadata?.answers, [["Option A"]], "the answer delivered back to the model should be exactly the one given, once");

      // Recovering the same request through the pending query a second
      // time (after it was answered) must report it as no longer pending.
      const afterReply = await listPending(managed.v2Client, session.id);
      assert.equal(afterReply.questions.length, 0, "the question must no longer be pending after being answered");
    } finally {
      subscription.stop();
      await subscription.closed;
    }
  } finally {
    await managed.close();
    await stub.close();
  }
});
