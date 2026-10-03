import { useEffect, useRef, useState } from "react";
import type { Agent } from "../api/agents";
import { missingInputsOf, type ReadinessInput } from "../api/http";
import type { Badge, Ticket, TicketAssignee, TicketUpdate } from "../api/tickets";
import { assigneeLabel } from "./assignee";
import { refinementGuidance } from "./refinementGuidance";
import type { HealthView } from "./RunnerHealthPill";
import { lockedLabel } from "./roundLock";
import { RoundsSection, type LoadEarlierActivity, type RoundRecords } from "./RoundsSection";
import { BadgeTag, ClaimedTag, DeliveredTag, ErrorMessage, FieldHint, FieldLabel, FieldNote, FieldValue, InlineError, LocalTime, LockGlyph, PrimaryButton, QueuedTag, ReceiptLine, Rule, SecondaryButton, Select, StatusTag, statusLabel, StoppingTag, TextInput, Textarea, ticketSerial } from "./ui";

interface TicketDetailProps {
  ticket: Ticket;
  onSave: (update: TicketUpdate) => Promise<Ticket>;
  onChangeStatus: (status: Ticket["status"]) => Promise<Ticket>;
  onAccept: () => Promise<Ticket>;
  onRework: () => Promise<Ticket>;
  onStop: () => Promise<Ticket>;
  onAssign: (assignee: TicketAssignee) => Promise<Ticket>;
  onUnassign: () => Promise<Ticket>;
  onLoadAgents: () => Promise<Agent[]>;
  onLoadBadges: () => Promise<Badge[]>;
  onCreateBadge: (name: string) => Promise<Badge>;
  onAttachBadge: (badgeId: string) => Promise<Ticket>;
  onDetachBadge: (badgeId: string) => Promise<Ticket>;
  onArchive: () => Promise<Ticket>;
  onRestore: () => Promise<Ticket>;
  onArchived?: () => void;
  editRequested?: boolean;
  runnerHealth?: HealthView;
  roundRecords?: RoundRecords;
  onLoadEarlierActivity?: LoadEarlierActivity;
}

interface EditableFields {
  title: string;
  goal: string;
  context: string;
  successCriteria: string;
  constraints: string;
  repository: string;
}

function fieldsFrom(ticket: Ticket): EditableFields {
  return {
    title: ticket.title,
    goal: ticket.goal,
    context: ticket.context,
    successCriteria: ticket.successCriteria,
    constraints: ticket.constraints,
    repository: ticket.repository,
  };
}

/**
 * Display text for the Ticket's retained completion condition
 * (issue #59, D3) -- derived from its Template's default once, at
 * creation, and never recomputed. CONTEXT.md's "Done" defines the two
 * underlying conditions; this only maps the wire enum to the same
 * words for display, it does not decide or store anything.
 */
function completionConditionLabel(condition: Ticket["completionCondition"]): string {
  return condition === "reviewedPrMerge" ? "Reviewed pull request merged" : "Human acceptance";
}

