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

async function waitForPendingPermission(
  managed: Awaited<ReturnType<typeof startManagedOpenCode>>,
  sessionId: string,
  attempts = 40,
) {
  let pending = await listPending(managed.v2Client, sessionId);
  for (let i = 0; i < attempts && pending.permissions.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    pending = await listPending(managed.v2Client, sessionId);
  }
  return pending.permissions[0];
}

/**
 * M1.6 test 5 (once versus always). This finding feeds the admission
 * bridge slice (#20): replying "always" to a first shell permission
 * request was observed to suppress a permission ask for a second shell
 * call in the SAME session, AND -- more significantly -- for a shell call
 * in a brand NEW session created afterward in the same project. The
 * pinned engine's "always" grant is not scoped to a single OpenCode
 * session; ticketIt's Temporary Permission model (ticket-based or
 * time-based, see CONTEXT.md) must not assume engine "always" grants are
 * revoked or re-scoped when a Round/session ends.
 */
test("once versus always: an \"always\" reply suppresses a later ask in the same session and in a brand-new session", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-harness-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  // StubModelServer's turn queue only shifts while more than one turn
  // remains (the last turn otherwise repeats indefinitely, see
  // `stub-model-server.ts`'s `nextTurn()`), so a test that scripts several
  // separate prompt/reply rounds must queue every round's turns upfront in
  // the exact order they will be consumed, rather than interleaving
  // `enqueueTurn` calls between `promptText` calls -- otherwise the first
  // request of a later round would consume the previous round's leftover
  // "sticky" final turn instead of the newly enqueued tool call.
  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [
      scriptBashToolCall({ command: markerAppendCommand(markerFile, "first") }),
      scriptTextTurn("after first"),
      scriptBashToolCall({ command: markerAppendCommand(markerFile, "second") }),
      scriptTextTurn("after second"),
      scriptBashToolCall({ command: markerAppendCommand(markerFile, "third") }),
      scriptTextTurn("after third"),
    ],
  });
  await stub.start();

  const managed = await startManagedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    extraConfig: { permission: { bash: "ask" } },
  });

  try {
    const session = await managed.session.create("m1-17 once vs always: first session");

    const firstPromptPromise = managed.session.promptText(session.id, "run the marker command once");
    const firstRequest = await waitForPendingPermission(managed, session.id);
    assert.ok(firstRequest, "a permission request should be pending for the first shell call");

    const alwaysReply = await replyPermission(managed.v2Client, firstRequest!.id, "always");
    assert.equal(alwaysReply.ok, true, `replying "always" should succeed: ${JSON.stringify(alwaysReply.error)}`);
    await firstPromptPromise;
    assert.equal(readMarkerLines(markerFile).length, 1, "the first scripted shell call should have executed exactly once");

    // Second shell call, same session: does a second permission request get raised?
    const secondPromptPromise = managed.session.promptText(session.id, "run the marker command again");
    const secondRequest = await waitForPendingPermission(managed, session.id, 15);
    const secondAskRaised = Boolean(secondRequest);
    if (secondRequest) {
      // Recorded either way -- if the engine did ask again, resolve it so
      // the test can still observe the rest of the scenario.
      await replyPermission(managed.v2Client, secondRequest.id, "once");
    }
    await secondPromptPromise;
    assert.equal(
      secondAskRaised,
      false,
      "OBSERVED: a second shell call in the same session after an \"always\" reply did not raise a new permission request on this pinned build",
    );
    assert.equal(readMarkerLines(markerFile).length, 2, "the second scripted shell call should also have executed exactly once (no permission block)");

    // A brand-new session in the same project: does it inherit "always"?
    const session2 = await managed.session.create("m1-17 once vs always: second session");
    const thirdPromptPromise = managed.session.promptText(session2.id, "run the marker command in a new session");
    const thirdRequest = await waitForPendingPermission(managed, session2.id, 15);
    const newSessionAskRaised = Boolean(thirdRequest);
    if (thirdRequest) {
      await replyPermission(managed.v2Client, thirdRequest.id, "once");
    }
    await thirdPromptPromise;
    assert.equal(
      newSessionAskRaised,
      false,
      "OBSERVED: a brand-new session in the same project did not get asked for shell permission either -- \"always\" was not scoped to the originating session on this pinned build (feeds #20's admission bridge)",
    );
    assert.equal(readMarkerLines(markerFile).length, 3, "the third scripted shell call (new session) should also have executed exactly once");
  } finally {
    await managed.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
