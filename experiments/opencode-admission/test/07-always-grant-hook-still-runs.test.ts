import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listPending, markerAppendCommand, readMarkerLines, replyPermission, scriptBashToolCall, scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

async function pendingPermissionCountAfterShortWait(
  managed: Awaited<ReturnType<typeof startAdmittedOpenCode>>["managed"],
  sessionId: string,
  attempts = 12,
  intervalMs = 150,
): Promise<number> {
  let max = 0;
  for (let i = 0; i < attempts; i++) {
    const pending = await listPending(managed.v2Client, sessionId);
    max = Math.max(max, pending.permissions.length);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return max;
}

/**
 * CRITICAL interaction with issue #17's finding (see
 * docs/evidence/m1/17-opencode-questions.md, "once versus always"): a
 * remembered "always" reply to OpenCode's own native
 * `permission: { bash: "ask" }` was observed to suppress the engine's
 * own permission prompt for later bash calls, including in a brand-new
 * session in the same project. That finding is exactly why D1 cannot
 * treat the engine's own permission memory as ticketIt's authority
 * boundary: a Round/Ticket-scoped revocation on ticketIt's side would not
 * by itself stop the engine from silently auto-approving a later action.
 *
 * This test explicitly checks whether THIS BRIDGE's `tool.execute.before`
 * hook still runs when the engine has such a remembered "always" grant.
 * If it does, external admission is a viable gate despite engine memory
 * (D1's central question for this slice); if it does not, that is a
 * failed gate for D1, and this test would need to say so plainly rather
 * than being weakened to pass.
 *
 * Design: round 1 replies "always" to the native ask (so the engine
 * remembers it, per #17). The grant this bridge's ledger holds is then
 * REVOKED before round 2, in the SAME session. If the hook still runs,
 * round 2 must be denied (reason "revoked") and must NOT execute, even
 * though the engine's own gate would otherwise let it straight through
 * with no further prompt at all (confirmed here by polling for a pending
 * native permission and finding none). Round 3 then grants fresh access
 * and confirms the same session can still continue once authority is
 * restored -- proving the bridge, not engine memory, is the operative
 * gate throughout.
 */
test('critical #17 interaction: hook still runs (and still gates) under a remembered "always" native grant', async () => {
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
    ],
  });
  await stub.start();

  const admitted = await startAdmittedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    extraConfig: { permission: { bash: "ask" } },
  });
  try {
    const grant = admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: admitted.action,
      resource: admitted.resource,
      kind: { kind: "ticket", ticketId: admitted.ticketId },
    });

    const session = await admitted.managed.session.create("m1-20 always-grant interaction");
    const sessionId = session.id;

    // Round 1: native ask pending (this bridge's hook already admitted
    // before this point, per test/03-hook-precedes-native-permission-ask.test.ts).
    const round1PromptPromise = admitted.managed.session.promptText(sessionId, "round 1: run r1");
    let pending = await listPending(admitted.managed.v2Client, sessionId);
    for (let i = 0; i < 40 && pending.permissions.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      pending = await listPending(admitted.managed.v2Client, sessionId);
    }
    assert.equal(pending.permissions.length, 1, "round 1 should raise a native permission request");

    const alwaysReply = await replyPermission(admitted.managed.v2Client, pending.permissions[0]!.id, "always");
    assert.equal(alwaysReply.ok, true, `replying "always" should succeed: ${JSON.stringify(alwaysReply.error)}`);
    await round1PromptPromise;

    assert.deepEqual(readMarkerLines(markerFile), ["r1"], "round 1 should have executed exactly once");
    assert.equal(admitted.ledger.decisions()[0]!.decision, "allow");

    // Revoke the grant used by round 1, so round 2's ONLY path to
    // admission is gone. If the engine's remembered "always" were the
    // operative gate, round 2 would run without any check at all.
    admitted.ledger.revoke(grant.id);

    const decisionsBeforeRound2 = admitted.ledger.decisions().length;
    const round2PromptPromise = admitted.managed.session.promptText(sessionId, "round 2: try r2");

    // Confirm the engine's own gate really is bypassed this time (the
    // #17 finding, reconfirmed here): no native permission request ever
    // becomes pending for round 2.
    const maxPendingDuringRound2 = await pendingPermissionCountAfterShortWait(admitted.managed, sessionId);

    await round2PromptPromise;

    assert.equal(maxPendingDuringRound2, 0, 'OBSERVED (per #17): a remembered "always" reply suppressed the native permission ask for round 2 -- the engine never asked again');

    // The load-bearing assertion: THIS BRIDGE's hook still ran for round 2
    // despite the engine's own gate being silently bypassed, and it still
    // denied (the grant is revoked), so the tool did NOT execute.
    assert.ok(
      admitted.ledger.decisions().length > decisionsBeforeRound2,
      'the plugin hook must still have called admit() for round 2 even though OpenCode\'s own "always" memory bypassed its native permission prompt -- this is the D1 finding this test exists to prove',
    );
    const round2Decision = admitted.ledger.decisions()[admitted.ledger.decisions().length - 1]!;
    assert.notEqual(round2Decision.decision, "allow", "round 2 must be denied: its only grant was revoked, regardless of engine memory");
    assert.equal(round2Decision.reason, "revoked");
    assert.deepEqual(readMarkerLines(markerFile), ["r1"], "round 2 must NOT have executed: the external bridge, not engine memory, is the operative gate");

    // Round 3: restore authority. Same session continues, still no
    // native ask (persistent "always" memory), and this bridge's hook
    // still runs and now allows.
    admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: admitted.action,
      resource: admitted.resource,
      kind: { kind: "ticket", ticketId: admitted.ticketId },
    });
    const decisionsBeforeRound3 = admitted.ledger.decisions().length;
    await admitted.managed.session.promptText(sessionId, "round 3: run r3");

    assert.deepEqual(readMarkerLines(markerFile), ["r1", "r3"], "round 3 should execute once fresh authority is granted");
    assert.ok(admitted.ledger.decisions().length > decisionsBeforeRound3, "the hook ran again for round 3");
    assert.equal(admitted.ledger.decisions()[admitted.ledger.decisions().length - 1]!.decision, "allow");

    const sessionAfter = await admitted.managed.client.session.get({ path: { id: sessionId } });
    assert.equal(sessionAfter.data?.id, sessionId, "the same session continued across every round of this test");
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
