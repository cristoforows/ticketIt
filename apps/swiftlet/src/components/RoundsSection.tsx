import { useEffect, useRef, useState, type ReactNode } from "react";
import { limitBreachLabel } from "../api/limitBreach";
import type { RoundActivityNote, RoundActivityPage, RoundDeliverable, TicketRound } from "../api/rounds";
import type { Ticket } from "../api/tickets";
import { FeedbackHistory, FeedbackPanel, type AddFeedback } from "./FeedbackPanel";
import { PermissionGrants, PermissionHistory, PermissionPanel, type DecidePermission, type RevokeGrant } from "./PermissionPanel";
import { QuestionHistory, QuestionPanel, type AnswerQuestion } from "./QuestionPanel";
import type { HealthView } from "./RunnerHealthPill";
import { AttestationRecord, AttestCessationControl, type AttestCessation } from "./AttestCessation";
import { activeTime, costFigure, countFigure, type UsageFigure } from "./roundUsage";
import { Disclosure, EstimateTag, SecondaryButton, FailedTag, FieldLabel, FieldNote, InlineError, InterruptedTag, LocalTime, Markdown, ReceiptLine, StoppedTag } from "./ui";

/** `rounds` is the last list Galley returned; `error` is the latest refresh's failure. */
export interface RoundRecords {
  rounds?: TicketRound[];
  error?: string;
}

export type LoadEarlierActivity = (roundId: string, before: string) => Promise<RoundActivityPage>;

export function RoundsSection({ openRound, runnerHealth, records = {}, onLoadEarlierActivity, answer, onAnswer, onAnswered = () => {}, delivery = null, feedback, onAddFeedback, permissionDecision, onDecidePermission, onRevokeGrant, permissionGrants = [], permissionGrantCount = permissionGrants.length, attestCessation, onAttestCessation }: {
  openRound: Ticket["openRound"];
  runnerHealth: HealthView;
  records?: RoundRecords;
  onLoadEarlierActivity?: LoadEarlierActivity;
  answer?: Ticket["allowedActions"]["answer"];
  onAnswer?: AnswerQuestion;
  onAnswered?: (ticket: Ticket) => void;
  delivery?: Ticket["delivery"];
  feedback?: Ticket["allowedActions"]["feedback"];
  onAddFeedback?: AddFeedback;
  permissionDecision?: Ticket["allowedActions"]["permissionDecision"];
  onDecidePermission?: DecidePermission;
  onRevokeGrant?: RevokeGrant;
  permissionGrants?: Ticket["permissionGrants"];
  permissionGrantCount?: number;
  attestCessation?: Ticket["allowedActions"]["attestCessation"];
  onAttestCessation?: AttestCessation;
}) {
  const runnerLost = openRound !== null && runnerHealth.kind === "loaded" && runnerHealth.health.state !== "connected";
  const awaitingOpenRound = openRound !== null && !records.rounds?.some((candidate) => candidate.id === openRound.id);
  return (
    <section aria-label="Rounds" data-testid="ticket-detail-rounds">
      <FieldLabel as="h3">Rounds</FieldLabel>
      {runnerLost && (
        <p role="status" data-testid="ticket-detail-runner-disconnected" className="my-2 border-2 border-status-blocked-deep p-2 text-status-blocked-deep">
          <span className="font-bold tracking-label uppercase">Runner disconnected</span> Lost contact does not mean the Round stopped. It stays open and the Ticket stays locked.
        </p>
      )}
      {!runnerLost && openRound?.waitingReason === "execution_unknown" && (
        <p role="status" data-testid="ticket-detail-execution-unknown" className="my-2 border-2 border-status-blocked-deep p-2 text-status-blocked-deep">
          <span className="font-bold tracking-label uppercase">Runner cannot confirm execution</span> The runner reconnected but cannot confirm this Round is running. It stays open and the Ticket stays locked.
        </p>
      )}
      {!runnerLost && openRound?.waitingReason === "runner_replaced" && (
        <p role="status" data-testid="ticket-detail-runner-replaced" className="my-2 border-2 border-status-blocked-deep p-2 text-status-blocked-deep">
          <span className="font-bold tracking-label uppercase">Runner replaced</span> The runner that claimed this Round was replaced. It stays open and the Ticket stays locked.
        </p>
      )}
      {openRound && attestCessation && <AttestCessationControl roundId={openRound.id} availability={attestCessation} onAttest={onAttestCessation} onAttested={onAnswered} />}
      {!runnerLost && openRound?.waitingReason === "reconciling" && (
        <FieldNote role="status" data-testid="ticket-detail-reconciling">Reconciling with the runner</FieldNote>
      )}
      {openRound?.question && answer && (
        <QuestionPanel roundId={openRound.id} question={openRound.question} availability={answer} onAnswer={onAnswer} onAnswered={onAnswered} />
      )}
      {openRound?.permissionRequest && permissionDecision && (
        <PermissionPanel roundId={openRound.id} request={openRound.permissionRequest} availability={permissionDecision} onDecide={onDecidePermission} onDecided={onAnswered} grants={permissionGrants} />
      )}
      <PermissionGrants grants={permissionGrants} count={permissionGrantCount} onRevoke={onRevokeGrant} onRevoked={onAnswered} />
      {delivery && feedback && <FeedbackPanel delivery={delivery} availability={feedback} onAddFeedback={onAddFeedback} onAdded={onAnswered} />}
      {records.error && (
        <InlineError data-testid="ticket-detail-round-records-error" className="my-2">
          Unable to refresh activity and usage: {records.error}
        </InlineError>
      )}
      {(records.rounds === undefined || awaitingOpenRound) && !records.error && (
        <FieldNote data-testid="ticket-detail-round-records-loading">Loading activity and usage…</FieldNote>
      )}
      {records.rounds && (
        <ol className="m-0 flex list-none flex-col p-0">
          {records.rounds.map((round, index) => <RoundEntry key={round.id} round={round} defaultOpen={index === 0} onLoadEarlierActivity={onLoadEarlierActivity} grants={permissionGrants} />)}
        </ol>
      )}
    </section>
  );
}

