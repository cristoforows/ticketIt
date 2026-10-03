import { useEffect, useState } from "react";
import { GalleyError } from "../api/http";
import type { RoundQuestion, Ticket } from "../api/tickets";
import { FieldHint, FieldLabel, FieldNote, InlineError, LocalTime, PrimaryButton, Textarea } from "./ui";

export type AnswerQuestion = (roundId: string, questionId: string, answer: string) => Promise<Ticket>;

export const ANSWER_MAX_LENGTH = 2000;

const alreadyAnsweredMessage = "This question already has an answer. The receipt now shows the one Galley recorded.";

export function QuestionPanel({ roundId, question, availability, onAnswer, onAnswered }: {
  roundId: string;
  question: RoundQuestion;
  availability: Ticket["allowedActions"]["answer"];
  onAnswer?: AnswerQuestion;
  onAnswered: (ticket: Ticket) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft("");
    setError(null);
  }, [question.id]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onAnswer || sending) return;
    setSending(true);
    setError(null);
    try {
      onAnswered(await onAnswer(roundId, question.id, draft));
      setDraft("");
    } catch (failure) {
      setError(failure instanceof GalleyError && failure.code === "question_already_answered" ? alreadyAnsweredMessage : failure instanceof Error ? failure.message : "Unable to send the answer.");
    } finally {
      setSending(false);
    }
  }

  const blank = draft.trim() === "";
  return (
    <section aria-label="Question from the Agent" data-testid="ticket-detail-question" data-question-id={question.id} className="my-3 border-2 border-ink p-3">
      <FieldLabel as="h4">Question from the Agent</FieldLabel>
      <p data-testid="ticket-detail-question-text" className="my-1 break-words whitespace-pre-wrap">{question.text}</p>
      <FieldHint>Asked <LocalTime iso={question.askedAt} /></FieldHint>
      {question.answer !== null ? (
        <p data-testid="ticket-detail-question-answered" className="my-1">
          <span className="font-bold">Your answer:</span> <span className="break-words whitespace-pre-wrap">{question.answer}</span>
        </p>
      ) : availability.available ? (
        <form data-testid="ticket-detail-answer-form" onSubmit={(event) => void submit(event)} className="mt-2 flex flex-col gap-2">
          <FieldLabel htmlFor="ticket-detail-answer-input">Your answer</FieldLabel>
          <Textarea
            id="ticket-detail-answer-input"
            data-testid="ticket-detail-answer-input"
            value={draft}
            maxLength={ANSWER_MAX_LENGTH}
            required
            onChange={(event) => setDraft(event.target.value)}
            disabled={sending}
            aria-invalid={error !== null || undefined}
            aria-describedby={error ? "ticket-detail-answer-error" : undefined}
          />
          <div>
            <PrimaryButton type="submit" data-testid="ticket-detail-answer-submit" disabled={sending || blank || !onAnswer}>
              {sending ? "Sending…" : "Send answer"}
            </PrimaryButton>
          </div>
        </form>
      ) : (
        <FieldNote data-testid="ticket-detail-answer-unavailable">{availability.reason?.message}</FieldNote>
      )}
      {error && <InlineError id="ticket-detail-answer-error" data-testid="ticket-detail-answer-error">{error}</InlineError>}
    </section>
  );
}

export function QuestionHistory({ questions, awaiting }: { questions: RoundQuestion[]; awaiting: boolean }) {
  if (questions.length === 0) return null;
  return (
    <section aria-label="Questions" data-testid="ticket-detail-round-questions" className="mt-3">
      <FieldLabel as="h4">Questions</FieldLabel>
      <ol className="my-1 flex list-none flex-col gap-2 p-0">
        {questions.map((question) => (
          <li key={question.id} data-testid="ticket-detail-round-question" data-question-id={question.id} className="mt-0 border-t-0 pt-0">
            <p className="m-0 break-words whitespace-pre-wrap"><span className="font-bold">Q:</span> {question.text}</p>
            {question.answer !== null ? (
              <p data-testid="ticket-detail-round-question-answer" className="m-0 break-words whitespace-pre-wrap"><span className="font-bold">A:</span> {question.answer}</p>
            ) : (
              <p data-testid="ticket-detail-round-question-unanswered" className="m-0 text-muted italic">{awaiting ? "Awaiting your answer" : "Not answered"}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
