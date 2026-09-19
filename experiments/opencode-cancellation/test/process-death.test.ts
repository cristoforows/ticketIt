import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StubModelServer, markerAppendCommand, scriptBashToolCall, scriptTextTurn } from "opencode-harness";
import { startOpencodeAtRoot } from "../src/direct-server.js";
import { initTempGitProject } from "../src/temp-git-project.js";
import { isProcessAlive, readPidFile, slowBashScript } from "../src/slow-bash.js";
import { classifyProcessDeath } from "../src/process-death.js";

/**
 * M1.7 scenario 4 (process death). SIGKILL the OpenCode server process
 * itself (not a clean `close()`) during a tool run, using
 * `startOpencodeAtRoot` (this package's local re-implementation of the
 * relevant slice of `startManagedOpenCode`, parameterized on an existing
 * root/project directory -- see `src/direct-server.ts` for why the
 * harness's own `startManagedOpenCode` cannot be reused here: it always
 * creates and owns a brand-new, single-use isolated root).
 *
 * "The supervisor observes the exit" here means external polling
 * (`process.kill(pid, 0)`), not a direct child `'exit'` event: like
 * `opencode-harness`'s own `ManagedOpenCode`, `startOpencodeAtRoot`
 * captures a pid but does not expose the underlying `ChildProcess`
 * outside this file, so an external caller that only has the pid (as a
 * real out-of-process supervisor reattaching after its own restart would)
 * is exactly what is being modeled.
 */