function outcomeOf(round: TicketRound): ReactNode {
  switch (round.state) {
    case "delivered":
      return `Delivered by ${round.agent.name}`;
    case "stopped":
      return <StoppedTag data-testid="ticket-detail-round-stopped">Stopped</StoppedTag>;
    case "failed":
      return <FailedTag data-testid="ticket-detail-round-failed">Failed</FailedTag>;
    case "interrupted":
      return <InterruptedTag data-testid="ticket-detail-round-interrupted">Interrupted</InterruptedTag>;
    case "running":
      return "Running";
    case "waiting_for_input":
      return round.questions.every((question) => question.answer !== null) && round.permissionRequests.some((request) => request.decision !== "approved") ? "Waiting for a Permission" : "Waiting for your answer";
    case "claimed":
      return "Claimed, waiting for the runner to start";
  }
}

function RoundEntry({ round, defaultOpen, onLoadEarlierActivity, grants }: { round: TicketRound; defaultOpen: boolean; onLoadEarlierActivity?: LoadEarlierActivity; grants: Ticket["permissionGrants"] }) {
  return (
    <li data-testid="ticket-detail-round" data-round-id={round.id} data-state={round.state}>
      <Disclosure
        defaultOpen={defaultOpen}
        summary={
          <span>
            <span data-testid="ticket-detail-round-number">Round {round.sequence}</span>{" "}
            <span aria-hidden="true">·</span>{" "}
            <span data-testid="ticket-detail-round-state" className="font-normal">{outcomeOf(round)}</span>
          </span>
        }
      >
        <dl className="m-0 mt-2 flex flex-col gap-1">
          <ReceiptLine label="Agent" data-testid="ticket-detail-round-agent">{round.agent.name}</ReceiptLine>
          <ReceiptLine label="Claimed at" data-testid="ticket-detail-round-claimed-at"><LocalTime iso={round.claimedAt} /></ReceiptLine>
          {round.startedAt !== null && <ReceiptLine label="Started at" data-testid="ticket-detail-round-started"><LocalTime iso={round.startedAt} /></ReceiptLine>}
          {round.state === "delivered" && <ReceiptLine label="Delivered at" data-testid="ticket-detail-round-delivered-at">{round.endedAt && <LocalTime iso={round.endedAt} />}</ReceiptLine>}
          {round.state === "stopped" && <ReceiptLine label="Stopped at" data-testid="ticket-detail-round-stopped-at">{round.endedAt && <LocalTime iso={round.endedAt} />}</ReceiptLine>}
          {round.state === "failed" && <ReceiptLine label="Failed at" data-testid="ticket-detail-round-failed-at">{round.endedAt && <LocalTime iso={round.endedAt} />}</ReceiptLine>}
          {round.state === "interrupted" && <ReceiptLine label="Interrupted at" data-testid="ticket-detail-round-interrupted-at">{round.endedAt && <LocalTime iso={round.endedAt} />}</ReceiptLine>}
        </dl>
        {round.limitBreach && round.endedAt === null && (
          <p data-testid="ticket-detail-round-limit-breach" className="my-1 mt-3 font-bold">{limitBreachLabel(round.limitBreach)}</p>
        )}
        {round.outcomeNote !== null && (
          <section aria-label="Outcome" className="mt-3">
            <FieldLabel as="h4">Outcome</FieldLabel>
            {round.state === "failed" && round.limitBreach && (
              <p data-testid="ticket-detail-round-limit-breach" className="my-1 font-bold">{limitBreachLabel(round.limitBreach)}</p>
            )}
            <p data-testid="ticket-detail-round-outcome-note" className="my-1 break-words whitespace-pre-wrap">{round.outcomeNote}</p>
          </section>
        )}
        {round.attestation && <AttestationRecord attestation={round.attestation} />}
        {round.deliverable && <Deliverable deliverable={round.deliverable} />}
        <QuestionHistory questions={round.questions} awaiting={round.state === "waiting_for_input"} />
        <PermissionHistory requests={round.permissionRequests} checks={round.authorityChecks} checkCount={round.authorityCheckCount} awaiting={round.state === "waiting_for_input"} grants={grants} />
        <FeedbackHistory feedback={round.feedback} />
        <RoundRecordDetails round={round} onLoadEarlierActivity={onLoadEarlierActivity} usageLabel={round.state === "claimed" || round.state === "running" || round.state === "waiting_for_input" ? "Usage so far" : "Usage"} />
      </Disclosure>
    </li>
  );
}

