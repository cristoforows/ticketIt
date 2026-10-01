import type { TicketRound } from "../api/rounds";
import type { Ticket } from "../api/tickets";
import type { HealthView } from "./RunnerHealthPill";
import { activeTime, costFigure, countFigure, type UsageFigure } from "./roundUsage";
import { EstimateTag, FieldLabel, FieldNote, InlineError, Markdown, ReceiptLine } from "./ui";

/** `rounds` is the last list Galley returned; `error` is the latest refresh's failure. */
export interface RoundRecords {
  rounds?: TicketRound[];
  error?: string;
}

export function RoundsSection({ openRound, runnerHealth, records = {} }: { openRound: Ticket["openRound"]; runnerHealth: HealthView; records?: RoundRecords }) {
  const runnerLost = openRound !== null && runnerHealth.kind === "loaded" && runnerHealth.health.state !== "connected";
  const openRecord = openRound === null ? undefined : records.rounds?.find((candidate) => candidate.id === openRound.id);
  const delivered = records.rounds?.filter((candidate) => candidate.state === "delivered") ?? [];
  return (
    <section aria-label="Rounds" data-testid="ticket-detail-rounds">
      <FieldLabel as="h3">Rounds</FieldLabel>
      {runnerLost && (
        <p role="status" data-testid="ticket-detail-runner-disconnected" className="my-2 border-2 border-status-blocked-deep p-2 text-status-blocked-deep">
          <span className="font-bold tracking-label uppercase">Runner disconnected</span> Lost contact does not mean the Round stopped. It stays open and the Ticket stays locked.
        </p>
      )}
      {openRound !== null && (
        <dl className="m-0 flex flex-col gap-1">
          <ReceiptLine label="Round" data-testid="ticket-detail-round-number">{openRound.sequence}</ReceiptLine>
          <ReceiptLine label="Agent" data-testid="ticket-detail-round-agent">{openRound.agent.name}</ReceiptLine>
          {openRound.startedAt === null ? (
            <ReceiptLine label="State" data-testid="ticket-detail-round-waiting">Claimed, waiting for the runner to start</ReceiptLine>
          ) : (
            <ReceiptLine label="Started" data-testid="ticket-detail-round-started">{openRound.startedAt}</ReceiptLine>
          )}
        </dl>
      )}
      {records.error && (
        <InlineError data-testid="ticket-detail-round-records-error" className="my-2">
          Unable to refresh activity and usage: {records.error}
        </InlineError>
      )}
      {records.rounds === undefined || (openRound !== null && openRecord === undefined) ? (
        !records.error && <FieldNote data-testid="ticket-detail-round-records-loading">Loading activity and usage…</FieldNote>
      ) : (
        openRecord && <RoundRecordDetails round={openRecord} testIdPrefix="ticket-detail-round" usageLabel="Usage so far" />
      )}
      {delivered.length > 0 && (
        <ol aria-label="Delivered Rounds" className="m-0 flex list-none flex-col p-0">
          {delivered.map((round) => <DeliveredRound key={round.id} round={round} />)}
        </ol>
      )}
    </section>
  );
}

function DeliveredRound({ round }: { round: TicketRound }) {
  const deliverable = round.deliverable!;
  return (
    <li data-testid="ticket-detail-delivered-round" data-round-id={round.id} className="mt-4 border-t border-dashed border-rule pt-3">
      <dl className="m-0 flex flex-col gap-1">
        <ReceiptLine label="Round" data-testid="ticket-detail-delivered-number">{round.sequence}</ReceiptLine>
        <ReceiptLine label="Delivered by" data-testid="ticket-detail-delivered-agent">{round.agent.name}</ReceiptLine>
        <ReceiptLine label="Delivered" data-testid="ticket-detail-delivered-at">{round.endedAt}</ReceiptLine>
      </dl>
      <section aria-label="Summary" className="mt-3">
        <FieldLabel as="h4">Summary</FieldLabel>
        <p data-testid="ticket-detail-delivered-summary" className="my-1 break-words whitespace-pre-wrap">{deliverable.summary}</p>
      </section>
      <section aria-label="Criteria assessment" className="mt-3">
        <FieldLabel as="h4">Criteria assessment</FieldLabel>
        <p data-testid="ticket-detail-delivered-assessment" className="my-1 break-words whitespace-pre-wrap">{deliverable.criteriaAssessment}</p>
      </section>
      <section aria-label="Report" className="mt-3">
        <FieldLabel as="h4">Report</FieldLabel>
        <Markdown data-testid="ticket-detail-delivered-body" className="mt-1 border border-rule p-3">{deliverable.bodyMarkdown}</Markdown>
      </section>
      <RoundRecordDetails round={round} testIdPrefix="ticket-detail-delivered" usageLabel="Usage" />
    </li>
  );
}

function RoundRecordDetails({ round, testIdPrefix, usageLabel }: { round: TicketRound; testIdPrefix: string; usageLabel: string }) {
  return (
    <>
      <section aria-label="Activity" data-testid={`${testIdPrefix}-activity`} className="mt-3">
        <FieldLabel as="h4">Activity</FieldLabel>
        {round.activity.length === 0 ? (
          <FieldNote data-testid={`${testIdPrefix}-activity-empty`}>No activity yet.</FieldNote>
        ) : (
          <ol className="my-1 flex list-none flex-col gap-1 p-0">
            {round.activity.map((note) => (
              <li key={note.seq} data-testid={`${testIdPrefix}-note`} className="mt-0 flex items-baseline gap-3 border-t-0 pt-0">
                <time dateTime={note.occurredAt} className="shrink-0 text-label text-muted">{note.occurredAt}</time>
                <span className="min-w-0 break-words whitespace-pre-wrap">{note.note}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Usage" data-testid={`${testIdPrefix}-usage`} className="mt-3">
        <FieldLabel as="h4">{usageLabel}</FieldLabel>
        <dl className="m-0 mt-1 flex flex-col gap-1">
          <UsageLine label="Cost" testId={`${testIdPrefix}-usage-cost`} figure={costFigure(round.usage)} />
          <UsageLine label="Input tokens" testId={`${testIdPrefix}-usage-input-tokens`} figure={countFigure(round.usage.inputTokens)} />
          <UsageLine label="Output tokens" testId={`${testIdPrefix}-usage-output-tokens`} figure={countFigure(round.usage.outputTokens)} />
          <UsageLine label="Active time" testId={`${testIdPrefix}-usage-active-time`} figure={countFigure(round.usage.activeMs, activeTime)} />
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
