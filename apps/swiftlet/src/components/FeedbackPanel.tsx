import { useEffect, useState } from "react";
import { GalleyError } from "../api/http";
import type { RoundFeedback } from "../api/rounds";
import type { Ticket } from "../api/tickets";
import { FieldHint, FieldLabel, InlineError, LocalTime, PrimaryButton, Textarea } from "./ui";

export type AddFeedback = (roundId: string, body: string) => Promise<Ticket>;

export const FEEDBACK_MAX_LENGTH = 10000;

const notAvailableMessage = "Feedback is no longer available on this Round. The receipt now shows the Ticket as Galley has it.";

export function FeedbackPanel({ delivery, availability, onAddFeedback, onAdded }: {
  delivery: NonNullable<Ticket["delivery"]>;
  availability: Ticket["allowedActions"]["feedback"];
  onAddFeedback?: AddFeedback;
  onAdded: (ticket: Ticket) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft("");
    setError(null);
  }, [delivery.roundId]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onAddFeedback || sending) return;
    setSending(true);
    setError(null);
    try {
      onAdded(await onAddFeedback(delivery.roundId, draft));
      setDraft("");
    } catch (failure) {
      setError(failure instanceof GalleyError && failure.code === "feedback_not_available" ? notAvailableMessage : failure instanceof Error ? failure.message : "Unable to add the feedback.");
    } finally {
      setSending(false);
    }
  }

  if (!availability.available && error === null) return null;
  const blank = draft.trim() === "";
  return (
    <section aria-label="Feedback for the next Round" data-testid="ticket-detail-feedback" data-round-id={delivery.roundId} className="my-3 border-2 border-ink p-3">
      <FieldLabel as="h4">Feedback for the next Round</FieldLabel>
      {availability.available && (
        <form data-testid="ticket-detail-feedback-form" onSubmit={(event) => void submit(event)} className="mt-2 flex flex-col gap-2">
          <FieldLabel htmlFor="ticket-detail-feedback-input">Your feedback on Round {delivery.sequence}</FieldLabel>
          <FieldHint id="ticket-detail-feedback-hint">The next Round receives it once. It cannot be edited or deleted.</FieldHint>
          <Textarea
            id="ticket-detail-feedback-input"
            data-testid="ticket-detail-feedback-input"
            value={draft}
            maxLength={FEEDBACK_MAX_LENGTH}
            required
            onChange={(event) => setDraft(event.target.value)}
            disabled={sending}
            aria-invalid={error !== null || undefined}
            aria-describedby={error ? "ticket-detail-feedback-hint ticket-detail-feedback-error" : "ticket-detail-feedback-hint"}
          />
          <div>
            <PrimaryButton type="submit" data-testid="ticket-detail-feedback-submit" disabled={sending || blank || !onAddFeedback}>
              {sending ? "Adding…" : "Add feedback"}
            </PrimaryButton>
          </div>
        </form>
      )}
      {error && <InlineError id="ticket-detail-feedback-error" data-testid="ticket-detail-feedback-error">{error}</InlineError>}
    </section>
  );
}

export function FeedbackHistory({ feedback }: { feedback: RoundFeedback[] }) {
  if (feedback.length === 0) return null;
  return (
    <section aria-label="Feedback" data-testid="ticket-detail-round-feedback" className="mt-3">
      <FieldLabel as="h4">Feedback</FieldLabel>
      <ol className="my-1 flex list-none flex-col gap-2 p-0">
        {feedback.map((item) => (
          <li key={item.id} data-testid="ticket-detail-round-feedback-item" data-feedback-id={item.id} className="mt-0 border-t-0 pt-0">
            <p data-testid="ticket-detail-round-feedback-body" className="m-0 break-words whitespace-pre-wrap">{item.body}</p>
            <FieldHint>
              Added <LocalTime iso={item.createdAt} /> <span aria-hidden="true">·</span>{" "}
              <span data-testid="ticket-detail-round-feedback-consumed" data-consumed={item.consumedBy !== null}>
                {item.consumedBy ? `Sent to Round ${item.consumedBy.sequence}` : "Waiting for the next Round"}
              </span>
            </FieldHint>
          </li>
        ))}
      </ol>
    </section>
  );
}
