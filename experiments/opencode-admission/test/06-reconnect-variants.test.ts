import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { markerAppendCommand, readMarkerLines, scriptBashToolCall, scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

/**
 * Scenario 5 (issue #20): reconnect variants, all within ONE continuous
 * OpenCode session/Round, driven deterministically by the ledger's
 * `FakeClock` (never a real wall-clock wait for expiry, per the
 * repository's "timing-sensitive assertions must poll rather than assume
 * a fixed number of ticks" rule -- here expiry needs no polling at all
 * since it is evaluated against a clock this test fully controls):
 *
 * 1. A valid time-based grant admits round 1.
 * 2. Advancing the clock past that grant's expiry denies round 2 with
 *    reason "expired".
 * 3. A NEW valid grant admits round 3, in the SAME OpenCode session --
 *    "a new grant continues the same session ID".
 * 4. Revoking that grant denies round 4 with reason "revoked".
 * 5. A pending Stop denies round 5 with reason "stop-pending" (and takes
 *    precedence even though no grant is currently valid anyway), and the
 *    thrown tool error text surfaces that reason to the model/session --
 *    "surfaces the stop".
 * 6. Confirming the Stop and granting fresh access admits round 6, again
 *    in the SAME session.
 *
 * Every round scripts a "bash" tool call followed by a distinct text
 * turn; per the observed behavior in
 * test/01-disconnected-before-dispatch.test.ts, a denial does not stop
 * the engine from asking the model again, so every round -- allowed or
 * denied -- consumes exactly two queued turns (tool call, then text).
 */
test("scenario 5: expired/revoked/pending-Stop each deny the next dispatch; a fresh grant continues the same session", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    turns: [
      scriptBashToolCall({ command: markerAppendCommand(markerFile, "r1") }),
      scriptTextTurn("after r1"),
      scriptBashToolCall({ command: markerAppendCommand(markerFile, "r2-should-not-run") }),
      scriptTextTurn("after r2"),
      scriptBashToolCall({ command: markerAppendCommand(markerFile, "r3") }),
      scriptTextTurn("after r3"),
      scriptBashToolCall({ command: markerAppendCommand(markerFile, "r4-should-not-run") }),
      scriptTextTurn("after r4"),
      scriptBashToolCall({ command: markerAppendCommand(markerFile, "r5-should-not-run") }),
      scriptTextTurn("after r5"),
      scriptBashToolCall({ command: markerAppendCommand(markerFile, "r6") }),
      scriptTextTurn("after r6"),
    ],
  });
  await stub.start();

  const admitted = await startAdmittedOpenCode({ stub: { baseUrl: `${stub.url}/v1` } });
  try {
    const session = await admitted.managed.session.create("m1-20 scenario 5");
    const sessionId = session.id;

    // Round 1: valid time-based grant, clock at 0, expiresAt 1000 -> allow.
    admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: admitted.action,
      resource: admitted.resource,
      kind: { kind: "time", expiresAt: 1000 },
    });
    await admitted.managed.session.promptText(sessionId, "round 1: run r1");
    assert.deepEqual(readMarkerLines(markerFile), ["r1"]);
    let decisions = admitted.ledger.decisions();
    assert.equal(decisions[decisions.length - 1]!.decision, "allow");

    // Round 2: advance the clock past expiry -> deny "expired".
    admitted.clock.advance(2000); // now = 2000, past expiresAt 1000
    await admitted.managed.session.promptText(sessionId, "round 2: try r2");
    assert.deepEqual(readMarkerLines(markerFile), ["r1"], "round 2 must not have executed: the only grant has expired");
    decisions = admitted.ledger.decisions();
    const round2Decision = decisions[decisions.length - 1]!;
    assert.notEqual(round2Decision.decision, "allow");
    assert.equal(round2Decision.reason, "expired");

    // Round 3: a NEW valid grant -> allow, same session continues.
    const renewedGrant = admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: admitted.action,
      resource: admitted.resource,
      kind: { kind: "time", expiresAt: admitted.clock.nowMs() + 10_000 },
    });
    await admitted.managed.session.promptText(sessionId, "round 3: run r3");
    assert.deepEqual(readMarkerLines(markerFile), ["r1", "r3"], "round 3 should have executed after a fresh grant");
    decisions = admitted.ledger.decisions();
    assert.equal(decisions[decisions.length - 1]!.decision, "allow");
    const sessionAfterRound3 = await admitted.managed.client.session.get({ path: { id: sessionId } });
    assert.equal(sessionAfterRound3.data?.id, sessionId, "round 3 continued the SAME session id");

    // Round 4: revoke the grant just used -> deny "revoked".
    admitted.ledger.revoke(renewedGrant.id);
    await admitted.managed.session.promptText(sessionId, "round 4: try r4");
    assert.deepEqual(readMarkerLines(markerFile), ["r1", "r3"], "round 4 must not have executed: its grant was revoked");
    decisions = admitted.ledger.decisions();
    const round4Decision = decisions[decisions.length - 1]!;
    assert.notEqual(round4Decision.decision, "allow");
    assert.equal(round4Decision.reason, "revoked");

    // Round 5: pending Stop -> deny "stop-pending", surfaced to the model.
    admitted.ledger.requestStop(admitted.roundId);
    await admitted.managed.session.promptText(sessionId, "round 5: try r5");
    assert.deepEqual(readMarkerLines(markerFile), ["r1", "r3"], "round 5 must not have executed: a Stop is pending for this Round");
    decisions = admitted.ledger.decisions();
    const round5Decision = decisions[decisions.length - 1]!;
    assert.notEqual(round5Decision.decision, "allow");
    assert.equal(round5Decision.reason, "stop-pending");
    const messagesAfterRound5 = JSON.stringify(await admitted.managed.session.messages(sessionId));
    assert.ok(messagesAfterRound5.includes("stop-pending"), "the pending Stop's reason must be surfaced in what the model/session sees, not silently swallowed");

    // Round 6: confirm the Stop, grant fresh access -> allow, same session.
    admitted.ledger.confirmStop(admitted.roundId);
    admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: admitted.action,
      resource: admitted.resource,
      kind: { kind: "time", expiresAt: admitted.clock.nowMs() + 10_000 },
    });
    await admitted.managed.session.promptText(sessionId, "round 6: run r6");
    assert.deepEqual(readMarkerLines(markerFile), ["r1", "r3", "r6"], "round 6 should have executed after confirming Stop and granting fresh access");
    decisions = admitted.ledger.decisions();
    assert.equal(decisions[decisions.length - 1]!.decision, "allow");
    const sessionAfterRound6 = await admitted.managed.client.session.get({ path: { id: sessionId } });
    assert.equal(sessionAfterRound6.data?.id, sessionId, "round 6 continued the SAME session id throughout every reconnect variant");
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
