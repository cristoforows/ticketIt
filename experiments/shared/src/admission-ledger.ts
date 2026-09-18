/**
 * A deterministic admission ledger driven by `FakeClock`.
 *
 * This is a bounded local substitute for Galley's authorization and
 * control state (see docs/contracts/execution-interface.md and
 * docs/v1-scope.md, "Permissions and accounts"), used to prove S2 ("Live
 * permission and disconnect admission", docs/integration-feasibility.md)
 * with deterministic fixtures before the real application exists.
 *
 * Important: there is deliberately NO method on this ledger, and no code
 * path anywhere in this module, by which an instruction, a Skill, or a
 * Recipe can create or influence a grant. `grant()` is the only way a
 * Permission comes into existence, and it must be called directly by
 * whatever stands in for the owner-authorized Galley record (in this
 * experiment, a test or the HTTP facade's caller) — never by agent
 * output, tool output, model text, or anything sourced from a Skill or
 * Recipe document. CONTEXT.md is explicit that a Skill "describes how to
 * work" and a Recipe "supplies background" and that "neither grants
 * permission to act"; this module's public API is shaped so that
 * property holds structurally, not just by convention.
 */
import type { FakeClock } from "./fake-clock.js";

/** A Ticket-based Temporary Permission: scoped to one Ticket, never another. */
export interface TicketGrantKind {
  readonly kind: "ticket";
  readonly ticketId: string;
}

/** A time-based Temporary Permission: scoped by expiry, not by Ticket. */
export interface TimeGrantKind {
  readonly kind: "time";
  readonly expiresAt: number;
}

/**
 * The two distinct Temporary Permission kinds (v1-scope.md, "Permissions
 * and accounts": "Never combine ticket and time restrictions into a single
 * grant."). Because this is a discriminated union, an object literal typed
 * as `GrantKind` cannot legally carry both `ticketId` and `expiresAt` —
 * `tsc -p tsconfig.json --noEmit` rejects it (type-level enforcement).
 * `assertGrantKind` below additionally enforces this at runtime for input
 * that bypasses TypeScript entirely, e.g. `JSON.parse`d HTTP bodies.
 */
export type GrantKind = TicketGrantKind | TimeGrantKind;

/** Input to `AdmissionLedger.grant()`. */
export interface GrantInput {
  readonly agentId: string;
  readonly account: string;
  readonly action: string;
  readonly resource: string;
  readonly kind: GrantKind;
}

/** A recorded Permission grant, as returned by `grant()` and `state()`. */
export interface Grant extends GrantInput {
  readonly id: string;
  readonly createdAtMs: number;
  readonly revoked: boolean;
  readonly revokedAtMs?: number;
}

interface GrantRecord {
  readonly id: string;
  readonly agentId: string;
  readonly account: string;
  readonly action: string;
  readonly resource: string;
  readonly kind: GrantKind;
  readonly createdAtMs: number;
  revoked: boolean;
  revokedAtMs?: number;
}

/** A request evaluated by `admit()` at the ledger's fake-clock "now". */
export interface AdmitRequest {
  readonly roundId: string;
  readonly ticketId: string;
  readonly agentId: string;
  readonly account: string;
  readonly action: string;
  readonly resource: string;
}

export type AdmitDecision = "allow" | "deny" | "hold";

export type AdmitReason =
  | "ok"
  | "no-grant"
  | "revoked"
  | "expired"
  | "ticket-done"
  | "stop-pending"
  | "disconnected";

export interface AdmitResult {
  readonly admissionId: string;
  readonly decision: AdmitDecision;
  readonly reason: AdmitReason;
  readonly grantId?: string;
}

/** One recorded `admit()` call, with the fake-clock timestamp it was decided at. */
export interface AdmissionRecord {
  readonly admissionId: string;
  readonly request: AdmitRequest;
  readonly decision: AdmitDecision;
  readonly reason: AdmitReason;
  readonly grantId?: string;
  readonly decidedAtMs: number;
}

/** One recorded dispatch/completion of an admitted (`allow`) action. */
export interface DispatchRecord {
  readonly admissionId: string;
  readonly dispatchedAtMs: number;
  readonly completedAtMs?: number;
}

