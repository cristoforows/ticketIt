import type { Ticket } from "../api/tickets";

export function lockedLabel(round: NonNullable<Ticket["openRound"]>): string {
  return `Locked while ${round.agent.name} works on Round ${round.sequence}`;
}
