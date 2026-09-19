import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

/**
 * Issue #21, priority row 2: model-only continuation. The stub is scripted
 * with SEVERAL assistant turns that invoke no tool at all (plain text
 * only). With the ledger disconnected (the issue's own framing: "with the
 * ledger disconnected, determine what, if anything, stops the next model
 * call"), send several prompts in a row and observe what happens.
 *
 * This bridge's only hook is `tool.execute.before`/`tool.execute.after`
 * (see `src/plugin/admission-plugin.ts`): both fire exclusively when
 * OpenCode's engine actually dispatches a registered tool. A turn that
 * produces no tool call never reaches either hook -- there is structurally
 * no code path by which this bridge's admission check can run for it. This
 * test proves that directly: with the ledger fully disconnected (which
 * would hold/deny *every* tool-based action, per every other test in this
 * suite), a sequence of text-only turns completes normally end to end, the
 * ledger records ZERO admit() calls for the whole sequence, and nothing
 * about the interaction is degraded or delayed by the disconnect.
 *
 * This is a genuine, structural coverage gap for D1, not a bug in this
 * bridge: "model-only continuation" -- the model producing more text (an
 * assistant message, more "thinking", a bare status update, a fabricated
 * claim of completed work) -- has no associated tool-execution event for a
 * plugin hook to intercept. Recorded here as a failed gate per issue #21's
 * instructions, with candidate mechanisms proposed (never decided) in the
 * evidence record.
 */
test("model-only continuation: text-only turns are not gated at all -- zero admit() calls even fully disconnected", async () => {
  const stub = new StubModelServer({
    turns: [
      scriptTextTurn("First model-only reply, no tool call."),
      scriptTextTurn("Second model-only reply, no tool call."),
      scriptTextTurn("Third model-only reply, claiming work is done with no verifiable action."),
    ],
  });
  await stub.start();

  const admitted = await startAdmittedOpenCode({ stub: { baseUrl: `${stub.url}/v1` } });
  try {
    // Deliberately no grant() at all, and the ledger disconnected -- the
    // strictest possible admission posture, applied to confirm it has zero
    // effect on a tool-free interaction.
    admitted.ledger.setConnected(false);

    const session = await admitted.managed.session.create("m1-21 model-only continuation");

    await admitted.managed.session.promptText(session.id, "just talk, don't run anything");
    await admitted.managed.session.promptText(session.id, "keep talking");
    await admitted.managed.session.promptText(session.id, "tell me you're done");

    const messagesJson = JSON.stringify(await admitted.managed.session.messages(session.id));
    assert.ok(messagesJson.includes("First model-only reply"), "the first text-only turn should have been delivered normally");
    assert.ok(messagesJson.includes("Second model-only reply"), "the second text-only turn should have been delivered normally");
    assert.ok(messagesJson.includes("Third model-only reply"), "the third text-only turn should have been delivered normally");

    // The load-bearing assertion: a fully disconnected ledger -- which
    // holds/denies every tool-gated action in every other test in this
    // suite -- had literally nothing to admit, hold, or deny here, because
    // no tool was ever invoked. Nothing "stopped the next model call";
    // nothing COULD, at this hook position.
    assert.equal(admitted.ledger.decisions().length, 0, "zero admit() calls should have been made for a purely text-only interaction, regardless of ledger connectivity");
    assert.equal(admitted.ledger.dispatches().length, 0);

    const completionRequests = stub.requests.filter((entry) => entry.url.startsWith("/v1/chat/completions"));
    assert.equal(completionRequests.length, 3, "all three prompts should have reached the model with no admission-related delay or interruption");
  } finally {
    await admitted.close();
    await stub.close();
  }
});
