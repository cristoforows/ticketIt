import { randomUUID } from "node:crypto";

/**
 * The identity mapping between a ticketIt Round and the OpenCode engine
 * execution it is attached to (see ADR 0002, "Round identity separate
 * from engine session/thread identity", and
 * docs/contracts/execution-interface.md, "Identity model"). The Round ID
 * is issued locally and never sent to OpenCode; the engine execution
 * reference is the OpenCode session ID, a separate record attached to
 * the Round.
 */
export interface RoundMapping {
  /** Issued locally (Galley, in production); never sent to the engine. */
  roundId: string;
  /** The OpenCode session ID, attached as the Round's current engine execution reference. */
  engineExecutionReference: string;
}

/**
 * Create a Round ID (uuid) and attach an already-created OpenCode session
 * ID as its engine execution reference. Does not talk to OpenCode: the
 * session must already exist (created through `ManagedOpenCode.session`).
 */
export function createRoundMapping(engineExecutionReference: string): RoundMapping {
  if (!engineExecutionReference) {
    throw new Error("createRoundMapping requires a non-empty engine execution reference (e.g. an OpenCode session id)");
  }
  return { roundId: randomUUID(), engineExecutionReference };
}
