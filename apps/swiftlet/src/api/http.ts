import type { components } from "./generated/schema";
import { UnauthenticatedError } from "./session";

export type ErrorDetail = components["schemas"]["ErrorDetail"];
export type ReadinessInput = components["schemas"]["AgentReadinessInput"];

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

export const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

const READINESS_INPUTS = { goal: true, successCriteria: true, repository: true } as const satisfies Record<ReadinessInput, true>;

function isReadinessInput(value: unknown): value is ReadinessInput {
  return typeof value === "string" && Object.hasOwn(READINESS_INPUTS, value);
}

/** Galley's ErrorDetail, or undefined when the value is off-contract. */
export function parseErrorDetail(value: unknown): ErrorDetail | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.message !== "string") return undefined;
  if (record.missing === undefined) return { code: record.code, message: record.message };
  const missing: unknown = record.missing;
  if (!Array.isArray(missing) || !missing.every(isReadinessInput)) return undefined;
  return { code: record.code, message: record.message, missing };
}

/** A rejected command, carrying Galley's own code and any missing readiness inputs. */
export class GalleyError extends Error {
  readonly code: string;
  readonly missing: ReadinessInput[];

  constructor(detail: ErrorDetail) {
    super(detail.message);
    this.name = "GalleyError";
    this.code = detail.code;
    this.missing = detail.missing ?? [];
  }
}

export function missingInputsOf(error: unknown): ReadinessInput[] {
  return error instanceof GalleyError ? error.missing : [];
}