export function TicketDetail({ ticket, onSave, onChangeStatus, onAccept, onRework, onStop, onAssign, onUnassign, onLoadAgents, onLoadBadges, onCreateBadge, onAttachBadge, onDetachBadge, onArchive, onRestore, onArchived, editRequested = false, runnerHealth = { kind: "loading" }, roundRecords, onLoadEarlierActivity }: TicketDetailProps) {
  const previousTicket = useRef(ticket);
  const [current, setCurrent] = useState(ticket);
  const [mode, setMode] = useState<"view" | "editing">(editRequested && !ticket.archivedAt && !ticket.openRound ? "editing" : "view");
  const [fields, setFields] = useState<EditableFields>(() => fieldsFrom(ticket));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Rejection | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<(Rejection & { control: ActionControl }) | null>(null);

  useEffect(() => {
    if (previousTicket.current === ticket) return;
    previousTicket.current = ticket;
    setCurrent(ticket);
    setFields(fieldsFrom(ticket));
    setMode("view");
    setSaveError(null);
    setActionError(null);
  }, [ticket]);

  /**
   * Never an optimistic update: a rejection leaves `current` alone, so
   * the last-known-good Status and Assignee stay on screen (ADR 0001).
   */
  async function runAction(action: () => Promise<Ticket>, control: ActionControl = "other") {
    setActionError(null);
    setActionPending(true);
    try {
      const updated = await action();
      setCurrent(updated);
    } catch (error) {
      setActionError({ ...rejectionOf(error, "Failed to update the ticket."), control });
    } finally {
      setActionPending(false);
    }
  }

  async function handleArchive() {
    if (!window.confirm("Archive this Ticket?")) return;
    setActionError(null);
    setActionPending(true);
    try {
      setCurrent(await onArchive());
      onArchived?.();
    } catch (error) {
      setActionError({ ...rejectionOf(error, "Failed to archive the ticket."), control: "other" });
    } finally {
      setActionPending(false);
    }
  }

  function startEditing() {
    setFields(fieldsFrom(current));
    setSaveError(null);
    setMode("editing");
  }

  function cancelEditing() {
    setFields(fieldsFrom(current));
    setSaveError(null);
    setMode("view");
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError(null);
    const update: TicketUpdate = {};
    for (const field of Object.keys(fields) as Array<keyof EditableFields>) {
      if (fields[field] !== current[field]) {
        update[field] = fields[field];
      }
    }
    if (Object.keys(update).length === 0) {
      setMode("view");
      return;
    }
    setSaving(true);
    try {
      const updated = await onSave(update);
      setCurrent(updated);
      setFields(fieldsFrom(updated));
      setMode("view");
    } catch (error) {
      // Galley's own message, verbatim -- not a friendlier substitute
      // (issue #58's own requirement).
      setSaveError(rejectionOf(error, "Failed to save the ticket."));
    } finally {
      setSaving(false);
    }
  }

  const archived = !!current.archivedAt;
  const readOnly = archived || current.openRound !== null;
  const readOnlyReason = readOnly ? current.allowedActions.accept.reason?.message : undefined;
  const readyRejection = current.allowedActions.statusChangeRejections.find(({ status }) => status === "Ready");
  const reworkRejection = current.allowedActions.rework.reason;
  const reworkIncomplete = reworkRejection?.code === "agent_readiness_incomplete" ? reworkRejection : undefined;
  const missingExplanations = [
    { id: "ticket-detail-action-error", missing: actionError?.missing ?? [] },
    { id: "ticket-detail-status-unavailable-Ready", missing: readyRejection?.reason.missing ?? [] },
    { id: "ticket-detail-rework-unavailable", missing: reworkIncomplete?.missing ?? [] },
  ];
  const missingReasonId = missingExplanations.find(({ missing }) => missing.length > 0)?.id;
  const missing = new Set<ReadinessInput>(missingExplanations.flatMap(({ missing }) => missing));
  const missingFor = (input: ReadinessInput) => (missing.has(input) ? missingReasonId : undefined);
  const actionErrorMessage = (control: ActionControl) => actionError?.control === control && (
    <ErrorMessage title="Could not update the ticket.">
      <p id="ticket-detail-action-error" data-testid="ticket-detail-action-error" className="m-0">{actionError.message}</p>
    </ErrorMessage>
  );

  return (
    <article data-testid="ticket-detail" className="text-body">
      {mode === "view" && (
        <>
          <p className="text-label tracking-label text-muted">{ticketSerial(current.id)}</p>
          <h2 data-testid="ticket-detail-title" className="mt-1 mb-2 text-title font-bold break-words">{current.title}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusTag status={current.status} data-testid="ticket-detail-status" />
            {current.requestingAgentWork && current.assigneeAgent && (
              <QueuedTag data-testid="ticket-detail-queued">Queued for {current.assigneeAgent.name}</QueuedTag>
            )}
            {current.openRound?.state === "claimed" && (
              <ClaimedTag data-testid="ticket-detail-claimed">Claimed by runner</ClaimedTag>
            )}
            {current.openRound?.stopRequestedAt && (
              <StoppingTag data-testid="ticket-detail-stopping">Stopping…</StoppingTag>
            )}
            {current.delivery && (
              <DeliveredTag data-testid="ticket-detail-delivered">Delivered by {current.delivery.agent.name}</DeliveredTag>
            )}
          </div>
          {archived && (
            <p data-testid="ticket-detail-archived" className="mt-3 border-2 border-status-blocked-deep p-2 text-status-blocked-deep">
              <span className="font-bold tracking-label uppercase">Archived</span> {current.archivedAt && <LocalTime iso={current.archivedAt} />}. {readOnlyReason}
            </p>
          )}
          {current.openRound && (
            <p data-testid="ticket-detail-locked" className="mt-3 flex items-center gap-2 border-2 border-ink p-2 font-bold text-ink">
              <LockGlyph />
              {lockedLabel(current.openRound)}
            </p>
          )}
          <Rule />
          <section aria-label="Refinement" className="flex flex-col gap-3">
            <RefinementValue label="Goal" testId="goal" value={current.goal} missingReasonId={missingFor("goal")} />
            <Rule className="my-0" />
            <RefinementValue label="Context" testId="context" value={current.context} />
            <Rule className="my-0" />
            <RefinementValue label="Success Criteria" testId="success-criteria" value={current.successCriteria} missingReasonId={missingFor("successCriteria")} />
            <Rule className="my-0" />
            <RefinementValue label="Constraints" testId="constraints" value={current.constraints} />
            <Rule className="my-0" />
            <RefinementValue label="Repository" testId="repository" value={current.repository} missingReasonId={missingFor("repository")} />
          </section>
          <Rule />
          <dl className="m-0 flex flex-col gap-1">
            <ReceiptLine label="Template" data-testid="ticket-detail-template">{current.template}</ReceiptLine>
            <ReceiptLine label="Completion condition" data-testid="ticket-detail-completion-condition">
              {completionConditionLabel(current.completionCondition)}
            </ReceiptLine>
            <ReceiptLine label="Assignee" data-testid="ticket-detail-assignee">
              {assigneeLabel(current)}
            </ReceiptLine>
            <ReceiptLine label="Created" data-testid="ticket-detail-created-at"><LocalTime iso={current.createdAt} /></ReceiptLine>
            <ReceiptLine label="Updated" data-testid="ticket-detail-updated-at"><LocalTime iso={current.updatedAt} /></ReceiptLine>
          </dl>
          {(current.openRound || current.delivery || (roundRecords?.rounds?.length ?? 0) > 0) && (
            <>
              <Rule />
              <RoundsSection openRound={current.openRound} runnerHealth={runnerHealth} records={roundRecords} onLoadEarlierActivity={onLoadEarlierActivity} />
            </>
          )}
          <Rule />
          <section aria-label="Badges" data-testid="ticket-detail-badges">
            <FieldLabel as="h3">Badges</FieldLabel>
            {current.badges.length === 0 ? (
              <FieldNote>No badges.</FieldNote>
            ) : (
              <ul className="my-2 flex list-none flex-wrap gap-2 p-0">
                {current.badges.map((badge) => (
                  <li key={badge.id} className="mt-0 flex items-center gap-1 border-t-0 pt-0">
                    <BadgeTag>{badge.name}</BadgeTag>
                    <SecondaryButton size="sm" disabled={actionPending || readOnly} title={readOnlyReason} onClick={() => runAction(() => onDetachBadge(badge.id))} aria-label={`Remove ${badge.name}`}>Remove</SecondaryButton>
                  </li>
                ))}
              </ul>
            )}
            <BadgePicker ticket={current} disabled={readOnly} reason={readOnlyReason} onAttached={setCurrent} onLoad={onLoadBadges} onCreate={onCreateBadge} onAttach={onAttachBadge} />
          </section>
          {current.template === "Coding" && (
            <>
              <Rule />
              <section aria-label="Pull Request" data-testid="ticket-detail-pr-section">
                <FieldLabel as="h3">Pull Request</FieldLabel>
                {/* No PR exists until M8 -- there is nothing to fabricate a
                    field for; this is the section's own honest state. */}
                <FieldNote data-testid="ticket-detail-pr-empty-state">
                  PR delivery arrives with coding execution -- no pull request exists yet.
                </FieldNote>
              </section>
            </>
          )}
          <Rule weight="thick" />
          <section aria-label="Workflow" data-testid="ticket-detail-workflow" className="flex flex-col gap-3">
            <div data-testid="ticket-detail-status-control" className="flex flex-col gap-2">
              {current.allowedActions.statusChanges.length > 0 && (
                <div data-testid="ticket-detail-status-actions" className="flex flex-wrap gap-2">
                  {current.allowedActions.statusChanges.map((target) => (
                    <PrimaryButton
                      key={target}
                      data-testid={`ticket-detail-status-button-${target}`}
                      onClick={() => runAction(() => onChangeStatus(target), "status")}
                      disabled={actionPending || readOnly}
                    >
                      {statusLabel(target)}
                    </PrimaryButton>
                  ))}
                </div>
              )}
              {current.allowedActions.statusChangeRejections.map(({ status, reason }) => (
                <p key={status} id={`ticket-detail-status-unavailable-${status}`} data-testid={`ticket-detail-status-unavailable-${status}`} className="m-0 text-muted">
                  <span className="font-bold">{statusLabel(status)}:</span> {reason.message}
                </p>
              ))}
              {actionErrorMessage("status")}
            </div>
            <div className="flex flex-wrap gap-2">
              {current.allowedActions.accept.available && (
                <PrimaryButton
                  data-testid="ticket-detail-accept-button"
                  onClick={() => runAction(onAccept)}
                  disabled={actionPending || readOnly}
                >
                  Accept
                </PrimaryButton>
              )}
              {current.allowedActions.rework.available && (
                <PrimaryButton
                  data-testid="ticket-detail-rework-button"
                  onClick={() => runAction(onRework)}
                  disabled={actionPending || readOnly}
                >
                  Request rework
                </PrimaryButton>
              )}
              {current.allowedActions.stop.available && (
                <PrimaryButton
                  data-testid="ticket-detail-stop-button"
                  onClick={() => runAction(onStop)}
                  disabled={actionPending}
                >
                  Stop
                </PrimaryButton>
              )}
              {current.assigneeType !== "" && (
                <SecondaryButton
                  data-testid="ticket-detail-unassign-button"
                  onClick={() => runAction(onUnassign)}
                  disabled={actionPending || readOnly}
                  title={readOnlyReason}
                >
                  Unassign
                </SecondaryButton>
              )}
            </div>
            <AssigneePicker ticket={current} disabled={actionPending || readOnly} reason={readOnlyReason} onLoad={onLoadAgents} onAssign={(assignee) => runAction(() => onAssign(assignee), "assignee")} />
            {actionErrorMessage("assignee")}
            {!current.allowedActions.accept.available && (
              <p data-testid="ticket-detail-accept-unavailable" className="m-0 text-muted">{current.allowedActions.accept.reason?.message}</p>
            )}
            {reworkIncomplete && (
              <p id="ticket-detail-rework-unavailable" data-testid="ticket-detail-rework-unavailable" className="m-0 text-muted">{reworkIncomplete.message}</p>
            )}
            {actionErrorMessage("other")}
            <div className="flex flex-wrap gap-2">
              <SecondaryButton data-testid="ticket-detail-edit-button" onClick={startEditing} disabled={readOnly} title={readOnlyReason}>
                Edit
              </SecondaryButton>
              <SecondaryButton data-testid="ticket-detail-archive-button" onClick={() => void handleArchive()} disabled={actionPending || readOnly} title={readOnlyReason}>Archive</SecondaryButton>
              {archived && <PrimaryButton data-testid="ticket-detail-restore-button" onClick={() => runAction(onRestore)} disabled={actionPending}>Restore</PrimaryButton>}
            </div>
          </section>
        </>
      )}
      {mode === "editing" && (
        <form data-testid="ticket-detail-edit-form" onSubmit={handleSave} className="flex flex-col gap-4">
          <p className="text-label tracking-label text-muted">{ticketSerial(current.id)}</p>
          <div>
            <FieldLabel htmlFor="ticket-detail-input-title">Title</FieldLabel>
            <TextInput
              id="ticket-detail-input-title"
              data-testid="ticket-detail-input-title"
              value={fields.title}
              onChange={(event) => setFields((current) => ({ ...current, title: event.target.value }))}
              disabled={saving}
            />
          </div>
          <RefinementInput
            label="Goal"
            guidance={refinementGuidance.goal}
            missing={saveError?.missing.includes("goal")}
            testId="goal"
            value={fields.goal}
            onChange={(value) => setFields((current) => ({ ...current, goal: value }))}
            disabled={saving}
          />
          <RefinementInput
            label="Context"
            guidance={refinementGuidance.context}
            testId="context"
            value={fields.context}
            onChange={(value) => setFields((current) => ({ ...current, context: value }))}
            disabled={saving}
          />
          <RefinementInput
            label="Success Criteria"
            guidance={refinementGuidance.successCriteria}
            missing={saveError?.missing.includes("successCriteria")}
            testId="success-criteria"
            value={fields.successCriteria}
            onChange={(value) => setFields((current) => ({ ...current, successCriteria: value }))}
            disabled={saving}
          />
          <RefinementInput
            label="Constraints"
            guidance={refinementGuidance.constraints}
            testId="constraints"
            value={fields.constraints}
            onChange={(value) => setFields((current) => ({ ...current, constraints: value }))}
            disabled={saving}
          />
          <div>
            <FieldLabel htmlFor="ticket-detail-input-repository">Repository</FieldLabel>
            <TextInput
              id="ticket-detail-input-repository"
              data-testid="ticket-detail-input-repository"
              value={fields.repository}
              onChange={(event) => setFields((current) => ({ ...current, repository: event.target.value }))}
              disabled={saving}
              aria-invalid={saveError?.missing.includes("repository") || undefined}
              aria-describedby={describedByMissing("repository", saveError?.missing.includes("repository") ? "ticket-detail-save-error" : undefined)}
            />
            {saveError?.missing.includes("repository") && <MissingNote testId="repository" />}
          </div>
          {saveError && (
            <ErrorMessage title="Could not save the ticket.">
              <p id="ticket-detail-save-error" data-testid="ticket-detail-save-error" className="m-0">{saveError.message}</p>
            </ErrorMessage>
          )}
          <Rule className="my-0" />
          <div className="flex gap-2">
            <PrimaryButton type="submit" data-testid="ticket-detail-save-button" disabled={saving}>
              Save
            </PrimaryButton>
            <SecondaryButton
              data-testid="ticket-detail-cancel-button"
              onClick={cancelEditing}
              disabled={saving}
            >
              Cancel
            </SecondaryButton>
          </div>
        </form>
      )}
    </article>
  );
}

