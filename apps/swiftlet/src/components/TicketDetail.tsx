import { useEffect, useState } from "react";
import type { Ticket, TicketUpdate } from "../api/tickets";

interface TicketDetailProps {
  ticket: Ticket;
  onSave: (update: TicketUpdate) => Promise<Ticket>;
  onChangeStatus: (status: Ticket["status"]) => Promise<Ticket>;
  onAccept: () => Promise<Ticket>;
  onAssign: () => Promise<Ticket>;
  onUnassign: () => Promise<Ticket>;
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

export function TicketDetail({ ticket, onSave, onChangeStatus, onAccept, onAssign, onUnassign }: TicketDetailProps) {
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
