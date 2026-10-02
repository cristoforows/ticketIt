import type { ReactNode } from "react";
import type { RoundDeliverable, TicketRound } from "../api/rounds";
import type { Ticket } from "../api/tickets";
import type { HealthView } from "./RunnerHealthPill";
import { activeTime, costFigure, countFigure, type UsageFigure } from "./roundUsage";
import { Disclosure, EstimateTag, FieldLabel, FieldNote, InlineError, Markdown, ReceiptLine, StoppedTag } from "./ui";

/** `rounds` is the last list Galley returned; `error` is the latest refresh's failure. */
export interface RoundRecords {
  rounds?: TicketRound[];
  error?: string;
}

export function RoundsSection({ openRound, runnerHealth, records = {} }: { openRound: Ticket["openRound"]; runnerHealth: HealthView; records?: RoundRecords }) {
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
          {records.rounds.map((round, index) => <RoundEntry key={round.id} round={round} defaultOpen={index === 0} />)}
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
    case "running":
      return "Running";
    case "claimed":
      return "Claimed, waiting for the runner to start";
  }
}

function RoundEntry({ round, defaultOpen }: { round: TicketRound; defaultOpen: boolean }) {
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
          <ReceiptLine label="Claimed at" data-testid="ticket-detail-round-claimed-at">{round.claimedAt}</ReceiptLine>
          {round.startedAt !== null && <ReceiptLine label="Started at" data-testid="ticket-detail-round-started">{round.startedAt}</ReceiptLine>}
          {round.state === "delivered" && <ReceiptLine label="Delivered at" data-testid="ticket-detail-round-delivered-at">{round.endedAt}</ReceiptLine>}
          {round.state === "stopped" && <ReceiptLine label="Stopped at" data-testid="ticket-detail-round-stopped-at">{round.endedAt}</ReceiptLine>}
        </dl>
        {round.outcomeNote !== null && (
          <section aria-label="Outcome" className="mt-3">
            <FieldLabel as="h4">Outcome</FieldLabel>
            <p data-testid="ticket-detail-round-outcome-note" className="my-1 break-words whitespace-pre-wrap">{round.outcomeNote}</p>
          </section>
        )}
        {round.deliverable && <Deliverable deliverable={round.deliverable} />}
        <RoundRecordDetails round={round} usageLabel={round.state === "delivered" || round.state === "stopped" ? "Usage" : "Usage so far"} />
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

function RoundRecordDetails({ round, usageLabel }: { round: TicketRound; usageLabel: string }) {
  return (
    <>
      <section aria-label="Activity" data-testid="ticket-detail-round-activity" className="mt-3">
        <FieldLabel as="h4">Activity</FieldLabel>
        {round.activity.length === 0 ? (
          <FieldNote data-testid="ticket-detail-round-activity-empty">No activity yet.</FieldNote>
        ) : (
          <ol className="my-1 flex list-none flex-col gap-1 p-0">
            {round.activity.map((note) => (
              <li key={note.seq} data-testid="ticket-detail-round-note" className="mt-0 flex items-baseline gap-3 border-t-0 pt-0">
                <time dateTime={note.occurredAt} className="shrink-0 text-label text-muted">{note.occurredAt}</time>
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