function assigneeValue(ticket: Ticket): string {
  return ticket.assigneeAgent ? `agent:${ticket.assigneeAgent.id}` : ticket.assigneeType;
}

function AssigneePicker({ ticket, disabled, reason, onLoad, onAssign }: {
  ticket: Ticket;
  disabled: boolean;
  reason?: string;
  onLoad: () => Promise<Agent[]>;
  onAssign: (assignee: TicketAssignee) => Promise<void>;
}) {
  const current = assigneeValue(ticket);
  const [selected, setSelected] = useState(current);
  const [agents, setAgents] = useState<Pick<Agent, "id" | "name">[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => setSelected(current), [current]);

  useEffect(() => {
    let cancelled = false;
    onLoad().then((loaded) => {
      if (!cancelled) setAgents(loaded);
    }).catch((cause: unknown) => {
      if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "Failed to load Agents.");
    });
    return () => { cancelled = true; };
  }, [onLoad]);

  const options = ticket.assigneeAgent && !agents.some((agent) => agent.id === ticket.assigneeAgent!.id)
    ? [...agents, ticket.assigneeAgent]
    : agents;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onAssign(selected === "owner" ? { type: "owner" } : { type: "agent", agentId: selected.slice("agent:".length) });
  }

  return (
    <form onSubmit={submit} data-testid="ticket-detail-assignee-form" className="flex flex-wrap items-end gap-2">
      <div className="min-w-48 flex-1">
        <FieldLabel htmlFor="ticket-detail-assignee-select">Assign to</FieldLabel>
        <Select id="ticket-detail-assignee-select" data-testid="ticket-detail-assignee-select" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={disabled} title={reason}>
          {current === "" && <option value="" disabled>Unassigned</option>}
          <option value="owner">Me</option>
          {options.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>)}
        </Select>
      </div>
      <SecondaryButton type="submit" data-testid="ticket-detail-assign-button" disabled={disabled || selected === current || selected === ""} title={reason}>Assign</SecondaryButton>
      {loadError && <InlineError data-testid="ticket-detail-agents-error" className="m-0 basis-full">Agents could not be loaded: {loadError}</InlineError>}
    </form>
  );
}

