import type { TicketRound } from "../api/rounds";
import type { Ticket } from "../api/tickets";
import type { HealthView } from "./RunnerHealthPill";
import { activeTime, costFigure, countFigure, type UsageFigure } from "./roundUsage";
import { EstimateTag, FieldLabel, FieldNote, InlineError, ReceiptLine } from "./ui";

/** `rounds` is the last list Galley returned; `error` is the latest refresh's failure. */
export interface RoundRecords {
  rounds?: TicketRound[];
  error?: string;
}

export function RoundsSection({ round, runnerHealth, records = {} }: { round: NonNullable<Ticket["openRound"]>; runnerHealth: HealthView; records?: RoundRecords }) {
  const runnerLost = runnerHealth.kind === "loaded" && runnerHealth.health.state !== "connected";
  const record = records.rounds?.find((candidate) => candidate.id === round.id);
  return (
    <section aria-label="Rounds" data-testid="ticket-detail-rounds">
      <FieldLabel as="h3">Rounds</FieldLabel>
      {runnerLost && (
        <p role="status" data-testid="ticket-detail-runner-disconnected" className="my-2 border-2 border-status-blocked-deep p-2 text-status-blocked-deep">
          <span className="font-bold tracking-label uppercase">Runner disconnected</span> Lost contact does not mean the Round stopped. It stays open and the Ticket stays locked.
        </p>
      )}
      <dl className="m-0 flex flex-col gap-1">
        <ReceiptLine label="Round" data-testid="ticket-detail-round-number">{round.sequence}</ReceiptLine>
        <ReceiptLine label="Agent" data-testid="ticket-detail-round-agent">{round.agent.name}</ReceiptLine>
        {round.startedAt === null ? (
          <ReceiptLine label="State" data-testid="ticket-detail-round-waiting">Claimed, waiting for the runner to start</ReceiptLine>
        ) : (
          <ReceiptLine label="Started" data-testid="ticket-detail-round-started">{round.startedAt}</ReceiptLine>
        )}
      </dl>
      {records.error && (
        <InlineError data-testid="ticket-detail-round-records-error" className="my-2">
          Unable to refresh activity and usage: {records.error}
        </InlineError>
      )}
      {record === undefined ? (
        !records.error && <FieldNote data-testid="ticket-detail-round-records-loading">Loading activity and usage…</FieldNote>
      ) : (
        <>
          <section aria-label="Activity" data-testid="ticket-detail-round-activity" className="mt-3">
            <FieldLabel as="h4">Activity</FieldLabel>
            {record.activity.length === 0 ? (
              <FieldNote data-testid="ticket-detail-round-activity-empty">No activity yet.</FieldNote>
            ) : (
              <ol className="my-1 flex list-none flex-col gap-1 p-0">
                {record.activity.map((note) => (
                  <li key={note.seq} data-testid="ticket-detail-round-note" className="mt-0 flex items-baseline gap-3 border-t-0 pt-0">
                    <time dateTime={note.occurredAt} className="shrink-0 text-label text-muted">{note.occurredAt}</time>
                    <span className="min-w-0 break-words whitespace-pre-wrap">{note.note}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label="Usage" data-testid="ticket-detail-round-usage" className="mt-3">
            <FieldLabel as="h4">Usage so far</FieldLabel>
            <dl className="m-0 mt-1 flex flex-col gap-1">
              <UsageLine label="Cost" testId="cost" figure={costFigure(record.usage)} />
              <UsageLine label="Input tokens" testId="input-tokens" figure={countFigure(record.usage.inputTokens)} />
              <UsageLine label="Output tokens" testId="output-tokens" figure={countFigure(record.usage.outputTokens)} />
              <UsageLine label="Active time" testId="active-time" figure={countFigure(record.usage.activeMs, activeTime)} />
            </dl>
          </section>
        </>
      )}
    </section>
  );
}

function UsageLine({ label, testId, figure }: { label: string; testId: string; figure: UsageFigure }) {
  return (
    <ReceiptLine label={label} data-testid={`ticket-detail-round-usage-${testId}`}>
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
