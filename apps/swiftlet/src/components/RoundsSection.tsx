import type { Ticket } from "../api/tickets";
import type { HealthView } from "./RunnerHealthPill";
import { FieldLabel, ReceiptLine } from "./ui";

export function RoundsSection({ round, runnerHealth }: { round: NonNullable<Ticket["openRound"]>; runnerHealth: HealthView }) {
  const runnerLost = runnerHealth.kind === "loaded" && runnerHealth.health.state !== "connected";
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
    </section>
  );
}
