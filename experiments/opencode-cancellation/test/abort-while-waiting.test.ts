import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  StubModelServer,
  listPending,
  markerAppendCommand,
  readMarkerLines,
  replyPermission,
  scriptBashToolCall,
  scriptTextTurn,
  startManagedOpenCode,
} from "opencode-harness";

/**
 * M1.7 scenario 2 (abort while waiting). A scripted "bash" tool call is
 * blocked on a permission request (`permission.bash: "ask"`, the same
 * isolated-project-config mechanism M1.6's permission-round-trip test
 * uses). `session.abort()` is called while that request is still pending.
 *
 * Observed (see docs/evidence/m1/18-opencode-cancellation.md for the ad
 * hoc probe that established this before writing this test): the pending
 * permission request is *not* cleared by abort -- `listPending` still
 * returns the identical request afterward. Replying to it after the abort
 * still returns `{ok: true}` (it does not error), but has no observable
 * side effect: the scripted marker command is never actually run, because
 * the turn it belonged to already ended. A *second* reply to the same
 * (now-consumed) request id then fails exactly the way M1.6's
 * duplicate-reply test observed (404 `PermissionNotFoundError`) --
 * consistent with that finding, not a new mechanism.
 */
test("abort while waiting: pending permission is not cleared by abort; a reply after abort succeeds but has no effect", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-cancellation-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("Done after permission (unreachable).")],
  });
  await stub.start();

  const managed = await startManagedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    extraConfig: { permission: { bash: "ask" } },
  });

  try {
    const session = await managed.session.create("m1-18 abort while waiting");

    const promptPromise = managed.session.promptText(session.id, "please run the marker command");
    promptPromise.catch(() => {});

    let pendingBefore = await listPending(managed.v2Client, session.id);
    for (let i = 0; i < 40 && pendingBefore.permissions.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      pendingBefore = await listPending(managed.v2Client, session.id);
    }
    assert.equal(pendingBefore.permissions.length, 1, "a permission request should be pending before abort");
    const requestId = pendingBefore.permissions[0]!.id;

    const abortResult = await managed.client.session.abort({ path: { id: session.id } });
    assert.equal(abortResult.data, true, `abort() should report success: ${JSON.stringify(abortResult.error)}`);

    // Bounded settle window, then check whether pending state was cleared.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pendingAfterAbort = await listPending(managed.v2Client, session.id);
    assert.equal(
      pendingAfterAbort.permissions.length,
      1,
      "observed: abort does NOT clear the pending permission request from listPending",
    );
    assert.equal(pendingAfterAbort.permissions[0]!.id, requestId, "the still-pending request must be the same one, not a new one");

    const replyAfterAbort = await replyPermission(managed.v2Client, requestId, "once");
    assert.equal(
      replyAfterAbort.ok,
      true,
      `observed: replying to a permission request after its session was aborted still succeeds (no error), got: ${JSON.stringify(replyAfterAbort.error)}`,
    );

    // The reply "succeeding" must not be confused with the tool call
    // actually running: the turn it belonged to already ended when the
    // session was aborted, so the marker command must never execute.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(
      readMarkerLines(markerFile),
      [],
      "the reply after abort must have no observable side effect -- the marker command must never run",
    );

    // The reply did consume the pending record even though it had no
    // execution effect: it is gone from listPending afterward.
    const pendingAfterReply = await listPending(managed.v2Client, session.id);
    assert.equal(pendingAfterReply.permissions.length, 0, "the permission request should be consumed (no longer pending) after the reply");

    const secondReply = await replyPermission(managed.v2Client, requestId, "once");
    assert.equal(secondReply.ok, false, "a second reply to the same now-consumed request id must fail");
    assert.match(
      JSON.stringify(secondReply.error),
      /PermissionNotFoundError/,
      "the second reply's error should be the same PermissionNotFoundError M1.6's duplicate-reply test observed",
    );

    const promptOutcome = await promptPromise;
    const info = (promptOutcome as { info?: { error?: { name?: string } } }).info;
    assert.equal(info?.error?.name, "MessageAbortedError", "the prompt's own response should reflect the abort");
  } finally {
    await managed.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
