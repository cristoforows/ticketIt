import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/fake-clock.js";
import { AdmissionLedger, assertGrantKind, type AdmitRequest, type GrantKind } from "../src/admission-ledger.js";

function baseRequest(overrides: Partial<AdmitRequest> = {}): AdmitRequest {
  return {
    roundId: "round-1",
    ticketId: "ticket-1",
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    ...overrides,
  };
}

test("admit() denies with no-grant when nothing matches the requested scope", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  const result = ledger.admit(baseRequest());
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "no-grant");
  assert.equal(result.grantId, undefined);
});

test("grant() records a Permission and admit() allows within its scope", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  const grant = ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });
  assert.ok(grant.id.length > 0);

  const result = ledger.admit(baseRequest());
  assert.equal(result.decision, "allow");
  assert.equal(result.reason, "ok");
  assert.equal(result.grantId, grant.id);
});

// --- Acceptance criterion: disconnected -------------------------------

test("disconnected: an otherwise-valid admission is held, not allowed", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  ledger.setConnected(false);
  const result = ledger.admit(baseRequest());
  assert.equal(result.decision, "hold");
  assert.equal(result.reason, "disconnected");
});

test("disconnected: an admission that would be denied anyway is still denied, not held", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  ledger.setConnected(false);
  const result = ledger.admit(baseRequest());
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "no-grant");
});

test("disconnected: an already-dispatched action can still be marked completed", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const ledger = new AdmissionLedger(clock);
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  const admitted = ledger.admit(baseRequest());
  assert.equal(admitted.decision, "allow");
  ledger.dispatch(admitted.admissionId);

  ledger.setConnected(false);
  const heldAdmission = ledger.admit(baseRequest());
  assert.equal(heldAdmission.decision, "hold");

  // Zero new admissions while offline, but the already-dispatched action
  // may still finish.
  ledger.complete(admitted.admissionId);
  const [dispatchRecord] = ledger.dispatches();
  assert.equal(dispatchRecord?.admissionId, admitted.admissionId);
  assert.ok(dispatchRecord?.completedAtMs !== undefined);
});

// --- Acceptance criterion: time-based expiry ---------------------------

test("time-based expiry denies that scope while other permitted scopes still allow", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const ledger = new AdmissionLedger(clock);
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "time", expiresAt: clock.nowMs() + 1_000 },
  });
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.read",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "time", expiresAt: clock.nowMs() + 100_000 },
  });

  clock.advance(1_500);

  const expired = ledger.admit(baseRequest({ action: "pr.create" }));
  assert.equal(expired.decision, "deny");
  assert.equal(expired.reason, "expired");

  const stillValid = ledger.admit(baseRequest({ action: "pr.read" }));
  assert.equal(stillValid.decision, "allow");
  assert.equal(stillValid.reason, "ok");
});

test("a renewed time-based grant lets the same Round continue after expiry", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const ledger = new AdmissionLedger(clock);
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "time", expiresAt: clock.nowMs() + 1_000 },
  });

  clock.advance(1_500);
  const expired = ledger.admit(baseRequest());
  assert.equal(expired.decision, "deny");
  assert.equal(expired.reason, "expired");

  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "time", expiresAt: clock.nowMs() + 1_000 },
  });

  const renewed = ledger.admit(baseRequest());
  assert.equal(renewed.decision, "allow");
});

// --- Acceptance criterion: revocation -----------------------------------

test("revocation denies subsequent admissions for that scope", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  const grant = ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  assert.equal(ledger.admit(baseRequest()).decision, "allow");
  ledger.revoke(grant.id);
  const afterRevoke = ledger.admit(baseRequest());
  assert.equal(afterRevoke.decision, "deny");
  assert.equal(afterRevoke.reason, "revoked");
});

test("already-dispatched work completes without a new admission after revocation", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  const grant = ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  const admitted = ledger.admit(baseRequest());
  ledger.dispatch(admitted.admissionId);
  ledger.revoke(grant.id);

  // No new admission call is needed or made; completion just records that
  // the already-dispatched action finished.
  ledger.complete(admitted.admissionId);
  const dispatchRecord = ledger.dispatches().find((entry) => entry.admissionId === admitted.admissionId);
  assert.ok(dispatchRecord?.completedAtMs !== undefined);
});

