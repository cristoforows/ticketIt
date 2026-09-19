import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StubModelServer, readMarkerLines, scriptTextTurn, startManagedOpenCode } from "opencode-harness";
import { allOf, confirmStop } from "../src/confirm-stop.js";
import { isProcessAlive, readPidFile, slowBashScript } from "../src/slow-bash.js";

/**
 * M1.7 scenario 1 (abort while running). A scripted "bash" tool call
 * writes a "before-sleep" marker, backgrounds `sleep <N>`, waits on it
 * (capturing its own pid to `pidFile` -- see `src/slow-bash.ts` for why
 * this is necessary: OpenCode's own SDK exposes no handle on the tool's
 * child process), then writes an "after-sleep" marker. `session.abort()`
 * is called mid-sleep. Only `confirmStop` observing real, out-of-band
 * evidence (the sleep pid actually gone, corroborated by the marker file
 * and the engine's own reported session status) may report Stopped; the
 * gap between `abort()` returning and that evidence being observed is
 * measured, not assumed.
 *
 * Default permission config is used deliberately (no `permission.bash:
 * "ask"`): this scenario is about aborting *running* work, so the tool
 * must not be blocked on an approval first (see
 * docs/evidence/m1/18-opencode-cancellation.md for the ad hoc probe that
 * established the pinned build's default bash permission is not "ask").
 */
test("abort while running: observed cessation, measured gap, no resumable pause claimed without evidence", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-cancellation-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");
  const pidFile = path.join(markerRoot, "sleep.pid");

  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [
      {
        content: "",
        toolCalls: [
          {
            id: "call_bash_1",
            name: "bash",
            arguments: JSON.stringify({ command: slowBashScript({ markerFile, pidFile, sleepSeconds: 5 }) }),
          },
        ],
      },
      scriptTextTurn("Done sleeping (should never be reached; the session is aborted first)."),
    ],
  });
  await stub.start();

  const managed = await startManagedOpenCode({ stub: { baseUrl: `${stub.url}/v1` } });

  try {
    const session = await managed.session.create("m1-18 abort while running");

    const promptPromise = managed.session.promptText(session.id, "please run the slow marker command");
    // Swallow rejection at this point; asserted explicitly below once we
    // are ready to inspect it (avoids an unhandled-rejection warning if
    // the process ends before we get there).
    promptPromise.catch(() => {});

    let childPid: number | null = null;
    for (let i = 0; i < 40 && childPid === null; i++) {
      childPid = readPidFile(pidFile);
      if (childPid === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(childPid !== null, "the scripted bash tool call should have started and recorded its sleep pid");
    assert.equal(isProcessAlive(childPid!), true, "the sleep child process should be alive while the tool call is running");

    const statusBefore = await managed.client.session.status({});
    assert.equal(
      (statusBefore.data as Record<string, { type: string }>)[session.id]?.type,
      "busy",
      "the session should report busy while the tool call is running",
    );

    const abortCallStartedAtMs = Date.now();
    const abortResult = await managed.client.session.abort({ path: { id: session.id } });
    const abortReturnedAtMs = Date.now();
    assert.equal(abortResult.data, true, `abort() should report success: ${JSON.stringify(abortResult.error)}`);

    const confirmation = await confirmStop({
      hasCeased: allOf([
        async () => {
          const alive = isProcessAlive(childPid!);
          return { observed: !alive, detail: alive ? "sleep child still alive" : "sleep child no longer exists" };
        },
        async () => {
          const lines = readMarkerLines(markerFile);
          const afterAppeared = lines.includes("after-sleep");
          return {
            observed: !afterAppeared,
            detail: afterAppeared ? "after-sleep marker was written (tool ran to completion)" : "after-sleep marker never appeared",
          };
        },
      ]),
      maxAttempts: 100,
      intervalMs: 20,
    });

    assert.equal(confirmation.status, "Stopped", `expected observed cessation: ${confirmation.reason}`);
    const cessationGapMs = confirmation.observedAtMs! - abortReturnedAtMs;
    // Recorded, not just asserted: the exact observed gap goes into
    // docs/evidence/m1/18-opencode-cancellation.md. It must be small and
    // non-negative (evidence cannot be observed before abort() itself
    // returned) but this is not a tight performance assertion -- only a
    // sanity bound against a hung poll loop.
    assert.ok(cessationGapMs >= 0, `cessation gap should be non-negative, got ${cessationGapMs}ms`);
    assert.ok(cessationGapMs < 5000, `cessation gap should be well under the abort call's own timeout, got ${cessationGapMs}ms`);

    // Redundant, direct re-checks (not just trusting confirmStop's internal polling):
    assert.equal(isProcessAlive(childPid!), false, "the sleep child process must actually be gone, not merely reported gone");
    const markerLines = readMarkerLines(markerFile);
    assert.deepEqual(markerLines, ["before-sleep"], "only the before-sleep marker should exist; the tool must not have run to completion");

    const statusAfter = await managed.client.session.status({});
    assert.notEqual(
      (statusAfter.data as Record<string, { type: string }>)[session.id]?.type,
      "busy",
      "the session must no longer report busy after confirmed cessation",
    );

    const promptOutcome = await promptPromise;
    const info = (promptOutcome as { info?: { error?: { name?: string } } }).info;
    assert.equal(info?.error?.name, "MessageAbortedError", "the prompt's own response should reflect the abort, not a normal completion");

    const messages = (await managed.session.messages(session.id)) as Array<{
      parts: Array<{ type: string; tool?: string; state?: { status?: string; output?: string } }>;
    }>;
    const toolPart = messages.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "bash");
    assert.ok(toolPart, "the bash tool part should still be present in session history after abort");
    assert.ok(
      toolPart!.state?.output?.includes("aborted"),
      `expected the tool part's own output to record the abort, got: ${JSON.stringify(toolPart!.state)}`,
    );
  } finally {
    await managed.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
