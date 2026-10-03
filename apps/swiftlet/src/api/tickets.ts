/**
 * `./generated/schema` comes from contracts/openapi.yaml -- see
 * src/api/status.ts and src/api/session.ts for the regeneration/
 * drift-check convention this file follows too.
 */
import type { components } from "./generated/schema";
import { isAgentSummary } from "./agents";
import { authenticatedFetch, errorMessage, GalleyError, parseErrorDetail } from "./http";

export type Ticket = components["schemas"]["Ticket"];
export type Badge = components["schemas"]["Badge"];
export type TicketAssignee = components["schemas"]["AssignTicketRequest"];
export type RoundQuestion = components["schemas"]["RoundQuestion"];

/**
 * Manual refinement (issue #58): a genuine partial update. A field
 * absent from the object leaves Galley's stored value unchanged; a
 * field present as "" clears it (title excepted -- Galley rejects
 * clearing title); a field present with text is trimmed and stored.
 * This is why every property here is optional (`?:`), not just typed
 * `string` -- `JSON.stringify` omits an `undefined` property entirely,
 * which is what lets this app send "leave unchanged" and "clear" as
 * genuinely different request bodies. See
 * apps/galley/internal/httpapi/ticket.go's UpdateTicket for the
 * server-side half of this same rule.
 */
export type TicketUpdate = components["schemas"]["UpdateTicketRequest"];

export type TicketDetails = Omit<components["schemas"]["CreateTicketRequest"], "title" | "template">;

const TICKETS_ENDPOINT = "/api/tickets";

/**
 * Mirrors apps/galley/internal/httpapi/ticket.go's ticketTitleMaxLength.
 * Galley is the authority that actually enforces this (a mismatch here
 * would only change when the rejection message appears, never whether
 * it does); this exists so the capture form's own input attribute has
 * one documented source instead of a second, undocumented magic number.
 */
export const TICKET_TITLE_MAX_LENGTH = 200;

/**
 * Thrown by fetchTicket on a 404 (contracts/openapi.yaml's getTicket:
 * an unknown identifier, a malformed one, and one belonging to another
 * Owner are all this same response -- see
 * apps/galley/internal/httpapi/ticket.go). Mirrors
 * src/api/session.ts's UnauthenticatedError: one distinguished error
 * type per signal a caller must render an explicit state for, rather
 * than string-matching a generic Error's message.
 */
export class TicketNotFoundError extends Error {
  constructor() {
    super("Galley reported no ticket with that identifier.");
    this.name = "TicketNotFoundError";
  }
}

type WaitingReason = NonNullable<Ticket["openRound"]>["waitingReason"];
const WAITING_REASONS: readonly WaitingReason[] = ["starting", "working", "waiting_for_answer", "resuming", "stopping", "runner_disconnected"];
type OpenRoundState = NonNullable<Ticket["openRound"]>["state"];
const OPEN_ROUND_STATES: readonly OpenRoundState[] = ["claimed", "running", "waiting_for_input"];

export function parseRoundQuestion(value: unknown): RoundQuestion | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const question = value as Record<string, unknown>;
  if (
    typeof question.id !== "string" ||
    typeof question.text !== "string" ||
    typeof question.askedAt !== "string" ||
    !(question.answer === null || typeof question.answer === "string") ||
    !(question.answeredAt === null || typeof question.answeredAt === "string") ||
    (question.answer === null) !== (question.answeredAt === null)
  ) {
    return undefined;
  }
  return { id: question.id, text: question.text, askedAt: question.askedAt, answer: question.answer, answeredAt: question.answeredAt };
}

function parseOpenRound(value: unknown): Ticket["openRound"] | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const round = value as Record<string, unknown>;
  if (
    typeof round.id !== "string" ||
    typeof round.sequence !== "number" ||
    !OPEN_ROUND_STATES.includes(round.state as OpenRoundState) ||
    !isAgentSummary(round.agent) ||
    typeof round.claimedAt !== "string" ||
    (round.state !== "claimed") !== (typeof round.startedAt === "string") ||
    !(round.startedAt === null || typeof round.startedAt === "string") ||
    !(round.stopRequestedAt === null || typeof round.stopRequestedAt === "string") ||
    !WAITING_REASONS.includes(round.waitingReason as WaitingReason)
  ) {
    return undefined;
  }
  const question = round.state === "waiting_for_input" ? parseRoundQuestion(round.question) : round.question === null ? null : undefined;
  if (question === undefined) {
    return undefined;
  }
  const agent = round.agent;
  return {
    id: round.id,
    sequence: round.sequence,
    state: round.state as OpenRoundState,
    agent: { id: agent.id, name: agent.name, kind: agent.kind },
    claimedAt: round.claimedAt,
    startedAt: round.startedAt,
    stopRequestedAt: round.stopRequestedAt,
    waitingReason: round.waitingReason as WaitingReason,
    question,
  };
}

