import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProcessDeath, type ProcessDeathObservation } from "../src/process-death.js";

/**
 * Unit coverage proving `classifyProcessDeath` refuses to auto-continue
 * under any observation -- the code-level counterpart to the integration
 * proof in `test/process-death.test.ts`. Per docs/v1-scope.md
 * ("Lifecycle") and docs/contracts/execution-interface.md
 * ("Reconciliation on reconnect"), losing the execution process always
 * ends the Round as Interrupted and blocks the Ticket, regardless of what
 * turns out to be recoverable; only an explicit owner action outside this
 * function may start a new Round.
 */

const baseObservation: ProcessDeathObservation = {
  pid: 12345,
  killedAtMs: 1000,
  detectedDeadAtMs: 1023,
  toolChildSurvivedParent: true,
  historyRecovered: true,
  pendingStateRecovered: false,
};

test("classifyProcessDeath: always Interrupted/Blocked/no-auto-continue, regardless of what was recoverable", () => {
  const variants: ProcessDeathObservation[] = [
    baseObservation,
    { ...baseObservation, toolChildSurvivedParent: false },
    { ...baseObservation, toolChildSurvivedParent: null, detectedDeadAtMs: null },
    { ...baseObservation, historyRecovered: false, pendingStateRecovered: false },
    { ...baseObservation, historyRecovered: true, pendingStateRecovered: true },
  ];

  for (const observation of variants) {
    const outcome = classifyProcessDeath(observation);
    assert.equal(outcome.round, "Interrupted");
    assert.equal(outcome.ticket, "Blocked");
    assert.equal(outcome.newRoundRequiresExplicitOwnerAction, true);
    assert.equal(outcome.autoContinued, false);
  }
});

test("classifyProcessDeath: summary reflects the specific observation without changing the outcome", () => {
  const survived = classifyProcessDeath({ ...baseObservation, toolChildSurvivedParent: true });
  const didNotSurvive = classifyProcessDeath({ ...baseObservation, toolChildSurvivedParent: false });

  assert.match(survived.summary, /tool's child process survived it/);
  assert.match(didNotSurvive.summary, /tool's child process did not survive it/);
  // Only the descriptive summary text differs; the classification itself never does.
  assert.deepEqual(
    { round: survived.round, ticket: survived.ticket, autoContinued: survived.autoContinued },
    { round: didNotSurvive.round, ticket: didNotSurvive.ticket, autoContinued: didNotSurvive.autoContinued },
  );
});
