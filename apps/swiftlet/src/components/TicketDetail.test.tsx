import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { TicketDetail } from "./TicketDetail";
import type { Agent } from "../api/agents";
import type { Badge, Ticket, TicketAssignee, TicketUpdate } from "../api/tickets";
import { statusLabel } from "./ui";
import { GalleyError } from "../api/http";
import type { HealthView } from "./RunnerHealthPill";

const TICKET: Ticket = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Fix login bug on Safari",
  status: "Backlog",
  allowedActions: { statusChangeRejections: [], statusChanges: ["Ready", "Blocked"], accept: { available: false, reason: { code: "invalid_transition", message: "Accept requires In Review" } } },
  template: "Basic",
  completionCondition: "humanAcceptance",
  assigneeType: "",
  assigneeAgent: null,
  requestingAgentWork: false,
  openRound: null,
  delivery: null,
  goal: "",
  context: "",
  successCriteria: "",
  constraints: "",
  repository: "",
  createdAt: "2026-09-22T10:00:00Z",
  updatedAt: "2026-09-22T10:05:00Z",
  badges: [],
  archivedAt: null,
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
    onAssign: vi.fn<(assignee: TicketAssignee) => Promise<Ticket>>(),
    onUnassign: vi.fn<() => Promise<Ticket>>(),
    onLoadAgents: vi.fn<() => Promise<Agent[]>>().mockResolvedValue([]),
    onLoadBadges: vi.fn<() => Promise<import("../api/tickets").Badge[]>>().mockResolvedValue([]),
    onCreateBadge: vi.fn<(name: string) => Promise<import("../api/tickets").Badge>>(),
    onAttachBadge: vi.fn<(id: string) => Promise<Ticket>>(),
    onDetachBadge: vi.fn<(id: string) => Promise<Ticket>>(),
    onArchive: vi.fn<() => Promise<Ticket>>(),
    onRestore: vi.fn<() => Promise<Ticket>>(),
  };
}

const BADGE: Badge = { id: "11111111-1111-4111-8111-111111111111", name: "Urgent", createdAt: "2026-09-22T10:00:00Z" };

describe("initial detail interaction", () => {
  afterEach(cleanup);

  it("does not reset editing when the Owner opens it during the first mounted commit", () => {
    function OpenEditOnMount() {
      useLayoutEffect(() => {
        document.querySelector<HTMLButtonElement>('[data-testid="ticket-detail-edit-button"]')?.click();
      }, []);
      return <TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />;
    }
    render(<OpenEditOnMount />);
    expect(screen.getByTestId("ticket-detail-edit-form")).toBeInTheDocument();
  });

  it("resets an in-progress edit when the Ticket prop changes", () => {
    const actions = noopActions();
    const onSave = vi.fn();
    const { rerender } = render(<TicketDetail ticket={TICKET} onSave={onSave} {...actions} />);
    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
    fireEvent.change(screen.getByTestId("ticket-detail-textarea-goal"), { target: { value: "Draft goal" } });

    const other = { ...TICKET, id: "55555555-5555-4555-8555-555555555555", title: "Another ticket" };
    rerender(<TicketDetail ticket={other} onSave={onSave} {...actions} />);

    expect(screen.queryByTestId("ticket-detail-edit-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-title")).toHaveTextContent(other.title);
  });
});

