import { useEffect, useState } from "react";
import type { Badge, Ticket, TicketUpdate } from "../api/tickets";

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

export function TicketDetail({ ticket, onSave, onChangeStatus, onAccept, onAssign, onUnassign, onLoadBadges, onCreateBadge, onAttachBadge, onDetachBadge }: TicketDetailProps) {
  const [current, setCurrent] = useState(ticket);
  const [mode, setMode] = useState<"view" | "editing">("view");
  const [fields, setFields] = useState<EditableFields>(() => fieldsFrom(ticket));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // A new Ticket prop (e.g. the container fetched a different one)
  // always wins over any in-progress local edit -- resets back to a
  // clean view of whatever was just fetched.
  useEffect(() => {
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

  return (
    <article data-testid="ticket-detail">
      {mode === "view" && (
        <>
          <h2 data-testid="ticket-detail-title">{current.title}</h2>
          <dl>
            <dt>Status</dt>
            <dd data-testid="ticket-detail-status">{current.status}</dd>
            <dt>Template</dt>
            <dd data-testid="ticket-detail-template">{current.template}</dd>
            <dt>Completion condition</dt>
            <dd data-testid="ticket-detail-completion-condition">
              {completionConditionLabel(current.completionCondition)}
            </dd>
            <dt>Created</dt>
            <dd data-testid="ticket-detail-created-at">{current.createdAt}</dd>
            <dt>Updated</dt>
            <dd data-testid="ticket-detail-updated-at">{current.updatedAt}</dd>
          </dl>
          <section aria-label="Badges" data-testid="ticket-detail-badges">
            <h3>Badges</h3>
            <ul>{current.badges.map((badge) => <li key={badge.id}><span>{badge.name}</span> <button type="button" disabled={actionPending} onClick={() => runAction(() => onDetachBadge(badge.id))} aria-label={`Remove ${badge.name}`}>Remove</button></li>)}</ul>
            <BadgePicker ticket={current} onAttached={setCurrent} onLoad={onLoadBadges} onCreate={onCreateBadge} onAttach={onAttachBadge} />
          </section>
          <section aria-label="Refinement">
            <RefinementValue label="Goal" testId="goal" value={current.goal} />
            <RefinementValue label="Context" testId="context" value={current.context} />
            <RefinementValue label="Success Criteria" testId="success-criteria" value={current.successCriteria} />
            <RefinementValue label="Constraints" testId="constraints" value={current.constraints} />
            <RefinementValue label="Repository" testId="repository" value={current.repository} />
          </section>
          {current.template === "Coding" && (
            <section aria-label="Pull Request" data-testid="ticket-detail-pr-section">
              <h3>Pull Request</h3>
              {/* No PR exists until M8 -- there is nothing to fabricate a
                  field for; this is the section's own honest state. */}
              <p data-testid="ticket-detail-pr-empty-state">
                PR delivery arrives with coding execution -- no pull request exists yet.
              </p>
            </section>
          )}
          <section aria-label="Workflow" data-testid="ticket-detail-workflow">
            <dl>
              <dt>Assignee</dt>
              <dd data-testid="ticket-detail-assignee">
                {current.assigneeType === OWNER_ASSIGNEE_TYPE ? "Owner" : "Unassigned"}
              </dd>
            </dl>
            {/* Owner is the only Assignee kind M2 has. */}
            {current.assigneeType === OWNER_ASSIGNEE_TYPE ? (
              <button
                type="button"
                data-testid="ticket-detail-unassign-button"
                onClick={() => runAction(onUnassign)}
                disabled={actionPending}
              >
                Unassign
              </button>
            ) : (
              <button
                type="button"
                data-testid="ticket-detail-assign-button"
                onClick={() => runAction(onAssign)}
                disabled={actionPending}
              >
                Assign to me
              </button>
            )}

            {current.allowedActions.statusChanges.length > 0 && (
              <div data-testid="ticket-detail-status-actions">
                {current.allowedActions.statusChanges.map((target) => (
                  <button
                    key={target}
                    type="button"
                    data-testid={`ticket-detail-status-button-${target}`}
                    onClick={() => runAction(() => onChangeStatus(target))}
                    disabled={actionPending}
                  >
                    {target}
                  </button>
                ))}
              </div>
            )}

            {current.allowedActions.accept.available ? (
              <button
                type="button"
                data-testid="ticket-detail-accept-button"
                onClick={() => runAction(onAccept)}
                disabled={actionPending}
              >
                Accept
              </button>
            ) : (
              <p data-testid="ticket-detail-accept-unavailable">{current.allowedActions.accept.reason?.message}</p>
            )}

            {actionError && (
              <p role="alert" data-testid="ticket-detail-action-error">
                {actionError}
              </p>
            )}
          </section>
          <button type="button" data-testid="ticket-detail-edit-button" onClick={startEditing}>
            Edit
          </button>
        </>
      )}
      {mode === "editing" && (
        <form data-testid="ticket-detail-edit-form" onSubmit={handleSave}>
          <div>
            <label htmlFor="ticket-detail-input-title">Title</label>
            <input
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
            <label htmlFor="ticket-detail-input-repository">Repository</label>
            <input
              id="ticket-detail-input-repository"
              data-testid="ticket-detail-input-repository"
              value={fields.repository}
              onChange={(event) => setFields((current) => ({ ...current, repository: event.target.value }))}
              disabled={saving}
            />
          </div>
          {saveError && (
            <p role="alert" data-testid="ticket-detail-save-error">
              {saveError}
            </p>
          )}
          <button type="submit" data-testid="ticket-detail-save-button" disabled={saving}>
            Save
          </button>
          <button
            type="button"
            data-testid="ticket-detail-cancel-button"
            onClick={cancelEditing}
            disabled={saving}
          >
            Cancel
          </button>
        </form>
      )}
    </article>
  );
}

function BadgePicker({ ticket, onAttached, onLoad, onCreate, onAttach }: {
  ticket: Ticket;
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
    <button type="button" onClick={() => setOpen((value) => !value)} data-testid="badge-picker-toggle">{open ? "Close badge picker" : "Add badge"}</button>
    {open && <div data-testid="badge-picker">
      <form onSubmit={attach}>
        <label htmlFor="existing-badge">Existing badge</label>
        <select id="existing-badge" data-testid="badge-picker-select" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={pending}>
          <option value="">Choose a badge</option>
          {available.map((badge) => <option key={badge.id} value={badge.id}>{badge.name}</option>)}
        </select>
        <button type="submit" disabled={pending || !selected}>Attach badge</button>
      </form>
      <form onSubmit={createAndAttach}>
        <label htmlFor="new-badge-name">New badge name</label>
        <input id="new-badge-name" data-testid="new-badge-name" value={name} onChange={(event) => setName(event.target.value)} disabled={pending} />
        <button type="submit" disabled={pending}>Create and attach</button>
      </form>
      {error && <p role="alert" data-testid="badge-picker-error">{error}</p>}
    </div>}
  </>;
}

function RefinementValue({ label, testId, value }: { label: string; testId: string; value: string }) {
  return (
    <div>
      <h3>{label}</h3>
      <p data-testid={`ticket-detail-field-${testId}`}>{value === "" ? "Not set." : value}</p>
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
      <label htmlFor={inputId}>{label}</label>
      <p data-testid={`ticket-detail-guidance-${testId}`}>{guidance}</p>
      <textarea
        id={inputId}
        data-testid={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </div>
  );
}
