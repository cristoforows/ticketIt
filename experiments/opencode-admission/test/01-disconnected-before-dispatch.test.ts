import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { markerAppendCommand, readMarkerLines, scriptBashToolCall, scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

/**
 * Scenario 1 (issue #20): ledger disconnected before dispatch. A valid
 * grant exists (so the ONLY reason this call is not admitted is the
 * disconnect, not a missing grant), but `setConnected(false)` happens
 * before the prompt is even sent, and the ledger never reconnects during
 * this test. Per `AdmissionLedger#admit`'s precedence rules, an
 * otherwise-valid grant while disconnected evaluates to "hold", not
 * "deny" (experiments/shared/src/admission-ledger.ts). This bridge's
 * `tool.execute.before` hold-polls a bounded number of times (see
 * `src/plugin/admission-plugin.ts`) and, since the ledger never
 * reconnects here, every poll still returns "hold" — so from the tool's
 * and the model's point of view this is exactly "the tool is not
 * executed", proven with the marker file.
 *
 * This test also captures what happens to the model/session when the
 * hook denies: the exact stub-request count, whether the engine asks the
 * model again after the thrown error (continuing to the scripted
 * follow-up turn), and the tool-call content the model actually saw.
 * These are the "how OpenCode reacts to a hook denial" findings issue #20
 * asks to be recorded — see docs/evidence/m1/20-opencode-admission.md.
 */
test("scenario 1: disconnected before dispatch -> tool not executed, hold exhausted, denial recorded", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("Done after scenario 1.")],
  });
  await stub.start();

  // Small bounded hold window so the test doesn't wait ~4.5s for nothing.
  const admitted = await startAdmittedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    holdPollIntervalMs: 100,
    holdMaxAttempts: 5, // ~500ms bounded wait
  });
  try {
    admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: admitted.action,
      resource: admitted.resource,
      kind: { kind: "ticket", ticketId: admitted.ticketId },
    });
    admitted.ledger.setConnected(false);

    const session = await admitted.managed.session.create("m1-20 scenario 1");
    await admitted.managed.session.promptText(session.id, "please run the marker command");

    // The tool must not have executed.
    assert.deepEqual(readMarkerLines(markerFile), [], "the marker file must show zero executions while disconnected");

    // The ledger must show a "hold" decision (not allow), never zero
    // acceptance-criterion admissions "recorded ... while disconnected"
    // means no *allow*; a recorded hold decision itself is the ledger
    // correctly refusing new admission, which is what this asserts.
    const decisions = admitted.ledger.decisions();
    assert.ok(decisions.length >= 1, "the ledger should have recorded at least one admit() attempt");
    for (const decision of decisions) {
      assert.notEqual(decision.decision, "allow", `no admission should have been allowed while disconnected: ${JSON.stringify(decision)}`);
      assert.equal(decision.reason, "disconnected");
    }
    assert.equal(admitted.ledger.dispatches().length, 0, "nothing should have been dispatched");

    // Record what the model/session actually saw.
    const messages = (await admitted.managed.session.messages(session.id)) as unknown[];
    const messagesJson = JSON.stringify(messages);
    const completionRequests = stub.requests.filter((entry) => entry.url.startsWith("/v1/chat/completions"));

    // Recorded, not asserted as a hard requirement either way (see
    // docs/evidence/m1/20-opencode-admission.md for the exact observed
    // behavior): does the engine deliver the thrown error back to the
    // model as a tool result and continue the conversation (consuming the
    // scripted follow-up turn), or does it stop without asking the model
    // again? Both are legitimate engine behaviors; this test records
    // which one this pinned build does.
    const continuedToFollowUpTurn = messagesJson.includes("Done after scenario 1.");
    const toolErrorSurfaced = messagesJson.includes("ticketit-admission") && messagesJson.includes("not admitted");

    assert.ok(toolErrorSurfaced, `expected the thrown admission-denial error text to appear somewhere in session messages: ${messagesJson}`);

    // Whichever branch this pinned build takes, log it plainly so the
    // evidence record can quote an unambiguous fact rather than an
    // assumption.
    console.log(
      JSON.stringify({
        scenario: "1-disconnected-before-dispatch",
        completionRequestCount: completionRequests.length,
        continuedToFollowUpTurn,
        toolErrorSurfaced,
      }),
    );
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