describe("Badge picker", () => {
  afterEach(cleanup);

  it("removes an attached Badge only after Galley confirms detach", async () => {
    let resolve!: (ticket: Ticket) => void;
    const detached = new Promise<Ticket>((done) => { resolve = done; });
    const onDetachBadge = vi.fn().mockReturnValue(detached);
    render(<TicketDetail ticket={{ ...TICKET, badges: [{ id: BADGE.id, name: BADGE.name }] }} onSave={vi.fn()} {...noopActions()} onDetachBadge={onDetachBadge} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Urgent" }));
    expect(onDetachBadge).toHaveBeenCalledWith(BADGE.id);
    expect(screen.getByTestId("ticket-detail-badges")).toHaveTextContent("Urgent");
    resolve({ ...TICKET, badges: [] });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Urgent" })).not.toBeInTheDocument());
  });

  it("creates and attaches inline, then offers another Ticket the existing Badge", async () => {
    const onCreateBadge = vi.fn().mockResolvedValue(BADGE);
    const onAttachBadge = vi.fn().mockResolvedValue({ ...TICKET, badges: [{ id: BADGE.id, name: BADGE.name }] });
    const actions = { ...noopActions(), onLoadBadges: vi.fn().mockResolvedValue([BADGE]), onCreateBadge, onAttachBadge };
    const { unmount } = render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...actions} />);
    fireEvent.click(screen.getByTestId("badge-picker-toggle"));
    await waitFor(() => expect(screen.getByRole("option", { name: BADGE.name })).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("new-badge-name"), { target: { value: BADGE.name } });
    fireEvent.click(screen.getByRole("button", { name: "Create and attach" }));
    await waitFor(() => expect(screen.getByTestId("ticket-detail-badges")).toHaveTextContent(BADGE.name));
    expect(onCreateBadge).toHaveBeenCalledWith(BADGE.name);
    expect(onAttachBadge).toHaveBeenCalledWith(BADGE.id);
    unmount();
    render(<TicketDetail ticket={{ ...TICKET, id: "another-ticket" }} onSave={vi.fn()} {...actions} />);
    fireEvent.click(screen.getByTestId("badge-picker-toggle"));
    await waitFor(() => expect(screen.getByRole("option", { name: BADGE.name })).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("badge-picker-select"), { target: { value: BADGE.id } });
    fireEvent.click(screen.getByRole("button", { name: "Attach badge" }));
    await waitFor(() => expect(onAttachBadge).toHaveBeenCalledTimes(2));
  });

  it("shows Galley's duplicate rejection and leaves the Ticket unchanged", async () => {
    const actions = { ...noopActions(), onCreateBadge: vi.fn().mockRejectedValue(new Error("a badge with that name already exists")) };
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...actions} />);
    fireEvent.click(screen.getByTestId("badge-picker-toggle"));
    fireEvent.change(screen.getByTestId("new-badge-name"), { target: { value: BADGE.name } });
    fireEvent.click(screen.getByRole("button", { name: "Create and attach" }));
    expect(await screen.findByTestId("badge-picker-error")).toHaveTextContent("a badge with that name already exists");
    expect(actions.onAttachBadge).not.toHaveBeenCalled();
  });

  it("clears a failed Badge list load when the picker reopens and the retry succeeds", async () => {
    const onLoadBadges = vi.fn().mockRejectedValueOnce(new Error("Badge list unavailable")).mockResolvedValue([BADGE]);
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} onLoadBadges={onLoadBadges} />);
    fireEvent.click(screen.getByTestId("badge-picker-toggle"));
    expect(await screen.findByTestId("badge-picker-error")).toHaveTextContent("Badge list unavailable");
    fireEvent.click(screen.getByTestId("badge-picker-toggle"));
    fireEvent.click(screen.getByTestId("badge-picker-toggle"));
    await waitFor(() => expect(onLoadBadges).toHaveBeenCalledTimes(2));
    await screen.findByRole("option", { name: BADGE.name });
    expect(screen.queryByTestId("badge-picker-error")).not.toBeInTheDocument();
  });

  it("keeps a created Badge when the initial catalog request resolves later", async () => {
    let resolveLoad!: (badges: Badge[]) => void;
    const onLoadBadges = vi.fn(() => new Promise<Badge[]>((resolve) => { resolveLoad = resolve; }));
    const actions = {
      ...noopActions(),
      onLoadBadges,
      onCreateBadge: vi.fn().mockResolvedValue(BADGE),
      onAttachBadge: vi.fn().mockRejectedValue(new Error("attach failed")),
    };
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...actions} />);
    fireEvent.click(screen.getByTestId("badge-picker-toggle"));
    fireEvent.change(screen.getByTestId("new-badge-name"), { target: { value: BADGE.name } });
    fireEvent.click(screen.getByRole("button", { name: "Create and attach" }));
    await waitFor(() => expect(actions.onAttachBadge).toHaveBeenCalledWith(BADGE.id));
    resolveLoad([]);
    expect(await screen.findByRole("option", { name: BADGE.name })).toBeInTheDocument();
  });
});

describe("archive presentation", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("keeps archived Tickets readable and disables their mutating controls with Galley's reason", () => {
    const reason = { code: "archived_ticket", message: "archived tickets are read-only" };
    render(<TicketDetail ticket={{ ...TICKET, archivedAt: "2026-09-29T10:00:00Z", badges: [{ id: BADGE.id, name: BADGE.name }], allowedActions: { statusChangeRejections: [], statusChanges: [], accept: { available: false, reason } } }} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.getByTestId("ticket-detail-archived")).toHaveTextContent(reason.message);
    expect(screen.getByTestId("ticket-detail-badges")).toHaveTextContent(BADGE.name);
    for (const name of ["Edit", "Archive", "Add badge", "Remove Urgent", "Assign"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      expect(screen.getByRole("button", { name })).toHaveAttribute("title", reason.message);
    }
    expect(screen.getByLabelText("Assign to")).toBeDisabled();
  });

  it("asks before archiving and only navigates after Galley confirms", async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const onArchive = vi.fn().mockResolvedValue({ ...TICKET, archivedAt: "2026-09-29T10:00:00Z" });
    const onArchived = vi.fn();
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} onArchive={onArchive} onArchived={onArchived} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(onArchive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(onArchived).toHaveBeenCalledTimes(1));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("shows Ready becoming Backlog after Restore and unlocks editing", async () => {
    const reason = { code: "archived_ticket", message: "archived tickets are read-only" };
    const archived = { ...TICKET, status: "Ready" as const, archivedAt: "2026-09-29T10:00:00Z", allowedActions: { statusChangeRejections: [], statusChanges: [] as Ticket["status"][], accept: { available: false, reason } } };
    const restored: Ticket = { ...TICKET, status: "Backlog", archivedAt: null };
    const onRestore = vi.fn().mockResolvedValue(restored);
    render(<TicketDetail ticket={archived} onSave={vi.fn()} {...noopActions()} onRestore={onRestore} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Backlog"));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ticket-detail-edit-button")).toBeEnabled();
    expect(screen.queryByTestId("ticket-detail-restore-button")).not.toBeInTheDocument();
  });
});

