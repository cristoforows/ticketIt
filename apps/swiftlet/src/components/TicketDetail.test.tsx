import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { TicketDetail } from "./TicketDetail";
import type { Agent } from "../api/agents";
import type { TicketRound } from "../api/rounds";
import type { Badge, Ticket, TicketAssignee, TicketUpdate } from "../api/tickets";
import { statusLabel } from "./ui";
import { GalleyError } from "../api/http";
import { remainingText, type DecidePermission } from "./PermissionPanel";
import { GrantNotFoundError } from "../api/tickets";
import type { HealthView } from "./RunnerHealthPill";

const TICKET: Ticket = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Fix login bug on Safari",
  status: "Backlog",
  permissionGrants: [],
  permissionGrantCount: 0,
  allowedActions: { statusChangeRejections: [], statusChanges: ["Ready", "Blocked"], accept: { available: false, reason: { code: "invalid_transition", message: "Accept requires In Review" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
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
    onRework: vi.fn<() => Promise<Ticket>>(),
    onStop: vi.fn<() => Promise<Ticket>>(),
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
    render(<TicketDetail ticket={{ ...TICKET, archivedAt: "2026-09-29T10:00:00Z", badges: [{ id: BADGE.id, name: BADGE.name }], allowedActions: { statusChangeRejections: [], statusChanges: [], accept: { available: false, reason }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } } }} onSave={vi.fn()} {...noopActions()} />);
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
    const archived = { ...TICKET, status: "Ready" as const, archivedAt: "2026-09-29T10:00:00Z", allowedActions: { statusChangeRejections: [], statusChanges: [] as Ticket["status"][], accept: { available: false, reason }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } } };
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
    openRound: { id: reason.roundId, sequence: 4, state: "running", agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: "2026-10-01T10:01:00Z", stopRequestedAt: null, waitingReason: "working", question: null, permissionRequest: null },
    permissionGrants: [],
    permissionGrantCount: 0,
    allowedActions: { statusChangeRejections: [], statusChanges: [], accept: { available: false, reason }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
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
    rerender(<TicketDetail ticket={{ ...locked, openRound: null, allowedActions: { statusChangeRejections: [], statusChanges: ["Backlog"], accept: { available: false, reason: { code: "invalid_transition", message: "Accept requires In Review" } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } } }} onSave={vi.fn()} {...noopActions()} />);
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
    expect(screen.getByTestId("ticket-detail-created-at")).toHaveTextContent("22 Sep 2026 15:30:00 UTC+05:30");
    expect(screen.getByTestId("ticket-detail-updated-at")).toHaveTextContent("22 Sep 2026 15:35:00 UTC+05:30");
    expect(screen.getByTestId("ticket-detail-created-at").querySelector("time")).toHaveAttribute("dateTime", TICKET.createdAt);
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
        permissionGrants: [],
        permissionGrantCount: 0,
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
        const round = { id: "r1", sequence: 1, agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null, stopRequestedAt: null, waitingReason: "starting" as const, question: null, permissionRequest: null };
        const { rerender } = render(<TicketDetail ticket={{ ...agentTicket, status: "Ready", openRound: { ...round, state: "claimed" } }} onSave={vi.fn()} {...noopActions()} />);
        expect(screen.getByTestId("ticket-detail-claimed")).toHaveTextContent("Claimed by runner");
        expect(screen.queryByTestId("ticket-detail-queued")).not.toBeInTheDocument();

        rerender(<TicketDetail ticket={{ ...agentTicket, status: "Ready", openRound: { ...round, state: "running", startedAt: "2026-10-01T10:01:00Z", waitingReason: "working" } }} onSave={vi.fn()} {...noopActions()} />);
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
  const claimedRound = { id: "66666666-6666-4666-8666-666666666666", sequence: 3, state: "claimed" as const, agent, claimedAt: "2026-10-01T10:00:00Z", startedAt: null, stopRequestedAt: null, waitingReason: "starting" as const, question: null, permissionRequest: null };
  const runningRound = { ...claimedRound, state: "running" as const, startedAt: "2026-10-01T10:01:00Z", waitingReason: "working" as const };
  const usage = {
    observations: 0,
    complete: true,
    estimated: false,
    costUsd: null,
    inputTokens: { sum: null, complete: true, estimated: false },
    outputTokens: { sum: null, complete: true, estimated: false },
    activeMs: { sum: null, complete: true, estimated: false },
  };
  const recordOf = (round: NonNullable<Ticket["openRound"]>): TicketRound => ({ ...round, endedAt: null, outcomeNote: null, activity: [], earlierActivityCursor: null, usage, deliverable: null, questions: [], feedback: [], permissionRequests: [], authorityChecks: [], authorityCheckCount: 0 });
  const deliveredRecord = (sequence: number, id: string): TicketRound => ({
    id,
    sequence,
    state: "delivered",
    agent,
    claimedAt: `2026-10-0${sequence}T10:00:00Z`,
    startedAt: `2026-10-0${sequence}T10:01:00Z`,
    endedAt: `2026-10-0${sequence}T10:09:00Z`,
    outcomeNote: null,
    activity: [],
    earlierActivityCursor: null,
    usage,
    deliverable: { summary: `Summary ${sequence}`, criteriaAssessment: `Assessment ${sequence}`, bodyMarkdown: `Report ${sequence}` },
    questions: [],
    feedback: [],
    permissionRequests: [],
    authorityChecks: [],
    authorityCheckCount: 0,
  });
  const roundTicket = (openRound: Ticket["openRound"], status: Ticket["status"] = "Ready"): Ticket => ({
    ...REFINED_TICKET,
    status,
    assigneeType: "agent",
    assigneeAgent: agent,
    openRound,
    permissionGrants: [],
    permissionGrantCount: 0,
    allowedActions: { statusChanges: [], statusChangeRejections: [], accept: { available: false, reason: { code: "round_open", message: "locked", roundId: claimedRound.id } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
  });
  const health = (state: "connected" | "disconnected" | "not_paired"): HealthView => ({
    kind: "loaded",
    health: { state, checkedAt: "2026-10-01T10:02:00Z", pairedAt: null, registeredAt: null, lastSeenAt: null, michelinVersion: null, hostname: null },
  });
  const entries = () => screen.getAllByTestId("ticket-detail-round");
  const entryOpen = (entry: HTMLElement) => (entry.querySelector("details") as HTMLDetailsElement).open;

  it("does not appear for a Ticket with no Round", () => {
    render(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} runnerHealth={health("disconnected")} />);
    expect(screen.queryByTestId("ticket-detail-rounds")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-runner-disconnected")).not.toBeInTheDocument();
  });

  it("shows the lock and the claimed tag from the Ticket while the Round records are still loading", () => {
    render(<TicketDetail ticket={roundTicket(claimedRound)} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.getByTestId("ticket-detail-locked")).toHaveTextContent("Locked while atlas works on Round 3");
    expect(screen.getByTestId("ticket-detail-claimed")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-round-records-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-round")).not.toBeInTheDocument();
  });

  it("shows a claimed Round as waiting for the runner, with its number and Agent and no started time", () => {
    render(<TicketDetail ticket={roundTicket(claimedRound)} onSave={vi.fn()} {...noopActions()} runnerHealth={health("connected")} roundRecords={{ rounds: [recordOf(claimedRound)] }} />);
    const section = within(screen.getByTestId("ticket-detail-rounds"));
    expect(section.getByRole("heading", { name: "Rounds" })).toBeInTheDocument();
    expect(section.getByTestId("ticket-detail-round-number")).toHaveTextContent("Round 3");
    expect(section.getByTestId("ticket-detail-round-agent")).toHaveTextContent("atlas");
    expect(section.getByTestId("ticket-detail-round-claimed-at")).toHaveTextContent("01 Oct 2026 15:30:00 UTC+05:30");
    expect(section.getByTestId("ticket-detail-round-state")).toHaveTextContent("Claimed, waiting for the runner to start");
    expect(section.queryByTestId("ticket-detail-round-started")).not.toBeInTheDocument();
    expect(section.queryByTestId("ticket-detail-round-records-loading")).not.toBeInTheDocument();
  });

  it("shows a running Round with the time Galley reports it started", () => {
    render(<TicketDetail ticket={roundTicket(runningRound, "InProgress")} onSave={vi.fn()} {...noopActions()} runnerHealth={health("connected")} roundRecords={{ rounds: [recordOf(runningRound)] }} />);
    const section = within(screen.getByTestId("ticket-detail-rounds"));
    expect(section.getByTestId("ticket-detail-round-number")).toHaveTextContent("Round 3");
    expect(section.getByTestId("ticket-detail-round-agent")).toHaveTextContent("atlas");
    expect(section.getByTestId("ticket-detail-round-state")).toHaveTextContent("Running");
    expect(section.getByTestId("ticket-detail-round-started")).toHaveTextContent("01 Oct 2026 15:31:00 UTC+05:30");
    expect(section.queryByTestId("ticket-detail-round-delivered-at")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Progress");
    expect(screen.queryByTestId("ticket-detail-claimed")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-locked")).toHaveTextContent("Locked while atlas works on Round 3");
  });

  it.each([
    ["disconnected", "disconnected"],
    ["not paired", "not_paired"],
  ] as const)("overlays Runner disconnected on an open Round when the runner is %s", (_name, state) => {
    render(<TicketDetail ticket={roundTicket(runningRound, "InProgress")} onSave={vi.fn()} {...noopActions()} runnerHealth={health(state)} roundRecords={{ rounds: [recordOf(runningRound)] }} />);
    const overlay = within(screen.getByTestId("ticket-detail-rounds")).getByTestId("ticket-detail-runner-disconnected");
    expect(overlay).toHaveTextContent("Runner disconnected");
    expect(overlay).toHaveAttribute("role", "status");
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Progress");
    expect(screen.getByTestId("ticket-detail-round-started")).toHaveTextContent("01 Oct 2026 15:31:00 UTC+05:30");
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
    const { rerender } = render(<TicketDetail ticket={roundTicket(claimedRound)} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [recordOf(claimedRound)] }} />);
    expect(screen.getByTestId("ticket-detail-round-state")).toHaveTextContent("Claimed, waiting for the runner to start");
    rerender(<TicketDetail ticket={roundTicket(runningRound, "InProgress")} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [recordOf(runningRound)] }} />);
    expect(screen.getByTestId("ticket-detail-round-state")).toHaveTextContent("Running");
    expect(screen.getByTestId("ticket-detail-round-started")).toHaveTextContent("01 Oct 2026 15:31:00 UTC+05:30");
  });

  describe("the Round history", () => {
    const round1 = deliveredRecord(1, "11111111-aaaa-4aaa-8aaa-111111111111");
    const round2 = deliveredRecord(2, "22222222-aaaa-4aaa-8aaa-222222222222");
    const delivery = { roundId: round2.id, sequence: 2, agent, deliveredAt: round2.endedAt! };
    const deliveredTicket: Ticket = { ...roundTicket(null, "InReview"), delivery };

    it("lists every Round in Galley's order with the latest open and the earlier ones closed", () => {
      render(<TicketDetail ticket={deliveredTicket} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [round2, round1] }} />);
      expect(entries().map((entry) => entry.getAttribute("data-round-id"))).toEqual([round2.id, round1.id]);
      expect(entries().map((entry) => within(entry).getByTestId("ticket-detail-round-number").textContent)).toEqual(["Round 2", "Round 1"]);
      expect(entries().map(entryOpen)).toEqual([true, false]);
      expect(within(entries()[0]).getByTestId("ticket-detail-round-state")).toHaveTextContent("Delivered by atlas");
      expect(entries()[0].querySelector("summary")!.textContent).toBe("+−Round 2 · Delivered by atlas");
      expect(within(entries()[0]).getByTestId("ticket-detail-round-delivered-at")).toHaveTextContent("02 Oct 2026 15:39:00 UTC+05:30");
    });

    it("opens an earlier Round from its summary to show its own report, activity and usage", () => {
      const withNote = { ...round1, activity: [{ seq: 1, note: "Round one note", occurredAt: "2026-10-01T10:02:00Z" }] };
      render(<TicketDetail ticket={deliveredTicket} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [round2, withNote] }} />);
      fireEvent.click(within(entries()[1]).getByText("Round 1"));
      const earlier = within(entries()[1]);
      expect(entryOpen(entries()[1])).toBe(true);
      expect(earlier.getByTestId("ticket-detail-round-summary")).toHaveTextContent("Summary 1");
      expect(earlier.getByTestId("ticket-detail-round-assessment")).toHaveTextContent("Assessment 1");
      expect(earlier.getByTestId("ticket-detail-round-body")).toBeInTheDocument();
      expect(earlier.getByTestId("ticket-detail-round-note")).toHaveTextContent("Round one note");
      expect(earlier.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
    });

    it("shows a running Round above the delivered one it reworks, labelling its usage as so far", () => {
      const running = { ...recordOf({ ...runningRound, id: "33333333-aaaa-4aaa-8aaa-333333333333", sequence: 2 }) };
      render(<TicketDetail ticket={roundTicket({ ...runningRound, id: running.id, sequence: 2 }, "InProgress")} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [running, round1] }} />);
      expect(entries().map((entry) => entry.getAttribute("data-state"))).toEqual(["running", "delivered"]);
      expect(within(entries()[0]).getByRole("heading", { name: "Usage so far" })).toBeInTheDocument();
      expect(within(entries()[1]).getByRole("heading", { name: "Usage" })).toBeInTheDocument();
    });

    it("collapses the previous latest Round when a newer Round arrives, and keeps the Owner's own toggles", () => {
      const { rerender } = render(<TicketDetail ticket={deliveredTicket} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [round1] }} />);
      expect(entryOpen(entries()[0])).toBe(true);
      const running = recordOf({ ...runningRound, id: "33333333-aaaa-4aaa-8aaa-333333333333", sequence: 2 });
      rerender(<TicketDetail ticket={deliveredTicket} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [running, round1] }} />);
      expect(entries().map((entry) => entry.getAttribute("data-round-id"))).toEqual([running.id, round1.id]);
      expect(entries().map(entryOpen)).toEqual([true, false]);
      fireEvent.click(within(entries()[1]).getByText("Round 1"));
      rerender(<TicketDetail ticket={deliveredTicket} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [{ ...running }, round1] }} />);
      expect(entries().map(entryOpen)).toEqual([true, true]);
    });

    it("shows a stopped Round with the Stopped tag, its outcome note, activity and usage, and the Ticket's Stopped Badge", () => {
      const stopped: TicketRound = {
        ...recordOf(runningRound),
        state: "stopped",
        endedAt: "2026-10-01T10:05:00Z",
        outcomeNote: "Stopped before step 2 of 2 on Stop command 55555555-5555-4555-8555-555555555555",
        activity: [{ seq: 1, note: "Reading the Ticket", occurredAt: "2026-10-01T10:02:00Z" }],
        usage: { ...usage, observations: 1, inputTokens: { sum: 1200, complete: true, estimated: false } },
      };
      const stoppedTicket: Ticket = { ...roundTicket(null, "Backlog"), badges: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Stopped" }] };
      render(<TicketDetail ticket={stoppedTicket} onSave={vi.fn()} {...noopActions()} runnerHealth={health("disconnected")} roundRecords={{ rounds: [stopped, round1] }} />);

      const entry = within(entries()[0]);
      expect(entries()[0]).toHaveAttribute("data-state", "stopped");
      expect(entry.getByTestId("ticket-detail-round-state")).toHaveTextContent("Stopped");
      expect(entry.getByTestId("ticket-detail-round-stopped")).toHaveTextContent("Stopped");
      expect(entries()[0].querySelector("summary")!.textContent).toBe("+−Round 3 · Stopped");
      expect(entry.getByTestId("ticket-detail-round-outcome-note")).toHaveTextContent(stopped.outcomeNote!);
      expect(entry.getByTestId("ticket-detail-round-stopped-at")).toHaveTextContent("01 Oct 2026 15:35:00 UTC+05:30");
      expect(entry.getByTestId("ticket-detail-round-started")).toHaveTextContent("01 Oct 2026 15:31:00 UTC+05:30");
      expect(entry.getAllByTestId("ticket-detail-round-note").map((note) => note.textContent)).toEqual(["01 Oct 2026 15:32:00 UTC+05:30Reading the Ticket"]);
      expect(entry.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
      expect(entry.getByTestId("ticket-detail-round-usage-input-tokens")).toHaveTextContent("1,200");
      expect(entry.queryByTestId("ticket-detail-round-summary")).not.toBeInTheDocument();
      expect(entry.queryByTestId("ticket-detail-round-delivered-at")).not.toBeInTheDocument();
      expect(within(entries()[1]).queryByTestId("ticket-detail-round-outcome-note")).not.toBeInTheDocument();
      expect(within(entries()[1]).queryByTestId("ticket-detail-round-stopped")).not.toBeInTheDocument();

      expect(within(screen.getByTestId("ticket-detail-badges")).getByText("Stopped")).toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Backlog");
      expect(screen.queryByTestId("ticket-detail-stopping")).not.toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-locked")).not.toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-runner-disconnected")).not.toBeInTheDocument();
    });

    it("shows a Round stopped while claimed without a started time", () => {
      const stopped: TicketRound = { ...recordOf(claimedRound), state: "stopped", endedAt: "2026-10-01T10:00:30Z", outcomeNote: "Stopped before step 1 of 2 on Stop command x" };
      render(<TicketDetail ticket={roundTicket(null, "Backlog")} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [stopped] }} />);
      expect(screen.getByTestId("ticket-detail-round-stopped")).toBeInTheDocument();
      expect(screen.queryByTestId("ticket-detail-round-started")).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-round-activity-empty")).toBeInTheDocument();
    });

    it.each([
      { state: "failed" as const, label: "Failed", note: "The repository is gone.", colours: ["bg-status-blocked-deep", "text-paper"] },
      { state: "interrupted" as const, label: "Interrupted", note: "The engine process exited with signal 9.", colours: ["border-dashed", "bg-paper", "text-status-blocked-deep"] },
    ])("shows a $state Round with its tag, its note beneath, its activity and usage, and offers the Owner Ready", ({ state, label, note, colours }) => {
      const ended: TicketRound = {
        ...recordOf(runningRound),
        state,
        endedAt: "2026-10-01T10:05:00Z",
        outcomeNote: note,
        activity: [{ seq: 1, note: "Reading the Ticket", occurredAt: "2026-10-01T10:02:00Z" }],
        usage: { ...usage, observations: 1, inputTokens: { sum: 1200, complete: true, estimated: false } },
      };
      const blocked: Ticket = { ...roundTicket(null, "Blocked"), allowedActions: { ...roundTicket(null, "Blocked").allowedActions, statusChanges: ["Ready"] } };
      render(<TicketDetail ticket={blocked} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [ended, round1] }} />);

      const entry = within(entries()[0]);
      expect(entries()[0]).toHaveAttribute("data-state", state);
      expect(entry.getByTestId(`ticket-detail-round-${state}`)).toHaveTextContent(label);
      expect(entry.getByTestId(`ticket-detail-round-${state}`).className.split(" ")).toEqual(expect.arrayContaining(colours));
      expect(entries()[0].querySelector("summary")!.textContent).toBe(`+−Round 3 · ${label}`);
      expect(entry.getByTestId("ticket-detail-round-outcome-note")).toHaveTextContent(note);
      expect(entry.getByTestId(`ticket-detail-round-${state}-at`)).toHaveTextContent("01 Oct 2026 15:35:00 UTC+05:30");
      expect(entry.getAllByTestId("ticket-detail-round-note").map((item) => item.textContent)).toEqual(["01 Oct 2026 15:32:00 UTC+05:30Reading the Ticket"]);
      expect(entry.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
      expect(entry.getByTestId("ticket-detail-round-usage-input-tokens")).toHaveTextContent("1,200");
      expect(entry.queryByTestId("ticket-detail-round-summary")).not.toBeInTheDocument();
      expect(entry.queryByTestId("ticket-detail-round-stopped")).not.toBeInTheDocument();
      expect(within(entries()[1]).queryByTestId(`ticket-detail-round-${state}`)).not.toBeInTheDocument();

      expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Blocked");
      expect(screen.getByTestId("ticket-detail-status-button-Ready")).toBeEnabled();
      expect(screen.queryByTestId("ticket-detail-locked")).not.toBeInTheDocument();
    });

    it("shows the records error beside the last good list", () => {
      render(<TicketDetail ticket={deliveredTicket} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [round2, round1], error: "503" }} />);
      expect(screen.getByTestId("ticket-detail-round-records-error")).toHaveTextContent("503");
      expect(entries()).toHaveLength(2);
    });
  });
});

