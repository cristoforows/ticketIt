import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Ticket } from "../api/tickets";
import { ReorderButtons, stageMoves } from "./ReorderButtons";

const ticket = (id: string, status: Ticket["status"]) => ({ id, title: `Ticket ${id}`, status }) as Ticket;

describe("stageMoves", () => {
  const order = [ticket("r1", "Ready"), ticket("b1", "Backlog"), ticket("r2", "Ready"), ticket("b2", "Backlog"), ticket("r3", "Ready")];

  it.each([
    ["r1", { reason: "Already first in Ready" }, { placement: { after: "r2" } }],
    ["r2", { placement: { before: "r1" } }, { placement: { after: "r3" } }],
    ["r3", { placement: { before: "r2" } }, { reason: "Already last in Ready" }],
    ["b1", { reason: "Already first in Backlog" }, { placement: { after: "b2" } }],
  ])("uses %s's neighbours within its own Status, skipping interleaved Statuses", (id, up, down) => {
    expect(stageMoves(order, order.find((item) => item.id === id)!)).toEqual({ up, down });
  });
});

describe("ReorderButtons", () => {
  afterEach(cleanup);

  it("sends the neighbour placement and disables each end with its reason", () => {
    const onReorder = vi.fn();
    const tickets = [ticket("first", "Ready"), ticket("last", "Ready")];
    render(<ReorderButtons ticket={tickets[0]} tickets={tickets} disabled={false} testIdPrefix="t" onReorder={onReorder} />);

    expect(screen.getByRole("group", { name: "Reorder Ticket first" })).toBeInTheDocument();
    const up = screen.getByRole("button", { name: "Move up" });
    expect(up).toBeDisabled();
    expect(up).toHaveAccessibleDescription("Already first in Ready");
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    expect(onReorder).toHaveBeenCalledWith({ after: "last" }, "down");
  });

  it("disables both while another command is pending", () => {
    const tickets = [ticket("a", "Ready"), ticket("b", "Ready"), ticket("c", "Ready")];
    render(<ReorderButtons ticket={tickets[1]} tickets={tickets} disabled testIdPrefix="t" onReorder={() => {}} />);
    expect(screen.getByTestId("t-reorder-up")).toBeDisabled();
    expect(screen.getByTestId("t-reorder-down")).toBeDisabled();
  });
});
