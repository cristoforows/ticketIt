import { useEffect, useRef, useState } from "react";
import type { Badge, Ticket, TicketUpdate } from "../api/tickets";
import { BadgeTag, cx, ErrorMessage, PrimaryButton, Rule, SecondaryButton, Select, StatusTag, statusLabel, TextInput, Textarea, ticketSerial } from "./ui";

interface TicketDetailProps {
  ticket: Ticket;
  onSave: (update: TicketUpdate) => Promise<Ticket>;
  onChangeStatus: (status: Ticket["status"]) => Promise<Ticket>;
  onAccept: () => Promise<Ticket>;
  onAssign: () => Promise<Ticket>;
  onUnassign: () => Promise<Ticket>;
  onLoadBadges: () => Promise<Badge[]>;
  onCreateBadge: (name: string) => Promise<Badge>;
  onAttachBadge: (badgeId: string) => Promise<Ticket>;
  onDetachBadge: (badgeId: string) => Promise<Ticket>;
  onArchive: () => Promise<Ticket>;
  onRestore: () => Promise<Ticket>;
  onArchived?: () => void;
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

/** The only non-empty assignee_type M2 writes; there is no Agent Assignee kind yet. */
const OWNER_ASSIGNEE_TYPE = "owner";

export function TicketDetail({ ticket, onSave, onChangeStatus, onAccept, onAssign, onUnassign, onLoadBadges, onCreateBadge, onAttachBadge, onDetachBadge, onArchive, onRestore, onArchived }: TicketDetailProps) {
  const previousTicket = useRef(ticket);
  const [current, setCurrent] = useState(ticket);
  const [mode, setMode] = useState<"view" | "editing">("view");
  const [fields, setFields] = useState<EditableFields>(() => fieldsFrom(ticket));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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
  async function runAction(action: () => Promise<Ticket>) {
    setActionError(null);
    setActionPending(true);
    try {
      const updated = await action();
      setCurrent(updated);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to update the ticket.");
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
      setActionError(error instanceof Error ? error.message : "Failed to archive the ticket.");
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
      setSaveError(error instanceof Error ? error.message : "Failed to save the ticket.");
    } finally {
      setSaving(false);
    }
  }

  const archived = !!current.archivedAt;
  const archivedReason = archived ? current.allowedActions.accept.reason?.message : undefined;

  return (
    <article data-testid="ticket-detail" className="text-body">
      {mode === "view" && (
        <>
          <p className="text-label tracking-label text-muted">{ticketSerial(current.id)}</p>
          <h2 data-testid="ticket-detail-title" className="mt-1 mb-2 text-title font-bold break-words">{current.title}</h2>
          <StatusTag status={current.status} data-testid="ticket-detail-status" />
          {archived && (
            <p data-testid="ticket-detail-archived" className="mt-3 border-2 border-status-blocked-deep p-2 text-status-blocked-deep">
              <span className="font-bold tracking-label uppercase">Archived</span> {current.archivedAt}. {archivedReason}
            </p>
          )}
          <Rule />
          <section aria-label="Refinement" className="flex flex-col gap-3">
            <RefinementValue label="Goal" testId="goal" value={current.goal} />
            <Rule className="my-0!" />
            <RefinementValue label="Context" testId="context" value={current.context} />
            <Rule className="my-0!" />
            <RefinementValue label="Success Criteria" testId="success-criteria" value={current.successCriteria} />
            <Rule className="my-0!" />
            <RefinementValue label="Constraints" testId="constraints" value={current.constraints} />
            <Rule className="my-0!" />
            <RefinementValue label="Repository" testId="repository" value={current.repository} />
          </section>
          <Rule />
          <dl className="m-0 flex flex-col gap-1">
            <ReceiptLine label="Template" testId="template">{current.template}</ReceiptLine>
            <ReceiptLine label="Completion condition" testId="completion-condition">
              {completionConditionLabel(current.completionCondition)}
            </ReceiptLine>
            <ReceiptLine label="Assignee" testId="assignee">
              {current.assigneeType === OWNER_ASSIGNEE_TYPE ? "Owner" : "Unassigned"}
            </ReceiptLine>
            <ReceiptLine label="Created" testId="created-at">{current.createdAt}</ReceiptLine>
            <ReceiptLine label="Updated" testId="updated-at">{current.updatedAt}</ReceiptLine>
          </dl>
          <Rule />
          <section aria-label="Badges" data-testid="ticket-detail-badges">
            <h3 className={labelClasses}>Badges</h3>
            {current.badges.length === 0 ? (
              <p className="my-1 text-muted italic">No badges.</p>
            ) : (
              <ul className="my-2 flex list-none flex-wrap gap-2 p-0">
                {current.badges.map((badge) => (
                  <li key={badge.id} className="mt-0 flex items-center gap-1 border-t-0 pt-0">
                    <BadgeTag>{badge.name}</BadgeTag>
                    <SecondaryButton size="sm" disabled={actionPending || archived} title={archivedReason} onClick={() => runAction(() => onDetachBadge(badge.id))} aria-label={`Remove ${badge.name}`}>Remove</SecondaryButton>
                  </li>
                ))}
              </ul>
            )}
            <BadgePicker ticket={current} disabled={archived} reason={archivedReason} onAttached={setCurrent} onLoad={onLoadBadges} onCreate={onCreateBadge} onAttach={onAttachBadge} />
          </section>
          {current.template === "Coding" && (
            <>
              <Rule />
              <section aria-label="Pull Request" data-testid="ticket-detail-pr-section">
                <h3 className={labelClasses}>Pull Request</h3>
                {/* No PR exists until M8 -- there is nothing to fabricate a
                    field for; this is the section's own honest state. */}
                <p data-testid="ticket-detail-pr-empty-state" className="my-1 text-muted italic">
                  PR delivery arrives with coding execution -- no pull request exists yet.
                </p>
              </section>
            </>
          )}
          <Rule weight="thick" />
          <section aria-label="Workflow" data-testid="ticket-detail-workflow" className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {current.allowedActions.statusChanges.length > 0 && (
                <div data-testid="ticket-detail-status-actions" className="flex flex-wrap gap-2">
                  {current.allowedActions.statusChanges.map((target) => (
                    <PrimaryButton
                      key={target}
                      data-testid={`ticket-detail-status-button-${target}`}
                      onClick={() => runAction(() => onChangeStatus(target))}
                      disabled={actionPending || archived}
                    >
                      {statusLabel(target)}
                    </PrimaryButton>
                  ))}
                </div>
              )}
              {current.allowedActions.accept.available && (
                <PrimaryButton
                  data-testid="ticket-detail-accept-button"
                  onClick={() => runAction(onAccept)}
                  disabled={actionPending || archived}
                >
                  Accept
                </PrimaryButton>
              )}
              {/* Owner is the only Assignee kind M2 has. */}
              {current.assigneeType === OWNER_ASSIGNEE_TYPE ? (
                <SecondaryButton
                  data-testid="ticket-detail-unassign-button"
                  onClick={() => runAction(onUnassign)}
                  disabled={actionPending || archived}
                  title={archivedReason}
                >
                  Unassign
                </SecondaryButton>
              ) : (
                <SecondaryButton
                  data-testid="ticket-detail-assign-button"
                  onClick={() => runAction(onAssign)}
                  disabled={actionPending || archived}
                  title={archivedReason}
                >
                  Assign to me
                </SecondaryButton>
              )}
            </div>
            {!current.allowedActions.accept.available && (
              <p data-testid="ticket-detail-accept-unavailable" className="m-0 text-muted">{current.allowedActions.accept.reason?.message}</p>
            )}
            {actionError && (
              <ErrorMessage title="Could not update the ticket.">
                <p data-testid="ticket-detail-action-error" className="m-0">{actionError}</p>
              </ErrorMessage>
            )}
            <div className="flex flex-wrap gap-2">
              <SecondaryButton data-testid="ticket-detail-edit-button" onClick={startEditing} disabled={archived} title={archivedReason}>
                Edit
              </SecondaryButton>
              <SecondaryButton data-testid="ticket-detail-archive-button" onClick={() => void handleArchive()} disabled={actionPending || archived} title={archivedReason}>Archive</SecondaryButton>
              {archived && <PrimaryButton data-testid="ticket-detail-restore-button" onClick={() => runAction(onRestore)} disabled={actionPending}>Restore</PrimaryButton>}
            </div>
          </section>
        </>
      )}
      {mode === "editing" && (
        <form data-testid="ticket-detail-edit-form" onSubmit={handleSave} className="flex flex-col gap-4">
          <p className="text-label tracking-label text-muted">{ticketSerial(current.id)}</p>
          <div>
            <label htmlFor="ticket-detail-input-title" className={labelClasses}>Title</label>
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
            guidance="What outcome do you want?"
            testId="goal"
            value={fields.goal}
            onChange={(value) => setFields((current) => ({ ...current, goal: value }))}
            disabled={saving}
          />
          <RefinementInput
            label="Context"
            guidance="Supply relevant background, links, repositories, or examples."
            testId="context"
            value={fields.context}
            onChange={(value) => setFields((current) => ({ ...current, context: value }))}
            disabled={saving}
          />
          <RefinementInput
            label="Success Criteria"
            guidance="Describe observable conditions that demonstrate the outcome was achieved."
            testId="success-criteria"
            value={fields.successCriteria}
            onChange={(value) => setFields((current) => ({ ...current, successCriteria: value }))}
            disabled={saving}
          />
          <RefinementInput
            label="Constraints"
            guidance="State what must stay unchanged or remain out of scope."
            testId="constraints"
            value={fields.constraints}
            onChange={(value) => setFields((current) => ({ ...current, constraints: value }))}
            disabled={saving}
          />
          <div>
            <label htmlFor="ticket-detail-input-repository" className={labelClasses}>Repository</label>
            <TextInput
              id="ticket-detail-input-repository"
              data-testid="ticket-detail-input-repository"
              value={fields.repository}
              onChange={(event) => setFields((current) => ({ ...current, repository: event.target.value }))}
              disabled={saving}
            />
          </div>
          {saveError && (
            <ErrorMessage title="Could not save the ticket.">
              <p data-testid="ticket-detail-save-error" className="m-0">{saveError}</p>
            </ErrorMessage>
          )}
          <Rule className="my-0!" />
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

const labelClasses = "m-0 block text-label font-bold tracking-label text-muted uppercase";

function ReceiptLine({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={labelClasses}>{label}</dt>
      <dd data-testid={`ticket-detail-${testId}`} className="m-0 text-right break-words">{children}</dd>
    </div>
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
          <label htmlFor="existing-badge" className={labelClasses}>Existing badge</label>
          <Select id="existing-badge" data-testid="badge-picker-select" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={pending}>
            <option value="">Choose a badge</option>
            {available.map((badge) => <option key={badge.id} value={badge.id}>{badge.name}</option>)}
          </Select>
        </div>
        <PrimaryButton type="submit" disabled={pending || !selected}>Attach badge</PrimaryButton>
      </form>
      <form onSubmit={createAndAttach} className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1">
          <label htmlFor="new-badge-name" className={labelClasses}>New badge name</label>
          <TextInput id="new-badge-name" data-testid="new-badge-name" value={name} onChange={(event) => setName(event.target.value)} disabled={pending} />
        </div>
        <PrimaryButton type="submit" disabled={pending}>Create and attach</PrimaryButton>
      </form>
      {error && <ErrorMessage title="Badge action failed."><p data-testid="badge-picker-error" className="m-0">{error}</p></ErrorMessage>}
    </div>}
  </>;
}

function RefinementValue({ label, testId, value }: { label: string; testId: string; value: string }) {
  return (
    <div>
      <h3 className={labelClasses}>{label}</h3>
      <p data-testid={`ticket-detail-field-${testId}`} className={cx("mt-1 mb-0 break-words whitespace-pre-wrap", value === "" && "text-muted italic")}>{value === "" ? "Not set." : value}</p>
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
}

function RefinementInput({ label, guidance, testId, value, onChange, disabled }: RefinementInputProps) {
  const inputId = `ticket-detail-textarea-${testId}`;
  return (
    <div>
      <label htmlFor={inputId} className={labelClasses}>{label}</label>
      <p data-testid={`ticket-detail-guidance-${testId}`} className="mt-0.5 mb-1 text-muted">{guidance}</p>
      <Textarea
        id={inputId}
        data-testid={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </div>
  );
}