describe("Request rework", () => {
  afterEach(cleanup);

  const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" as const };
  const reviewable: Ticket = {
    ...REFINED_TICKET,
    status: "InReview",
    assigneeType: "agent",
    assigneeAgent: agent,
    delivery: { roundId: "11111111-aaaa-4aaa-8aaa-111111111111", sequence: 1, agent, deliveredAt: "2026-10-01T10:09:00Z" },
    permissionGrants: [],
    permissionGrantCount: 0,
    allowedActions: { ...TICKET.allowedActions, accept: { available: true }, rework: { available: true } },
  };
  const withRework = (rework: Ticket["allowedActions"]["rework"]): Ticket => ({ ...reviewable, allowedActions: { ...reviewable.allowedActions, rework } });

  it("is offered only when Galley says rework is available", () => {
    const { rerender } = render(<TicketDetail ticket={reviewable} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.getByTestId("ticket-detail-rework-button")).toHaveTextContent("Request rework");

    rerender(<TicketDetail ticket={withRework({ available: false, reason: { code: "rework_not_available", message: "Only an Agent-assigned Ticket can be reworked" } })} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.queryByTestId("ticket-detail-rework-button")).not.toBeInTheDocument();
  });

  it("requests rework and shows the Ready, queued Ticket Galley returned", async () => {
    const ready: Ticket = { ...reviewable, status: "Ready", requestingAgentWork: true, allowedActions: { ...reviewable.allowedActions, accept: TICKET.allowedActions.accept, rework: TICKET.allowedActions.rework } };
    const onRework = vi.fn<() => Promise<Ticket>>().mockResolvedValue(ready);
    render(<TicketDetail ticket={reviewable} onSave={vi.fn()} {...noopActions()} onRework={onRework} />);

    fireEvent.click(screen.getByTestId("ticket-detail-rework-button"));

    expect(await screen.findByTestId("ticket-detail-queued")).toHaveTextContent("Queued for atlas");
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("Ready");
    expect(onRework).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("ticket-detail-rework-button")).not.toBeInTheDocument();
  });

  it("shows Galley's rejection verbatim and leaves the Ticket as it was", async () => {
    const onRework = vi.fn<() => Promise<Ticket>>().mockRejectedValue(new GalleyError({ code: "rework_not_available", message: "A Round is already open" }));
    render(<TicketDetail ticket={reviewable} onSave={vi.fn()} {...noopActions()} onRework={onRework} />);

    fireEvent.click(screen.getByTestId("ticket-detail-rework-button"));

    expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent("A Round is already open");
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Review");
  });

  it("is disabled while an action is pending", async () => {
    let finish: (ticket: Ticket) => void = () => {};
    const onRework = vi.fn(() => new Promise<Ticket>((resolve) => { finish = resolve; }));
    render(<TicketDetail ticket={reviewable} onSave={vi.fn()} {...noopActions()} onRework={onRework} />);

    fireEvent.click(screen.getByTestId("ticket-detail-rework-button"));

    await waitFor(() => expect(screen.getByTestId("ticket-detail-rework-button")).toBeDisabled());
    finish(reviewable);
    await waitFor(() => expect(screen.getByTestId("ticket-detail-rework-button")).toBeEnabled());
  });

  describe("when an input is missing", () => {
    const incomplete = { code: "agent_readiness_incomplete", message: "Add a Goal before requesting rework", missing: ["goal" as const] };

    it("shows Galley's reason and points the empty field at it", () => {
      render(<TicketDetail ticket={{ ...withRework({ available: false, reason: incomplete }), goal: "" }} onSave={vi.fn()} {...noopActions()} />);

      expect(screen.queryByTestId("ticket-detail-rework-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-rework-unavailable")).toHaveTextContent("Add a Goal before requesting rework");
      expect(screen.getByTestId("ticket-detail-field-goal")).toHaveAttribute("aria-describedby", "ticket-detail-missing-goal ticket-detail-rework-unavailable");
      expect(screen.getByTestId("ticket-detail-field-goal")).toHaveAccessibleDescription("Missing Add a Goal before requesting rework");
      expect(screen.queryByTestId("ticket-detail-missing-success-criteria")).not.toBeInTheDocument();
    });

    it("explains the missing inputs with the action error first", async () => {
      const onAccept = vi.fn<() => Promise<Ticket>>().mockRejectedValue(new GalleyError({ code: "agent_readiness_incomplete", message: "Accept failed", missing: ["goal"] }));
      render(<TicketDetail ticket={{ ...withRework({ available: false, reason: incomplete }), goal: "" }} onSave={vi.fn()} {...noopActions()} onAccept={onAccept} />);

      fireEvent.click(screen.getByTestId("ticket-detail-accept-button"));

      await screen.findByTestId("ticket-detail-action-error");
      expect(screen.getByTestId("ticket-detail-field-goal")).toHaveAttribute("aria-describedby", "ticket-detail-missing-goal ticket-detail-action-error");
    });
  });

  it("never shows the rework_not_available reason", () => {
    render(<TicketDetail ticket={withRework({ available: false, reason: { code: "rework_not_available", message: "Only an Agent-assigned Ticket can be reworked" } })} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.queryByText("Only an Agent-assigned Ticket can be reworked")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-rework-unavailable")).not.toBeInTheDocument();
  });
});

