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
  subscribeEvents,
} from "../src/index.js";

/**
 * M1.6 test 3 (reconnect recovery). With a permission request pending,
 * drop the event subscription (`stop()`), then recover the exact same
 * pending request through `listPending` alone (ids match; no replayed
 * events), resubscribe, reply once, and confirm the marker file still
 * shows exactly one execution (no duplicate).
 */
test("reconnect recovery: dropped subscription's pending request is recovered via listPending alone, ids match, no duplicate execution", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-harness-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("Done after reconnect.")],
  });
  await stub.start();

  const managed = await startManagedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    extraConfig: { permission: { bash: "ask" } },
  });

  try {
    const session = await managed.session.create("m1-17 reconnect recovery");

    const firstSubscription = await subscribeEvents(managed.client);
    const promptPromise = managed.session.promptText(session.id, "please run the marker command");

    let pendingBeforeDrop = await listPending(managed.v2Client, session.id);
    for (let i = 0; i < 40 && pendingBeforeDrop.permissions.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      pendingBeforeDrop = await listPending(managed.v2Client, session.id);
    }
    assert.equal(pendingBeforeDrop.permissions.length, 1, "a permission request should be pending before dropping the subscription");
    const requestIdBeforeDrop = pendingBeforeDrop.permissions[0]!.id;

    // Drop the event subscription entirely while the request is still pending.
    firstSubscription.stop();
    await firstSubscription.closed;

    // Recover pending state from queries alone -- no event replay is possible
    // now that the subscription is stopped; this call goes through
    // `client.permission.list()`, never the (now-dead) event stream.
    const recovered = await listPending(managed.v2Client, session.id);
    assert.equal(recovered.permissions.length, 1, "the pending permission request should still be recoverable purely from listPending after the subscription was dropped");
    assert.equal(recovered.permissions[0]!.id, requestIdBeforeDrop, "the recovered request id must match the one observed before the subscription was dropped");

    // Resubscribe, then reply.
    const secondSubscription = await subscribeEvents(managed.client);
    try {
      const replyResult = await replyPermission(managed.v2Client, recovered.permissions[0]!.id, "once");
      assert.equal(replyResult.ok, true, `replying "once" after reconnect should succeed: ${JSON.stringify(replyResult.error)}`);

      await promptPromise;

      // The resubscribed stream should observe session activity continuing
      // (this pinned build was observed not to emit a distinct
      // "permission.replied" event back out over `/event` for a reply sent
      // through the top-level `/permission/{requestID}/reply` route used by
      // `replyPermission` -- see "Observed limitations" in
      // docs/evidence/m1/17-opencode-questions.md -- so continuation is
      // confirmed by the resumed message stream and the marker file below,
      // not by a specific reply event name).
      assert.ok(secondSubscription.events.length > 0, "the resubscribed stream should observe events once the session resumes");
      const messagesJson = JSON.stringify(await managed.session.messages(session.id));
      assert.ok(messagesJson.includes("Done after reconnect."), "the session should continue to the scripted follow-up turn after reconnect recovery");

      const markerLines = readMarkerLines(markerFile);
      assert.equal(markerLines.length, 1, `the marker file should show exactly one execution after reconnect recovery, got: ${JSON.stringify(markerLines)}`);
    } finally {
      secondSubscription.stop();
      await secondSubscription.closed;
    }
  } finally {
    await managed.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
