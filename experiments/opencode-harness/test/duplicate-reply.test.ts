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
} from "../src/index.js";

/**
 * M1.6 test 4 (duplicate reply). Sending the same "once" reply twice for
 * the same permission request id: the pinned version's
 * `POST /permission/{requestID}/reply` endpoint (used by `replyPermission`)
 * was observed to REJECT the duplicate with a 404 `PermissionNotFoundError`
 * (the request record is consumed on first reply, not idempotently
 * accepted) -- recorded here with the exact error text. Either way, the
 * marker file must show exactly one execution.
 */
test("duplicate reply: the same reply sent twice is rejected (exact error recorded); marker count stays one", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-harness-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("Done after duplicate-reply test.")],
  });
  await stub.start();

  const managed = await startManagedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    extraConfig: { permission: { bash: "ask" } },
  });

  try {
    const session = await managed.session.create("m1-17 duplicate reply");
    const promptPromise = managed.session.promptText(session.id, "please run the marker command");

    let pending = await listPending(managed.v2Client, session.id);
    for (let i = 0; i < 40 && pending.permissions.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      pending = await listPending(managed.v2Client, session.id);
    }
    assert.equal(pending.permissions.length, 1);
    const requestId = pending.permissions[0]!.id;

    const firstReply = await replyPermission(managed.v2Client, requestId, "once");
    assert.equal(firstReply.ok, true, `the first reply should succeed: ${JSON.stringify(firstReply.error)}`);

    await promptPromise;

    // Send the exact same reply again for the same (now-resolved) request id.
    const duplicateReply = await replyPermission(managed.v2Client, requestId, "once");
    assert.equal(duplicateReply.ok, false, "a duplicate reply to an already-resolved permission request should not report success");
    assert.deepEqual(
      duplicateReply.error,
      { _tag: "PermissionNotFoundError", requestID: requestId, message: `Permission request not found: ${requestId}` },
      "the engine's exact rejection for a duplicate reply should be a PermissionNotFoundError naming the request id",
    );

    const markerLines = readMarkerLines(markerFile);
    assert.equal(markerLines.length, 1, `the marker file must show exactly one execution regardless of the duplicate reply, got: ${JSON.stringify(markerLines)}`);
  } finally {
    await managed.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
