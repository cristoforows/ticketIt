import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "shared";
import { GalleySubstitute } from "../src/galley-substitute.js";

test("non-owner sign-in is rejected", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const galley = new GalleySubstitute("cristoforows", clock);

  const result = galley.signIn("someone-else");

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "not-owner");
  assert.equal(result.session, undefined);
  assert.equal(galley.sessions().length, 0);
});

test("owner sign-in is accepted and creates a session carrying no account authority", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const galley = new GalleySubstitute("cristoforows", clock);

  const result = galley.signIn("cristoforows");

  assert.equal(result.accepted, true);
  assert.ok(result.session);
  assert.equal(result.session?.login, "cristoforows");
  assert.equal(result.session?.createdAtMs, clock.nowMs());
  // Structural check: SignInSession has exactly sessionId/login/createdAtMs
  // — no grant, permission, or authority field.
  assert.deepEqual(Object.keys(result.session ?? {}).sort(), ["createdAtMs", "login", "sessionId"]);
  assert.equal(galley.sessions().length, 1);
});

test("a sign-in session alone cannot perform an account action: no grant means admit() denies", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const galley = new GalleySubstitute("cristoforows", clock);

  const result = galley.signIn("cristoforows");
  assert.equal(result.accepted, true);

  // Nothing about signIn() created a grant. An admission for the signed-in
  // owner's identity must still deny with "no-grant".
  const admission = galley.ledger.admit({
    roundId: "round-1",
    ticketId: "ticket-1",
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "github.identity.verify",
    resource: "github-account:cristoforows",
  });

  assert.equal(admission.decision, "deny");
  assert.equal(admission.reason, "no-grant");
});

test("a valid ticket-based grant on the same ledger allows the admission", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const galley = new GalleySubstitute("cristoforows", clock);
  galley.signIn("cristoforows");

  galley.ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "github.identity.verify",
    resource: "github-account:cristoforows",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  const admission = galley.ledger.admit({
    roundId: "round-1",
    ticketId: "ticket-1",
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "github.identity.verify",
    resource: "github-account:cristoforows",
  });

  assert.equal(admission.decision, "allow");
  assert.equal(admission.reason, "ok");
});
