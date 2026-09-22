import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TicketDetail } from "./TicketDetail";
import type { Ticket, TicketUpdate } from "../api/tickets";

const TICKET: Ticket = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Fix login bug on Safari",
  status: "Backlog",
  template: "Basic",
  completionCondition: "humanAcceptance",
  assigneeType: "",
  goal: "",
  context: "",
  successCriteria: "",
  constraints: "",
  repository: "",
  createdAt: "2026-09-22T10:00:00Z",
  updatedAt: "2026-09-22T10:05:00Z",
};

const CODING_TICKET: Ticket = {
  ...TICKET,
  id: "77777777-7777-4777-8777-777777777777",
  template: "Coding",
  completionCondition: "reviewedPrMerge",
};

const REFINED_TICKET: Ticket = {
  ...TICKET,
  goal: "Restore sign-in for existing users on Safari.",
  context: "Include the affected page and reproduction steps.",
  successCriteria: "Existing users can sign in on Safari.",
  constraints: "Preserve the existing login flow.",
  repository: "owner/safari-fixes",
};

describe("TicketDetail", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the given Ticket's title, Status, Template, completion condition, and timestamps", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} />);

    expect(screen.getByTestId("ticket-detail-title")).toHaveTextContent(TICKET.title);
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent(TICKET.status);
    expect(screen.getByTestId("ticket-detail-template")).toHaveTextContent("Basic");
    expect(screen.getByTestId("ticket-detail-completion-condition")).toHaveTextContent("Human acceptance");
    expect(screen.getByTestId("ticket-detail-created-at")).toHaveTextContent(TICKET.createdAt);
    expect(screen.getByTestId("ticket-detail-updated-at")).toHaveTextContent(TICKET.updatedAt);
  });

  it("renders no section for a Round, Report, or Grill Mode -- none of those exist yet", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} />);

    for (const testid of ["ticket-detail-rounds", "ticket-detail-reports", "ticket-detail-grill-mode"]) {
      expect(screen.queryByTestId(testid)).not.toBeInTheDocument();
    }
  });

  it("shows the reviewed-PR-merge completion condition and a Pull Request section for a Coding ticket", () => {
    render(<TicketDetail ticket={CODING_TICKET} onSave={vi.fn()} />);

    expect(screen.getByTestId("ticket-detail-template")).toHaveTextContent("Coding");
    expect(screen.getByTestId("ticket-detail-completion-condition")).toHaveTextContent(
      "Reviewed pull request merged",
    );
    expect(screen.getByTestId("ticket-detail-pr-section")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-pr-empty-state")).toHaveTextContent(
      "PR delivery arrives with coding execution",
    );
  });

  it("renders no Pull Request section for a Basic ticket", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} />);

    expect(screen.queryByTestId("ticket-detail-pr-section")).not.toBeInTheDocument();
  });

  it("shows a placeholder for each unset refinement field and repository in view mode", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} />);

    expect(screen.getByTestId("ticket-detail-field-goal")).toHaveTextContent("Not set.");
    expect(screen.getByTestId("ticket-detail-field-context")).toHaveTextContent("Not set.");
    expect(screen.getByTestId("ticket-detail-field-success-criteria")).toHaveTextContent("Not set.");
    expect(screen.getByTestId("ticket-detail-field-constraints")).toHaveTextContent("Not set.");
    expect(screen.getByTestId("ticket-detail-field-repository")).toHaveTextContent("Not set.");
  });

  it("shows each refinement field's and repository's stored value in view mode when set", () => {
    render(<TicketDetail ticket={REFINED_TICKET} onSave={vi.fn()} />);

    expect(screen.getByTestId("ticket-detail-field-goal")).toHaveTextContent(REFINED_TICKET.goal);
    expect(screen.getByTestId("ticket-detail-field-context")).toHaveTextContent(REFINED_TICKET.context);
    expect(screen.getByTestId("ticket-detail-field-success-criteria")).toHaveTextContent(
      REFINED_TICKET.successCriteria,
    );
    expect(screen.getByTestId("ticket-detail-field-constraints")).toHaveTextContent(REFINED_TICKET.constraints);
    expect(screen.getByTestId("ticket-detail-field-repository")).toHaveTextContent(REFINED_TICKET.repository);
  });

  it("has no edit form until Edit is clicked", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} />);

    expect(screen.queryByTestId("ticket-detail-edit-form")).not.toBeInTheDocument();
  });

  it("enters edit mode with the guidance prompts from docs/ticket-creation.md, verbatim", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} />);

    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));

    expect(screen.getByTestId("ticket-detail-edit-form")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-guidance-goal")).toHaveTextContent("What outcome do you want?");
    expect(screen.getByTestId("ticket-detail-guidance-context")).toHaveTextContent(
      "Supply relevant background, links, repositories, or examples.",
    );
    expect(screen.getByTestId("ticket-detail-guidance-success-criteria")).toHaveTextContent(
      "Describe observable conditions that demonstrate the outcome was achieved.",
    );
    expect(screen.getByTestId("ticket-detail-guidance-constraints")).toHaveTextContent(
      "State what must stay unchanged or remain out of scope.",
    );
  });

  it("pre-fills the edit form with the Ticket's current values", () => {
    render(<TicketDetail ticket={REFINED_TICKET} onSave={vi.fn()} />);

    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));

    expect(screen.getByTestId("ticket-detail-input-title")).toHaveValue(REFINED_TICKET.title);
    expect(screen.getByTestId("ticket-detail-textarea-goal")).toHaveValue(REFINED_TICKET.goal);
    expect(screen.getByTestId("ticket-detail-textarea-context")).toHaveValue(REFINED_TICKET.context);
    expect(screen.getByTestId("ticket-detail-textarea-success-criteria")).toHaveValue(
      REFINED_TICKET.successCriteria,
    );
    expect(screen.getByTestId("ticket-detail-textarea-constraints")).toHaveValue(REFINED_TICKET.constraints);
    expect(screen.getByTestId("ticket-detail-input-repository")).toHaveValue(REFINED_TICKET.repository);
  });

  it("saves the edited fields and returns to view mode showing the saved values", async () => {
    const saved: Ticket = { ...TICKET, goal: "Restore sign-in for existing users on Safari." };
    const onSave = vi.fn<(update: TicketUpdate) => Promise<Ticket>>().mockResolvedValue(saved);

    render(<TicketDetail ticket={TICKET} onSave={onSave} />);
    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
    fireEvent.change(screen.getByTestId("ticket-detail-textarea-goal"), {
      target: { value: "Restore sign-in for existing users on Safari." },
    });
    fireEvent.click(screen.getByTestId("ticket-detail-save-button"));

    expect(await screen.findByTestId("ticket-detail-field-goal")).toHaveTextContent(
      "Restore sign-in for existing users on Safari.",
    );
    expect(screen.queryByTestId("ticket-detail-edit-form")).not.toBeInTheDocument();
    // template is never part of the payload -- Save never sends it, and
    // there is no control anywhere in this component that could.
    expect(onSave).toHaveBeenCalledWith({
      title: TICKET.title,
      goal: "Restore sign-in for existing users on Safari.",
      context: "",
      successCriteria: "",
      constraints: "",
      repository: "",
    });
  });

  it("discards edits and returns to view mode on Cancel, without calling onSave", () => {
    const onSave = vi.fn();
    render(<TicketDetail ticket={TICKET} onSave={onSave} />);

    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
    fireEvent.change(screen.getByTestId("ticket-detail-textarea-goal"), { target: { value: "Discarded text" } });
    fireEvent.click(screen.getByTestId("ticket-detail-cancel-button"));

    expect(screen.queryByTestId("ticket-detail-edit-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-field-goal")).toHaveTextContent("Not set.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("surfaces Galley's own rejection message verbatim and stays in edit mode", async () => {
    const onSave = vi
      .fn<(update: TicketUpdate) => Promise<Ticket>>()
      .mockRejectedValue(new Error('"goal" must be at most 2000 characters after trimming'));

    render(<TicketDetail ticket={TICKET} onSave={onSave} />);
    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
    fireEvent.click(screen.getByTestId("ticket-detail-save-button"));

    expect(await screen.findByTestId("ticket-detail-save-error")).toHaveTextContent(
      '"goal" must be at most 2000 characters after trimming',
    );
    expect(screen.getByTestId("ticket-detail-edit-form")).toBeInTheDocument();
  });
});
