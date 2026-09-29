import type { Ticket } from "../../api/tickets";

export type TicketStatus = Ticket["status"];

export const statuses: { value: TicketStatus; label: string }[] = [
  { value: "Backlog", label: "Backlog" },
  { value: "Ready", label: "Ready" },
  { value: "InProgress", label: "In Progress" },
  { value: "Blocked", label: "Blocked" },
  { value: "InReview", label: "In Review" },
  { value: "Done", label: "Done" },
];

export function statusLabel(status: TicketStatus): string {
  return statuses.find(({ value }) => value === status)?.label ?? status;
}

export function statusTone(status: TicketStatus): { "data-status": TicketStatus } {
  return { "data-status": status };
}