describe("Stop", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" as const };
  const runningRound = { id: "66666666-6666-4666-8666-666666666666", sequence: 2, state: "running" as const, agent, claimedAt: "2026-10-02T10:00:00Z", startedAt: "2026-10-02T10:00:01Z", stopRequestedAt: null, waitingReason: "working" as const, question: null, permissionRequest: null };
  const locked = { code: "round_open", message: "Locked while atlas works on Round 2", roundId: runningRound.id };
  const running: Ticket = {
    ...REFINED_TICKET,
    status: "InProgress",
    assigneeType: "agent",
    assigneeAgent: agent,
    openRound: runningRound,
    permissionGrants: [],
    permissionGrantCount: 0,
    allowedActions: { statusChanges: [], statusChangeRejections: [], accept: { available: false, reason: locked }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: true }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
  };
  const stopping: Ticket = {
    ...running,
    openRound: { ...runningRound, stopRequestedAt: "2026-10-02T10:00:05Z", waitingReason: "stopping", question: null, permissionRequest: null },
    permissionGrants: [],
    permissionGrantCount: 0,
    allowedActions: { ...running.allowedActions, stop: { available: false, reason: { code: "stop_already_requested", message: "Stop is already requested for this Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
  };

  it("is offered only when Galley says Stop is available, and is not disabled by the Round's lock", () => {
    const { rerender } = render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.getByTestId("ticket-detail-stop-button")).toHaveTextContent("Stop");
    expect(screen.getByTestId("ticket-detail-stop-button")).toBeEnabled();
    expect(screen.queryByTestId("ticket-detail-stopping")).not.toBeInTheDocument();

    rerender(<TicketDetail ticket={stopping} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.queryByTestId("ticket-detail-stop-button")).not.toBeInTheDocument();

    rerender(<TicketDetail ticket={TICKET} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.queryByTestId("ticket-detail-stop-button")).not.toBeInTheDocument();
  });

  it("requests Stop without a confirmation and shows Stopping on the locked receipt Galley returned", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const onStop = vi.fn<() => Promise<Ticket>>().mockResolvedValue(stopping);
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} onStop={onStop} />);

    fireEvent.click(screen.getByTestId("ticket-detail-stop-button"));

    expect(await screen.findByTestId("ticket-detail-stopping")).toHaveTextContent("Stopping…");
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("ticket-detail-status")).toHaveTextContent("In Progress");
    expect(screen.getByTestId("ticket-detail-locked")).toHaveTextContent("Locked while atlas works on Round 2");
    expect(screen.queryByTestId("ticket-detail-stop-button")).not.toBeInTheDocument();
  });

  it("shows Stopping beside the claimed tag for a claimed Round", () => {
    const claimedStopping: Ticket = { ...stopping, status: "Ready", openRound: { ...runningRound, state: "claimed", startedAt: null, stopRequestedAt: "2026-10-02T10:00:05Z", waitingReason: "stopping", question: null, permissionRequest: null } };
    render(<TicketDetail ticket={claimedStopping} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.getByTestId("ticket-detail-claimed")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-stopping")).toHaveTextContent("Stopping…");
  });

  it("shows Galley's rejection verbatim and leaves the Ticket as it was", async () => {
    const onStop = vi.fn<() => Promise<Ticket>>().mockRejectedValue(new GalleyError({ code: "stop_not_available", message: "Stop needs an open Round" }));
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} onStop={onStop} />);

    fireEvent.click(screen.getByTestId("ticket-detail-stop-button"));

    expect(await screen.findByTestId("ticket-detail-action-error")).toHaveTextContent("Stop needs an open Round");
    expect(screen.queryByTestId("ticket-detail-stopping")).not.toBeInTheDocument();
  });

  it("is disabled while an action is pending", async () => {
    let finish: (ticket: Ticket) => void = () => {};
    const onStop = vi.fn(() => new Promise<Ticket>((resolve) => { finish = resolve; }));
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} onStop={onStop} />);

    fireEvent.click(screen.getByTestId("ticket-detail-stop-button"));

    await waitFor(() => expect(screen.getByTestId("ticket-detail-stop-button")).toBeDisabled());
    finish(running);
    await waitFor(() => expect(screen.getByTestId("ticket-detail-stop-button")).toBeEnabled());
  });
});