function parseDelivery(value: unknown): Ticket["delivery"] | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const delivery = value as Record<string, unknown>;
  if (typeof delivery.roundId !== "string" || typeof delivery.sequence !== "number" || !isAgentSummary(delivery.agent) || typeof delivery.deliveredAt !== "string") {
    return undefined;
  }
  const agent = delivery.agent;
  return { roundId: delivery.roundId, sequence: delivery.sequence, agent: { id: agent.id, name: agent.name, kind: agent.kind }, deliveredAt: delivery.deliveredAt };
}

function parseCommandAvailability(value: unknown): Ticket["allowedActions"]["rework"] | undefined {
  const availability = value as Record<string, unknown> | null | undefined;
  if (typeof availability !== "object" || availability === null || typeof availability.available !== "boolean") {
    return undefined;
  }
  if (availability.available) {
    return availability.reason === undefined ? { available: true } : undefined;
  }
  const reason = parseErrorDetail(availability.reason);
  return reason && { available: false, reason };
}

function parseTicket(payload: unknown): Ticket {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Galley's response body was not a JSON object.");
  }
  const record = payload as Record<string, unknown>;
  const actions = record.allowedActions as Record<string, unknown> | undefined;
  const accept = parseCommandAvailability(actions?.accept);
  const rework = parseCommandAvailability(actions?.rework);
  const stop = parseCommandAvailability(actions?.stop);
  const answer = parseCommandAvailability(actions?.answer);
  const agent = record.assigneeAgent;
  const openRound = parseOpenRound(record.openRound);
  const delivery = parseDelivery(record.delivery);
  const rejections = Array.isArray(actions?.statusChangeRejections)
    ? actions.statusChangeRejections.map((rejection: unknown) => {
      const entry = rejection as Record<string, unknown> | null;
      const detail = parseErrorDetail(entry?.reason);
      return typeof entry?.status === "string" && detail ? { status: entry.status as Ticket["status"], reason: detail } : undefined;
    })
    : undefined;
  if (
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.status !== "string" ||
    typeof record.template !== "string" ||
    typeof record.completionCondition !== "string" ||
    typeof record.assigneeType !== "string" ||
    !(agent === null || isAgentSummary(agent)) ||
    typeof record.requestingAgentWork !== "boolean" ||
    openRound === undefined ||
    delivery === undefined ||
    typeof record.goal !== "string" ||
    typeof record.context !== "string" ||
    typeof record.successCriteria !== "string" ||
    typeof record.constraints !== "string" ||
    typeof record.repository !== "string" ||
    !(record.archivedAt === null || typeof record.archivedAt === "string") ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !Array.isArray(record.badges) ||
    !record.badges.every((badge: unknown) => typeof badge === "object" && badge !== null &&
      typeof (badge as Record<string, unknown>).id === "string" &&
      typeof (badge as Record<string, unknown>).name === "string") ||
    !actions ||
    typeof actions !== "object" ||
    !Array.isArray(actions.statusChanges) ||
    !actions.statusChanges.every((status: unknown) => typeof status === "string") ||
    !rejections ||
    !rejections.every((rejection) => rejection !== undefined) ||
    !accept ||
    !rework ||
    !stop ||
    !answer
  ) {
    throw new Error("Galley's Ticket response was missing a required field.");
  }
  return {
    id: record.id,
    title: record.title,
    status: record.status as Ticket["status"],
    allowedActions: {
      statusChanges: actions.statusChanges as Ticket["status"][],
      statusChangeRejections: rejections as Ticket["allowedActions"]["statusChangeRejections"],
      accept,
      rework,
      stop,
      answer,
    },
    template: record.template as Ticket["template"],
    completionCondition: record.completionCondition as Ticket["completionCondition"],
    assigneeType: record.assigneeType as Ticket["assigneeType"],
    assigneeAgent: agent === null ? null : { id: agent.id, name: agent.name, kind: agent.kind },
    requestingAgentWork: record.requestingAgentWork,
    openRound,
    delivery,
    badges: record.badges as Ticket["badges"],
    archivedAt: record.archivedAt,
    goal: record.goal,
    context: record.context,
    successCriteria: record.successCriteria,
    constraints: record.constraints,
    repository: record.repository,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function parseTicketList(payload: unknown): Ticket[] {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Galley's response body was not a JSON object.");
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.tickets)) {
    throw new Error('Galley\'s response was missing array field "tickets".');
  }
  return record.tickets.map(parseTicket);
}

