import type { components } from "./generated/schema";
import { isAgentSummary } from "./agents";
import { authenticatedFetch, GalleyError, isNullableString, parseErrorDetail } from "./http";
import { parsePermissionRequest, parseRoundQuestion, TicketNotFoundError, type PermissionRequest, type RoundQuestion } from "./tickets";

export type TicketRound = components["schemas"]["TicketRound"];
export type RoundActivityNote = components["schemas"]["RoundActivityNote"];
export type RoundUsage = components["schemas"]["RoundUsage"];
export type UsageCount = components["schemas"]["UsageCount"];
export type RoundDeliverable = components["schemas"]["RoundDeliverable"];
export type RoundActivityPage = components["schemas"]["RoundActivityPage"];
export type RoundFeedback = components["schemas"]["RoundFeedback"];
export type RoundAuthorityCheck = components["schemas"]["RoundAuthorityCheck"];
export type RoundAttestation = components["schemas"]["RoundAttestation"];
export type AttestationBasis = components["schemas"]["AttestationBasis"];
export type AttestCessationRequest = components["schemas"]["AttestCessationRequest"];

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

function parseDeliverable(value: unknown): RoundDeliverable | undefined {
  const deliverable = record(value);
  if (!deliverable || typeof deliverable.bodyMarkdown !== "string" || typeof deliverable.summary !== "string" || typeof deliverable.criteriaAssessment !== "string") return undefined;
  return { bodyMarkdown: deliverable.bodyMarkdown, summary: deliverable.summary, criteriaAssessment: deliverable.criteriaAssessment };
}

function parseActivity(value: unknown): RoundActivityNote[] | undefined {
  const notes = Array.isArray(value) ? value.map(parseNote) : undefined;
  return notes?.every((note) => note !== undefined) ? (notes as RoundActivityNote[]) : undefined;
}

const ROUND_STATES: readonly TicketRound["state"][] = ["claimed", "running", "waiting_for_input", "delivered", "stopped", "failed", "interrupted"];

function parseQuestions(value: unknown): RoundQuestion[] | undefined {
  const questions = Array.isArray(value) ? value.map(parseRoundQuestion) : undefined;
  return questions?.every((question) => question !== undefined) ? (questions as RoundQuestion[]) : undefined;
}

function parseFeedbackItem(value: unknown): RoundFeedback | undefined {
  const item = record(value);
  if (!item || typeof item.id !== "string" || typeof item.body !== "string" || typeof item.createdAt !== "string") return undefined;
  if (item.consumedBy === null) return { id: item.id, body: item.body, createdAt: item.createdAt, consumedBy: null };
  const consumer = record(item.consumedBy);
  if (!consumer || typeof consumer.roundId !== "string" || typeof consumer.sequence !== "number") return undefined;
  return { id: item.id, body: item.body, createdAt: item.createdAt, consumedBy: { roundId: consumer.roundId, sequence: consumer.sequence } };
}

function parseFeedback(value: unknown): RoundFeedback[] | undefined {
  const feedback = Array.isArray(value) ? value.map(parseFeedbackItem) : undefined;
  return feedback?.every((item) => item !== undefined) ? (feedback as RoundFeedback[]) : undefined;
}

function parsePermissionRequests(value: unknown): PermissionRequest[] | undefined {
  const requests = Array.isArray(value) ? value.map(parsePermissionRequest) : undefined;
  return requests?.every((request) => request !== undefined) ? (requests as PermissionRequest[]) : undefined;
}

function parseAuthorityCheck(value: unknown): RoundAuthorityCheck | undefined {
  const check = record(value);
  if (
    !check ||
    ![check.account, check.action, check.resource, check.checkedAt].every((field) => typeof field === "string") ||
    !(check.decision === "allow"
      ? typeof check.grantId === "string" && check.expiredGrantId === null
      : check.decision === "deny" && check.grantId === null && (check.expiredGrantId === null || typeof check.expiredGrantId === "string"))
  ) {
    return undefined;
  }
  return {
    account: check.account as string,
    action: check.action as string,
    resource: check.resource as string,
    decision: check.decision as RoundAuthorityCheck["decision"],
    grantId: check.grantId as string | null,
    expiredGrantId: check.expiredGrantId as string | null,
    checkedAt: check.checkedAt as string,
  };
}

function parseAuthorityChecks(value: unknown): RoundAuthorityCheck[] | undefined {
  const checks = Array.isArray(value) ? value.map(parseAuthorityCheck) : undefined;
  return checks?.every((check) => check !== undefined) ? (checks as RoundAuthorityCheck[]) : undefined;
}

const NOTED_STATES: readonly TicketRound["state"][] = ["stopped", "failed", "interrupted"];

const ATTESTATION_BASES: readonly AttestationBasis[] = ["runner_process_ended", "runner_host_off", "other"];
const OPEN_ROUND_STATES: readonly RoundAttestation["roundState"][] = ["claimed", "running", "waiting_for_input"];
const HOLDER_HEALTH: readonly RoundAttestation["holderHealth"][] = ["connected", "disconnected", "replaced", "not_paired"];
const HELD_EXECUTIONS: readonly string[] = ["running", "stopped", "unknown"];