describe("a question from the Agent", () => {
  afterEach(cleanup);

  const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" as const };
  const question = { id: "99999999-9999-5999-8999-999999999999", text: "Which region should the report cover?", askedAt: "2026-10-02T10:00:03Z", answer: null, answeredAt: null };
  const waitingRound = { id: "66666666-6666-4666-8666-666666666666", sequence: 1, state: "waiting_for_input" as const, agent, claimedAt: "2026-10-02T10:00:00Z", startedAt: "2026-10-02T10:00:01Z", stopRequestedAt: null, waitingReason: "waiting_for_answer" as const, question, permissionRequest: null };
  const notAvailable = { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } };
  const usage = {
    observations: 0,
    complete: true,
    estimated: false,
    costUsd: null,
    inputTokens: { sum: null, complete: true, estimated: false },
    outputTokens: { sum: null, complete: true, estimated: false },
    activeMs: { sum: null, complete: true, estimated: false },
  };
  const waiting: Ticket = {
    ...REFINED_TICKET,
    status: "Blocked",
    assigneeType: "agent",
    assigneeAgent: agent,
    openRound: waitingRound,
    permissionGrants: [],
    permissionGrantCount: 0,
    allowedActions: { statusChanges: [], statusChangeRejections: [], accept: { available: false, reason: { code: "round_open", message: "locked", roundId: waitingRound.id } }, rework: { available: false, reason: { code: "rework_not_available", message: "Rework unavailable" } }, stop: { available: true }, answer: { available: true }, feedback: { available: false, reason: { code: "feedback_not_available", message: "Feedback needs a delivered Round" } }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
  };
  const answeredQuestion = { ...question, answer: "Europe only", answeredAt: "2026-10-02T10:00:09Z" };
  const resuming: Ticket = { ...waiting, openRound: { ...waitingRound, waitingReason: "resuming", question: answeredQuestion }, allowedActions: { ...waiting.allowedActions, answer: { available: false, reason: { code: "question_already_answered", message: "This question already has an answer" } } } };
  const record = (fields: Partial<TicketRound>): TicketRound => ({ ...waitingRound, endedAt: null, outcomeNote: null, activity: [], earlierActivityCursor: null, usage, deliverable: null, questions: [question], feedback: [], permissionRequests: [], authorityChecks: [], authorityCheckCount: 0, ...fields });
  const answerQuestion = () => vi.fn<(roundId: string, questionId: string, answer: string) => Promise<Ticket>>();

  it("shows the question with an answer form, sending nothing while the answer is blank", () => {
    const onAnswer = answerQuestion();
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onAnswer={onAnswer} />);
    const panel = within(screen.getByRole("region", { name: "Question from the Agent" }));
    expect(panel.getByTestId("ticket-detail-question-text")).toHaveTextContent("Which region should the report cover?");
    expect(panel.getByLabelText("Your answer")).toHaveAttribute("maxLength", "2000");
    expect(panel.getByTestId("ticket-detail-answer-submit")).toBeDisabled();
    fireEvent.change(panel.getByLabelText("Your answer"), { target: { value: "   " } });
    expect(panel.getByTestId("ticket-detail-answer-submit")).toBeDisabled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("sends the answer as typed for this Round and question and shows the receipt Galley returned", async () => {
    const onAnswer = answerQuestion().mockResolvedValue(resuming);
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: " Europe only" } });
    fireEvent.click(screen.getByTestId("ticket-detail-answer-submit"));
    expect(await screen.findByTestId("ticket-detail-question-answered")).toHaveTextContent("Your answer: Europe only");
    expect(onAnswer).toHaveBeenCalledWith(waitingRound.id, question.id, " Europe only");
    expect(screen.queryByTestId("ticket-detail-answer-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-locked")).toHaveTextContent("Locked while atlas works on Round 1");
  });

  it("keeps the answer and the form while it is being sent", async () => {
    let finish: (ticket: Ticket) => void = () => {};
    const onAnswer = answerQuestion().mockImplementation(() => new Promise<Ticket>((resolve) => { finish = resolve; }));
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "Europe only" } });
    fireEvent.click(screen.getByTestId("ticket-detail-answer-submit"));
    await waitFor(() => expect(screen.getByTestId("ticket-detail-answer-submit")).toHaveTextContent("Sending…"));
    expect(screen.getByTestId("ticket-detail-answer-submit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("ticket-detail-answer-submit"));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    finish(resuming);
    expect(await screen.findByTestId("ticket-detail-question-answered")).toBeInTheDocument();
  });

  it("explains an answer that lost the race and keeps the draft", async () => {
    const onAnswer = answerQuestion().mockRejectedValue(new GalleyError({ code: "question_already_answered", message: "This question already has an answer" }));
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "Europe only" } });
    fireEvent.click(screen.getByTestId("ticket-detail-answer-submit"));
    expect(await screen.findByTestId("ticket-detail-answer-error")).toHaveTextContent("This question already has an answer. The receipt now shows the one Galley recorded.");
    expect(screen.getByLabelText("Your answer")).toHaveValue("Europe only");
  });

  it("shows any other rejection in Galley's words", async () => {
    const onAnswer = answerQuestion().mockRejectedValue(new GalleyError({ code: "stop_already_requested", message: "Stop is already requested for this Round" }));
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "Europe only" } });
    fireEvent.click(screen.getByTestId("ticket-detail-answer-submit"));
    expect(await screen.findByTestId("ticket-detail-answer-error")).toHaveTextContent("Stop is already requested for this Round");
  });

  it("names why an answer cannot be sent when Galley offers none", () => {
    const stopping: Ticket = { ...waiting, openRound: { ...waitingRound, stopRequestedAt: "2026-10-02T10:00:05Z", waitingReason: "stopping" }, allowedActions: { ...waiting.allowedActions, stop: { available: false, reason: { code: "stop_already_requested", message: "Stop is already requested for this Round" } }, answer: { available: false, reason: { code: "stop_already_requested", message: "Stop is already requested for this Round" } } } };
    render(<TicketDetail ticket={stopping} onSave={vi.fn()} {...noopActions()} onAnswer={answerQuestion()} />);
    expect(screen.getByTestId("ticket-detail-question-text")).toHaveTextContent("Which region should the report cover?");
    expect(screen.queryByTestId("ticket-detail-answer-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-answer-unavailable")).toHaveTextContent("Stop is already requested for this Round");
  });

  it("shows no question panel for a running Round", () => {
    const running: Ticket = { ...waiting, status: "InProgress", openRound: { ...waitingRound, state: "running", waitingReason: "working", question: null, permissionRequest: null }, allowedActions: { ...waiting.allowedActions, answer: notAvailable } };
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} onAnswer={answerQuestion()} />);
    expect(screen.queryByTestId("ticket-detail-question")).not.toBeInTheDocument();
  });

  it("shows the waiting Round's outcome and lists each question with its answer under its Round", () => {
    const second = { ...question, id: "88888888-8888-5888-8888-888888888888", text: "Include the appendix?" };
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onAnswer={answerQuestion()} roundRecords={{ rounds: [record({ questions: [answeredQuestion, second] })] }} />);
    expect(screen.getByTestId("ticket-detail-round-state")).toHaveTextContent("Waiting for your answer");
    const listed = screen.getAllByTestId("ticket-detail-round-question");
    expect(listed).toHaveLength(2);
    expect(within(listed[0]).getByTestId("ticket-detail-round-question-answer")).toHaveTextContent("A: Europe only");
    expect(listed[1]).toHaveTextContent("Q: Include the appendix?");
    expect(within(listed[1]).getByTestId("ticket-detail-round-question-unanswered")).toHaveTextContent("Awaiting your answer");
  });

  it("marks a question a stopped Round left unanswered as not answered", () => {
    render(<TicketDetail ticket={{ ...waiting, status: "Backlog", openRound: null }} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [record({ state: "stopped", endedAt: "2026-10-02T10:01:00Z", outcomeNote: "Stopped while waiting for the answer to step 2 of 3 on Stop command x" })] }} />);
    expect(screen.getByTestId("ticket-detail-round-question-unanswered")).toHaveTextContent(/^Not answered$/);
  });

  it("lists no questions for a Round that asked none", () => {
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [record({ state: "running", questions: [] })] }} />);
    expect(screen.queryByTestId("ticket-detail-round-questions")).not.toBeInTheDocument();
  });
});

