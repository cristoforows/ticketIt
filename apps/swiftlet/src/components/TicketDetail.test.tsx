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

/** No-op workflow-command props for tests that don't exercise them. */
function noopActions() {
  return {
    onChangeStatus: vi.fn<(status: Ticket["status"]) => Promise<Ticket>>(),
    onAccept: vi.fn<() => Promise<Ticket>>(),
    onAssign: vi.fn<() => Promise<Ticket>>(),
    onUnassign: vi.fn<() => Promise<Ticket>>(),
  };
}

describe("TicketDetail", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the given Ticket's title, Status, Template, completion condition, and timestamps", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);

    expect(screen.getByTestId("ticket-detail-title")).toHaveTextContent(TICKET.title);
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent(TICKET.status);
    expect(screen.getByTestId("ticket-detail-template")).toHaveTextContent("Basic");
    expect(screen.getByTestId("ticket-detail-completion-condition")).toHaveTextContent("Human acceptance");
    expect(screen.getByTestId("ticket-detail-created-at")).toHaveTextContent(TICKET.createdAt);
    expect(screen.getByTestId("ticket-detail-updated-at")).toHaveTextContent(TICKET.updatedAt);
  });

  it("renders no section for a Round, Report, or Grill Mode -- none of those exist yet", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);

    for (const testid of ["ticket-detail-rounds", "ticket-detail-reports", "ticket-detail-grill-mode"]) {
      expect(screen.queryByTestId(testid)).not.toBeInTheDocument();
    }
  });

  it("shows the reviewed-PR-merge completion condition and a Pull Request section for a Coding ticket", () => {
    render(<TicketDetail ticket={CODING_TICKET} onSave={vi.fn()} {...noopActions()} />);

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
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);

    expect(screen.queryByTestId("ticket-detail-pr-section")).not.toBeInTheDocument();
  });

  it("shows a placeholder for each unset refinement field and repository in view mode", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);

    expect(screen.getByTestId("ticket-detail-field-goal")).toHaveTextContent("Not set.");
    expect(screen.getByTestId("ticket-detail-field-context")).toHaveTextContent("Not set.");
    expect(screen.getByTestId("ticket-detail-field-success-criteria")).toHaveTextContent("Not set.");
    expect(screen.getByTestId("ticket-detail-field-constraints")).toHaveTextContent("Not set.");
    expect(screen.getByTestId("ticket-detail-field-repository")).toHaveTextContent("Not set.");
  });

  it("shows each refinement field's and repository's stored value in view mode when set", () => {
    render(<TicketDetail ticket={REFINED_TICKET} onSave={vi.fn()} {...noopActions()} />);

    expect(screen.getByTestId("ticket-detail-field-goal")).toHaveTextContent(REFINED_TICKET.goal);
    expect(screen.getByTestId("ticket-detail-field-context")).toHaveTextContent(REFINED_TICKET.context);
    expect(screen.getByTestId("ticket-detail-field-success-criteria")).toHaveTextContent(
      REFINED_TICKET.successCriteria,
    );
    expect(screen.getByTestId("ticket-detail-field-constraints")).toHaveTextContent(REFINED_TICKET.constraints);
    expect(screen.getByTestId("ticket-detail-field-repository")).toHaveTextContent(REFINED_TICKET.repository);
  });

  it("has no edit form until Edit is clicked", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);

    expect(screen.queryByTestId("ticket-detail-edit-form")).not.toBeInTheDocument();
  });

  it("enters edit mode with the guidance prompts from docs/ticket-creation.md, verbatim", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);

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
    render(<TicketDetail ticket={REFINED_TICKET} onSave={vi.fn()} {...noopActions()} />);

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

    render(<TicketDetail ticket={TICKET} onSave={onSave} {...noopActions()} />);
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
    render(<TicketDetail ticket={TICKET} onSave={onSave} {...noopActions()} />);

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

    render(<TicketDetail ticket={TICKET} onSave={onSave} {...noopActions()} />);
    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
    fireEvent.click(screen.getByTestId("ticket-detail-save-button"));

    expect(await screen.findByTestId("ticket-detail-save-error")).toHaveTextContent(
      '"goal" must be at most 2000 characters after trimming',
    );
    expect(screen.getByTestId("ticket-detail-edit-form")).toBeInTheDocument();
  });

  // The workflow controls live in this reusable component rather than
  // TicketDetailPage, so M3's modal inherits them unchanged.
  describe("workflow controls", () => {
    it("shows Unassigned and an Assign button when the Ticket has no Assignee", () => {
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);

      expect(screen.getByTestId("ticket-detail-assignee")).toHaveTextContent("Unassigned");
      expect(screen.getByTestId("ticket-detail-assign-button")).toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-unassign-button")).not.toBeInTheDocument();
    });

    it("shows Owner and an Unassign button when the Ticket is Owner-assigned", () => {
      const assigned: Ticket = { ...TICKET, assigneeType: "owner" };
      render(<TicketDetail ticket={assigned} onSave={vi.fn()} {...noopActions()} />);

      expect(screen.getByTestId("ticket-detail-assignee")).toHaveTextContent("Owner");
      expect(screen.getByTestId("ticket-detail-unassign-button")).toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-assign-button")).not.toBeInTheDocument();
    });

    it("assigns the Owner and shows the updated Ticket Galley returned", async () => {
      const assigned: Ticket = { ...TICKET, assigneeType: "owner" };
      const onAssign = vi.fn<() => Promise<Ticket>>().mockResolvedValue(assigned);
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} onAssign={onAssign} />);

      fireEvent.click(screen.getByTestId("ticket-detail-assign-button"));

      expect(await screen.findByTestId("ticket-detail-assignee")).toHaveTextContent("Owner");
      expect(onAssign).toHaveBeenCalledTimes(1);
    });

    it("unassigns and shows the updated Ticket Galley returned", async () => {
      const assigned: Ticket = { ...TICKET, assigneeType: "owner" };
      const unassigned: Ticket = { ...TICKET, assigneeType: "" };
      const onUnassign = vi.fn<() => Promise<Ticket>>().mockResolvedValue(unassigned);
      render(<TicketDetail ticket={assigned} onSave={vi.fn()} {...noopActions()} onUnassign={onUnassign} />);

      fireEvent.click(screen.getByTestId("ticket-detail-unassign-button"));

      expect(await screen.findByTestId("ticket-detail-assignee")).toHaveTextContent("Unassigned");
      expect(onUnassign).toHaveBeenCalledTimes(1);
    });

    it("offers only D3 S2's allowed next Statuses for each current Status, and never Done", () => {
      const cases: Array<[Ticket["status"], Ticket["status"][]]> = [
        ["Backlog", ["Ready"]],
        ["Ready", ["Backlog", "InProgress"]],
        ["InProgress", ["Ready", "Blocked", "InReview"]],
        ["Blocked", ["InProgress"]],
        ["InReview", ["InProgress"]],
        ["Done", ["Ready"]],
      ];
      for (const [status, expectedTargets] of cases) {
        const ticket: Ticket = { ...TICKET, status };
        const { unmount } = render(<TicketDetail ticket={ticket} onSave={vi.fn()} {...noopActions()} />);

        for (const target of ["Backlog", "Ready", "InProgress", "Blocked", "InReview", "Done"] as const) {
          const button = screen.queryByTestId(`ticket-detail-status-button-${target}`);
          if (expectedTargets.includes(target)) {
            expect(button, `expected a ${target} button from ${status}`).toBeInTheDocument();
          } else {
            expect(button, `expected no ${target} button from ${status}`).not.toBeInTheDocument();
          }
        }
        unmount();
      }
    });

    it("moves to the clicked Status and shows the updated Ticket Galley returned", async () => {
      const moved: Ticket = { ...TICKET, status: "Ready" };
      const onChangeStatus = vi.fn<(status: Ticket["status"]) => Promise<Ticket>>().mockResolvedValue(moved);
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} onChangeStatus={onChangeStatus} />);

      fireEvent.click(screen.getByTestId("ticket-detail-status-button-Ready"));

      expect(await screen.findByTestId("ticket-detail-status")).toHaveTextContent("Ready");
      expect(onChangeStatus).toHaveBeenCalledWith("Ready");
    });

    it("surfaces Galley's own rejection verbatim and leaves the displayed Status unchanged -- never an optimistic update", async () => {
      const onChangeStatus = vi
        .fn<(status: Ticket["status"]) => Promise<Ticket>>()
        .mockRejectedValue(new Error("the transition Backlog -> InProgress is not permitted"));
      const ready: Ticket = { ...TICKET, status: "Ready" };
      render(<TicketDetail ticket={ready} onSave={vi.fn()} {...noopActions()} onChangeStatus={onChangeStatus} />);

      fireEvent.click(screen.getByTestId("ticket-detail-status-button-InProgress"));

      expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent(
        "the transition Backlog -> InProgress is not permitted",
      );
      // Still Ready: a rejection never touches the displayed Status.
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Ready");
    });

    it("shows Accept only when In Review with a retained humanAcceptance condition", () => {
      const inReview: Ticket = { ...TICKET, status: "InReview" };
      render(<TicketDetail ticket={inReview} onSave={vi.fn()} {...noopActions()} />);

      expect(screen.getByTestId("ticket-detail-accept-button")).toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-accept-unavailable")).not.toBeInTheDocument();
    });

    it("accepts and shows the Ticket as Done", async () => {
      const inReview: Ticket = { ...TICKET, status: "InReview" };
      const done: Ticket = { ...inReview, status: "Done" };
      const onAccept = vi.fn<() => Promise<Ticket>>().mockResolvedValue(done);
      render(<TicketDetail ticket={inReview} onSave={vi.fn()} {...noopActions()} onAccept={onAccept} />);

      fireEvent.click(screen.getByTestId("ticket-detail-accept-button"));

      expect(await screen.findByTestId("ticket-detail-status")).toHaveTextContent("Done");
      expect(onAccept).toHaveBeenCalledTimes(1);
    });

    it("shows Galley's not-yet-implemented reason instead of an Accept button for an In Review reviewedPrMerge Ticket", () => {
      const inReviewCoding: Ticket = { ...CODING_TICKET, status: "InReview" };
      render(<TicketDetail ticket={inReviewCoding} onSave={vi.fn()} {...noopActions()} />);

      expect(screen.queryByTestId("ticket-detail-accept-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-accept-unavailable")).toHaveTextContent(
        "reviewed PR merge, which cannot be completed in M2",
      );
      expect(screen.getByTestId("ticket-detail-accept-unavailable")).toHaveTextContent("D2");
      expect(screen.getByTestId("ticket-detail-accept-unavailable")).toHaveTextContent("M8");
    });

    it("shows no Accept control at all outside In Review, for either completion condition", () => {
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);
      expect(screen.queryByTestId("ticket-detail-accept-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-accept-unavailable")).not.toBeInTheDocument();

      render(<TicketDetail ticket={CODING_TICKET} onSave={vi.fn()} {...noopActions()} />);
      expect(screen.queryByTestId("ticket-detail-accept-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-accept-unavailable")).not.toBeInTheDocument();
    });

    it("offers no Agent Assignee option anywhere -- M2 has no Agents (AGENTS.md)", () => {
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);
      expect(screen.queryByText(/agent/i)).not.toBeInTheDocument();
    });
  });
});