function parseAttestation(value: unknown): RoundAttestation | undefined {
  const attestation = record(value);
  if (
    !attestation ||
    typeof attestation.attestedAt !== "string" ||
    !ATTESTATION_BASES.includes(attestation.basis as AttestationBasis) ||
    !isNullableString(attestation.note) ||
    (attestation.basis === "other" && attestation.note === null) ||
    !OPEN_ROUND_STATES.includes(attestation.roundState as RoundAttestation["roundState"]) ||
    !Number.isSafeInteger(attestation.claimEpoch) ||
    !isNullableString(attestation.holderLastSeenAt) ||
    !HOLDER_HEALTH.includes(attestation.holderHealth as RoundAttestation["holderHealth"]) ||
    !(attestation.reconcileExecution === null || HELD_EXECUTIONS.includes(attestation.reconcileExecution as string))
  ) {
    return undefined;
  }
  return {
    attestedAt: attestation.attestedAt,
    basis: attestation.basis as AttestationBasis,
    note: attestation.note,
    roundState: attestation.roundState as RoundAttestation["roundState"],
    claimEpoch: attestation.claimEpoch as number,
    holderLastSeenAt: attestation.holderLastSeenAt,
    holderHealth: attestation.holderHealth as RoundAttestation["holderHealth"],
    reconcileExecution: attestation.reconcileExecution as RoundAttestation["reconcileExecution"],
  };
}

function parseRound(value: unknown): TicketRound | undefined {
  const round = record(value);
  if (
    !round ||
    typeof round.id !== "string" ||
    typeof round.sequence !== "number" ||
    !ROUND_STATES.includes(round.state as TicketRound["state"]) ||
    !isAgentSummary(round.agent) ||
    typeof round.claimedAt !== "string" ||
    !isNullableString(round.startedAt) ||
    !isNullableString(round.endedAt) ||
    !isNullableString(round.earlierActivityCursor)
  ) {
    return undefined;
  }
  const activity = parseActivity(round.activity);
  const usage = parseUsage(round.usage);
  const deliverable = round.state === "delivered" ? parseDeliverable(round.deliverable) : round.deliverable === null ? null : undefined;
  const outcomeNote = NOTED_STATES.includes(round.state as TicketRound["state"]) ? (typeof round.outcomeNote === "string" ? round.outcomeNote : undefined) : round.outcomeNote === null ? null : undefined;
  const questions = parseQuestions(round.questions);
  const feedback = parseFeedback(round.feedback);
  const permissionRequests = parsePermissionRequests(round.permissionRequests);
  const authorityChecks = parseAuthorityChecks(round.authorityChecks);
  const authorityCheckCount = round.authorityCheckCount;
  const attestation = round.attestation === null ? null : round.state === "interrupted" ? parseAttestation(round.attestation) : undefined;
  if (!usage || deliverable === undefined || outcomeNote === undefined || !activity || !questions || !feedback || !permissionRequests || !authorityChecks || attestation === undefined) return undefined;
  if (!Number.isSafeInteger(authorityCheckCount) || (authorityCheckCount as number) < authorityChecks.length) return undefined;
  const { id, name, kind } = round.agent;
  return {
    id: round.id,
    sequence: round.sequence,
    state: round.state as TicketRound["state"],
    agent: { id, name, kind },
    claimedAt: round.claimedAt,
    startedAt: round.startedAt,
    endedAt: round.endedAt,
    outcomeNote,
    activity,
    earlierActivityCursor: round.earlierActivityCursor,
    usage,
    deliverable,
    questions,
    feedback,
    permissionRequests,
    authorityChecks,
    authorityCheckCount: authorityCheckCount as number,
    attestation,
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

export async function fetchRoundActivity(ticketId: string, roundId: string, before: string): Promise<RoundActivityPage> {
  const response = await authenticatedFetch(`/api/tickets/${encodeURIComponent(ticketId)}/rounds/${encodeURIComponent(roundId)}/activity?before=${encodeURIComponent(before)}`);
  if (response.status === 404) throw new TicketNotFoundError();
  if (!response.ok) throw new Error(`Galley returned an error response: ${response.status} ${response.statusText}`.trim());
  const page = record(await response.json());
  const activity = parseActivity(page?.activity);
  if (!page || !activity || !isNullableString(page.earlierActivityCursor)) {
    throw new Error("Galley's activity page was missing a required field.");
  }
  return { activity, earlierActivityCursor: page.earlierActivityCursor };
}

/** A 404 here names the Ticket or Round together, so Galley's own message is shown. */
export async function attestRoundCessation(ticketId: string, roundId: string, body: AttestCessationRequest): Promise<TicketRound> {
  const path = `/api/tickets/${encodeURIComponent(ticketId)}/rounds/${encodeURIComponent(roundId)}/attest-cessation`;
  const response = await authenticatedFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = parseErrorDetail(record(payload)?.error);
    if (detail) throw new GalleyError(detail);
    throw new Error(`Galley returned an error response: ${response.status} ${response.statusText}`.trim());
  }
  const round = parseRound(payload);
  if (!round) throw new Error("Galley's attested Round was missing a required field.");
  return round;
}