// --- Acceptance criterion: ticket-based grant lifecycle -----------------

test("ticket-based grant is valid across multiple Rounds of the same Ticket", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  assert.equal(ledger.admit(baseRequest({ roundId: "round-1" })).decision, "allow");
  assert.equal(ledger.admit(baseRequest({ roundId: "round-2" })).decision, "allow");
});

test("ticket-based grant never matches a different Ticket", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  const other = ledger.admit(baseRequest({ ticketId: "ticket-2" }));
  assert.equal(other.decision, "deny");
  assert.equal(other.reason, "no-grant");
});

test("ticket-based grant permanently ends at Ticket Done", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  ledger.ticketDone("ticket-1");
  const result = ledger.admit(baseRequest());
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "ticket-done");
});

test("ticketReopened does not restore a ticket-based grant ended by Done", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  ledger.ticketDone("ticket-1");
  ledger.ticketReopened("ticket-1");
  const result = ledger.admit(baseRequest());
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "ticket-done");
});

// --- Acceptance criterion: time-based grant lifecycle --------------------

test("time-based grant survives Ticket Done", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const ledger = new AdmissionLedger(clock);
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "time", expiresAt: clock.nowMs() + 100_000 },
  });

  ledger.ticketDone("ticket-1");
  const result = ledger.admit(baseRequest());
  assert.equal(result.decision, "allow");
});

test("time-based grant applies across Tickets within its authorized scope", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const ledger = new AdmissionLedger(clock);
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "time", expiresAt: clock.nowMs() + 100_000 },
  });

  assert.equal(ledger.admit(baseRequest({ ticketId: "ticket-1" })).decision, "allow");
  assert.equal(ledger.admit(baseRequest({ ticketId: "ticket-2" })).decision, "allow");
});

test("time-based grant ends at its configured expiry", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const ledger = new AdmissionLedger(clock);
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "time", expiresAt: clock.nowMs() + 1_000 },
  });

  assert.equal(ledger.admit(baseRequest()).decision, "allow");
  clock.set(clock.nowMs() + 1_000);
  const atExpiry = ledger.admit(baseRequest());
  assert.equal(atExpiry.decision, "deny");
  assert.equal(atExpiry.reason, "expired");
});

// --- Acceptance criterion: pending Stop -----------------------------------

test("pending Stop denies with reason stop-pending, taking precedence over an otherwise-valid grant", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  ledger.requestStop("round-1");
  const result = ledger.admit(baseRequest({ roundId: "round-1" }));
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "stop-pending");

  // Scoped to the Round: a different Round on the same Ticket is unaffected.
  const other = ledger.admit(baseRequest({ roundId: "round-2" }));
  assert.equal(other.decision, "allow");
});

test("a pending Stop is cleared only by confirmStop", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });

  ledger.requestStop("round-1");
  assert.equal(ledger.admit(baseRequest({ roundId: "round-1" })).reason, "stop-pending");

  // Nothing else — not revoking an unrelated grant, not reconnecting —
  // clears a pending Stop.
  ledger.setConnected(false);
  ledger.setConnected(true);
  assert.equal(ledger.admit(baseRequest({ roundId: "round-1" })).reason, "stop-pending");

  ledger.confirmStop("round-1");
  assert.equal(ledger.admit(baseRequest({ roundId: "round-1" })).decision, "allow");
});

// --- Acceptance criterion: combined ticket-plus-time grant ---------------

test("constructing a grant kind with both ticketId and expiresAt throws at runtime", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  const combined = { kind: "ticket", ticketId: "ticket-1", expiresAt: 1_000 } as unknown as GrantKind;
  assert.throws(
    () =>
      ledger.grant({
        agentId: "agent-1",
        account: "github:cristoforows",
        action: "pr.create",
        resource: "repo:cristoforows/ticketIt",
        kind: combined,
      }),
    /cannot combine/i,
  );
});

