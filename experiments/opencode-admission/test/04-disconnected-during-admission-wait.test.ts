import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { markerAppendCommand, readMarkerLines, scriptBashToolCall, scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

async function waitFor(predicate: () => boolean, attempts = 80, intervalMs = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.ok(predicate(), "waitFor: condition never became true within the polling budget");
}

/**
 * Scenario 3 (issue #20): "disconnected during an approval wait: after
 * reconnect, the approval leads to a fresh admission check before
 * dispatch." As established in
 * test/03-hook-precedes-native-permission-ask.test.ts, this bridge's
 * `tool.execute.before` hook resolves BEFORE OpenCode's own native
 * `permission: { bash: "ask" }` request ever becomes pending on this
 * pinned build -- so a disconnect that occurs while a NATIVE approval is
 * pending cannot be "seen" by an admission check that already finished
 * before that wait even began. The closest, most faithful thing
 * "disconnected during an approval wait" can mean for a hook at this
 * pipeline position is THIS bridge's own admission wait: the bounded
 * hold-poll loop inside `tool.execute.before` while the ledger is
 * disconnected (see src/plugin/admission-plugin.ts). That loop's "wait"
 * *is* the wait ticketIt is admitting/holding on. This test disconnects
 * before the hold-poll begins, lets it run for several iterations (each
 * one a fresh `/admit` call, never a cached decision), reconnects
 * mid-wait, and asserts that the very next poll iteration -- not a stale
 * earlier read -- is what allows dispatch.
 */
test("scenario 3 (bridge admission wait): disconnected during the bridge's own hold-wait, reconnect drives a fresh admit() that then dispatches", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("Done after scenario 3.")],
  });
  await stub.start();

  const admitted = await startAdmittedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    holdPollIntervalMs: 100,
    holdMaxAttempts: 40, // ~4s bounded wait, ample room to observe several holds and then reconnect mid-wait.
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

    const session = await admitted.managed.session.create("m1-20 scenario 3 (bridge admission wait)");
    const promptPromise = admitted.managed.session.promptText(session.id, "please run the marker command");

    // Let several fresh hold-poll iterations happen while still disconnected.
    await waitFor(() => admitted.ledger.decisions().length >= 2);
    for (const decision of admitted.ledger.decisions()) {
      assert.notEqual(decision.decision, "allow", "no admission should be allowed while the ledger is still disconnected");
      assert.equal(decision.reason, "disconnected");
    }
    assert.deepEqual(readMarkerLines(markerFile), [], "the tool must not have executed during the disconnected hold-wait");
    const decisionsBeforeReconnect = admitted.ledger.decisions().length;

    admitted.ledger.setConnected(true);

    await promptPromise;

    assert.deepEqual(readMarkerLines(markerFile), ["executed"], "the tool should execute exactly once after reconnect");
    const decisions = admitted.ledger.decisions();
    assert.ok(decisions.length > decisionsBeforeReconnect, "reconnect must have produced at least one MORE admit() call (a fresh check), not reused a stale pre-reconnect decision");
    const lastDecision = decisions[decisions.length - 1]!;
    assert.equal(lastDecision.decision, "allow", `the fresh post-reconnect check should allow: ${JSON.stringify(lastDecision)}`);
    assert.equal(admitted.ledger.dispatches().length, 1);
    assert.ok(admitted.ledger.dispatches()[0]!.completedAtMs !== undefined, "the dispatch should have completed");

    const messagesJson = JSON.stringify(await admitted.managed.session.messages(session.id));
    assert.ok(messagesJson.includes("Done after scenario 3."), "the session should continue to the scripted follow-up turn");
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
