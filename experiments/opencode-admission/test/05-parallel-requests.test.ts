import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { markerAppendCommand, readMarkerLines, scriptTextTurn, StubModelServer, type ScriptedTurn } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

async function waitFor(predicate: () => boolean, attempts = 80, intervalMs = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.ok(predicate(), "waitFor: condition never became true within the polling budget");
}

/**
 * Scenario 4 (issue #20): parallel requests. One scripted assistant turn
 * carries TWO "bash" tool calls at once (`toolCalls` with two entries,
 * OpenAI-style parallel tool calling), rather than `scriptBashToolCall`'s
 * single-call helper, so the stub returns both in one completion
 * response. Both must pass through this bridge's admission hook and both
 * decisions must be recorded by the ledger, correlated by their distinct
 * `callID`s (see `dispatchedByCallId` in src/plugin/admission-plugin.ts).
 */
test("scenario 4: parallel tool calls both pass through admission and are both recorded", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const parallelTurn: ScriptedTurn = {
    content: "",
    toolCalls: [
      { id: "call_parallel_a", name: "bash", arguments: JSON.stringify({ command: markerAppendCommand(markerFile, "a") }) },
      { id: "call_parallel_b", name: "bash", arguments: JSON.stringify({ command: markerAppendCommand(markerFile, "b") }) },
    ],
  };

  const stub = new StubModelServer({ turns: [parallelTurn, scriptTextTurn("Done after parallel calls.")] });
  await stub.start();

  const admitted = await startAdmittedOpenCode({ stub: { baseUrl: `${stub.url}/v1` } });
  try {
    admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: admitted.action,
      resource: admitted.resource,
      kind: { kind: "ticket", ticketId: admitted.ticketId },
    });

    const session = await admitted.managed.session.create("m1-20 scenario 4");
    await admitted.managed.session.promptText(session.id, "run both marker commands in parallel");

    await waitFor(() => readMarkerLines(markerFile).length === 2);
    const markerLines = readMarkerLines(markerFile).sort();
    assert.deepEqual(markerLines, ["a", "b"], "both parallel shell calls should have executed exactly once each");

    const decisions = admitted.ledger.decisions();
    assert.equal(decisions.length, 2, `expected exactly two admit() calls, got: ${JSON.stringify(decisions)}`);
    assert.ok(decisions.every((d) => d.decision === "allow"), "both parallel calls should have been allowed");
    assert.notEqual(decisions[0]!.admissionId, decisions[1]!.admissionId, "the two parallel calls must have distinct admission ids");

    const dispatches = admitted.ledger.dispatches();
    assert.equal(dispatches.length, 2, `expected exactly two dispatches, got: ${JSON.stringify(dispatches)}`);
    assert.ok(
      dispatches.every((d) => d.completedAtMs !== undefined),
      "both parallel dispatches should have completed",
    );

    const messagesJson = JSON.stringify(await admitted.managed.session.messages(session.id));
    assert.ok(messagesJson.includes("Done after parallel calls."), "the session should continue to the scripted follow-up turn");
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
