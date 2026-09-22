import { useEffect, useState } from "react";
import type { Ticket, TicketUpdate } from "../api/tickets";

interface TicketDetailProps {
  ticket: Ticket;
  /**
   * Performs the actual PATCH (apps/swiftlet/src/api/tickets.ts's
   * updateTicket) and returns the updated Ticket, or throws Galley's
   * own rejection. Supplied by whichever container renders this
   * component -- TicketDetailPage today, M3's modal container later --
   * so this component still neither fetches nor routes itself
   * (issue #57's split, preserved by issue #58).
   */
  onSave: (update: TicketUpdate) => Promise<Ticket>;
  /**
   * Owner commands arrive as props, like onSave, rather than this
   * component importing src/api/tickets.ts: that is what lets M3's
   * modal container supply its own and render this component
   * unchanged. Each throws Galley's rejection verbatim.
   */
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

/**
 * D3 S2's workflow table
 * (docs/decisions/d3-agent-template-compatibility.md), mirrored for
 * presentation only. It decides nothing: Galley re-validates every
 * request against the persisted Status, so a stale offer here surfaces
 * Galley's rejection rather than a fabricated success (ADR 0001).
 * Omits Done, which only Accept reaches.
 */
const presentationNextStatuses: Record<Ticket["status"], Ticket["status"][]> = {
  Backlog: ["Ready", "Blocked"],
  Ready: ["Backlog", "InProgress"],
  InProgress: ["Ready", "Blocked", "InReview"],
  Blocked: ["InProgress"],
  InReview: ["InProgress"],
  Done: ["Ready"],
};

/**
 * Copied from decideAccept so the limitation can be shown without
 * firing Accept, which is an explicit owner action. Drift is caught by
 * e2e/tests/ticket-lifecycle.spec.ts's Coding-Template case, which
 * compares this against Galley's live response.
 */
const REVIEWED_PR_MERGE_NOT_IMPLEMENTED_MESSAGE =
  "this ticket's retained completion condition is reviewed PR merge, which cannot be completed in M2: " +
  "D2 (review/merge evidence) is unresolved and the shared mechanism it selects is owned by M8 " +
  '(docs/decisions/d3-agent-template-compatibility.md, "Completing human work that requires a reviewed PR merge"); ' +
  "this is a current-implementation limitation, not a permanent rule -- the condition is never downgraded to human acceptance";

/**
 * Pure presentation of one already-fetched Ticket's detail content,
 * now including manual refinement (issue #58) and Templates (issue
 * #59). View mode shows title, Status, Template, the retained
 * completion condition, timestamps, the refinement fields and
 * repository reference (an explicit "Not set" placeholder for whichever
 * are still empty), and -- only for a Coding-template Ticket -- a Pull
 * Request section with an honest empty state (no PR exists until M8).
 * Edit mode offers title, the four refinement fields, and repository as
 * plain-text inputs -- never Markdown (M7 owns report rendering) --
 * plus Save and Cancel. Template itself has no edit control here:
 * changing it after creation is out of scope for M2 (D4, M8), and
 * completionCondition has no control at all -- it is never sent in any
 * update this component makes. No AI of any kind: Save submits exactly
 * what the Owner typed and triggers nothing else.
 *
 * Saving delegates to the `onSave` prop rather than calling
 * updateTicket itself, so this component still neither fetches nor
 * routes -- only the container does -- which is what lets M3's modal
 * render this exact component with its own container, unchanged,
 * exactly as issue #57 already established for the read-only view.
 */
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
    setSaving(true);
    try {
      const updated = await onSave({
        title: fields.title,
        goal: fields.goal,
        context: fields.context,
        successCriteria: fields.successCriteria,
        constraints: fields.constraints,
        repository: fields.repository,
      });
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

            {presentationNextStatuses[current.status].length > 0 && (
              <div data-testid="ticket-detail-status-actions">
                {presentationNextStatuses[current.status].map((target) => (
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

            {current.status === "InReview" && current.completionCondition === "humanAcceptance" && (
              <button
                type="button"
                data-testid="ticket-detail-accept-button"
                onClick={() => runAction(onAccept)}
                disabled={actionPending}
              >
                Accept
              </button>
            )}
            {current.status === "InReview" && current.completionCondition === "reviewedPrMerge" && (
              <p data-testid="ticket-detail-accept-unavailable">{REVIEWED_PR_MERGE_NOT_IMPLEMENTED_MESSAGE}</p>
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
