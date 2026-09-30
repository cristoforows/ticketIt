import { UnauthenticatedError } from "./session";

type FetchLike = Pick<Response, "ok" | "status" | "statusText" | "json">;

/**
 * Every Ticket, Badge and Agent call is authenticated (Galley requires
 * a valid session -- docs/adr/0001-single-authority-galley.md), so this
 * mirrors src/api/session.ts's authenticatedFetch exactly: a 401 always
 * throws UnauthenticatedError, the one signal this app treats as
 * "return to the sign-in page."
 */
export async function authenticatedFetch(path: string, init?: RequestInit): Promise<FetchLike> {
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

/** Galley's error.message, when the body matches the shared error shape -- undefined otherwise. */
export function errorMessage(payload: unknown): string | undefined {
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
