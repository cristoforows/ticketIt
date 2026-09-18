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
 */
import { randomUUID } from "node:crypto";
import { AdmissionLedger, type FakeClock } from "shared";

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
}