/**
 * Fetches the signed-in Owner's Tickets, in the order Galley returns
 * them (apps/galley/README.md's "Ticket ordering").
 * Throws on every failure -- unreachable, 401, non-2xx, or an
 * off-contract shape -- so callers render an explicit state rather
 * than a partial or stale list.
 */
export async function fetchTickets(badgeIds: string[] = [], archived = false): Promise<Ticket[]> {
  const query = new URLSearchParams();
  if (archived) query.set("archived", "true");
  badgeIds.forEach((id) => query.append("badgeId", id));
  const response = await authenticatedFetch(`${TICKETS_ENDPOINT}${query.size ? `?${query}` : ""}`);
  if (!response.ok) {
    throw new Error(
      `Galley returned an error response: ${response.status} ${response.statusText}`.trim(),
    );
  }
  const payload: unknown = await response.json();
  return parseTicketList(payload);
}

/**
 * Fetches one Ticket by its opaque public identifier (issue #57).
 * Throws TicketNotFoundError on Galley's shared 404 -- which covers an
 * unknown identifier, a malformed one, and one belonging to another
 * Owner alike, by design (docs/adr/0001-single-authority-galley.md) --
 * and a plain Error for every other failure, matching fetchTickets's
 * own convention.
 */
export async function fetchTicket(id: string): Promise<Ticket> {
  const response = await authenticatedFetch(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}`);
  if (response.status === 404) {
    throw new TicketNotFoundError();
  }
  if (!response.ok) {
    throw new Error(
      `Galley returned an error response: ${response.status} ${response.statusText}`.trim(),
    );
  }
  const payload: unknown = await response.json();
  return parseTicket(payload);
}

/** The two built-in Ticket Templates (issue #59, docs/ticket-creation.md). Basic is the default when none is chosen. */
export const TICKET_TEMPLATES: Ticket["template"][] = ["Basic", "Coding"];

/**
 * Captures a Ticket from a title, optionally naming a Template
 * (issue #59) and the manual refinement fields -- the Template
 * defaults to Basic when omitted, exactly like Galley's own
 * CreateTicketRequest.template. A title alone remains
 * sufficient to capture either Template (docs/ticket-creation.md,
 * "Quick capture"); completionCondition is derived from the chosen
 * Template's default by Galley, once, at creation, and is never sent
 * by this app. Galley owns trimming and validation
 * (apps/galley/internal/httpapi/ticket.go); this surfaces Galley's own
 * rejection message (e.g. a blank or over-length title) rather than a
 * generic status line, since the caller is a form the Owner is
 * actively filling in.
 */
export async function createTicket(title: string, template: Ticket["template"] = "Basic", details: TicketDetails = {}): Promise<Ticket> {
  const filled = Object.fromEntries(Object.entries(details).filter(([, value]) => (value ?? "").trim() !== ""));
  const response = await authenticatedFetch(TICKETS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, template, ...filled }),
  });
  if (!response.ok) {
    const payload: unknown = await response.json();
    throw new Error(
      errorMessage(payload) ??
        `Galley returned an error response: ${response.status} ${response.statusText}`.trim(),
    );
  }
  const payload: unknown = await response.json();
  return parseTicket(payload);
}

/**
 * Shared response handling for every id-scoped Ticket command below
 * (issue #61) plus updateTicket: Galley's shared 404 becomes
 * TicketNotFoundError except for Badge attachment, whose 404 can mean
 * either a missing Ticket or a missing Badge. Any other non-2xx becomes an Error carrying
 * Galley's own message verbatim (never a friendlier substitute -- see
 * docs/adr/0001-single-authority-galley.md), and success parses the
 * returned Ticket the same way every other call in this file already
 * does.
 */
async function ticketCommand(path: string, init?: RequestInit, notFound: "ticket" | "response" = "ticket"): Promise<Ticket> {
  const response = await authenticatedFetch(path, init);
  if (response.status === 404 && notFound === "ticket") {
    throw new TicketNotFoundError();
  }
  if (!response.ok) {
    const payload: unknown = await response.json();
    const detail = parseErrorDetail((payload as { error?: unknown } | null)?.error);
    if (detail) throw new GalleyError(detail);
    throw new Error(`Galley returned an error response: ${response.status} ${response.statusText}`.trim());
  }
  const payload: unknown = await response.json();
  return parseTicket(payload);
}

/**
 * Manual refinement (issue #58): a genuine partial update, sent
 * exactly as the caller built it -- this function trims nothing and
 * fills in no default, since only Galley owns those rules
 * (docs/adr/0001-single-authority-galley.md). On rejection this
 * surfaces Galley's own error message (e.g. an over-length field or an
 * attempt to clear the title) rather than a generic status line, the
 * same way createTicket does, since the caller is a form the Owner is
 * actively editing. Throws TicketNotFoundError on Galley's shared 404,
 * matching fetchTicket.
 */
export async function updateTicket(id: string, update: TicketUpdate): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
}

/**
 * A human-assigned lifecycle transition (issue #61, D3 S2): a plain
 * Status write. Galley alone decides whether (current, target) is
 * permitted, validated against the Ticket's own persisted current
 * Status -- this function submits the command and renders whichever
 * outcome Galley returns; it never predicts success, retries, or
 * substitutes its own wording for a rejection
 * (docs/adr/0001-single-authority-galley.md).
 */
export async function changeTicketStatus(id: string, status: Ticket["status"]): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

/**
 * Accept (issue #61): the one path to Done, kept a separate command
 * from changeTicketStatus per
 * docs/contracts/execution-interface.md's owner-command boundary.
 * Completes only a Ticket that is In Review with a retained
 * humanAcceptance condition; every other case -- wrong Status, or a
 * reviewedPrMerge condition -- is Galley's own rejection, shown
 * verbatim by the caller.
 */
export async function acceptTicket(id: string): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}/accept`, { method: "POST" });
}