describe("feedback for the next Round", () => {
  afterEach(cleanup);

  const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" as const };
  const notAvailable = (message: string) => ({ available: false, reason: { code: "feedback_not_available", message } });
  const usage = {
    observations: 0,
    complete: true,
    estimated: false,
    costUsd: null,
    inputTokens: { sum: null, complete: true, estimated: false },
    outputTokens: { sum: null, complete: true, estimated: false },
    activeMs: { sum: null, complete: true, estimated: false },
  };
  const delivery = { roundId: "66666666-6666-4666-8666-666666666666", sequence: 2, agent, deliveredAt: "2026-10-02T10:09:00Z" };
  const inReview: Ticket = {
    ...REFINED_TICKET,
    status: "InReview",
    assigneeType: "agent",
    assigneeAgent: agent,
    delivery,
    permissionGrants: [],
    permissionGrantCount: 0,
    allowedActions: { statusChanges: ["Done"], statusChangeRejections: [], accept: { available: true }, rework: { available: true }, stop: { available: false, reason: { code: "stop_not_available", message: "Stop needs an open Round" } }, answer: { available: false, reason: { code: "answer_not_available", message: "Answer needs a question the Round waits on" } }, feedback: { available: true }, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "A Permission decision needs a request the Round waits on" } } },
  };
  const done: Ticket = { ...inReview, status: "Done", allowedActions: { ...inReview.allowedActions, statusChanges: ["Ready"], accept: { available: false, reason: { code: "accept_not_available", message: "Accept needs In Review" } } } };
  const deliveredRecord = (sequence: number, id: string, feedback: TicketRound["feedback"]): TicketRound => ({
    id,
    sequence,
    state: "delivered",
    agent,
    claimedAt: "2026-10-02T10:00:00Z",
    startedAt: "2026-10-02T10:01:00Z",
    endedAt: "2026-10-02T10:09:00Z",
    outcomeNote: null,
    activity: [],
    earlierActivityCursor: null,
    usage,
    deliverable: { summary: `Summary ${sequence}`, criteriaAssessment: "Met", bodyMarkdown: "Report" },
    questions: [],
    feedback,
    permissionRequests: [],
    authorityChecks: [],
    authorityCheckCount: 0,
  });
  const addFeedback = () => vi.fn<(roundId: string, body: string) => Promise<Ticket>>();

  it.each([["In Review", inReview], ["Done", done]])("offers a labelled feedback form on the delivered Round in %s, sending nothing while it is blank", (_status, ticket) => {
    const onAddFeedback = addFeedback();
    render(<TicketDetail ticket={ticket} onSave={vi.fn()} {...noopActions()} onAddFeedback={onAddFeedback} />);
    const panel = within(screen.getByRole("region", { name: "Feedback for the next Round" }));
    const input = panel.getByLabelText("Your feedback on Round 2");
    expect(input).toHaveAttribute("maxLength", "10000");
    expect(input).toHaveAccessibleDescription("The next Round receives it once. It cannot be edited or deleted.");
    expect(panel.getByTestId("ticket-detail-feedback-submit")).toBeDisabled();
    fireEvent.change(input, { target: { value: "  \n " } });
    expect(panel.getByTestId("ticket-detail-feedback-submit")).toBeDisabled();
    expect(onAddFeedback).not.toHaveBeenCalled();
  });

  it("shows no feedback form when Galley does not offer feedback", () => {
    render(<TicketDetail ticket={{ ...inReview, allowedActions: { ...inReview.allowedActions, feedback: notAvailable("Feedback is not available on an archived Ticket") } }} onSave={vi.fn()} {...noopActions()} onAddFeedback={addFeedback()} />);
    expect(screen.queryByTestId("ticket-detail-feedback")).not.toBeInTheDocument();
  });

  it("sends the feedback as typed for the delivered Round, clears the draft and shows the receipt Galley returned", async () => {
    const onAddFeedback = addFeedback().mockResolvedValue({ ...done, updatedAt: "2026-10-02T11:00:00Z" });
    render(<TicketDetail ticket={done} onSave={vi.fn()} {...noopActions()} onAddFeedback={onAddFeedback} />);
    fireEvent.change(screen.getByLabelText("Your feedback on Round 2"), { target: { value: " Cover Asia too\nand Africa" } });
    fireEvent.click(screen.getByTestId("ticket-detail-feedback-submit"));
    await waitFor(() => expect(screen.getByLabelText("Your feedback on Round 2")).toHaveValue(""));
    expect(onAddFeedback).toHaveBeenCalledExactlyOnceWith(delivery.roundId, " Cover Asia too\nand Africa");
    expect(screen.queryByTestId("ticket-detail-feedback-error")).not.toBeInTheDocument();
  });

  it("can be sent with the keyboard alone", async () => {
    const onAddFeedback = addFeedback().mockResolvedValue(inReview);
    render(<TicketDetail ticket={inReview} onSave={vi.fn()} {...noopActions()} onAddFeedback={onAddFeedback} />);
    fireEvent.change(screen.getByLabelText("Your feedback on Round 2"), { target: { value: "Shorter, please" } });
    fireEvent.submit(screen.getByTestId("ticket-detail-feedback-form"));
    await waitFor(() => expect(onAddFeedback).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("ticket-detail-feedback-submit").tagName).toBe("BUTTON");
  });

  it("explains feedback that is no longer available and keeps the draft", async () => {
    const onAddFeedback = addFeedback().mockRejectedValue(new GalleyError({ code: "feedback_not_available", message: "Feedback needs a Ticket in In Review or Done (current status Ready)" }));
    render(<TicketDetail ticket={inReview} onSave={vi.fn()} {...noopActions()} onAddFeedback={onAddFeedback} />);
    fireEvent.change(screen.getByLabelText("Your feedback on Round 2"), { target: { value: "Cover Asia too" } });
    fireEvent.click(screen.getByTestId("ticket-detail-feedback-submit"));
    expect(await screen.findByTestId("ticket-detail-feedback-error")).toHaveTextContent("Feedback is no longer available on this Round. The receipt now shows the Ticket as Galley has it.");
    expect(screen.getByLabelText("Your feedback on Round 2")).toHaveValue("Cover Asia too");
    expect(screen.getByLabelText("Your feedback on Round 2")).toHaveAttribute("aria-invalid", "true");
  });

  it("shows any other failure in its own words", async () => {
    const onAddFeedback = addFeedback().mockRejectedValue(new GalleyError({ code: "invalid_request", message: "\"body\" must be 1 to 10000 characters" }));
    render(<TicketDetail ticket={inReview} onSave={vi.fn()} {...noopActions()} onAddFeedback={onAddFeedback} />);
    fireEvent.change(screen.getByLabelText("Your feedback on Round 2"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("ticket-detail-feedback-submit"));
    expect(await screen.findByTestId("ticket-detail-feedback-error")).toHaveTextContent("\"body\" must be 1 to 10000 characters");
  });

  it("lists each Round's feedback under that Round with its time and whether a Round received it", () => {
    const round2 = deliveredRecord(2, delivery.roundId, [{ id: "13131313-1313-4313-8313-131313131313", body: "Cover Asia too", createdAt: "2026-10-02T10:10:00Z", consumedBy: null }]);
    const round1 = deliveredRecord(1, "77777777-7777-4777-8777-777777777777", [{ id: "14141414-1414-4414-8414-141414141414", body: "More sources", createdAt: "2026-10-02T09:00:00Z", consumedBy: { roundId: delivery.roundId, sequence: 2 } }]);
    render(<TicketDetail ticket={inReview} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [round2, round1] }} />);
    const [second, first] = screen.getAllByTestId("ticket-detail-round");
    const waiting = within(second).getByTestId("ticket-detail-round-feedback-item");
    expect(within(waiting).getByTestId("ticket-detail-round-feedback-body")).toHaveTextContent("Cover Asia too");
    expect(waiting).toHaveTextContent("02 Oct 2026 15:40:00 UTC+05:30");
    expect(within(waiting).getByTestId("ticket-detail-round-feedback-consumed")).toHaveTextContent("Waiting for the next Round");
    const sent = within(first).getByTestId("ticket-detail-round-feedback-item");
    expect(within(sent).getByTestId("ticket-detail-round-feedback-body")).toHaveTextContent("More sources");
    expect(within(sent).getByTestId("ticket-detail-round-feedback-consumed")).toHaveTextContent("Sent to Round 2");
  });

  it("lists no feedback for a Round that has none", () => {
    render(<TicketDetail ticket={inReview} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [deliveredRecord(2, delivery.roundId, [])] }} />);
    expect(screen.queryByTestId("ticket-detail-round-feedback")).not.toBeInTheDocument();
  });
});