/** A JSON-serializable snapshot of ledger state, used by the HTTP facade. */
export interface LedgerState {
  readonly nowMs: number;
  readonly connected: boolean;
  readonly pendingStopRoundIds: readonly string[];
  readonly doneTicketIds: readonly string[];
  readonly grants: readonly Grant[];
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Expected a non-empty string for "${field}", got: ${JSON.stringify(value)}`);
  }
}

/**
 * Runtime guard for `GrantKind`. Enforces, independently of TypeScript,
 * that a grant kind never carries both `ticketId` and `expiresAt`
 * (v1-scope.md, "Permissions and accounts": "Never combine ticket and time
 * restrictions into a single grant."). This matters because the
 * discriminated-union type-level check (see `GrantKind` above) only
 * protects callers who go through `tsc`; the HTTP facade accepts
 * `JSON.parse`d bodies that can smuggle both fields past the type system.
 */
export function assertGrantKind(kind: GrantKind): void {
  if (kind === null || typeof kind !== "object") {
    throw new TypeError(`Grant kind must be an object, got: ${JSON.stringify(kind)}`);
  }
  const raw = kind as unknown as Record<string, unknown>;
  const hasTicketId = Object.prototype.hasOwnProperty.call(raw, "ticketId");
  const hasExpiresAt = Object.prototype.hasOwnProperty.call(raw, "expiresAt");
  if (hasTicketId && hasExpiresAt) {
    throw new TypeError(
      'Grant kind cannot combine a Ticket-based scope ("ticketId") with a ' +
        'time-based expiry ("expiresAt"); Temporary Permissions are never ' +
        'combined (v1-scope.md, "Permissions and accounts").',
    );
  }
  if (raw["kind"] === "ticket") {
    assertNonEmptyString(raw["ticketId"], "kind.ticketId");
  } else if (raw["kind"] === "time") {
    if (typeof raw["expiresAt"] !== "number" || !Number.isFinite(raw["expiresAt"])) {
      throw new TypeError(`Time-based grant kind requires a finite numeric "expiresAt", got: ${JSON.stringify(raw["expiresAt"])}`);
    }
  } else {
    throw new TypeError(`Unknown grant kind: ${JSON.stringify(raw["kind"])}`);
  }
}

function toGrantView(record: GrantRecord): Grant {
  return {
    id: record.id,
    agentId: record.agentId,
    account: record.account,
    action: record.action,
    resource: record.resource,
    kind: record.kind,
    createdAtMs: record.createdAtMs,
    revoked: record.revoked,
    ...(record.revokedAtMs === undefined ? {} : { revokedAtMs: record.revokedAtMs }),
  };
}

/**
 * Deterministic, in-memory admission ledger. Every decision is evaluated
 * at `clock`'s current time, so an experiment can move time forward with
 * `clock.advance()`/`clock.set()` and observe grants expiring, without any
 * real timers.
 *
 * There is no persistence and no concurrency control (see the evidence
 * record's "Observed limitations"): this substitutes for Galley only for
 * bounded M1 adapter proofs, not for the eventual application.
 */
export class AdmissionLedger {
  readonly #clock: FakeClock;
  readonly #grants = new Map<string, GrantRecord>();
  readonly #doneTickets = new Set<string>();
  readonly #pendingStopRounds = new Set<string>();
  readonly #admissions: AdmissionRecord[] = [];
  readonly #dispatches = new Map<string, DispatchRecord>();
  #connected = true;
  #nextGrantSeq = 1;
  #nextAdmissionSeq = 1;

  constructor(clock: FakeClock) {
    this.#clock = clock;
  }

  /**
   * Record a new Permission grant. This is the ONLY way a grant can come
   * into existence on this ledger — see the module comment above: no
   * Skill, Recipe, or instruction has a path to this call except through
   * whatever stands in for an owner-authorized Galley record.
   */
  grant(input: GrantInput): Grant {
    assertNonEmptyString(input.agentId, "agentId");
    assertNonEmptyString(input.account, "account");
    assertNonEmptyString(input.action, "action");
    assertNonEmptyString(input.resource, "resource");
    assertGrantKind(input.kind);

    const record: GrantRecord = {
      id: `grant-${this.#nextGrantSeq++}`,
      agentId: input.agentId,
      account: input.account,
      action: input.action,
      resource: input.resource,
      kind: input.kind,
      createdAtMs: this.#clock.nowMs(),
      revoked: false,
    };
    this.#grants.set(record.id, record);
    return toGrantView(record);
  }

  /** Revoke a grant. Subsequent `admit()` calls for its scope deny; already-dispatched work is unaffected. */
  revoke(grantId: string): void {
    const record = this.#grants.get(grantId);
    if (!record) {
      throw new RangeError(`Unknown grant id: ${grantId}`);
    }
    record.revoked = true;
    record.revokedAtMs = this.#clock.nowMs();
  }

  /**
   * Permanently end every ticket-based grant scoped to `ticketId`
   * (v1-scope.md: "permanently ends at Done"). Time-based grants are
   * unaffected: "Time-based grant survives Ticket Done" per issue #15.
   */
  ticketDone(ticketId: string): void {
    assertNonEmptyString(ticketId, "ticketId");
    this.#doneTickets.add(ticketId);
  }

  /**
   * Record that a Ticket was reopened. This deliberately does NOT remove
   * `ticketId` from the set of Done tickets: v1-scope.md, "Permissions and
   * accounts" is explicit that a ticket-based grant "permanently ends at
   * Done" and "reopening does not restore it". This method exists so that
   * property is an explicit, callable, testable no-op rather than an
   * absence.
   */
  ticketReopened(ticketId: string): void {
    assertNonEmptyString(ticketId, "ticketId");
    // Intentionally does not delete from #doneTickets.
  }

  /** Set runner/Galley connectivity. Disconnected pauses new admissions (see `admit()`). */
  setConnected(connected: boolean): void {
    this.#connected = connected;
  }

  /** Record a pending owner Stop request for a Round. Denies subsequent admissions for that Round until confirmed. */
  requestStop(roundId: string): void {
    assertNonEmptyString(roundId, "roundId");
    this.#pendingStopRounds.add(roundId);
  }

  /** The only way a pending Stop is cleared (execution-interface.md: "Only 'Stop confirmed' moves the Round to Stopped"). */
  confirmStop(roundId: string): void {
    assertNonEmptyString(roundId, "roundId");
    this.#pendingStopRounds.delete(roundId);
  }

  /**
   * Evaluate an admission request at the ledger's current fake-clock time.
   * Every call is recorded in the dispatch ledger and retrievable through
   * `decisions()`.
   *
   * Precedence, most to least authoritative:
   * 1. A pending Stop for `request.roundId` always denies with reason
   *    "stop-pending", even over an otherwise-valid grant (execution
   *    contract: only "Stop confirmed" clears it).
   * 2. Otherwise, the best matching grant for
   *    (agentId, account, action, resource[, ticketId]) is evaluated:
   *    a valid one allows (or holds, see below); none valid denies with
   *    the most specific reason found (revoked > ticket-done > expired >
   *    no-grant).
   * 3. If the ledger is disconnected, an otherwise-"allow" outcome is
   *    downgraded to "hold" ("new actions pause, they may continue after
   *    reconnect"); an otherwise-"deny" outcome stays "deny" — matching
   *    acceptance criterion "every new admission is held or denied".
   */
  admit(request: AdmitRequest): AdmitResult {
    assertNonEmptyString(request.roundId, "roundId");
    assertNonEmptyString(request.ticketId, "ticketId");
    assertNonEmptyString(request.agentId, "agentId");
    assertNonEmptyString(request.account, "account");
    assertNonEmptyString(request.action, "action");
    assertNonEmptyString(request.resource, "resource");

    const admissionId = `admission-${this.#nextAdmissionSeq++}`;
    const evaluated = this.#evaluate(request);
    const record: AdmissionRecord = {
      admissionId,
      request: { ...request },
      decision: evaluated.decision,
      reason: evaluated.reason,
      ...(evaluated.grantId === undefined ? {} : { grantId: evaluated.grantId }),
      decidedAtMs: this.#clock.nowMs(),
    };
    this.#admissions.push(record);
    return {
      admissionId,
      decision: record.decision,
      reason: record.reason,
      ...(record.grantId === undefined ? {} : { grantId: record.grantId }),
    };
  }

  #evaluate(request: AdmitRequest): { decision: AdmitDecision; reason: AdmitReason; grantId?: string } {
    if (this.#pendingStopRounds.has(request.roundId)) {
      return { decision: "deny", reason: "stop-pending" };
    }

    let sawRevoked = false;
    let sawTicketDone = false;
    let sawExpired = false;
    let validGrant: GrantRecord | undefined;

    for (const candidate of this.#grants.values()) {
      if (
        candidate.agentId !== request.agentId ||
        candidate.account !== request.account ||
        candidate.action !== request.action ||
        candidate.resource !== request.resource
      ) {
        continue;
      }

      if (candidate.kind.kind === "ticket") {
        if (candidate.kind.ticketId !== request.ticketId) {
          // Ticket-based grants never match another Ticket; irrelevant here.
          continue;
        }
        if (candidate.revoked) {
          sawRevoked = true;
          continue;
        }
        if (this.#doneTickets.has(candidate.kind.ticketId)) {
          sawTicketDone = true;
          continue;
        }
        validGrant = candidate;
        break;
      } else {
        // Time-based: applies across Tickets within scope, ignores request.ticketId.
        if (candidate.revoked) {
          sawRevoked = true;
          continue;
        }
        if (candidate.kind.expiresAt <= this.#clock.nowMs()) {
          sawExpired = true;
          continue;
        }
        validGrant = candidate;
        break;
      }
    }

    if (validGrant) {
      return this.#connected
        ? { decision: "allow", reason: "ok", grantId: validGrant.id }
        : { decision: "hold", reason: "disconnected", grantId: validGrant.id };
    }

    if (sawRevoked) return { decision: "deny", reason: "revoked" };
    if (sawTicketDone) return { decision: "deny", reason: "ticket-done" };
    if (sawExpired) return { decision: "deny", reason: "expired" };
    return { decision: "deny", reason: "no-grant" };
  }

  /**
   * Record that an admitted ("allow") action actually started. Disconnect,
   * revocation, or expiry after this point does not undo it — only
   * `complete()` (or never completing) determines the dispatched action's
   * fate; already-dispatched work is explicitly allowed to finish
   * (v1-scope.md: "Already-dispatched actions may complete on expiry").
   */
  dispatch(admissionId: string): void {
    const admission = this.#findAdmission(admissionId);
    if (admission.decision !== "allow") {
      throw new Error(`Cannot dispatch admission "${admissionId}": decision was "${admission.decision}", not "allow"`);
    }
    if (this.#dispatches.has(admissionId)) {
      throw new Error(`Admission "${admissionId}" was already dispatched`);
    }
    this.#dispatches.set(admissionId, { admissionId, dispatchedAtMs: this.#clock.nowMs() });
  }

  /** Record that a dispatched action finished. Independent of current connectivity/grant state by design. */
  complete(admissionId: string): void {
    const dispatch = this.#dispatches.get(admissionId);
    if (!dispatch) {
      throw new RangeError(`Admission "${admissionId}" was not dispatched`);
    }
    if (dispatch.completedAtMs !== undefined) {
      throw new Error(`Admission "${admissionId}" was already completed`);
    }
    this.#dispatches.set(admissionId, { ...dispatch, completedAtMs: this.#clock.nowMs() });
  }

  #findAdmission(admissionId: string): AdmissionRecord {
    const admission = this.#admissions.find((entry) => entry.admissionId === admissionId);
    if (!admission) {
      throw new RangeError(`Unknown admission id: ${admissionId}`);
    }
    return admission;
  }

  /** Every `admit()` decision made so far, with fake-clock timestamps, oldest first. */
  decisions(): AdmissionRecord[] {
    return this.#admissions.map((entry) => ({ ...entry, request: { ...entry.request } }));
  }

  /** Every dispatch/completion recorded so far, oldest first. */
  dispatches(): DispatchRecord[] {
    return [...this.#dispatches.values()].map((entry) => ({ ...entry }));
  }

  /** JSON-serializable snapshot, used by the HTTP facade's `/state` endpoint. */
  state(): LedgerState {
    return {
      nowMs: this.#clock.nowMs(),
      connected: this.#connected,
      pendingStopRoundIds: [...this.#pendingStopRounds],
      doneTicketIds: [...this.#doneTickets],
      grants: [...this.#grants.values()].map(toGrantView),
    };
  }
}
