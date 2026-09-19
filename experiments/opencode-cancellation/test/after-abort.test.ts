import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StubModelServer, readMarkerLines, scriptTextTurn, startManagedOpenCode } from "opencode-harness";
import { isProcessAlive, readPidFile, slowBashScript } from "../src/slow-bash.js";

/**
 * M1.7 scenario 3 (after abort). Once a session has been aborted mid tool
 * call, send another prompt to the *same* session and record what
 * happens: is history retained, and does the previously-aborted tool
 * call resume by itself?
 *
 * Observed: the OpenCode session itself keeps full message history
 * (the aborted user/assistant turn is still present, unchanged, in
 * `session.messages()`), and a brand-new user prompt is answered
 * normally with the next scripted turn -- but nothing about sending that
 * new prompt re-touches, re-runs, or completes the earlier aborted tool
 * call: its tool part (status, output, callID) is byte-for-byte the same
 * before and after, and the marker file the aborted command was writing
 * to gains no new lines. Continuing the OpenCode session is therefore
 * conversation continuity, not resumption of the ended work -- consistent
 * with treating abort as ending the Round (docs/agent-execution.md,
 * "Autonomy": a Stop request ends the round; a new prompt is a new,
 * explicit action, never automatic).
 */
test("after abort: history retained, but the same session's new prompt does not resume the aborted work", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-cancellation-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");
  const pidFile = path.join(markerRoot, "sleep.pid");

  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [
      {
        content: "",
        toolCalls: [{ id: "call_bash_1", name: "bash", arguments: JSON.stringify({ command: slowBashScript({ markerFile, pidFile, sleepSeconds: 5 }) }) }],
      },
      scriptTextTurn("Reply after abort."),
    ],
  });
  await stub.start();

  const managed = await startManagedOpenCode({ stub: { baseUrl: `${stub.url}/v1` } });

  try {
    const session = await managed.session.create("m1-18 after abort");

    const firstPromptPromise = managed.session.promptText(session.id, "please run the slow marker command");
    firstPromptPromise.catch(() => {});

    let childPid: number | null = null;
    for (let i = 0; i < 40 && childPid === null; i++) {
      childPid = readPidFile(pidFile);
      if (childPid === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(childPid !== null, "the scripted bash tool call should have started");

    await managed.client.session.abort({ path: { id: session.id } });
    for (let i = 0; i < 100 && isProcessAlive(childPid!); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(isProcessAlive(childPid!), false, "the sleep child must be gone before continuing this test");
    await firstPromptPromise;

    const messagesBefore = (await managed.session.messages(session.id)) as Array<{
      info: { role: string };
      parts: Array<{ type: string; tool?: string; state?: unknown }>;
    }>;
    assert.equal(messagesBefore.length, 2, "baseline: one user message, one aborted assistant message");
    const abortedToolPartBefore = messagesBefore.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "bash");
    assert.ok(abortedToolPartBefore, "the aborted tool part should be present before sending a new prompt");
    const abortedToolPartSnapshotBefore = JSON.stringify(abortedToolPartBefore);

    // The explicit new action: send a brand-new prompt to the same session.
    const secondPromptOutcome = await managed.session.promptText(session.id, "Please continue.");
    const secondInfo = (secondPromptOutcome as { info?: { error?: unknown } }).info;
    assert.equal(secondInfo?.error, undefined, "the follow-up prompt should complete normally, not as another abort");

    const messagesAfter = (await managed.session.messages(session.id)) as Array<{
      info: { role: string };
      parts: Array<{ type: string; tool?: string; text?: string; state?: unknown }>;
    }>;
    assert.equal(messagesAfter.length, 4, "history retained: the two earlier messages plus one new user + one new assistant message");

    // History retained, unchanged: the earlier aborted tool part is byte-for-byte identical.
    const abortedToolPartAfter = messagesAfter.slice(0, 2).flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "bash");
    assert.equal(
      JSON.stringify(abortedToolPartAfter),
      abortedToolPartSnapshotBefore,
      "the earlier aborted tool call's own record must be untouched by the new prompt -- no silent replay or completion",
    );

    // The new assistant turn is the plain scripted text reply, not another tool call.
    const newAssistantMessage = messagesAfter[3]!;
    const newText = newAssistantMessage.parts.find((p) => p.type === "text")?.text;
    assert.equal(newText, "Reply after abort.", "the new prompt should be answered with the next scripted turn, not a repeat of the aborted tool call");

    // No automatic resumption of the aborted work: the marker file gained
    // no new lines from continuing the session.
    assert.deepEqual(
      readMarkerLines(markerFile),
      ["before-sleep"],
      "the aborted work must not resume by itself; only the original before-sleep marker should ever exist",
    );
  } finally {
    await managed.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
