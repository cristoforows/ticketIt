/**
 * `./generated/schema` comes from contracts/openapi.yaml — see
 * src/api/status.ts for the regeneration/drift-check convention this
 * file follows too. `Owner`/`SessionResponse` were added by issue #54;
 * this file is the first Swiftlet source to consume them.
 */
import type { components } from "./generated/schema";

export type Owner = components["schemas"]["Owner"];
export type SessionResponse = components["schemas"]["SessionResponse"];

const SESSION_ENDPOINT = "/api/session";

/**
 * Thrown whenever Galley answers 401 to an authenticated call
 * (contracts/openapi.yaml's shared `unauthenticated` code). Every
 * caller in this app treats this the same way: return to the sign-in
 * page, never a generic error state.
 */
export class UnauthenticatedError extends Error {
  constructor() {
    super("Galley reported no active session.");
    this.name = "UnauthenticatedError";
  }
}

type FetchLike = Pick<Response, "ok" | "status" | "statusText" | "json">;

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

function parseSessionResponse(payload: unknown): SessionResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Galley's response body was not a JSON object.");
  }

  const record = payload as Record<string, unknown>;
  const owner = record.owner;
  if (typeof owner !== "object" || owner === null) {
    throw new Error('Galley\'s response was missing object field "owner".');
  }

  const ownerRecord = owner as Record<string, unknown>;
  if (typeof ownerRecord.id !== "number" || typeof ownerRecord.login !== "string") {
    throw new Error('Galley\'s response\'s "owner" was missing "id" or "login".');
  }

  return { owner: { id: ownerRecord.id, login: ownerRecord.login } };
}

/**
 * Fetches the signed-in Owner. Throws UnauthenticatedError on 401 (no
 * session) and a plain Error for every other failure — unreachable,
 * non-2xx, or an off-contract shape — so callers render an explicit
 * state rather than guessing, matching fetchGalleyStatus's convention.
 */
export async function fetchSession(): Promise<SessionResponse> {
  const response = await authenticatedFetch(SESSION_ENDPOINT);

  if (!response.ok) {
    throw new Error(
      `Galley returned an error response: ${response.status} ${response.statusText}`.trim(),
    );
  }

  const payload: unknown = await response.json();
  return parseSessionResponse(payload);
}

/**
 * Revokes the current session through Galley. A 401 here means Galley
 * already considers the caller signed out — treated as success, since
 * there is nothing left to revoke.
 */
export async function signOut(): Promise<void> {
  let response: FetchLike;
  try {
    response = await authenticatedFetch(SESSION_ENDPOINT, { method: "DELETE" });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return;
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(
      `Galley returned an error response: ${response.status} ${response.statusText}`.trim(),
    );
  }
}
