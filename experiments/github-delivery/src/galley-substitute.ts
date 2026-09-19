/**
 * A bounded local substitute for Galley's sign-in/ownership boundary
 * (docs/deployment.md, "Ownership and sign-in": "Use GitHub OAuth for
 * owner sign-in in v1, restricted to the configured owner... Signing in
 * is distinct from authorizing agent use of a connected external
 * account."; CONTEXT.md, **Owner**, **Connected Account**).
 *
 * `signIn()` restricts sign-in to the configured Owner login and returns
 * a `SignInSession` that deliberately carries NO account authority: it
 * has no permission-granting field or method. The only way an Agent
 * gains authority to act through a Connected Account is a separate
 * `ledger.grant()` call (see experiments/shared/src/admission-ledger.ts,
 * whose own module comment makes the same structural point) — never
 * something reachable from `signIn()` or the session it returns. This
 * mirrors CONTEXT.md's **Permission**: "Authorization for an Agent to
 * perform actions within a resource scope... " is a concept distinct
 * from the Owner's sign-in identity.
 *
 * #28 (M1.17) extends this substitute with a bounded local Ticket record
 * (status, the template-derived "reviewed-pr-merged" completion
 * condition, Rounds, informational feedback, and undefined transitions)
 * so the delivery-lifecycle fixtures have something to interpret
 * "Delivered"/merge facts against, mirroring
 * docs/contracts/execution-interface.md's ownership statement: "Galley
 * alone mutates authoritative records: Ticket Status, Round outcome,
 * Permission grants..." and "Michelin never sets Ticket status directly.
 * It reports execution facts as events." `GalleySubstitute` here plays
 * Galley's role of interpreting those facts.
 */
import { randomUUID } from "node:crypto";
import { AdmissionLedger, type FakeClock } from "shared";

/** A Ticket's lifecycle Status, per CONTEXT.md and docs/v1-scope.md, "Lifecycle" — the subset this substitute models. */
export type TicketStatus = "Ready" | "In Progress" | "In Review" | "Done";

/** The only completion condition this substitute models: docs/v1-scope.md, "Deliverables and review" — "Reviewed PR merges for a Ticket requiring merge." */
export type TicketCompletionCondition = "reviewed-pr-merged";

/**
 * One Round's retained delivery (v1-scope.md, "Deliverables and review":
 * "Each round retains its delivered commit and result.").
 */
export interface RoundRecord {
  readonly roundNumber: number;
  readonly deliveredCommitSha: string;
  readonly summary: string;
  readonly testsAndResults: string;
  readonly successCriteriaAssessment: string;
  readonly prNumber: number;
  readonly deliveredAtMs: number;
}

export type FeedbackKind = "review" | "comment";

/**
 * An informational feedback event (agent-execution.md: "GitHub reviews
 * and comments are informational in the first iteration, including a
 * submitted Request changes review."). Append-only; never interpreted
 * into a Status change.
 */
export interface FeedbackEvent {
  readonly kind: FeedbackKind;
  readonly detail: string;
  readonly recordedAtMs: number;
}

export type UndefinedTransitionKind = "closed-unmerged" | "merge-during-open-round";

/**
 * An exceptional PR fact this substitute deliberately does NOT interpret
 * into any Status change — open decision **D4** ("Exceptional PR and
 * template/repository changes," docs/open-decisions.md): "Preserve prior
 * deliveries; never infer a new PR or successful completion without a
 * defined transition."
 */
export interface UndefinedTransitionRecord {
  readonly kind: UndefinedTransitionKind;
  readonly observed: Readonly<Record<string, unknown>>;
  readonly recordedAtMs: number;
}

/**
 * An observed PR-state fact, reported "outside the Round-fencing model"
 * (docs/contracts/execution-interface.md) by Michelin's GitHub connection
 * or owner confirmation. Deliberately does not import any type from
 * `github-connection.ts`/`fake-github-api.ts` — in the real application
 * Galley never depends on Michelin's modules directly; it only receives
 * reported facts.
 */
