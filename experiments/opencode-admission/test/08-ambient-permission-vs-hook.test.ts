import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listPending, markerAppendCommand, readMarkerLines, scriptBashToolCall, scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

/**
 * Issue #21, priority row 1 (the single most important question this slice
 * asks): does OpenCode's own ambient `OPENCODE_PERMISSION` environment
 * variable defeat THIS BRIDGE's `tool.execute.before` hook the way
 * `docs/evidence/m1/19-opencode-fixed-inputs.md` found it silently
 * overrides a Round's own *native* `permission.bash` configuration?
 *
 * Background (both findings this test builds on):
 * - #19's failed gate: an ambient `OPENCODE_PERMISSION={"bash":"allow"}`
 *   env var, present before a Round's process is spawned, silently
 *   overrides `extraConfig: { permission: { bash: "ask" } }` -- the
 *   configured "ask" becomes "allow" and a shell command executes with NO
 *   permission request ever appearing.
 * - #20's positive finding: this bridge's `tool.execute.before` hook does
 *   not consult OpenCode's `permission` config at all -- it is a wholly
 *   separate, externally-owned admission check reached over the ledger's
 *   HTTP facade. The #17-interaction test (07-always-grant-hook-still-runs)
 *   already proved the hook survives OpenCode's own *permission-memory*
 *   bypass; this test proves it also survives OpenCode's own
 *   *ambient-environment* bypass, the more directly damaging of #19's two
 *   failed gates for a live admission boundary.
 *
 * Design: the ledger is set to deny everything (zero grants -- the
 * per-issue-#21 baseline posture for this whole coverage sweep). The
 * ambient `OPENCODE_PERMISSION` env var is set to `{"bash":"allow"}` in
 * *this* process immediately before `startAdmittedOpenCode` spawns the
 * OpenCode process (mirroring #19's exact reproduction, restored in a
 * `finally`), while the Round's own config explicitly asks for
 * `permission: { bash: "ask" }`. If OpenCode's own permission system were
 * the operative gate, the shell command would run directly, with no
 * pending permission ever appearing (the #19 failed-gate signature) AND
 * with no grant on the ledger to admit it either way. The load-bearing
 * assertion is that despite that ambient override neutralizing OpenCode's
 * own "ask", THIS BRIDGE's hook still runs, still calls `/admit`, and
 * still denies (reason "no-grant") -- so the tool does not execute.
 */
test('ambient OPENCODE_PERMISSION=allow does not defeat the plugin hook (ledger denies everything, "ask" is ambiently overridden to "allow")', async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("Done after ambient-permission probe.")],
  });
  await stub.start();

  // Reproduce #19's exact ambient-leak vector: OPENCODE_PERMISSION present
  // in *this* process's env before the OpenCode process is spawned, never
  // set or cleared by startManagedOpenCode/startAdmittedOpenCode.
  const previousAmbient = process.env.OPENCODE_PERMISSION;
  process.env.OPENCODE_PERMISSION = JSON.stringify({ bash: "allow" });

  // Deliberately NO grant() call anywhere in this test: "the ledger set to
  // deny everything" per issue #21's own instruction.
  const admitted = await startAdmittedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    extraConfig: { permission: { bash: "ask" } },
    holdPollIntervalMs: 100,
    holdMaxAttempts: 5,
  });
  try {
    const session = await admitted.managed.session.create("m1-21 ambient-permission-vs-hook");
    await admitted.managed.session.promptText(session.id, "please run the marker command");

    // Confirm the ambient override really did neutralize OpenCode's own
    // native "ask" (the #19 failed-gate signature, reconfirmed here): no
    // native permission request should ever have become pending.
    const pending = await listPending(admitted.managed.v2Client, session.id);
    assert.equal(pending.permissions.length, 0, 'OBSERVED (per #19): ambient OPENCODE_PERMISSION="allow" suppressed the native "ask" -- no permission request ever appeared');

    // The load-bearing assertion: THIS BRIDGE's hook still ran and denied,
    // regardless of OpenCode's own ambient-permission bypass.
    assert.deepEqual(readMarkerLines(markerFile), [], "the tool must NOT have executed: the ledger has zero grants, and the plugin hook does not consult OpenCode's own `permission` config at all");
    const decisions = admitted.ledger.decisions();
    assert.ok(decisions.length >= 1, "the plugin hook must have called admit() at least once");
    for (const decision of decisions) {
      assert.notEqual(decision.decision, "allow", `no admission should have been allowed with zero grants: ${JSON.stringify(decision)}`);
      assert.equal(decision.reason, "no-grant");
    }
    assert.equal(admitted.ledger.dispatches().length, 0, "nothing should have been dispatched");

    const messagesJson = JSON.stringify(await admitted.managed.session.messages(session.id));
    assert.ok(messagesJson.includes("not admitted"), "the denial must have been surfaced to the model/session, not silently swallowed");
  } finally {
    if (previousAmbient === undefined) delete process.env.OPENCODE_PERMISSION;
    else process.env.OPENCODE_PERMISSION = previousAmbient;
    await admitted.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