describe("open-Round lock", () => {
  afterEach(() => { cleanup(); });

  const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" as const };
  const reason = { code: "round_open", message: "this Ticket has an open Round; it can be changed once the Round ends", roundId: "66666666-6666-4666-8666-666666666666" };
  const locked: Ticket = {
    ...REFINED_TICKET,
    status: "Ready",
    assigneeType: "agent",
    assigneeAgent: agent,
    badges: [{ id: BADGE.id, name: BADGE.name }],
    openRound: { id: reason.roundId, sequence: 4, state: "running", agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: "2026-10-01T10:01:00Z" },
    allowedActions: { statusChangeRejections: [], statusChanges: [], accept: { available: false, reason } },
  };

  it("shows who holds the lock and keeps every field readable", () => {
    render(<TicketDetail ticket={locked} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.getByTestId("ticket-detail-locked")).toHaveTextContent("Locked while atlas works on Round 4");
    expect(screen.getByTestId("ticket-detail-field-goal")).toHaveTextContent(REFINED_TICKET.goal);
    expect(screen.getByTestId("ticket-detail-badges")).toHaveTextContent(BADGE.name);
    expect(screen.queryByTestId("ticket-detail-archived")).not.toBeInTheDocument();
  });

  it("disables every mutating control with Galley's reason and offers no status move or Accept", () => {
    render(<TicketDetail ticket={locked} onSave={vi.fn()} {...noopActions()} />);
    for (const name of ["Edit", "Archive", "Add badge", "Remove Urgent", "Unassign", "Assign"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      expect(screen.getByRole("button", { name })).toHaveAttribute("title", reason.message);
    }
    expect(screen.getByLabelText("Assign to")).toBeDisabled();
    expect(screen.queryByTestId("ticket-detail-status-actions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-accept-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-accept-unavailable")).toHaveTextContent(reason.message);
    expect(screen.queryByTestId("ticket-detail-restore-button")).not.toBeInTheDocument();
  });

  it("opens in view mode even when editing was requested", () => {
    render(<TicketDetail ticket={locked} onSave={vi.fn()} {...noopActions()} editRequested />);
    expect(screen.queryByTestId("ticket-detail-edit-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-locked")).toBeInTheDocument();
  });

  it("unlocks once Galley reports no open Round", () => {
    const { rerender } = render(<TicketDetail ticket={locked} onSave={vi.fn()} {...noopActions()} />);
    rerender(<TicketDetail ticket={{ ...locked, openRound: null, allowedActions: { statusChangeRejections: [], statusChanges: ["Backlog"], accept: { available: false, reason: { code: "invalid_transition", message: "Accept requires In Review" } } } }} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.queryByTestId("ticket-detail-locked")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.getByTestId("ticket-detail-status-button-Backlog")).toBeEnabled();
  });
});

describe("TicketDetail", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the given Ticket's title, Status, Template, completion condition, and timestamps", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);

    expect(screen.getByTestId("ticket-detail-title")).toHaveTextContent(TICKET.title);
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent(statusLabel(TICKET.status));
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
    expect(onSave).toHaveBeenCalledWith({ goal: "Restore sign-in for existing users on Safari." });
  });

  it("sends only changed fields, including clearing an initially populated field", async () => {
    const saved: Ticket = { ...REFINED_TICKET, goal: "", context: "Updated context" };
    const onSave = vi.fn<(update: TicketUpdate) => Promise<Ticket>>().mockResolvedValue(saved);
    render(<TicketDetail ticket={REFINED_TICKET} onSave={onSave} {...noopActions()} />);

    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
    fireEvent.change(screen.getByTestId("ticket-detail-textarea-goal"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("ticket-detail-textarea-context"), {
      target: { value: "Updated context" },
    });
    fireEvent.click(screen.getByTestId("ticket-detail-save-button"));

    expect(await screen.findByTestId("ticket-detail-field-context")).toHaveTextContent("Updated context");
    expect(screen.getByTestId("ticket-detail-field-goal")).toHaveTextContent("Not set.");
    expect(onSave).toHaveBeenCalledWith({ goal: "", context: "Updated context" });
  });

  it("does not PATCH when Save is clicked without edits", () => {
    const onSave = vi.fn();
    render(<TicketDetail ticket={REFINED_TICKET} onSave={onSave} {...noopActions()} />);

    fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
    fireEvent.click(screen.getByTestId("ticket-detail-save-button"));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("ticket-detail-field-goal")).toHaveTextContent(REFINED_TICKET.goal);
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
    fireEvent.change(screen.getByTestId("ticket-detail-textarea-goal"), { target: { value: "New goal" } });
    fireEvent.click(screen.getByTestId("ticket-detail-save-button"));

    expect(await screen.findByTestId("ticket-detail-save-error")).toHaveTextContent(
      '"goal" must be at most 2000 characters after trimming',
    );
    expect(screen.getByTestId("ticket-detail-edit-form")).toBeInTheDocument();
  });

  // The workflow controls live in this reusable component rather than
  // TicketDetailPage, so M3's modal inherits them unchanged.
  describe("workflow controls", () => {
    const AGENTS: Agent[] = [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research", createdAt: "2026-09-30T10:00:00Z" },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Builder", kind: "coding", createdAt: "2026-09-30T10:00:00Z" },
    ];

    function agentAssigned(agent: Agent): Ticket {
      return { ...TICKET, assigneeType: "agent", assigneeAgent: { id: agent.id, name: agent.name, kind: agent.kind } };
    }

    it("shows Unassigned and offers Me first, then Galley's Agents in order", async () => {
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} onLoadAgents={vi.fn().mockResolvedValue(AGENTS)} />);

      expect(screen.getByTestId("ticket-detail-assignee")).toHaveTextContent("Unassigned");
      await screen.findByRole("option", { name: "Builder" });
      const options = screen.getAllByRole("option").map((option) => option.textContent);
      expect(options).toEqual(["Unassigned", "Me", "atlas", "Builder"]);
      expect(screen.getByRole("option", { name: "Unassigned" })).toBeDisabled();
      expect(screen.getByTestId("ticket-detail-assign-button")).toBeDisabled();
      expect(screen.queryByTestId("ticket-detail-unassign-button")).not.toBeInTheDocument();
    });

    it("shows Owner, selects Me and offers Unassign when the Ticket is Owner-assigned", () => {
      const assigned: Ticket = { ...TICKET, assigneeType: "owner" };
      render(<TicketDetail ticket={assigned} onSave={vi.fn()} {...noopActions()} />);

      expect(screen.getByTestId("ticket-detail-assignee")).toHaveTextContent("Owner");
      expect(screen.getByLabelText("Assign to")).toHaveValue("owner");
      expect(screen.queryByRole("option", { name: "Unassigned" })).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-unassign-button")).toBeInTheDocument();
    });

    it("shows the assigned Agent's name and selects it", async () => {
      render(<TicketDetail ticket={agentAssigned(AGENTS[1])} onSave={vi.fn()} {...noopActions()} onLoadAgents={vi.fn().mockResolvedValue(AGENTS)} />);

      expect(screen.getByTestId("ticket-detail-assignee")).toHaveTextContent("Builder");
      await screen.findByRole("option", { name: "atlas" });
      expect(screen.getByLabelText("Assign to")).toHaveValue(`agent:${AGENTS[1].id}`);
      expect(screen.getByTestId("ticket-detail-unassign-button")).toBeInTheDocument();
    });

    it("assigns the Owner and shows the updated Ticket Galley returned", async () => {
      const assigned: Ticket = { ...TICKET, assigneeType: "owner" };
      const onAssign = vi.fn<(assignee: TicketAssignee) => Promise<Ticket>>().mockResolvedValue(assigned);
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} onAssign={onAssign} />);

      fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: "owner" } });
      fireEvent.click(screen.getByTestId("ticket-detail-assign-button"));

      expect(await screen.findByTestId("ticket-detail-assignee")).toHaveTextContent("Owner");
      expect(onAssign).toHaveBeenCalledExactlyOnceWith({ type: "owner" });
    });

    it("assigns an Agent, then replaces it with the Owner", async () => {
      const onAssign = vi.fn<(assignee: TicketAssignee) => Promise<Ticket>>()
        .mockResolvedValueOnce(agentAssigned(AGENTS[0]))
        .mockResolvedValueOnce({ ...TICKET, assigneeType: "owner" });
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} onAssign={onAssign} onLoadAgents={vi.fn().mockResolvedValue(AGENTS)} />);
      await screen.findByRole("option", { name: "atlas" });

      fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: `agent:${AGENTS[0].id}` } });
      fireEvent.click(screen.getByTestId("ticket-detail-assign-button"));
      expect(await screen.findByTestId("ticket-detail-assignee")).toHaveTextContent("atlas");
      expect(onAssign).toHaveBeenLastCalledWith({ type: "agent", agentId: AGENTS[0].id });
      expect(screen.getByTestId("ticket-detail-assign-button")).toBeDisabled();

      await waitFor(() => expect(screen.getByLabelText("Assign to")).toBeEnabled());
      fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: "owner" } });
      fireEvent.click(screen.getByTestId("ticket-detail-assign-button"));
      await waitFor(() => expect(screen.getByTestId("ticket-detail-assignee")).toHaveTextContent("Owner"));
      expect(onAssign).toHaveBeenLastCalledWith({ type: "owner" });
    });

    it("keeps the last-known Assignee and shows Galley's rejection when assignment fails", async () => {
      const onAssign = vi.fn<(assignee: TicketAssignee) => Promise<Ticket>>().mockRejectedValue(new Error("no ticket or agent with that identifier"));
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} onAssign={onAssign} onLoadAgents={vi.fn().mockResolvedValue(AGENTS)} />);
      await screen.findByRole("option", { name: "atlas" });

      fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: `agent:${AGENTS[0].id}` } });
      fireEvent.click(screen.getByTestId("ticket-detail-assign-button"));

      expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent("no ticket or agent with that identifier");
      expect(screen.getByTestId("ticket-detail-assignee")).toHaveTextContent("Unassigned");
    });

    it("still offers Me when Agents cannot be loaded", async () => {
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} onLoadAgents={vi.fn().mockRejectedValue(new Error("Galley is unreachable."))} />);

      expect(await screen.findByTestId("ticket-detail-agents-error")).toHaveTextContent("Galley is unreachable.");
      expect(screen.getByRole("option", { name: "Me" })).toBeInTheDocument();
    });

    it("unassigns and shows the updated Ticket Galley returned", async () => {
      const assigned = agentAssigned(AGENTS[0]);
      const unassigned: Ticket = { ...TICKET, assigneeType: "" };
      const onUnassign = vi.fn<() => Promise<Ticket>>().mockResolvedValue(unassigned);
      render(<TicketDetail ticket={assigned} onSave={vi.fn()} {...noopActions()} onUnassign={onUnassign} />);

      fireEvent.click(screen.getByTestId("ticket-detail-unassign-button"));

      expect(await screen.findByTestId("ticket-detail-assignee")).toHaveTextContent("Unassigned");
      expect(onUnassign).toHaveBeenCalledTimes(1);
    });

    it("offers exactly Galley's supplied targets, even when the Status suggests otherwise", () => {
      const ticket: Ticket = { ...TICKET, status: "Done", allowedActions: { ...TICKET.allowedActions, statusChanges: ["InReview"] } };
      render(<TicketDetail ticket={ticket} onSave={vi.fn()} {...noopActions()} />);
      expect(screen.getByTestId("ticket-detail-status-button-InReview")).toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-status-button-Ready")).not.toBeInTheDocument();
    });

    it("moves to the clicked Status and shows the updated Ticket Galley returned", async () => {
      const moved: Ticket = { ...TICKET, status: "Ready", allowedActions: { ...TICKET.allowedActions, statusChanges: ["Backlog", "InProgress"] } };
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
      const ready: Ticket = { ...TICKET, status: "Ready", allowedActions: { ...TICKET.allowedActions, statusChanges: ["InProgress"] } };
      render(<TicketDetail ticket={ready} onSave={vi.fn()} {...noopActions()} onChangeStatus={onChangeStatus} />);

      fireEvent.click(screen.getByTestId("ticket-detail-status-button-InProgress"));

      expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent(
        "the transition Backlog -> InProgress is not permitted",
      );
      // Still Ready: a rejection never touches the displayed Status.
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Ready");
    });

    describe("Agent readiness", () => {
      const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "coding" as const };
      const readiness = {
        code: "agent_readiness_incomplete",
        message: "this Ticket needs a goal and a repository before a coding Agent can take it from Ready",
        missing: ["goal", "repository"] as ("goal" | "repository")[],
      };
      const agentTicket: Ticket = {
        ...TICKET,
        assigneeType: "agent",
        assigneeAgent: agent,
        successCriteria: "done",
        allowedActions: {
          ...TICKET.allowedActions,
          statusChanges: [],
          statusChangeRejections: [
            { status: "Ready", reason: readiness },
            { status: "Blocked", reason: { code: "agent_owned_transition", message: "Execution sets Blocked on an Agent-assigned Ticket" } },
          ],
        },
      };

      it("shows Queued for the Agent only when Galley says the Ticket requests Agent work", () => {
        const { rerender } = render(<TicketDetail ticket={{ ...agentTicket, status: "Ready", requestingAgentWork: true }} onSave={vi.fn()} {...noopActions()} />);
        expect(screen.getByTestId("ticket-detail-queued")).toHaveTextContent("Queued for atlas");

        rerender(<TicketDetail ticket={{ ...REFINED_TICKET, status: "Ready", assigneeType: "agent", assigneeAgent: agent, requestingAgentWork: false }} onSave={vi.fn()} {...noopActions()} />);
        expect(screen.queryByTestId("ticket-detail-queued")).not.toBeInTheDocument();
      });

      it("shows Claimed by runner only while Galley reports the open Round as claimed", () => {
        const round = { id: "r1", sequence: 1, agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null };
        const { rerender } = render(<TicketDetail ticket={{ ...agentTicket, status: "Ready", openRound: { ...round, state: "claimed" } }} onSave={vi.fn()} {...noopActions()} />);
        expect(screen.getByTestId("ticket-detail-claimed")).toHaveTextContent("Claimed by runner");
        expect(screen.queryByTestId("ticket-detail-queued")).not.toBeInTheDocument();

        rerender(<TicketDetail ticket={{ ...agentTicket, status: "Ready", openRound: { ...round, state: "running", startedAt: "2026-10-01T10:01:00Z" } }} onSave={vi.fn()} {...noopActions()} />);
        expect(screen.queryByTestId("ticket-detail-claimed")).not.toBeInTheDocument();
      });

      it("shows Galley's reasons beside the Status control and marks exactly the fields Galley lists", () => {
        render(<TicketDetail ticket={agentTicket} onSave={vi.fn()} {...noopActions()} />);

        const control = screen.getByTestId("ticket-detail-status-control");
        expect(within(control).getByTestId("ticket-detail-status-unavailable-Ready")).toHaveTextContent(`Ready: ${readiness.message}`);
        expect(within(control).getByTestId("ticket-detail-status-unavailable-Blocked")).toHaveTextContent("Execution sets Blocked on an Agent-assigned Ticket");
        expect(screen.queryByTestId("ticket-detail-status-button-Ready")).not.toBeInTheDocument();
        expect(screen.getByTestId("ticket-detail-missing-goal")).not.toHaveAttribute("role");
        expect(screen.getByTestId("ticket-detail-field-goal")).toHaveAttribute("aria-describedby", "ticket-detail-missing-goal ticket-detail-status-unavailable-Ready");
        expect(screen.getByTestId("ticket-detail-field-goal")).toHaveAccessibleDescription(`Missing Ready: ${readiness.message}`);
        expect(screen.getByTestId("ticket-detail-field-repository")).toHaveAttribute("aria-describedby", "ticket-detail-missing-repository ticket-detail-status-unavailable-Ready");
        expect(screen.getByTestId("ticket-detail-field-success-criteria")).not.toHaveAttribute("aria-describedby");
        expect(screen.getByTestId("ticket-detail-missing-repository")).toBeInTheDocument();
        expect(screen.queryByTestId("ticket-detail-missing-success-criteria")).not.toBeInTheDocument();
      });

      it("shows a rejected Status change inside the Status control", async () => {
        const onChangeStatus = vi.fn<(status: Ticket["status"]) => Promise<Ticket>>().mockRejectedValue(new GalleyError(readiness));
        render(<TicketDetail ticket={{ ...TICKET, assigneeType: "agent", assigneeAgent: agent }} onSave={vi.fn()} {...noopActions()} onChangeStatus={onChangeStatus} />);

        fireEvent.click(screen.getByTestId("ticket-detail-status-button-Ready"));

        const error = await within(screen.getByTestId("ticket-detail-status-control")).findByTestId("ticket-detail-action-error");
        expect(error).toHaveTextContent(readiness.message);
        expect(screen.getByTestId("ticket-detail-field-goal")).toHaveAccessibleDescription(`Missing ${readiness.message}`);
        expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Backlog");
      });

      it("shows a rejected Agent assignment beside the assignee control and marks the missing fields", async () => {
        const onAssign = vi.fn<(assignee: TicketAssignee) => Promise<Ticket>>().mockRejectedValue(new GalleyError(readiness));
        render(<TicketDetail ticket={{ ...TICKET, status: "Ready" }} onSave={vi.fn()} {...noopActions()} onAssign={onAssign} onLoadAgents={vi.fn().mockResolvedValue([{ ...agent, createdAt: "2026-09-30T10:00:00Z" }])} />);
        await screen.findByRole("option", { name: "atlas" });

        fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: `agent:${agent.id}` } });
        fireEvent.click(screen.getByTestId("ticket-detail-assign-button"));

        const error = await screen.findByTestId("ticket-detail-action-error");
        expect(error).toHaveTextContent(readiness.message);
        expect(screen.getByTestId("ticket-detail-assignee-form").nextElementSibling).toContainElement(error);
        expect(within(screen.getByTestId("ticket-detail-status-control")).queryByTestId("ticket-detail-action-error")).not.toBeInTheDocument();
        expect(screen.getByTestId("ticket-detail-missing-goal")).toBeInTheDocument();
        expect(screen.getByTestId("ticket-detail-missing-repository")).toBeInTheDocument();
        expect(screen.getByTestId("ticket-detail-assignee")).toHaveTextContent("Unassigned");
      });

      it("marks the cleared field and keeps Galley's message in the save error when clearing is rejected", async () => {
        const rejection = { code: "agent_readiness_incomplete", message: "this Ticket needs a goal before a research Agent can take it from Ready", missing: ["goal" as const] };
        const onSave = vi.fn<(update: TicketUpdate) => Promise<Ticket>>().mockRejectedValue(new GalleyError(rejection));
        render(<TicketDetail ticket={{ ...REFINED_TICKET, status: "Ready", assigneeType: "agent", assigneeAgent: { ...agent, kind: "research" }, requestingAgentWork: true }} onSave={onSave} {...noopActions()} />);

        fireEvent.click(screen.getByTestId("ticket-detail-edit-button"));
        fireEvent.change(screen.getByTestId("ticket-detail-textarea-goal"), { target: { value: "" } });
        fireEvent.click(screen.getByTestId("ticket-detail-save-button"));

        expect(await screen.findByTestId("ticket-detail-save-error")).toHaveTextContent(rejection.message);
        expect(screen.getByTestId("ticket-detail-textarea-goal")).toHaveAttribute("aria-invalid", "true");
        expect(screen.getByTestId("ticket-detail-textarea-goal")).toHaveAccessibleDescription(`Missing ${rejection.message}`);
        expect(screen.getByTestId("ticket-detail-textarea-success-criteria")).not.toHaveAttribute("aria-describedby");
        expect(screen.queryByTestId("ticket-detail-missing-success-criteria")).not.toBeInTheDocument();
      });
    });

    it("shows Accept when Galley advertises it", () => {
      const inReview: Ticket = { ...TICKET, status: "InReview", allowedActions: { ...TICKET.allowedActions, accept: { available: true } } };
      render(<TicketDetail ticket={inReview} onSave={vi.fn()} {...noopActions()} />);

      expect(screen.getByTestId("ticket-detail-accept-button")).toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-accept-unavailable")).not.toBeInTheDocument();
    });

    it("accepts and shows the Ticket as Done", async () => {
      const inReview: Ticket = { ...TICKET, status: "InReview", allowedActions: { ...TICKET.allowedActions, accept: { available: true } } };
      const done: Ticket = { ...inReview, status: "Done", allowedActions: TICKET.allowedActions };
      const onAccept = vi.fn<() => Promise<Ticket>>().mockResolvedValue(done);
      render(<TicketDetail ticket={inReview} onSave={vi.fn()} {...noopActions()} onAccept={onAccept} />);

      fireEvent.click(screen.getByTestId("ticket-detail-accept-button"));

      expect(await screen.findByTestId("ticket-detail-status")).toHaveTextContent("Done");
      expect(onAccept).toHaveBeenCalledTimes(1);
    });

    it("shows Galley's published reason instead of Accept when unavailable", () => {
      const reason = { code: "reviewed_pr_merge_not_implemented", message: "Galley says reviewed PR merge is unavailable" };
      const inReviewCoding: Ticket = { ...CODING_TICKET, status: "InReview", allowedActions: { ...TICKET.allowedActions, accept: { available: false, reason } } };
      render(<TicketDetail ticket={inReviewCoding} onSave={vi.fn()} {...noopActions()} />);

      expect(screen.queryByTestId("ticket-detail-accept-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-accept-unavailable")).toHaveTextContent(reason.message);
    });

    it("shows the published unavailability reason outside In Review, for either completion condition", () => {
      render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);
      expect(screen.queryByTestId("ticket-detail-accept-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-accept-unavailable")).toHaveTextContent(TICKET.allowedActions.accept.reason!.message);

      render(<TicketDetail ticket={CODING_TICKET} onSave={vi.fn()} {...noopActions()} />);
      expect(screen.queryByTestId("ticket-detail-accept-button")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("ticket-detail-accept-unavailable")).toHaveLength(2);
    });

  });
});