export interface PrObservation {
  readonly merged: boolean;
  readonly state: "open" | "closed";
  readonly mergedAt?: string | null;
  readonly mergeCommitSha?: string | null;
  readonly prNumber?: number;
}

/** Read-only snapshot of a Ticket's current state, as returned by `createTicket`/`getTicket`/mutators. */
export interface TicketView {
  readonly id: string;
  readonly status: TicketStatus;
  readonly completionCondition: TicketCompletionCondition;
  readonly rounds: readonly RoundRecord[];
  readonly feedbackEvents: readonly FeedbackEvent[];
  readonly undefinedTransitions: readonly UndefinedTransitionRecord[];
  /** Whether the current Round is still open (started but not yet delivered). */
  readonly roundOpen: boolean;
  /** The open (or, if none is open, most recently opened) Round's number; `null` before any Round has started. */
  readonly currentRoundNumber: number | null;
}

interface TicketRecord {
  readonly id: string;
  status: TicketStatus;
  readonly rounds: RoundRecord[];
  readonly feedbackEvents: FeedbackEvent[];
  readonly undefinedTransitions: UndefinedTransitionRecord[];
  roundOpen: boolean;
  currentRoundNumber: number | null;
  nextRoundNumber: number;
}

function toTicketView(record: TicketRecord): TicketView {
  return {
    id: record.id,
    status: record.status,
    completionCondition: "reviewed-pr-merged",
    rounds: record.rounds.map((round) => ({ ...round })),
    feedbackEvents: record.feedbackEvents.map((event) => ({ ...event })),
    undefinedTransitions: record.undefinedTransitions.map((entry) => ({ ...entry, observed: { ...entry.observed } })),
    roundOpen: record.roundOpen,
    currentRoundNumber: record.currentRoundNumber,
  };
}

/** A sign-in session record. Intentionally carries no grant/authority field or method. */
export interface SignInSession {
  readonly sessionId: string;
  readonly login: string;
  readonly createdAtMs: number;
}

export interface SignInResult {
  readonly accepted: boolean;
  readonly session?: SignInSession;
  readonly reason?: "not-owner";
}

/**
 * Galley substitute: holds the configured Owner login, accepts or
 * rejects a sign-in identity, and owns the `AdmissionLedger` (driven by
 * the given `FakeClock`) that Connected Account grants come from.
 */
export class GalleySubstitute {
  readonly #ownerLogin: string;
  readonly #ledger: AdmissionLedger;
  readonly #sessions: SignInSession[] = [];
  readonly #tickets = new Map<string, TicketRecord>();

  constructor(ownerLogin: string, clock: FakeClock) {
    this.#ownerLogin = ownerLogin;
    this.#ledger = new AdmissionLedger(clock);
  }

  /** The configured Owner login; only this identity is accepted by `signIn()`. */
  get ownerLogin(): string {
    return this.#ownerLogin;
  }

  /** The admission ledger grants are recorded on. Not affected by `signIn()`. */
  get ledger(): AdmissionLedger {
    return this.#ledger;
  }

  /**
   * Attempt sign-in with `login` (as resolved from the fake OAuth `GET
   * /user` identity). Only the configured Owner is accepted. A rejected
   * non-owner identity gets no session at all.
   */
  signIn(login: string): SignInResult {
    if (login !== this.#ownerLogin) {
      return { accepted: false, reason: "not-owner" };
    }
    const session: SignInSession = {
      sessionId: `session-${randomUUID()}`,
      login,
      createdAtMs: this.#ledger.state().nowMs,
    };
    this.#sessions.push(session);
    return { accepted: true, session };
  }

  /** Every accepted sign-in session so far, oldest first. Copies, not live references. */
  sessions(): SignInSession[] {
    return this.#sessions.map((session) => ({ ...session }));
  }

