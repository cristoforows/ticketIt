import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/fake-clock.js";
import { AdmissionLedger, type AdmitResult, type LedgerState } from "../src/admission-ledger.js";
import { startLedgerServer } from "../src/ledger-server.js";

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test("startLedgerServer exposes admit/dispatch/complete/state over loopback", async () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const ledger = new AdmissionLedger(clock);
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  const handle = await startLedgerServer(ledger, 0);
  try {
    const base = `http://127.0.0.1:${handle.port}`;

    const stateBefore = await readJson<LedgerState>(await fetch(`${base}/state`));
    assert.equal(stateBefore.connected, true);
    assert.equal(stateBefore.grants.length, 1);

    const admitResponse = await fetch(`${base}/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roundId: "round-1",
        ticketId: "ticket-1",
        agentId: "agent-1",
        account: "github:cristoforows",
        action: "pr.create",
        resource: "repo:cristoforows/ticketIt",
      }),
    });
    assert.equal(admitResponse.status, 200);
    const admitted = await readJson<AdmitResult>(admitResponse);
    assert.equal(admitted.decision, "allow");

    const dispatchResponse = await fetch(`${base}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admissionId: admitted.admissionId }),
    });
    assert.equal(dispatchResponse.status, 200);

    const completeResponse = await fetch(`${base}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admissionId: admitted.admissionId }),
    });
    assert.equal(completeResponse.status, 200);

    const stateAfter = await readJson<LedgerState>(await fetch(`${base}/state`));
    assert.equal(stateAfter.grants.length, 1);

    // The in-process ledger's own bookkeeping reflects the HTTP calls too:
    // the facade calls straight through to the same ledger object.
    assert.equal(ledger.decisions().length, 1);
    assert.equal(ledger.dispatches()[0]?.completedAtMs !== undefined, true);
  } finally {
    await handle.close();
  }
});

test("a malformed dispatch request (unknown admissionId) returns a 400, not a crash", async () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  const handle = await startLedgerServer(ledger, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admissionId: "admission-does-not-exist" }),
    });
    assert.equal(response.status, 400);
    const body = await readJson<{ error: string }>(response);
    assert.match(body.error, /Unknown admission id/);
  } finally {
    await handle.close();
  }
});
