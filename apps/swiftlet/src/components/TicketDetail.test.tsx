import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TicketDetail } from "./TicketDetail";
import type { Ticket } from "../api/tickets";

const TICKET: Ticket = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Fix login bug on Safari",
  status: "Backlog",
  createdAt: "2026-09-22T10:00:00Z",
  updatedAt: "2026-09-22T10:05:00Z",
};

describe("TicketDetail", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the given Ticket's title, Status, and timestamps, and only those fields", () => {
    render(<TicketDetail ticket={TICKET} />);

    expect(screen.getByTestId("ticket-detail-title")).toHaveTextContent(TICKET.title);
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent(TICKET.status);
    expect(screen.getByTestId("ticket-detail-created-at")).toHaveTextContent(TICKET.createdAt);
    expect(screen.getByTestId("ticket-detail-updated-at")).toHaveTextContent(TICKET.updatedAt);
  });

  it("renders no section for a Round, Report, PR link, or Grill Mode -- none of those exist yet", () => {
    render(<TicketDetail ticket={TICKET} />);

    for (const testid of ["ticket-detail-rounds", "ticket-detail-reports", "ticket-detail-pr-links", "ticket-detail-grill-mode"]) {
      expect(screen.queryByTestId(testid)).not.toBeInTheDocument();
    }
  });
});