  #requireTicket(ticketId: string): TicketRecord {
    const record = this.#tickets.get(ticketId);
    if (!record) throw new RangeError(`Unknown ticket id: ${ticketId}`);
    return record;
  }

  /**
   * Create a Ticket with the template-derived "reviewed-pr-merged"
   * completion condition (the Coding template's default; CONTEXT.md,
   * **Ticket Template**: "defining its visible fields and sections,
   * required information, and default completion condition"), starting
   * in Ready.
   */
  createTicket(ticketId: string): TicketView {
    if (this.#tickets.has(ticketId)) {
      throw new RangeError(`Ticket "${ticketId}" already exists`);
    }
    const record: TicketRecord = {
      id: ticketId,
      status: "Ready",
      rounds: [],
      feedbackEvents: [],
      undefinedTransitions: [],
      roundOpen: false,
      currentRoundNumber: null,
      nextRoundNumber: 1,
    };
    this.#tickets.set(ticketId, record);
    return toTicketView(record);
  }

  /** Current view of a Ticket's status, Rounds, feedback, and undefined transitions. */
  getTicket(ticketId: string): TicketView {
    return toTicketView(this.#requireTicket(ticketId));
  }

  /**
   * "Michelin begins work" (v1-scope.md, "Lifecycle") → In Progress.
   * Opens a new Round; at most one Round is open per Ticket at a time.
   * The Round after an explicit requeue is a NEW Round (its own
   * `roundNumber`), never a reopening of a prior one.
   */
  startRound(ticketId: string): { readonly roundNumber: number } {
    const ticket = this.#requireTicket(ticketId);
    if (ticket.roundOpen) {
      throw new Error(`Ticket "${ticketId}" already has an open Round`);
    }
    ticket.status = "In Progress";
    ticket.roundOpen = true;
    ticket.currentRoundNumber = ticket.nextRoundNumber++;
    return { roundNumber: ticket.currentRoundNumber };
  }

  /**
   * The "Delivered" event (docs/contracts/execution-interface.md):
   * "Ticket moves to In Review; the deliverable is retained on the
   * Round." Requires an open Round; closes it. The deliverable (delivered
   * commit sha, summary, tests/results, Success Criteria assessment, PR
   * number) is retained on that Round permanently — later Rounds append,
   * never overwrite.
   */
  recordDelivery(
    ticketId: string,
    input: {
      readonly commitSha: string;
      readonly summary: string;
      readonly testsAndResults: string;
      readonly successCriteriaAssessment: string;
      readonly prNumber: number;
    },
  ): RoundRecord {
    const ticket = this.#requireTicket(ticketId);
    if (!ticket.roundOpen || ticket.currentRoundNumber === null) {
      throw new Error(`Ticket "${ticketId}" has no open Round to deliver`);
    }
    const round: RoundRecord = {
      roundNumber: ticket.currentRoundNumber,
      deliveredCommitSha: input.commitSha,
      summary: input.summary,
      testsAndResults: input.testsAndResults,
      successCriteriaAssessment: input.successCriteriaAssessment,
      prNumber: input.prNumber,
      deliveredAtMs: this.#ledger.state().nowMs,
    };
    ticket.rounds.push(round);
    ticket.roundOpen = false;
    ticket.status = "In Review";
    return { ...round };
  }

  /**
   * GitHub reviews/comments are informational (agent-execution.md:
   * "GitHub reviews and comments are informational in the first
   * iteration, including a submitted Request changes review. Surface
   * feedback in ticketIt, but require the user to explicitly return the
   * ticket to Ready to request another round."). Append-only: never
   * changes Status, never starts or closes a Round — including an
   * APPROVED review, which alone leaves the Ticket In Review.
   */
  recordFeedback(ticketId: string, event: { readonly kind: FeedbackKind; readonly detail: string }): FeedbackEvent {
    const ticket = this.#requireTicket(ticketId);
    const recorded: FeedbackEvent = { kind: event.kind, detail: event.detail, recordedAtMs: this.#ledger.state().nowMs };
    ticket.feedbackEvents.push(recorded);
    return { ...recorded };
  }

  /**
   * Report an observed PR-state fact (docs/contracts/execution-interface.md:
   * "Michelin's GitHub connection can check merge status, and the owner
   * can confirm merge in Swiftlet; either path reports that fact to
   * Galley outside the Round-fencing model"). Three defined outcomes:
   *
   * - **Merged, with no open Round**: Ticket → Done, and
   *   `ledger.ticketDone(ticketId)` permanently ends its ticket-based
   *   grants (v1-scope.md, "Permissions and accounts": "permanently ends
   *   at Done").
   * - **Closed without merging**: an undefined transition for **D4**
   *   (docs/open-decisions.md: "Define closed-unmerged PRs...") —
   *   recorded with the observed data; Status is NOT changed, since D4 is
   *   not resolved here.
   * - **Observed while a Round is open** (merged or closed): also an
   *   undefined transition for D4 ("merge arrival during an open round"
   *   is D4's own wording) — recorded, Status unchanged, the Round stays
   *   open. Checked FIRST, before the merged/closed branches above, since
   *   an open Round makes either fact contradictory to interpret safely.
   *
   * An observation of a still-open, unmerged PR (e.g. approval alone,
   * which is informational feedback via `recordFeedback`, not this
   * method) is not a fact worth reporting through `observeMerge` and is
   * a no-op here.
   */
  observeMerge(ticketId: string, observation: PrObservation): void {
    const ticket = this.#requireTicket(ticketId);
    if (ticket.roundOpen) {
      ticket.undefinedTransitions.push({
        kind: "merge-during-open-round",
        observed: { ...observation },
        recordedAtMs: this.#ledger.state().nowMs,
      });
      return;
    }
    if (observation.merged) {
      if (ticket.status === "In Review") {
        ticket.status = "Done";
        this.#ledger.ticketDone(ticketId);
      }
      return;
    }
    if (observation.state === "closed") {
      ticket.undefinedTransitions.push({
        kind: "closed-unmerged",
        observed: { ...observation },
        recordedAtMs: this.#ledger.state().nowMs,
      });
    }
  }

  /**
   * Owner command: request rework (docs/contracts/execution-interface.md).
   * Requires In Review; moves to Ready. Does not itself open a Round —
   * "the next admitted claim creates a new Round" (same doc), modeled
   * here as the next `startRound()` call creating a new `roundNumber`.
   */
  explicitRequeue(ticketId: string): void {
    const ticket = this.#requireTicket(ticketId);
    if (ticket.status !== "In Review") {
      throw new Error(`Ticket "${ticketId}" must be In Review to requeue, was "${ticket.status}"`);
    }
    ticket.status = "Ready";
  }

  /**
   * Reopen a Done Ticket. `AdmissionLedger.ticketDone()` is permanent
   * (v1-scope.md, "Permissions and accounts": "permanently ends at Done;
   * reopening does not restore it") — `ledger.ticketReopened(ticketId)`
   * records the reopen without undoing that, structurally guaranteeing
   * the ticket-based grant stays denied. This slice interprets "reopen"
   * as returning the Ticket to In Review (it again awaits its completion
   * condition); CONTEXT.md does not name a distinct Status for a
   * reopened-after-Done Ticket, so this is this slice's own modeling
   * choice — see the evidence record's "Decision impacts".
   */
  reopen(ticketId: string): void {
    const ticket = this.#requireTicket(ticketId);
    if (ticket.status !== "Done") {
      throw new Error(`Ticket "${ticketId}" must be Done to reopen, was "${ticket.status}"`);
    }
    ticket.status = "In Review";
    this.#ledger.ticketReopened(ticketId);
  }
}