test("process death: server exit is detected externally, nothing restarts automatically, the tool's child process survives its parent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-cancellation-root-"));
  const projectDir = initTempGitProject(root);
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-cancellation-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");
  const pidFile = path.join(markerRoot, "sleep.pid");
  let orphanPid: number | null = null;

  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [
      {
        content: "",
        toolCalls: [{ id: "call_bash_1", name: "bash", arguments: JSON.stringify({ command: slowBashScript({ markerFile, pidFile, sleepSeconds: 6 }) }) }],
      },
      scriptTextTurn("unreachable"),
    ],
  });
  await stub.start();

  const first = await startOpencodeAtRoot({ root, projectDir, stub: { baseUrl: `${stub.url}/v1` } });
  let second: Awaited<ReturnType<typeof startOpencodeAtRoot>> | undefined;

  try {
    assert.ok(first.pid !== undefined, "must have captured the first server's pid to be able to SIGKILL it");

    const created = await first.client.session.create({ body: { title: "m1-18 process death" } });
    const sessionId = created.data!.id;

    first.client.session
      .prompt({
        path: { id: sessionId },
        body: { model: { providerID: "stub", modelID: "stub-model" }, parts: [{ type: "text", text: "run the slow command" }] },
      })
      .catch(() => {
        // Expected: the underlying connection dies with the server.
      });

    let childPid: number | null = null;
    for (let i = 0; i < 40 && childPid === null; i++) {
      childPid = readPidFile(pidFile);
      if (childPid === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(childPid !== null, "the scripted bash tool call should have started before killing the server");
    orphanPid = childPid;
    assert.equal(isProcessAlive(childPid!), true);

    const killedAtMs = Date.now();
    process.kill(first.pid!, "SIGKILL");

    let detectedDeadAtMs: number | null = null;
    for (let i = 0; i < 150 && detectedDeadAtMs === null; i++) {
      if (!isProcessAlive(first.pid!)) detectedDeadAtMs = Date.now();
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(detectedDeadAtMs !== null, "the supervisor (external polling) should observe the server process exit");
    const detectionGapMs = detectedDeadAtMs! - killedAtMs;
    assert.ok(detectionGapMs < 5000, `expected the exit to be detected quickly, took ${detectionGapMs}ms`);

    // The tool's own child process is a separate OS process from its
    // parent (the OpenCode server): SIGKILLing the parent alone does not
    // propagate to it.
    assert.equal(
      isProcessAlive(childPid!),
      true,
      "observed: the tool's child process (sleep) survives its parent's SIGKILL -- it is orphaned, not terminated",
    );

    // Nothing restarts automatically: wait past a generous grace period
    // and confirm the old server is still gone and unreachable.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(isProcessAlive(first.pid!), false, "no automatic restart should bring the old pid back");
    await assert.rejects(() => fetch(`${first.serverUrl}/session`), "the old server URL must stay unreachable, not silently recover");

    // Start a fresh server against the SAME storage and see what is recoverable.
    second = await startOpencodeAtRoot({ root, projectDir, stub: { baseUrl: `${stub.url}/v1` } });
    assert.notEqual(second.pid, first.pid, "the restarted server must be a genuinely new process");

    const requestCountBeforeIdle = stub.requests.length;
    const sessionsAfter = await second.client.session.list({});
    const recoveredSession = (sessionsAfter.data ?? []).find((s: { id: string }) => s.id === sessionId);
    assert.ok(recoveredSession, "recoverable: the prior session is listed by the fresh server against the same storage");

    const messagesAfter = (await second.client.session.messages({ path: { id: sessionId } })) as {
      data: Array<{ parts: Array<{ type: string; tool?: string; state?: { status?: string } }> }>;
    };
    const toolPart = (messagesAfter.data ?? []).flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "bash");
    assert.ok(toolPart, "recoverable: the interrupted tool call's own record is still present");
    assert.equal(
      toolPart!.state?.status,
      "running",
      "observed: an interrupted tool call's persisted state is stuck at 'running' -- it is never marked completed or errored by a mere restart",
    );

    // No auto-continuation: merely listing/restarting must not itself
    // trigger any new model call.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(
      stub.requests.length,
      requestCountBeforeIdle,
      "starting a fresh server against the same storage and inspecting it must not by itself send any new completion request",
    );

    const outcome = classifyProcessDeath({
      pid: first.pid!,
      killedAtMs,
      detectedDeadAtMs,
      toolChildSurvivedParent: true,
      historyRecovered: true,
      pendingStateRecovered: false,
    });
    assert.equal(outcome.round, "Interrupted");
    assert.equal(outcome.ticket, "Blocked");
    assert.equal(outcome.autoContinued, false);
  } finally {
    if (second) await second.close().catch(() => {});
    await first.close().catch(() => {});
    await stub.close();
    // Hygiene: the orphaned sleep process this test deliberately produces
    // (see the assertion above) would otherwise keep running for its full
    // duration after the test ends. Real orphan cleanup after a genuine
    // process death is exactly the kind of gap docs/open-decisions.md D8
    // (execution limits) and D5 (stranded-runner recovery) are expected to
    // resolve; this is a test-hygiene measure, not a claim that this
    // package implements that recovery.
    if (orphanPid !== null && isProcessAlive(orphanPid)) {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

test("process death: a pending permission request is not recoverable after restart (in-memory only)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-cancellation-root-"));
  const projectDir = initTempGitProject(root);
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-cancellation-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("unreachable")],
  });
  await stub.start();

  const first = await startOpencodeAtRoot({
    root,
    projectDir,
    stub: { baseUrl: `${stub.url}/v1` },
    extraConfig: { permission: { bash: "ask" } },
  });
  let second: Awaited<ReturnType<typeof startOpencodeAtRoot>> | undefined;

  try {
    const created = await first.client.session.create({ body: { title: "m1-18 pending across death" } });
    const sessionId = created.data!.id;

    first.client.session
      .prompt({ path: { id: sessionId }, body: { model: { providerID: "stub", modelID: "stub-model" }, parts: [{ type: "text", text: "run it" }] } })
      .catch(() => {});

    let pending = await first.v2Client.permission.list({});
    for (let i = 0; i < 40 && (pending.data ?? []).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      pending = await first.v2Client.permission.list({});
    }
    assert.equal((pending.data ?? []).length, 1, "a permission request should be pending before killing the server");

    process.kill(first.pid!, "SIGKILL");
    for (let i = 0; i < 150 && isProcessAlive(first.pid!); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(isProcessAlive(first.pid!), false);

    second = await startOpencodeAtRoot({
      root,
      projectDir,
      stub: { baseUrl: `${stub.url}/v1` },
      extraConfig: { permission: { bash: "ask" } },
    });

    const pendingAfterRestart = await second.v2Client.permission.list({});
    assert.equal(
      (pendingAfterRestart.data ?? []).length,
      0,
      "observed: the pending permission request does not survive a process restart -- it is in-memory only, unlike session/message history",
    );

    const sessionsAfter = await second.client.session.list({});
    const recoveredSession = (sessionsAfter.data ?? []).find((s: { id: string }) => s.id === sessionId);
    assert.ok(recoveredSession, "session history is still recoverable even though the pending permission is not");
  } finally {
    if (second) await second.close().catch(() => {});
    await first.close().catch(() => {});
    await stub.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