describe("a Permission request from the Agent", () => {
  afterEach(cleanup);

  const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" as const };
  const request = { id: "99999999-9999-5999-8999-999999999990", account: "controlled", action: "write_note", resource: "notes/weekly-report", substituteAccount: true, requestedAt: "2026-10-02T10:00:03Z", decision: null, decidedAt: null, grantId: null, renewsGrantId: null };
  const grantId = "12121212-1212-4121-8121-121212121212";
  const approved = { ...request, decision: "approved" as const, decidedAt: "2026-10-02T10:00:09Z", grantId };
  const declined = { ...request, decision: "declined" as const, decidedAt: "2026-10-02T10:00:09Z" };
  const waitingRound = { id: "66666666-6666-4666-8666-666666666666", sequence: 1, state: "waiting_for_input" as const, agent, claimedAt: "2026-10-02T10:00:00Z", startedAt: "2026-10-02T10:00:01Z", stopRequestedAt: null, waitingReason: "waiting_for_permission" as const, question: null, permissionRequest: request };
  const usage = {
    observations: 0,
    complete: true,
    estimated: false,
    costUsd: null,
    inputTokens: { sum: null, complete: true, estimated: false },
    outputTokens: { sum: null, complete: true, estimated: false },
    activeMs: { sum: null, complete: true, estimated: false },
  };
  const waiting: Ticket = {
    ...REFINED_TICKET,
    status: "Blocked",
    assigneeType: "agent",
    assigneeAgent: agent,
    openRound: waitingRound,
    allowedActions: { ...TICKET.allowedActions, statusChanges: [], accept: { available: false, reason: { code: "round_open", message: "locked", roundId: waitingRound.id } }, stop: { available: true }, permissionDecision: { available: true } },
  };
  const grant = { id: grantId, agent, account: "controlled", full: false, action: "write_note", resource: "notes/weekly-report", substituteAccount: true, form: "ticket" as const, state: "active" as const, expiresAt: null, remainingSeconds: null, roundId: waitingRound.id, createdAt: "2026-10-02T10:00:09Z", approvedAt: "2026-10-02T10:00:09Z", revokedAt: null, endedAt: null, allowedActions: { revoke: { available: true } }, coveredOpenRounds: [] };
  const decidedActions = { ...waiting.allowedActions, permissionDecision: { available: false, reason: { code: "permission_already_decided", message: "this Permission request is already decided" } } };
  const resuming: Ticket = { ...waiting, openRound: { ...waitingRound, waitingReason: "resuming", permissionRequest: approved }, permissionGrants: [grant], permissionGrantCount: 1, allowedActions: decidedActions };
  const stillWaiting: Ticket = { ...waiting, openRound: { ...waitingRound, permissionRequest: declined }, allowedActions: decidedActions };
  const record = (fields: Partial<TicketRound>): TicketRound => ({ ...waitingRound, endedAt: null, outcomeNote: null, activity: [], earlierActivityCursor: null, usage, deliverable: null, questions: [], feedback: [], permissionRequests: [request], authorityChecks: [], authorityCheckCount: 0, ...fields });
  const decide = () => vi.fn<DecidePermission>();

  it("shows the request as a receipt that labels the controlled account a substitute, with both decisions", () => {
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} />);
    const panel = within(screen.getByRole("region", { name: "Permission request" }));
    expect(panel.getByTestId("ticket-detail-permission-account")).toHaveTextContent("controlledSubstitute account");
    expect(panel.getByTestId("ticket-detail-permission-action")).toHaveTextContent("write_note");
    expect(panel.getByTestId("ticket-detail-permission-resource")).toHaveTextContent("notes/weekly-report");
    expect(panel.getByTestId("ticket-detail-permission-approve")).toHaveTextContent("Allow for this Ticket");
    expect(panel.getByTestId("ticket-detail-permission-decline")).toHaveTextContent("Decline");
  });

  it("offers no decision Galley does not advertise, and names why", () => {
    const stopping: Ticket = { ...waiting, openRound: { ...waitingRound, stopRequestedAt: "2026-10-02T10:00:05Z", waitingReason: "stopping" }, allowedActions: { ...waiting.allowedActions, permissionDecision: { available: false, reason: { code: "stop_already_requested", message: "Stop is already requested for this Round" } } } };
    render(<TicketDetail ticket={stopping} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} />);
    expect(screen.queryByTestId("ticket-detail-permission-actions")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-permission-unavailable")).toHaveTextContent("Stop is already requested for this Round");
  });

  it("shows no Permission panel for a Round that waits on none", () => {
    const running: Ticket = { ...waiting, status: "InProgress", openRound: { ...waitingRound, state: "running", waitingReason: "working", permissionRequest: null }, allowedActions: { ...waiting.allowedActions, permissionDecision: { available: false, reason: { code: "permission_decision_not_available", message: "unavailable" } } } };
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} />);
    expect(screen.queryByTestId("ticket-detail-permission")).not.toBeInTheDocument();
  });

  it("approves for this Round and request once, and shows the grant Galley returned", async () => {
    let finish: (ticket: Ticket) => void = () => {};
    const onDecide = decide().mockImplementation(() => new Promise<Ticket>((resolve) => { finish = resolve; }));
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
    fireEvent.click(screen.getByTestId("ticket-detail-permission-approve"));
    await waitFor(() => expect(screen.getByTestId("ticket-detail-permission-approve")).toHaveTextContent("Allowing…"));
    fireEvent.click(screen.getByTestId("ticket-detail-permission-approve"));
    fireEvent.click(screen.getByTestId("ticket-detail-permission-decline"));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith(waitingRound.id, request.id, "approve", { form: "ticket" });
    finish(resuming);
    expect(await screen.findByTestId("ticket-detail-permission-approved")).toHaveTextContent("Allowed for this Ticket");
    expect(screen.getByTestId("ticket-detail-permission-grant")).toHaveTextContent("atlas may write_note on notes/weekly-report (controlled)Substitute account");
    expect(screen.getByTestId("ticket-detail-locked")).toHaveTextContent("Locked while atlas works on Round 1");
  });

  it("declines and leaves the Round waiting, with Stop still offered", async () => {
    const onDecide = decide().mockResolvedValue(stillWaiting);
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
    fireEvent.click(screen.getByTestId("ticket-detail-permission-decline"));
    expect(await screen.findByTestId("ticket-detail-permission-declined")).toHaveTextContent("Declined. The Round still waits for a Permission; Stop ends it.");
    expect(onDecide).toHaveBeenCalledExactlyOnceWith(waitingRound.id, request.id, "decline");
    expect(screen.getByTestId("ticket-detail-stop-button")).toBeEnabled();
  });

  it("explains a decision that lost the race", async () => {
    const onDecide = decide().mockRejectedValue(new GalleyError({ code: "permission_already_decided", message: "this Permission request is already decided" }));
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
    fireEvent.click(screen.getByTestId("ticket-detail-permission-approve"));
    expect(await screen.findByTestId("ticket-detail-permission-error")).toHaveTextContent("This Permission request is already decided. The receipt now shows the decision Galley recorded.");
  });

  it("shows any other rejection in Galley's words", async () => {
    const onDecide = decide().mockRejectedValue(new GalleyError({ code: "round_not_open", message: "the Round has ended" }));
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
    fireEvent.click(screen.getByTestId("ticket-detail-permission-decline"));
    expect(await screen.findByTestId("ticket-detail-permission-error")).toHaveTextContent("the Round has ended");
  });

  it("lists the Round's requests, their decisions and its authority checks", () => {
    const deny = { account: "controlled", action: "write_note", resource: "notes/weekly-report", decision: "deny" as const, grantId: null, expiredGrantId: null, checkedAt: "2026-10-02T10:00:02Z" };
    const allow = { ...deny, decision: "allow" as const, grantId, checkedAt: "2026-10-02T10:00:10Z" };
    render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [record({ authorityChecks: [deny, allow], authorityCheckCount: 2 })] }} />);
    expect(screen.getByTestId("ticket-detail-round-state")).toHaveTextContent("Waiting for a Permission");
    const listed = screen.getByTestId("ticket-detail-round-permission-request");
    expect(listed).toHaveAttribute("data-decision", "pending");
    expect(listed).toHaveTextContent("write_note on notes/weekly-report (controlled)Substitute account");
    expect(listed).toHaveTextContent("Awaiting your decision");
    const checks = screen.getAllByTestId("ticket-detail-round-authority-check");
    expect(checks.map((check) => check.getAttribute("data-decision"))).toEqual(["deny", "allow"]);
    expect(checks[0]).toHaveTextContent("Denied write_note on notes/weekly-report (controlled)");
    expect(screen.queryByTestId("ticket-detail-round-authority-checks-truncated")).not.toBeInTheDocument();
  });

  it("says when Galley lists only the latest authority checks", () => {
    const allow = { account: "controlled", action: "write_note", resource: "notes/weekly-report", decision: "allow" as const, grantId, expiredGrantId: null, checkedAt: "2026-10-02T10:00:10Z" };
    render(<TicketDetail ticket={{ ...waiting, openRound: null, status: "InReview", permissionGrants: [grant], permissionGrantCount: 1 }} onSave={vi.fn()} {...noopActions()} roundRecords={{ rounds: [record({ state: "delivered", permissionRequests: [approved], authorityChecks: [allow], authorityCheckCount: 51 })] }} />);
    expect(screen.getByTestId("ticket-detail-round-authority-checks-truncated")).toHaveTextContent("Showing the latest 1 of 51 checks.");
    expect(screen.getByTestId("ticket-detail-round-permission-request")).toHaveTextContent("Allowed for this Ticket");
  });

  it("keeps the Ticket's grants on its receipt after the Round ends", () => {
    render(<TicketDetail ticket={{ ...waiting, status: "InReview", openRound: null, permissionGrants: [grant], permissionGrantCount: 1 }} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.getByTestId("ticket-detail-permission-grant")).toHaveTextContent("atlas may write_note on notes/weekly-report (controlled)");
  });

  describe("the time form", () => {
    afterEach(() => vi.useRealTimers());

    const timeGrant = { ...grant, id: "13131313-1313-4131-8131-131313131313", form: "time" as const, expiresAt: "2026-10-02T11:00:09Z", remainingSeconds: 3_600 };
    const expiredGrant = { ...timeGrant, id: "14141414-1414-4141-8141-141414141414", state: "expired" as const, expiresAt: "2026-10-01T11:00:00Z", remainingSeconds: 0, allowedActions: { revoke: { available: false, reason: { code: "grant_expired", message: "this grant has expired and authorizes nothing, so there is nothing to revoke" } } } };

    it("defaults to the ticket form and offers the time form with a labelled duration", () => {
      render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} />);
      expect(screen.getByTestId("ticket-detail-permission-form-ticket")).toBeChecked();
      expect(screen.queryByTestId("ticket-detail-permission-duration")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("ticket-detail-permission-form-time"));
      expect(screen.getByLabelText("Expires after")).toBe(screen.getByTestId("ticket-detail-permission-duration"));
      expect(within(screen.getByTestId("ticket-detail-permission-duration")).getAllByRole("option").map((option) => option.textContent)).toEqual(["1 hour", "8 hours", "1 day", "7 days"]);
      expect(screen.getByTestId("ticket-detail-permission-approve")).toHaveTextContent("Allow for a time");
    });

    it("approves with the expiry the chosen duration names from now", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
      const onDecide = decide().mockResolvedValue({ ...resuming, permissionGrants: [timeGrant], openRound: { ...waitingRound, waitingReason: "resuming", permissionRequest: { ...approved, grantId: timeGrant.id } } });
      render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
      fireEvent.click(screen.getByTestId("ticket-detail-permission-form-time"));
      fireEvent.change(screen.getByTestId("ticket-detail-permission-duration"), { target: { value: "86400" } });
      expect(screen.getByTestId("ticket-detail-permission-expiry")).toHaveTextContent("Until about 03 Oct 2026 15:30:00 UTC+05:30");
      fireEvent.click(screen.getByTestId("ticket-detail-permission-approve"));
      expect(onDecide).toHaveBeenCalledExactlyOnceWith(waitingRound.id, request.id, "approve", { form: "time", expiresAt: "2026-10-03T10:00:00.000Z" });
      expect(await screen.findByTestId("ticket-detail-permission-approved")).toHaveTextContent("Allowed for a time. The Round resumes.");
    });

    it("declines with no grant terms whichever form is chosen", () => {
      const onDecide = decide().mockResolvedValue(stillWaiting);
      render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
      fireEvent.click(screen.getByTestId("ticket-detail-permission-form-time"));
      fireEvent.click(screen.getByTestId("ticket-detail-permission-decline"));
      expect(onDecide).toHaveBeenCalledExactlyOnceWith(waitingRound.id, request.id, "decline");
    });

    it("explains an expiry Galley refused", async () => {
      const onDecide = decide().mockRejectedValue(new GalleyError({ code: "invalid_grant_expiry", message: "raw" }));
      render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
      fireEvent.click(screen.getByTestId("ticket-detail-permission-form-time"));
      fireEvent.click(screen.getByTestId("ticket-detail-permission-approve"));
      expect(await screen.findByTestId("ticket-detail-permission-error")).toHaveTextContent("Galley refused this expiry: by Galley's clock it must be in the future and at most 30 days away.");
    });

    it("lists live and expired time grants with their expiry, remaining time and form, and says when only the newest are shown", () => {
      render(<TicketDetail ticket={{ ...waiting, status: "InReview", openRound: null, permissionGrants: [expiredGrant, timeGrant, grant], permissionGrantCount: 60 }} onSave={vi.fn()} {...noopActions()} />);
      const listed = screen.getAllByTestId("ticket-detail-permission-grant");
      expect(listed.map((item) => [item.getAttribute("data-form"), item.getAttribute("data-state")])).toEqual([["time", "expired"], ["time", "active"], ["ticket", "active"]]);
      expect(within(listed[0]!).getByTestId("ticket-detail-permission-grant-expired")).toHaveTextContent("Expired");
      expect(listed[0]).toHaveTextContent("expired 01 Oct 2026 16:30:00 UTC+05:30");
      expect(listed[1]).toHaveTextContent("until 02 Oct 2026 16:30:09 UTC+05:30");
      expect(within(listed[1]!).getByTestId("ticket-detail-permission-grant-remaining")).toHaveTextContent("1 h left");
      expect(within(listed[1]!).queryByTestId("ticket-detail-permission-grant-expired")).not.toBeInTheDocument();
      expect(listed[2]).toHaveTextContent("Allowed for this Ticket");
      expect(screen.getByTestId("ticket-detail-permission-grants-truncated")).toHaveTextContent("Showing the latest 3 of 60 grants.");
    });

    it("marks a renewal request and the deny that named the expired grant", () => {
      const renewal = { ...request, renewsGrantId: expiredGrant.id };
      const asking: Ticket = { ...waiting, openRound: { ...waitingRound, permissionRequest: renewal } };
      const deny = { account: "controlled", action: "write_note", resource: "notes/weekly-report", decision: "deny" as const, grantId: null, expiredGrantId: expiredGrant.id, checkedAt: "2026-10-02T10:00:02Z" };
      render(<TicketDetail ticket={asking} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} roundRecords={{ rounds: [record({ permissionRequests: [renewal], authorityChecks: [deny], authorityCheckCount: 1 })] }} />);
      expect(screen.getByTestId("ticket-detail-permission-renewal")).toHaveTextContent("Renewal. The Agent's time-based grant for this scope expired.");
      expect(screen.getByTestId("ticket-detail-round-permission-request")).toHaveTextContent("Renews an expired grant");
      expect(screen.getByTestId("ticket-detail-round-authority-check-expired")).toHaveTextContent("its time-based grant expired");
    });

    it("marks neither on a first request or a plain deny", () => {
      render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} roundRecords={{ rounds: [record({ authorityChecks: [{ account: "controlled", action: "write_note", resource: "notes/weekly-report", decision: "deny", grantId: null, expiredGrantId: null, checkedAt: "2026-10-02T10:00:02Z" }], authorityCheckCount: 1 })] }} />);
      expect(screen.queryByTestId("ticket-detail-permission-renewal")).not.toBeInTheDocument();
      expect(screen.getByTestId("ticket-detail-round-permission-request")).not.toHaveTextContent("Renews");
      expect(screen.queryByTestId("ticket-detail-round-authority-check-expired")).not.toBeInTheDocument();
    });

    describe("full access", () => {
      const fullGrant = { ...timeGrant, id: "15151515-1515-4151-8151-151515151515", full: true, action: null, resource: null };
      const fullTicketGrant = { ...grant, id: "16161616-1616-4161-8161-161616161616", full: true, action: null, resource: null };

      it("offers it as an explicit choice that is never the default, in a labelled radio group", () => {
        render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} />);
        const scope = within(screen.getByRole("group", { name: "Access" }));
        const requested = scope.getByRole("radio", { name: /Only what was requested — write_note on notes\/weekly-report/ });
        const full = scope.getByRole("radio", { name: /Full access to the controlled account — every action and resource it declares/ });
        expect(requested).toBeChecked();
        expect(full).not.toBeChecked();
        expect(screen.queryByTestId("ticket-detail-permission-full-warning")).not.toBeInTheDocument();
        expect(screen.getByTestId("ticket-detail-permission-approve")).toHaveTextContent("Allow for this Ticket");
        expect(screen.getByRole("group", { name: "Allow" })).toBeInTheDocument();
      });

      it("warns what full access allows once chosen, and words the forms and the button for it", () => {
        render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} />);
        fireEvent.click(screen.getByTestId("ticket-detail-permission-scope-full"));
        const warning = screen.getByTestId("ticket-detail-permission-full-warning");
        expect(warning).toHaveTextContent("Full access. This Agent may use every action and resource the controlled account declares (a substitute account) without asking you again, not only write_note on notes/weekly-report. Anything the account does not declare stays refused.");
        expect(screen.getByTestId("ticket-detail-permission-scope-full")).toHaveAttribute("aria-describedby", warning.id);
        expect(screen.getByTestId("ticket-detail-permission-approve")).toHaveTextContent("Allow full access for this Ticket");
        expect(screen.getByRole("radio", { name: /For this Ticket — full access to the controlled account, on this Ticket only/ })).toBeChecked();
        fireEvent.click(screen.getByTestId("ticket-detail-permission-form-time"));
        expect(screen.getByTestId("ticket-detail-permission-approve")).toHaveTextContent("Allow full access for a time");
        fireEvent.click(screen.getByTestId("ticket-detail-permission-scope-requested"));
        expect(screen.queryByTestId("ticket-detail-permission-full-warning")).not.toBeInTheDocument();
        expect(screen.getByTestId("ticket-detail-permission-approve")).toHaveTextContent("Allow for a time");
      });

      it("approves for this Ticket with the full scope and shows the full grant Galley returned", async () => {
        const onDecide = decide().mockResolvedValue({ ...resuming, permissionGrants: [fullTicketGrant], openRound: { ...waitingRound, waitingReason: "resuming", permissionRequest: { ...approved, grantId: fullTicketGrant.id } } });
        render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
        fireEvent.click(screen.getByTestId("ticket-detail-permission-scope-full"));
        fireEvent.click(screen.getByTestId("ticket-detail-permission-approve"));
        expect(onDecide).toHaveBeenCalledExactlyOnceWith(waitingRound.id, request.id, "approve", { form: "ticket", scope: "full" });
        expect(await screen.findByTestId("ticket-detail-permission-approved")).toHaveTextContent("Full access allowed for this Ticket. The Round resumes.");
        const listed = screen.getByTestId("ticket-detail-permission-grant");
        expect(listed).toHaveAttribute("data-full", "true");
        expect(listed).toHaveTextContent("atlas has Full access to the controlled accountSubstitute account");
        expect(within(listed).getByTestId("ticket-detail-permission-grant-full")).toHaveTextContent("Full access");
      });

      it("approves for a time with the full scope and the chosen expiry", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
        const onDecide = decide().mockResolvedValue(stillWaiting);
        render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
        fireEvent.click(screen.getByTestId("ticket-detail-permission-scope-full"));
        fireEvent.click(screen.getByTestId("ticket-detail-permission-form-time"));
        fireEvent.click(screen.getByTestId("ticket-detail-permission-approve"));
        expect(onDecide).toHaveBeenCalledExactlyOnceWith(waitingRound.id, request.id, "approve", { form: "time", expiresAt: "2026-10-02T11:00:00.000Z", scope: "full" });
      });

      it("sends no scope once the Owner returns to only what was requested", () => {
        const onDecide = decide().mockResolvedValue(stillWaiting);
        render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
        fireEvent.click(screen.getByTestId("ticket-detail-permission-scope-full"));
        fireEvent.click(screen.getByTestId("ticket-detail-permission-scope-requested"));
        fireEvent.click(screen.getByTestId("ticket-detail-permission-approve"));
        expect(onDecide).toHaveBeenCalledExactlyOnceWith(waitingRound.id, request.id, "approve", { form: "ticket" });
      });

      it("declines with no terms while full access is chosen", () => {
        const onDecide = decide().mockResolvedValue(stillWaiting);
        render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
        fireEvent.click(screen.getByTestId("ticket-detail-permission-scope-full"));
        fireEvent.click(screen.getByTestId("ticket-detail-permission-decline"));
        expect(onDecide).toHaveBeenCalledExactlyOnceWith(waitingRound.id, request.id, "decline");
      });

      it("goes back to only what was requested for the next request", () => {
        const { rerender } = render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} />);
        fireEvent.click(screen.getByTestId("ticket-detail-permission-scope-full"));
        const next: Ticket = { ...waiting, openRound: { ...waitingRound, permissionRequest: { ...request, id: "99999999-9999-5999-8999-999999999991", action: "post_message", resource: "channels/general" } } };
        rerender(<TicketDetail ticket={next} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} />);
        expect(screen.getByTestId("ticket-detail-permission-scope-requested")).toBeChecked();
        expect(screen.queryByTestId("ticket-detail-permission-full-warning")).not.toBeInTheDocument();
      });

      it("shows Galley's refusal of a full-access approval", async () => {
        const onDecide = decide().mockRejectedValue(new GalleyError({ code: "stop_already_requested", message: "Stop is already requested for this Round" }));
        render(<TicketDetail ticket={waiting} onSave={vi.fn()} {...noopActions()} onDecidePermission={onDecide} />);
        fireEvent.click(screen.getByTestId("ticket-detail-permission-scope-full"));
        fireEvent.click(screen.getByTestId("ticket-detail-permission-approve"));
        expect(await screen.findByTestId("ticket-detail-permission-error")).toHaveTextContent("Stop is already requested for this Round");
      });

      it("marks checks allowed by full access, a renewal of expired full access, and lists the time-based full grant with its remaining time", () => {
        const expiredFull = { ...fullGrant, state: "expired" as const, remainingSeconds: 0, allowedActions: { revoke: { available: false, reason: { code: "grant_expired", message: "this grant has expired and authorizes nothing, so there is nothing to revoke" } } } };
        const renewal = { ...request, renewsGrantId: expiredFull.id };
        const allow = { account: "controlled", action: "post_message", resource: "channels/general", decision: "allow" as const, grantId: fullGrant.id, expiredGrantId: null, checkedAt: "2026-10-02T10:00:10Z" };
        const exact = { ...allow, action: "write_note", resource: "notes/weekly-report", grantId };
        const asking: Ticket = { ...waiting, openRound: { ...waitingRound, permissionRequest: renewal }, permissionGrants: [expiredFull, grant, fullGrant], permissionGrantCount: 3 };
        render(<TicketDetail ticket={asking} onSave={vi.fn()} {...noopActions()} onDecidePermission={decide()} roundRecords={{ rounds: [record({ permissionRequests: [renewal], authorityChecks: [allow, exact], authorityCheckCount: 2 })] }} />);
        expect(screen.getByTestId("ticket-detail-permission-renewal")).toHaveTextContent("Renewal. The Agent's time-based full access to the controlled account expired.");
        const checks = screen.getAllByTestId("ticket-detail-round-authority-check");
        expect(checks[0]).toHaveTextContent("Allowed post_message on channels/general (controlled) · by full access");
        expect(checks[1]).not.toHaveTextContent("full access");
        const listed = screen.getAllByTestId("ticket-detail-permission-grant");
        expect(listed.map((item) => item.getAttribute("data-full"))).toEqual(["true", "false", "true"]);
        expect(within(listed[2]!).getByTestId("ticket-detail-permission-grant-remaining")).toHaveTextContent("1 h left");
        expect(listed[1]).toHaveTextContent("atlas may write_note on notes/weekly-report (controlled)");
      });
    });

    it.each([
      [59, "less than a minute left"],
      [60, "1 min left"],
      [3_599, "59 min left"],
      [3_600, "1 h left"],
      [5_400, "1 h 30 min left"],
      [86_400, "1 d left"],
      [2_592_000, "30 d left"],
      [97_200, "1 d 3 h left"],
    ])("words %i seconds left as %s", (seconds, text) => {
      expect(remainingText(seconds)).toBe(text);
    });
  });
});