function BadgePicker({ ticket, disabled, reason, onAttached, onLoad, onCreate, onAttach }: {
  ticket: Ticket;
  disabled: boolean;
  reason?: string;
  onAttached: (ticket: Ticket) => void;
  onLoad: () => Promise<Badge[]>;
  onCreate: (name: string) => Promise<Badge>;
  onAttach: (badgeId: string) => Promise<Ticket>;
}) {
  const [open, setOpen] = useState(false);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    onLoad().then((available) => {
      if (!cancelled) {
        setBadges((current) => {
          const merged = new Map(available.map((badge) => [badge.id, badge]));
          for (const badge of current) {
            if (!merged.has(badge.id)) merged.set(badge.id, badge);
          }
          return [...merged.values()];
        });
        setError(null);
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Failed to load badges.");
    });
    return () => { cancelled = true; };
  }, [open, onLoad]);

  const available = badges.filter((badge) => !ticket.badges.some((attached) => attached.id === badge.id));

  async function attach(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const updated = await onAttach(selected);
      onAttached(updated);
      setSelected("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to attach badge.");
    } finally {
      setPending(false);
    }
  }

  async function createAndAttach(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const created = await onCreate(name);
      setBadges((current) => [...current, created]);
      const updated = await onAttach(created.id);
      onAttached(updated);
      setName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create badge.");
    } finally {
      setPending(false);
    }
  }

  return <>
    <SecondaryButton size="sm" onClick={() => setOpen((value) => !value)} disabled={disabled} title={disabled ? reason : undefined} data-testid="badge-picker-toggle">{open ? "Close badge picker" : "Add badge"}</SecondaryButton>
    {open && <div data-testid="badge-picker" className="mt-3 flex flex-col gap-3 border border-dashed border-rule p-3">
      <form onSubmit={attach} className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1">
          <FieldLabel htmlFor="existing-badge">Existing badge</FieldLabel>
          <Select id="existing-badge" data-testid="badge-picker-select" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={pending}>
            <option value="">Choose a badge</option>
            {available.map((badge) => <option key={badge.id} value={badge.id}>{badge.name}</option>)}
          </Select>
        </div>
        <PrimaryButton type="submit" disabled={pending || !selected}>Attach badge</PrimaryButton>
      </form>
      <form onSubmit={createAndAttach} className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1">
          <FieldLabel htmlFor="new-badge-name">New badge name</FieldLabel>
          <TextInput id="new-badge-name" data-testid="new-badge-name" value={name} onChange={(event) => setName(event.target.value)} disabled={pending} />
        </div>
        <PrimaryButton type="submit" disabled={pending}>Create and attach</PrimaryButton>
      </form>
      {error && <ErrorMessage title="Badge action failed."><p data-testid="badge-picker-error" className="m-0">{error}</p></ErrorMessage>}
    </div>}
  </>;
}