describe("the Rounds section", () => {
  afterEach(cleanup);

  const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" as const };
  const claimedRound = { id: "66666666-6666-4666-8666-666666666666", sequence: 3, state: "claimed" as const, agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null };
  const runningRound = { ...claimedRound, state: "running" as const, startedAt: "2026-10-01T10:01:00Z" };
  const roundTicket = (openRound: Ticket["openRound"], status: Ticket["status"] = "Ready"): Ticket => ({
    ...REFINED_TICKET,
    status,
    assigneeType: "agent",
    assigneeAgent: agent,
    openRound,
    allowedActions: { statusChanges: [], statusChangeRejections: [], accept: { available: false, reason: { code: "round_open", message: "locked", roundId: claimedRound.id } } },
  });
  const health = (state: "connected" | "disconnected" | "not_paired"): HealthView => ({
    kind: "loaded",
    health: { state, checkedAt: "2026-10-01T10:02:00Z", pairedAt: null, registeredAt: null, lastSeenAt: null, michelinVersion: null, hostname: null },
  });

  it("does not appear for a Ticket with no Round", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} runnerHealth={health("disconnected")} />);
    expect(screen.queryByTestId("ticket-detail-rounds")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-runner-disconnected")).not.toBeInTheDocument();
  });

  it("shows a claimed Round as waiting for the runner, with its number and Agent and no started time", () => {
    render(<TicketDetail ticket={roundTicket(claimedRound)} onSave={vi.fn()} {...noopActions()} runnerHealth={health("connected")} />);
    const section = within(screen.getByTestId("ticket-detail-rounds"));
    expect(section.getByRole("heading", { name: "Rounds" })).toBeInTheDocument();
    expect(section.getByTestId("ticket-detail-round-number")).toHaveTextContent("3");
    expect(section.getByTestId("ticket-detail-round-agent")).toHaveTextContent("atlas");
    expect(section.getByTestId("ticket-detail-round-waiting")).toHaveTextContent("Claimed, waiting for the runner to start");
    expect(section.queryByTestId("ticket-detail-round-started")).not.toBeInTheDocument();
  });

  it("shows a running Round with the time Galley reports it started", () => {
    render(<TicketDetail ticket={roundTicket(runningRound, "InProgress")} onSave={vi.fn()} {...noopActions()} runnerHealth={health("connected")} />);
    const section = within(screen.getByTestId("ticket-detail-rounds"));
    expect(section.getByTestId("ticket-detail-round-number")).toHaveTextContent("3");
    expect(section.getByTestId("ticket-detail-round-agent")).toHaveTextContent("atlas");
    expect(section.getByTestId("ticket-detail-round-started")).toHaveTextContent("2026-10-01T10:01:00Z");
    expect(section.queryByTestId("ticket-detail-round-waiting")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Progress");
    expect(screen.queryByTestId("ticket-detail-claimed")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-locked")).toHaveTextContent("Locked while atlas works on Round 3");
  });

  it.each([
    ["disconnected", "disconnected"],
    ["not paired", "not_paired"],
  ] as const)("overlays Runner disconnected on an open Round when the runner is %s", (_name, state) => {
    render(<TicketDetail ticket={roundTicket(runningRound, "InProgress")} onSave={vi.fn()} {...noopActions()} runnerHealth={health(state)} />);
    const overlay = within(screen.getByTestId("ticket-detail-rounds")).getByTestId("ticket-detail-runner-disconnected");
    expect(overlay).toHaveTextContent("Runner disconnected");
    expect(overlay).toHaveAttribute("role", "status");
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Progress");
    expect(screen.getByTestId("ticket-detail-round-started")).toHaveTextContent("2026-10-01T10:01:00Z");
  });

  it.each([
    ["connected", health("connected")],
    ["still being checked", { kind: "loading" } as HealthView],
    ["unknown because the check failed", { kind: "error" } as HealthView],
  ])("shows no overlay while the runner is %s", (_name, runnerHealth) => {
    render(<TicketDetail ticket={roundTicket(runningRound, "InProgress")} onSave={vi.fn()} {...noopActions()} runnerHealth={runnerHealth} />);
    expect(screen.getByTestId("ticket-detail-rounds")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-runner-disconnected")).not.toBeInTheDocument();
  });

  it("shows no overlay when the runner health is not supplied", () => {
    render(<TicketDetail ticket={roundTicket(runningRound, "InProgress")} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.queryByTestId("ticket-detail-runner-disconnected")).not.toBeInTheDocument();
  });

  it("follows Galley when the Round moves from claimed to running", () => {
    const { rerender } = render(<TicketDetail ticket={roundTicket(claimedRound)} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.getByTestId("ticket-detail-round-waiting")).toBeInTheDocument();
    rerender(<TicketDetail ticket={roundTicket(runningRound, "InProgress")} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.queryByTestId("ticket-detail-round-waiting")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-round-started")).toHaveTextContent("2026-10-01T10:01:00Z");
  });
});