export async function requestTicketRework(id: string): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}/rework`, { method: "POST" });
}

export async function requestTicketStop(id: string): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}/stop`, { method: "POST" });
}

/** A 404 here names the Ticket, Round or question together, so Galley's own message is shown. */
export async function answerRoundQuestion(id: string, roundId: string, questionId: string, answer: string): Promise<Ticket> {
  const path = `${TICKETS_ENDPOINT}/${encodeURIComponent(id)}/rounds/${encodeURIComponent(roundId)}/questions/${encodeURIComponent(questionId)}/answer`;
  return ticketCommand(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer }) }, "response");
}

/** An Agent id Galley cannot find for this Owner shares the Ticket's 404, so its message is shown rather than "not found". */
export async function assignTicket(id: string, assignee: TicketAssignee): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}/assignee`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(assignee),
  }, assignee.type === "agent" ? "response" : "ticket");
}

/** Clears a Ticket's Assignee (issue #61). Idempotent, matching Galley's own DELETE semantics. */
export async function unassignTicket(id: string): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}/assignee`, { method: "DELETE" });
}

export async function fetchBadges(): Promise<Badge[]> {
  const response = await authenticatedFetch("/api/badges");
  if (!response.ok) {
    const payload: unknown = await response.json();
    throw new Error(errorMessage(payload) ?? `Galley returned ${response.status} ${response.statusText}`);
  }
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { badges?: unknown }).badges)) {
    throw new Error("Galley's Badge list was missing badges.");
  }
  const badges = (payload as { badges: unknown[] }).badges;
  if (!badges.every((badge) => typeof badge === "object" && badge !== null &&
    typeof (badge as Record<string, unknown>).id === "string" &&
    typeof (badge as Record<string, unknown>).name === "string" &&
    typeof (badge as Record<string, unknown>).createdAt === "string")) {
    throw new Error("Galley's Badge list contained an invalid Badge.");
  }
  return badges as Badge[];
}

export async function createBadge(name: string): Promise<Badge> {
  const response = await authenticatedFetch("/api/badges", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(errorMessage(payload) ?? `Galley returned ${response.status} ${response.statusText}`);
  if (typeof payload !== "object" || payload === null ||
    typeof (payload as Badge).id !== "string" || typeof (payload as Badge).name !== "string" ||
    typeof (payload as Badge).createdAt !== "string") {
    throw new Error("Galley's Badge response was missing a required field.");
  }
  return payload as Badge;
}

export async function attachTicketBadge(ticketId: string, badgeId: string): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(ticketId)}/badges/${encodeURIComponent(badgeId)}`, { method: "PUT" }, "response");
}

export async function detachTicketBadge(ticketId: string, badgeId: string): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(ticketId)}/badges/${encodeURIComponent(badgeId)}`, { method: "DELETE" }, "response");
}

export async function archiveTicket(id: string): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}/archive`, { method: "POST" });
}

export async function restoreTicket(id: string): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

export type TicketPlacement = { before: string } | { after: string };

export async function reorderTicket(id: string, placement: TicketPlacement): Promise<Ticket> {
  return ticketCommand(`${TICKETS_ENDPOINT}/${encodeURIComponent(id)}/position`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(placement),
  });
}