function Deliverable({ deliverable }: { deliverable: RoundDeliverable }) {
  return (
    <>
      <section aria-label="Summary" className="mt-3">
        <FieldLabel as="h4">Summary</FieldLabel>
        <p data-testid="ticket-detail-round-summary" className="my-1 break-words whitespace-pre-wrap">{deliverable.summary}</p>
      </section>
      <section aria-label="Criteria assessment" className="mt-3">
        <FieldLabel as="h4">Criteria assessment</FieldLabel>
        <p data-testid="ticket-detail-round-assessment" className="my-1 break-words whitespace-pre-wrap">{deliverable.criteriaAssessment}</p>
      </section>
      <section aria-label="Report" className="mt-3">
        <FieldLabel as="h4">Report</FieldLabel>
        <Markdown data-testid="ticket-detail-round-body" className="mt-1 border border-rule p-3">{deliverable.bodyMarkdown}</Markdown>
      </section>
    </>
  );
}

function mergeNotes(known: RoundActivityNote[], more: RoundActivityNote[]): RoundActivityNote[] {
  const bySeq = new Map(known.map((note) => [note.seq, note]));
  for (const note of more) bySeq.set(note.seq, note);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// A refresh moves Galley's latest-50 window forward, so shown notes are kept; a window that
// skipped past them is back-filled through its own cursor.
function useRoundActivity(round: TicketRound, onLoadEarlierActivity?: LoadEarlierActivity) {
  const [notes, setNotes] = useState(round.activity);
  const [oldestCursor, setOldestCursor] = useState(round.earlierActivityCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef(notes);
  shown.current = notes;

  useEffect(() => {
    const latest = round.activity;
    const newestShown = shown.current.at(-1)?.seq ?? 0;
    setNotes((current) => mergeNotes(current, latest));
    if (shown.current.length === 0) setOldestCursor(round.earlierActivityCursor);
    if (!onLoadEarlierActivity || newestShown === 0 || latest.length === 0 || latest[0].seq <= newestShown + 1) return;
    let cancelled = false;
    void (async () => {
      let cursor = round.earlierActivityCursor;
      while (cursor && !cancelled) {
        const page = await onLoadEarlierActivity(round.id, cursor).catch((failure: unknown) => {
          if (!cancelled) setError(failure instanceof Error ? failure.message : "Unknown error loading earlier activity.");
          return undefined;
        });
        if (!page || cancelled) return;
        setNotes((current) => mergeNotes(current, page.activity));
        cursor = (page.activity[0]?.seq ?? 0) > newestShown + 1 ? page.earlierActivityCursor : null;
      }
    })();
    return () => { cancelled = true; };
  }, [round.activity, round.earlierActivityCursor, round.id, onLoadEarlierActivity]);

  async function loadEarlier() {
    if (!oldestCursor || !onLoadEarlierActivity || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await onLoadEarlierActivity(round.id, oldestCursor);
      setNotes((current) => mergeNotes(current, page.activity));
      setOldestCursor(page.earlierActivityCursor);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unknown error loading earlier activity.");
    } finally {
      setLoading(false);
    }
  }

  return { notes, canLoadEarlier: oldestCursor !== null && onLoadEarlierActivity !== undefined, loadEarlier, loading, error };
}

function RoundRecordDetails({ round, usageLabel, onLoadEarlierActivity }: { round: TicketRound; usageLabel: string; onLoadEarlierActivity?: LoadEarlierActivity }) {
  const activity = useRoundActivity(round, onLoadEarlierActivity);
  return (
    <>
      <section aria-label="Activity" data-testid="ticket-detail-round-activity" className="mt-3">
        <FieldLabel as="h4">Activity</FieldLabel>
        {activity.canLoadEarlier && (
          <SecondaryButton
            size="sm"
            data-testid="ticket-detail-round-load-earlier"
            aria-label={`Load earlier activity for Round ${round.sequence}`}
            disabled={activity.loading}
            onClick={() => void activity.loadEarlier()}
          >
            {activity.loading ? "Loading earlier…" : "Load earlier"}
          </SecondaryButton>
        )}
        {activity.error && (
          <InlineError data-testid="ticket-detail-round-load-earlier-error" className="my-2">Unable to load earlier activity: {activity.error}</InlineError>
        )}
        {activity.notes.length === 0 ? (
          <FieldNote data-testid="ticket-detail-round-activity-empty">No activity yet.</FieldNote>
        ) : (
          <ol className="my-1 flex list-none flex-col gap-1 p-0">
            {activity.notes.map((note) => (
              <li key={note.seq} data-testid="ticket-detail-round-note" data-seq={note.seq} className="mt-0 flex items-baseline gap-3 border-t-0 pt-0">
                <LocalTime iso={note.occurredAt} className="shrink-0 text-label text-muted" />
                <span className="min-w-0 break-words whitespace-pre-wrap">{note.note}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Usage" data-testid="ticket-detail-round-usage" className="mt-3">
        <FieldLabel as="h4">{usageLabel}</FieldLabel>
        <dl className="m-0 mt-1 flex flex-col gap-1">
          <UsageLine label="Cost" testId="ticket-detail-round-usage-cost" figure={costFigure(round.usage)} />
          <UsageLine label="Input tokens" testId="ticket-detail-round-usage-input-tokens" figure={countFigure(round.usage.inputTokens)} />
          <UsageLine label="Output tokens" testId="ticket-detail-round-usage-output-tokens" figure={countFigure(round.usage.outputTokens)} />
          <UsageLine label="Active time" testId="ticket-detail-round-usage-active-time" figure={countFigure(round.usage.activeMs, activeTime)} />
        </dl>
      </section>
    </>
  );
}

function UsageLine({ label, testId, figure }: { label: string; testId: string; figure: UsageFigure }) {
  return (
    <ReceiptLine label={label} data-testid={testId}>
      <span data-unknown={figure.text === "Unknown" || undefined} className="data-unknown:text-muted data-unknown:italic">{figure.text}</span>
      {figure.estimated && (
        <>
          {" "}
          <EstimateTag title="Estimated, not reported by the provider" />
        </>
      )}
    </ReceiptLine>
  );
}