test("assertGrantKind rejects a combined kind directly, independent of the ledger", () => {
  const combined = { kind: "time", expiresAt: 1_000, ticketId: "ticket-1" } as unknown as GrantKind;
  assert.throws(() => assertGrantKind(combined), /cannot combine/i);
});

test("assertGrantKind rejects an incomplete ticket kind (missing ticketId)", () => {
  const incomplete = { kind: "ticket" } as unknown as GrantKind;
  assert.throws(() => assertGrantKind(incomplete));
});

test("assertGrantKind rejects an incomplete time kind (missing expiresAt)", () => {
  const incomplete = { kind: "time" } as unknown as GrantKind;
  assert.throws(() => assertGrantKind(incomplete));
});

// Type-level: a `GrantKind`-typed object literal cannot legally carry both
// `ticketId` and `expiresAt`. This is checked by `npm run typecheck`
// (`tsc -p tsconfig.json --noEmit`), not by `npm test`: this package's test
// runner uses `tsx`, which only strips types (see experiments/README.md,
// "Why this runner") and does not type-check. If this invariant is ever
// relaxed, the `@ts-expect-error` below starts failing typecheck.
test("grant kind type-level exclusivity is pinned for npm run typecheck", () => {
  // @ts-expect-error - a ticket-based kind cannot also carry expiresAt.
  const invalid: GrantKind = { kind: "ticket", ticketId: "ticket-1", expiresAt: 1_000 };
  void invalid;
  assert.ok(true, "see the @ts-expect-error above; this assertion just gives the test a body");
});

// --- Acceptance criterion: dispatch ledger and decisions() ----------------

test("decisions() exposes every admit() call with its fake-clock timestamp", () => {
  const clock = new FakeClock(0);
  const ledger = new AdmissionLedger(clock);
  ledger.admit(baseRequest());
  clock.advance(5_000);
  ledger.admit(baseRequest({ roundId: "round-2" }));

  const decisions = ledger.decisions();
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0]?.decidedAtMs, 0);
  assert.equal(decisions[1]?.decidedAtMs, 5_000);
  assert.deepEqual(
    decisions.map((d) => d.reason),
    ["no-grant", "no-grant"],
  );
});

test("dispatch() requires an allow decision and records a fake-clock timestamp", () => {
  const clock = new FakeClock(0);
  const ledger = new AdmissionLedger(clock);
  const denied = ledger.admit(baseRequest());
  assert.throws(() => ledger.dispatch(denied.admissionId), /not "allow"/);

  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });
  clock.advance(2_000);
  const admitted = ledger.admit(baseRequest());
  ledger.dispatch(admitted.admissionId);

  const [dispatchRecord] = ledger.dispatches();
  assert.equal(dispatchRecord?.dispatchedAtMs, 2_000);
  assert.equal(dispatchRecord?.completedAtMs, undefined);
});

test("complete() requires the admission to have been dispatched first", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  ledger.grant({
    agentId: "agent-1",
    account: "github:cristoforows",
    action: "pr.create",
    resource: "repo:cristoforows/ticketIt",
    kind: { kind: "ticket", ticketId: "ticket-1" },
  });
  const admitted = ledger.admit(baseRequest());
  assert.throws(() => ledger.complete(admitted.admissionId), /was not dispatched/);
});

// --- No Skill/Recipe/instruction grant path --------------------------------

test("the ledger's public method surface has no path for a Skill, Recipe, or instruction to create a grant", () => {
  const ledger = new AdmissionLedger(new FakeClock("2026-01-01T00:00:00.000Z"));
  const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(ledger)).filter(
    (name) => name !== "constructor",
  );
  // Pin the exact API surface. `grant()` is the only creation path, and it
  // is a direct method call requiring an explicit GrantInput — nothing here
  // accepts free-text instructions, Skill content, or Recipe content that
  // could be parsed into a grant.
  assert.deepEqual(
    [...methodNames].sort(),
    [
      "admit",
      "complete",
      "confirmStop",
      "decisions",
      "dispatch",
      "dispatches",
      "grant",
      "requestStop",
      "revoke",
      "setConnected",
      "state",
      "ticketDone",
      "ticketReopened",
    ],
  );
});
