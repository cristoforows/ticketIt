import type { components } from "./generated/schema";
import { isAgentSummary } from "./agents";
import { authenticatedFetch, isNullableString } from "./http";
import { TicketNotFoundError } from "./tickets";

export type TicketRound = components["schemas"]["TicketRound"];
export type RoundActivityNote = components["schemas"]["RoundActivityNote"];
export type RoundUsage = components["schemas"]["RoundUsage"];
export type UsageCount = components["schemas"]["UsageCount"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseNote(value: unknown): RoundActivityNote | undefined {
  const note = record(value);
  if (!note || typeof note.seq !== "number" || typeof note.note !== "string" || typeof note.occurredAt !== "string") return undefined;
  return { seq: note.seq, note: note.note, occurredAt: note.occurredAt };
}

function parseCount(value: unknown): UsageCount | undefined {
  const count = record(value);
  if (!count || !(count.sum === null || typeof count.sum === "number") || typeof count.complete !== "boolean" || typeof count.estimated !== "boolean") return undefined;
  return { sum: count.sum, complete: count.complete, estimated: count.estimated };
}

function parseUsage(value: unknown): RoundUsage | undefined {
  const usage = record(value);
  if (!usage || typeof usage.observations !== "number" || typeof usage.complete !== "boolean" || typeof usage.estimated !== "boolean" || !isNullableString(usage.costUsd)) return undefined;
  const inputTokens = parseCount(usage.inputTokens);
  const outputTokens = parseCount(usage.outputTokens);
  const activeMs = parseCount(usage.activeMs);
  if (!inputTokens || !outputTokens || !activeMs) return undefined;
  return { observations: usage.observations, complete: usage.complete, estimated: usage.estimated, costUsd: usage.costUsd, inputTokens, outputTokens, activeMs };
}

function parseRound(value: unknown): TicketRound | undefined {
  const round = record(value);
  if (
    !round ||
    typeof round.id !== "string" ||
    typeof round.sequence !== "number" ||
    (round.state !== "claimed" && round.state !== "running") ||
    !isAgentSummary(round.agent) ||
    typeof round.claimedAt !== "string" ||
    !isNullableString(round.startedAt) ||
    !isNullableString(round.endedAt) ||
    !Array.isArray(round.activity)
  ) {
    return undefined;
  }
  const activity = round.activity.map(parseNote);
  const usage = parseUsage(round.usage);
  if (!usage || !activity.every((note) => note !== undefined)) return undefined;
  const { id, name, kind } = round.agent;
  return {
    id: round.id,
    sequence: round.sequence,
    state: round.state,
    agent: { id, name, kind },
    claimedAt: round.claimedAt,
    startedAt: round.startedAt,
    endedAt: round.endedAt,
    activity: activity as RoundActivityNote[],
    usage,
  };
}

export async function fetchTicketRounds(ticketId: string): Promise<TicketRound[]> {
  const response = await authenticatedFetch(`/api/tickets/${encodeURIComponent(ticketId)}/rounds`);
  if (response.status === 404) throw new TicketNotFoundError();
  if (!response.ok) throw new Error(`Galley returned an error response: ${response.status} ${response.statusText}`.trim());
  const rounds = record(await response.json())?.rounds;
  const parsed = Array.isArray(rounds) ? rounds.map(parseRound) : undefined;
  if (!parsed || !parsed.every((round) => round !== undefined)) {
    throw new Error("Galley's Round list was missing a required field.");
  }
  return parsed as TicketRound[];
}