type ActionControl = "status" | "assignee" | "other";

interface Rejection {
  message: string;
  missing: ReadinessInput[];
}

function rejectionOf(error: unknown, fallback: string): Rejection {
  return { message: error instanceof Error ? error.message : fallback, missing: missingInputsOf(error) };
}

const missingNoteId = (testId: string) => `ticket-detail-missing-${testId}`;

/** The field references this marker and Galley's reason (`reasonId`) through `aria-describedby`. */
function describedByMissing(testId: string, reasonId: string | undefined): string | undefined {
  return reasonId ? `${missingNoteId(testId)} ${reasonId}` : undefined;
}

function MissingNote({ testId }: { testId: string }) {
  return (
    <InlineError announce={false} id={missingNoteId(testId)} data-testid={missingNoteId(testId)} className="m-0 mt-1 font-bold">
      Missing
    </InlineError>
  );
}

function RefinementValue({ label, testId, value, missingReasonId }: { label: string; testId: string; value: string; missingReasonId?: string }) {
  return (
    <div>
      <FieldLabel as="h3">{label}</FieldLabel>
      <FieldValue data-testid={`ticket-detail-field-${testId}`} empty={value === ""} aria-describedby={describedByMissing(testId, missingReasonId)}>
        {value === "" ? "Not set." : value}
      </FieldValue>
      {missingReasonId && <MissingNote testId={testId} />}
    </div>
  );
}

interface RefinementInputProps {
  label: string;
  guidance: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  missing?: boolean;
}

function RefinementInput({ label, guidance, testId, value, onChange, disabled, missing = false }: RefinementInputProps) {
  const inputId = `ticket-detail-textarea-${testId}`;
  return (
    <div>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <FieldHint data-testid={`ticket-detail-guidance-${testId}`}>{guidance}</FieldHint>
      <Textarea
        id={inputId}
        data-testid={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-invalid={missing || undefined}
        aria-describedby={describedByMissing(testId, missing ? "ticket-detail-save-error" : undefined)}
      />
      {missing && <MissingNote testId={testId} />}
    </div>
  );
}
