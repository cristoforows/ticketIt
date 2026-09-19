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
 * M1.6 test 1 (permission round trip): a scripted "bash" tool call is
 * blocked on a permission request (project config sets `permission.bash:
 * "ask"`). The pending request is observed both through the live event
 * stream (`permission.asked`) and through `listPending` (a query, not the
 * event stream). Replying "once" continues the same session to the
 * scripted follow-up turn, the marker file shows exactly one execution,
 * and the session id never changes.
 */
test("permission round trip: observed via events and listPending, reply once, continues, marker has exactly one line", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-harness-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("Done after permission.")],
  });
  await stub.start();

  const managed = await startManagedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    // Permission configuration in the isolated OpenCode config (see
    // `startManagedOpenCode`'s isolation env, docs/evidence/m1/16-opencode-boot.md)
    // so the shell tool requires approval in this session.
    extraConfig: { permission: { bash: "ask" } },
  });

  try {
    const session = await managed.session.create("m1-17 permission round trip");
    const sessionIdBefore = session.id;

    const subscription = await subscribeEvents(managed.client);
    try {
      const promptPromise = managed.session.promptText(session.id, "please run the marker command");

      // Poll listPending (a query) until the permission request appears.
      let pending = await listPending(managed.v2Client, session.id);
      for (let i = 0; i < 40 && pending.permissions.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        pending = await listPending(managed.v2Client, session.id);
      }
      assert.equal(pending.permissions.length, 1, "listPending should observe exactly one pending permission request");
      const permissionRequest = pending.permissions[0]!;
      assert.equal(permissionRequest.sessionID, sessionIdBefore, "the pending permission request must belong to this session");
      assert.equal(permissionRequest.permission, "bash", "the pending request should be for the bash permission");

      // The same request must also have been observed through the event stream.
      const permissionEvent = subscription.events.find(
        (entry) =>
          typeof entry.event === "object" &&
          entry.event !== null &&
          (entry.event as { type?: string }).type === "permission.asked" &&
          (entry.event as { properties?: { id?: string } }).properties?.id === permissionRequest.id,
      );
      assert.ok(permissionEvent, "the pending permission request should also have been observed via the event stream (permission.asked)");

      const replyResult = await replyPermission(managed.v2Client, permissionRequest.id, "once");
      assert.equal(replyResult.ok, true, `replying "once" should succeed: ${JSON.stringify(replyResult.error)}`);

      await promptPromise;

      const messages = await managed.session.messages(session.id);
      assert.ok(
        JSON.stringify(messages).includes("Done after permission."),
        "the session should continue to the scripted follow-up turn after the permission reply",
      );

      const markerLines = readMarkerLines(markerFile);
      assert.equal(markerLines.length, 1, `the marker file should have exactly one line, got: ${JSON.stringify(markerLines)}`);

      const sessionAfter = await managed.client.session.get({ path: { id: sessionIdBefore } });
      assert.equal(sessionAfter.data?.id, sessionIdBefore, "the session id must stay constant across the permission wait");
    } finally {
      subscription.stop();
      await subscription.closed;
    }
  } finally {
    await managed.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
