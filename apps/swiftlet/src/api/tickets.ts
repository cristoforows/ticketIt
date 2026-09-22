/**
 * `./generated/schema` comes from contracts/openapi.yaml -- see
 * src/api/status.ts and src/api/session.ts for the regeneration/
 * drift-check convention this file follows too.
 */
import type { components } from "./generated/schema";
import { UnauthenticatedError } from "./session";

export type Ticket = components["schemas"]["Ticket"];

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

type FetchLike = Pick<Response, "ok" | "status" | "statusText" | "json">;

/**
 * Every Ticket call is authenticated (Galley requires a valid session
 * for both operations -- docs/adr/0001-single-authority-galley.md),
 * so this mirrors src/api/session.ts's authenticatedFetch exactly: a
 * 401 always throws UnauthenticatedError, the one signal this app
 * treats as "return to the sign-in page."
 */
async function authenticatedFetch(path: string, init?: RequestInit): Promise<FetchLike> {
  let response: FetchLike;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    throw new Error("Galley is unreachable.", { cause });
  }
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  return response;
}

function parseTicket(payload: unknown): Ticket {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Galley's response body was not a JSON object.");
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.status !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    throw new Error("Galley's Ticket response was missing a required field.");
  }
  return {
    id: record.id,
    title: record.title,
    status: record.status as Ticket["status"],
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

/** Galley's error.message, when the body matches the shared error shape -- undefined otherwise. */
function errorMessage(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const error = (payload as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}

/**
 * Fetches the signed-in Owner's Tickets, in the order Galley returns
 * them (newest first, apps/galley/README.md's "Ticket ordering").
 * Throws on every failure -- unreachable, 401, non-2xx, or an
 * off-contract shape -- so callers render an explicit state rather
 * than a partial or stale list.
 */
export async function fetchTickets(): Promise<Ticket[]> {
  const response = await authenticatedFetch(TICKETS_ENDPOINT);
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

/**
 * Captures a Ticket from a title alone. Galley owns trimming and
 * validation (apps/galley/internal/httpapi/ticket.go); this surfaces
 * Galley's own rejection message (e.g. a blank or over-length title)
 * rather than a generic status line, since the caller is a form the
 * Owner is actively filling in.
 */
export async function createTicket(title: string): Promise<Ticket> {
  const response = await authenticatedFetch(TICKETS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
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
