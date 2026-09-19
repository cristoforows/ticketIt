import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { markerAppendCommand, readMarkerLines, scriptBashToolCall, scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

/**
 * Pilot/baseline: the plugin loads for this pinned build, a valid grant
 * admits the shell tool call, and the ledger records exactly one allow +
 * one dispatch + one completion. This is the positive control every
 * scenario test below builds on.
 */
test("baseline: plugin loads, a valid grant admits the shell tool, ledger records allow/dispatch/complete", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("Done after baseline admission.")],
  });
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

    const session = await admitted.managed.session.create("m1-20 baseline");
    await admitted.managed.session.promptText(session.id, "please run the marker command");

    const markerLines = readMarkerLines(markerFile);
    assert.equal(markerLines.length, 1, `expected exactly one execution, got: ${JSON.stringify(markerLines)}`);

    const messagesJson = JSON.stringify(await admitted.managed.session.messages(session.id));
    assert.ok(messagesJson.includes("Done after baseline admission."), "session should continue to the scripted follow-up turn");

    const decisions = admitted.ledger.decisions();
    assert.equal(decisions.length, 1, `expected exactly one admit() call, got: ${JSON.stringify(decisions)}`);
    assert.equal(decisions[0]!.decision, "allow");
    assert.equal(decisions[0]!.request.roundId, admitted.roundId);
    assert.equal(decisions[0]!.request.ticketId, admitted.ticketId);

    const dispatches = admitted.ledger.dispatches();
    assert.equal(dispatches.length, 1, `expected exactly one dispatch, got: ${JSON.stringify(dispatches)}`);
    assert.ok(dispatches[0]!.completedAtMs !== undefined, "the dispatch should have been marked completed by tool.execute.after");
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