describe("revoking a grant", () => {
  afterEach(cleanup);

  const agent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research" as const };
  const runningRound = { id: "66666666-6666-4666-8666-666666666666", sequence: 2, state: "running" as const, agent, claimedAt: "2026-10-02T10:00:00Z", startedAt: "2026-10-02T10:00:01Z", stopRequestedAt: null, waitingReason: "working" as const, question: null, permissionRequest: null };
  const covered = { roundId: runningRound.id, sequence: 2, ticketId: REFINED_TICKET.id, ticketTitle: "Write the weekly report" };
  const grant = { id: "12121212-1212-4121-8121-121212121212", agent, account: "controlled", full: false, action: "write_note", resource: "notes/weekly-report", substituteAccount: false, form: "ticket" as const, state: "active" as const, expiresAt: null, remainingSeconds: null, roundId: runningRound.id, createdAt: "2026-10-02T10:00:09Z", approvedAt: "2026-10-02T10:00:09Z", revokedAt: null, endedAt: null, allowedActions: { revoke: { available: true } }, coveredOpenRounds: [covered] };
  const revoked = { ...grant, state: "revoked" as const, revokedAt: "2026-10-02T10:05:00Z", endedAt: null, allowedActions: { revoke: { available: false, reason: { code: "grant_already_revoked", message: "this grant is already revoked" } } }, coveredOpenRounds: [] };
  const running: Ticket = {
    ...REFINED_TICKET,
    status: "InProgress",
    assigneeType: "agent",
    assigneeAgent: agent,
    openRound: runningRound,
    permissionGrants: [grant],
    permissionGrantCount: 1,
    allowedActions: { ...TICKET.allowedActions, statusChanges: [], stop: { available: true } },
  };
  const stopping: Ticket = { ...running, openRound: { ...runningRound, stopRequestedAt: "2026-10-02T10:05:00Z", waitingReason: "stopping" }, permissionGrants: [revoked], allowedActions: { ...running.allowedActions, stop: { available: false, reason: { code: "stop_already_requested", message: "Stop is already requested for this Round" } } } };
  const openDialog = () => {
    fireEvent.click(screen.getByTestId("ticket-detail-permission-grant-revoke"));
    return screen.getByRole("dialog", { name: "Revoke this grant?" });
  };

  it("offers Revoke only on a grant Galley says can be revoked, and only with a handler", () => {
    const expired = { ...grant, id: "14141414-1414-4141-8141-141414141414", form: "time" as const, state: "expired" as const, expiresAt: "2026-10-01T11:00:00Z", remainingSeconds: 0, allowedActions: { revoke: { available: false, reason: { code: "grant_expired", message: "expired" } } }, coveredOpenRounds: [] };
    render(<TicketDetail ticket={{ ...running, permissionGrants: [expired, revoked, grant], permissionGrantCount: 3 }} onSave={vi.fn()} {...noopActions()} onRevokeGrant={vi.fn()} />);
    const listed = screen.getAllByTestId("ticket-detail-permission-grant");
    expect(listed.map((item) => within(item).queryByTestId("ticket-detail-permission-grant-revoke") !== null)).toEqual([false, false, true]);
    cleanup();
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} />);
    expect(screen.queryByTestId("ticket-detail-permission-grant-revoke")).not.toBeInTheDocument();
  });

  it("shows a grant ended at Done with its time, distinct from Revoked and Expired, and offers no Revoke", () => {
    const ended = { ...grant, state: "ended_at_done" as const, endedAt: "2026-10-02T10:06:00Z", allowedActions: { revoke: { available: false, reason: { code: "grant_ended", message: "this grant ended when its Ticket reached Done" } } } };
    render(<TicketDetail ticket={{ ...running, status: "Done", openRound: null, permissionGrants: [ended, revoked], permissionGrantCount: 2 }} onSave={vi.fn()} {...noopActions()} onRevokeGrant={vi.fn()} />);
    const [endedItem, revokedItem] = screen.getAllByTestId("ticket-detail-permission-grant");
    expect(endedItem).toHaveAttribute("data-state", "ended_at_done");
    expect(within(endedItem).getByTestId("ticket-detail-permission-grant-ended")).toHaveTextContent("Ended at Done");
    expect(within(endedItem).getByTestId("ticket-detail-permission-grant-ended-at")).toHaveAttribute("dateTime", "2026-10-02T10:06:00Z");
    expect(within(endedItem).queryByTestId("ticket-detail-permission-grant-revoked")).not.toBeInTheDocument();
    expect(within(endedItem).queryByTestId("ticket-detail-permission-grant-expired")).not.toBeInTheDocument();
    expect(within(endedItem).queryByTestId("ticket-detail-permission-grant-revoke")).not.toBeInTheDocument();
    expect(within(revokedItem).queryByTestId("ticket-detail-permission-grant-ended")).not.toBeInTheDocument();
  });

  it("names the grant in the button's accessible name", () => {
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} onRevokeGrant={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Revoke: write_note on notes/weekly-report (controlled)" })).toBeInTheDocument();
  });

  it("confirms in a labelled, described dialog that names the Round it stops, says completed actions stay, and focuses Cancel", async () => {
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} onRevokeGrant={vi.fn()} />);
    const dialog = openDialog();
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining("This stops the open Round it covers: Round 2 of “Write the weekly report”."));
    expect(within(dialog).getByTestId("ticket-detail-permission-revoke-undone")).toHaveTextContent("Actions the Agent already completed are not undone.");
    await waitFor(() => expect(within(dialog).getByTestId("ticket-detail-permission-revoke-cancel")).toHaveFocus());
  });

  it("says nothing is stopped when no open Round uses the grant, and lists several when it covers several", () => {
    render(<TicketDetail ticket={{ ...running, permissionGrants: [{ ...grant, coveredOpenRounds: [] }] }} onSave={vi.fn()} {...noopActions()} onRevokeGrant={vi.fn()} />);
    expect(within(openDialog()).getByTestId("ticket-detail-permission-revoke-effect")).toHaveTextContent("No open Round uses it, so nothing is stopped.");
    cleanup();
    const other = { roundId: "77777777-7777-4777-8777-777777777777", sequence: 1, ticketId: "88888888-8888-4888-8888-888888888888", ticketTitle: "Tidy the notes" };
    render(<TicketDetail ticket={{ ...running, permissionGrants: [{ ...grant, form: "time", expiresAt: "2026-10-02T11:00:09Z", remainingSeconds: 3_600, coveredOpenRounds: [covered, other] }] }} onSave={vi.fn()} {...noopActions()} onRevokeGrant={vi.fn()} />);
    expect(within(openDialog()).getByTestId("ticket-detail-permission-revoke-effect")).toHaveTextContent("This stops the 2 open Rounds it covers: Round 2 of “Write the weekly report”, Round 1 of “Tidy the notes”.");
  });

  it("Cancel and Escape close the dialog without revoking", async () => {
    const onRevokeGrant = vi.fn();
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} onRevokeGrant={onRevokeGrant} />);
    fireEvent.click(within(openDialog()).getByTestId("ticket-detail-permission-revoke-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.keyDown(openDialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onRevokeGrant).not.toHaveBeenCalled();
  });

  it("revokes, then shows the grant Revoked with its time and the Round Stopping", async () => {
    const onRevokeGrant = vi.fn().mockResolvedValue(stopping);
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} onRevokeGrant={onRevokeGrant} />);
    fireEvent.click(within(openDialog()).getByTestId("ticket-detail-permission-revoke-confirm"));
    expect(onRevokeGrant).toHaveBeenCalledExactlyOnceWith(grant.id);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const listed = screen.getByTestId("ticket-detail-permission-grant");
    expect(listed).toHaveAttribute("data-state", "revoked");
    expect(within(listed).getByTestId("ticket-detail-permission-grant-revoked")).toHaveTextContent("Revoked");
    expect(within(listed).getByTestId("ticket-detail-permission-grant-revoked-at")).toHaveAttribute("dateTime", "2026-10-02T10:05:00Z");
    expect(within(listed).queryByTestId("ticket-detail-permission-grant-revoke")).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-stopping")).toBeInTheDocument();
  });

  it.each([
    ["grant_expired", new GalleyError({ code: "grant_expired", message: "raw" }), "This grant has already expired, so there is nothing to revoke."],
    ["grant_already_revoked", new GalleyError({ code: "grant_already_revoked", message: "raw" }), "This grant was already revoked."],
    ["a 404", new GrantNotFoundError(), "Galley has no such grant."],
    ["an outage", new Error("failed to revoke the grant"), "failed to revoke the grant"],
  ])("closes the dialog and explains %s under the grants", async (_name, failure, message) => {
    render(<TicketDetail ticket={running} onSave={vi.fn()} {...noopActions()} onRevokeGrant={vi.fn().mockRejectedValue(failure)} />);
    fireEvent.click(within(openDialog()).getByTestId("ticket-detail-permission-revoke-confirm"));
    expect(await screen.findByTestId("ticket-detail-permission-revoke-error")).toHaveTextContent(message);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Could not revoke the grant.");
    openDialog();
    expect(screen.queryByTestId("ticket-detail-permission-revoke-error")).not.toBeInTheDocument();
  });
});
