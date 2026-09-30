import type { Ticket } from "../api/tickets";

export function assigneeLabel(ticket: Pick<Ticket, "assigneeType" | "assigneeAgent">): string {
  if (ticket.assigneeAgent) return ticket.assigneeAgent.name;
  return ticket.assigneeType === "owner" ? "Owner" : "Unassigned";
}
