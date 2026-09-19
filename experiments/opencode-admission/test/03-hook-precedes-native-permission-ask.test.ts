import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listPending, markerAppendCommand, readMarkerLines, replyPermission, scriptBashToolCall, scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

/**
 * Pipeline-ordering finding, load-bearing for how scenario 3 ("disconnected
 * during an approval wait") had to be designed (see
 * test/04-disconnected-during-admission-wait.test.ts and
 * docs/evidence/m1/20-opencode-admission.md, "Observed limitations"):
 * on this pinned build, with a bash tool call gated by BOTH this bridge's
 * `tool.execute.before` plugin hook AND OpenCode's own native
 * `permission: { bash: "ask" }` config, the plugin hook resolves (and, on
 * "allow", dispatches against the ledger) BEFORE the native permission
 * request ever becomes visible/pending, not after. Concretely: with a
 * valid grant and a connected ledger, `ledger.decisions()` and
 * `ledger.dispatches()` already show one entry the first moment
 * `listPending(...)` reports the native permission request pending, and
 * the shell command itself has not run yet at that point (native approval
 * still gates the actual execution). This means a plugin at this hook
 * position cannot implement "one fresh check strictly after a native
 * human approval, immediately before dispatch" for a tool also gated by
 * native "ask" permission -- tool.execute.before IS the pre-flight check,
 * and it runs first.
 */
test("ordering: tool.execute.before (and this bridge's admit+dispatch) resolves before the native permission request becomes pending", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("Done after ordering probe.")],
  });
  await stub.start();

  const admitted = await startAdmittedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    extraConfig: { permission: { bash: "ask" } },
  });
  try {
    admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: admitted.action,
      resource: admitted.resource,
      kind: { kind: "ticket", ticketId: admitted.ticketId },
    });

    const session = await admitted.managed.session.create("m1-20 ordering probe");
    const promptPromise = admitted.managed.session.promptText(session.id, "please run the marker command");

    let pending = await listPending(admitted.managed.v2Client, session.id);
    for (let i = 0; i < 40 && pending.permissions.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      pending = await listPending(admitted.managed.v2Client, session.id);
    }
    assert.equal(pending.permissions.length, 1, "a native permission request should be pending");

    // At the FIRST instant the native permission request is observed
    // pending, this bridge's hook has already run to completion: exactly
    // one admit() decision (allow) and one dispatch already recorded, and
    // the tool has NOT executed yet (native approval still gates the
    // actual run).
    assert.equal(admitted.ledger.decisions().length, 1, "the plugin hook should have already admitted before the native permission became pending");
    assert.equal(admitted.ledger.decisions()[0]!.decision, "allow");
    assert.equal(admitted.ledger.dispatches().length, 1, "the plugin hook should have already recorded a dispatch before the native permission became pending");
    assert.equal(admitted.ledger.dispatches()[0]!.completedAtMs, undefined, "the dispatch must not be complete yet -- native approval still gates actual execution");
    assert.deepEqual(readMarkerLines(markerFile), [], "the shell command must not have run yet");

    const replyResult = await replyPermission(admitted.managed.v2Client, pending.permissions[0]!.id, "once");
    assert.equal(replyResult.ok, true);
    await promptPromise;

    assert.deepEqual(readMarkerLines(markerFile), ["executed"], "the shell command should run exactly once after the native approval");
    assert.equal(admitted.ledger.decisions().length, 1, "no second admit() call should have happened for this same tool call");
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
