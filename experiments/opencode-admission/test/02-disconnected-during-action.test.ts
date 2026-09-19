import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { markerAppendCommand, readMarkerLines, scriptBashToolCall, scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

async function waitFor(predicate: () => boolean, attempts = 60, intervalMs = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.ok(predicate(), "waitFor: condition never became true within the polling budget");
}

/**
 * Scenario 2 (issue #20): disconnected during an action. The first shell
 * call is admitted while connected, and disconnect happens strictly
 * *after* dispatch (observed via `ledger.dispatches()` showing a
 * dispatched-but-not-yet-completed record — never a fixed sleep/tick
 * count) but *before* the shell command (which sleeps briefly) finishes.
 * The in-flight action must still finish and record its completion
 * (`AdmissionLedger#complete` is deliberately independent of `connected`,
 * see experiments/shared/src/admission-ledger.ts). A second shell call
 * requested afterward, while still disconnected, must not be admitted.
 */
test("scenario 2: disconnected during an action -> in-flight action finishes, next action is not admitted", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-marker-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    turns: [
      // Sleep briefly so there is an observable window between dispatch
      // and completion in which to flip connectivity.
      scriptBashToolCall({ command: `sleep 0.6 && ${markerAppendCommand(markerFile, "first")}` }),
      scriptTextTurn("after first"),
      scriptBashToolCall({ command: markerAppendCommand(markerFile, "second") }),
      scriptTextTurn("after second"),
    ],
  });
  await stub.start();

  const admitted = await startAdmittedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    holdPollIntervalMs: 100,
    holdMaxAttempts: 5,
  });
  try {
    admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: admitted.action,
      resource: admitted.resource,
      kind: { kind: "ticket", ticketId: admitted.ticketId },
    });

    const session = await admitted.managed.session.create("m1-20 scenario 2");

    const firstPromptPromise = admitted.managed.session.promptText(session.id, "run the first (slow) marker command");

    // Wait until the ledger shows the first admission actually dispatched
    // (not just admitted) before flipping connectivity -- this is the
    // "during an action" window, found by polling ledger state, never by
    // assuming a fixed number of ticks.
    await waitFor(() => admitted.ledger.dispatches().length >= 1);
    assert.equal(admitted.ledger.dispatches()[0]!.completedAtMs, undefined, "the first action should still be in flight (not yet completed) at the moment of disconnect");

    admitted.ledger.setConnected(false);

    await firstPromptPromise;

    assert.deepEqual(readMarkerLines(markerFile), ["first"], "the in-flight action must still have finished and executed exactly once");
    const firstDispatch = admitted.ledger.dispatches()[0]!;
    assert.ok(firstDispatch.completedAtMs !== undefined, "the in-flight action's completion must be recorded even though the ledger disconnected mid-flight");

    // Second action, requested while still disconnected: must not be admitted.
    const secondPromptPromise = admitted.managed.session.promptText(session.id, "run the second marker command");
    await secondPromptPromise;

    assert.deepEqual(readMarkerLines(markerFile), ["first"], "the second action must not have executed while disconnected");
    assert.equal(admitted.ledger.dispatches().length, 1, "no second dispatch should have been recorded");

    const decisions = admitted.ledger.decisions();
    const secondDecision = decisions[decisions.length - 1]!;
    assert.notEqual(secondDecision.decision, "allow", `the second action must not have been allowed: ${JSON.stringify(secondDecision)}`);
    assert.equal(secondDecision.reason, "disconnected");
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
