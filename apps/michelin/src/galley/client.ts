import type { components } from "../api/generated/schema.d.ts";

export type StatusResponse = components["schemas"]["StatusResponse"];

export type TransportFailure =
  | { reason: "unreachable"; error: string; code?: string }
  | { reason: "timeout"; timeoutMs: number }
  | { reason: "aborted" };

export type StatusFailure =
  | TransportFailure
  | { reason: "http_status"; httpStatus: number }
  | { reason: "invalid_body"; error: string };

export type Outcome<T, F> = { ok: true; value: T } | { ok: false; failure: F };

export type Timed<O> = O & { durationMs: number };

export type StatusResult =
  | { ok: true; status: StatusResponse; durationMs: number }
  | { ok: false; failure: StatusFailure; durationMs: number };

export type FetchFn = typeof fetch;

export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export interface GalleyRequest {
  fetch: FetchFn;
  galleyUrl: URL;
  signal: AbortSignal;
  timeoutMs?: number;
}

export type StatusRequest = GalleyRequest;

export async function callGalley<T, F>(
  request: GalleyRequest,
  path: string,
  init: RequestInit,
  handle: (response: Response, readJson: () => Promise<unknown>) => Promise<Outcome<T, F>>,
): Promise<Timed<Outcome<T, F | TransportFailure>>> {
  const { fetch: fetchFn, galleyUrl, signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = request;
  const started = performance.now();
  const done = (outcome: Outcome<T, F | TransportFailure>): Timed<Outcome<T, F | TransportFailure>> => ({
    ...outcome,
    durationMs: Math.round(performance.now() - started),
  });

  const attempt = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    attempt.abort();
  }, timeoutMs);
  const onShutdown = (): void => attempt.abort();
  signal.addEventListener("abort", onShutdown, { once: true });
  if (signal.aborted) {
    attempt.abort();
  }

  try {
    const response = await fetchFn(new URL(path, galleyUrl), { ...init, signal: attempt.signal });
    const readJson = async (): Promise<unknown> => {
      try {
        return await response.json();
      } catch (error) {
        if (attempt.signal.aborted) {
          throw error;
        }
        return INVALID_JSON;
      }
    };
    return done(await handle(response, readJson));
  } catch (error) {
    if (timedOut) {
      return done({ ok: false, failure: { reason: "timeout", timeoutMs } });
    }
    if (signal.aborted) {
      return done({ ok: false, failure: { reason: "aborted" } });
    }
    return done({ ok: false, failure: unreachable(error) });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onShutdown);
  }
}

export const INVALID_JSON: unique symbol = Symbol("invalid JSON");

export async function fetchStatus(request: StatusRequest): Promise<StatusResult> {
  const result = await callGalley<StatusResponse, StatusFailure>(
    request,
    "api/status",
    { headers: { accept: "application/json" } },
    async (response, readJson) => {
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, failure: { reason: "http_status", httpStatus: response.status } };
      }
      const body = await readJson();
      if (body === INVALID_JSON) {
        return { ok: false, failure: { reason: "invalid_body", error: "response is not valid JSON" } };
      }
      const parsed = parseStatusResponse(body);
      if (typeof parsed === "string") {
        return { ok: false, failure: { reason: "invalid_body", error: parsed } };
      }
      return { ok: true, value: parsed };
    },
  );
  return result.ok
    ? { ok: true, status: result.value, durationMs: result.durationMs }
    : { ok: false, failure: result.failure, durationMs: result.durationMs };
}

function unreachable(error: unknown): TransportFailure {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) && typeof cause["code"] === "string" ? cause["code"] : undefined;
  const nested = cause instanceof AggregateError ? cause.errors[0] : undefined;
  const message = [cause, nested, error]
    .map((candidate) => (candidate instanceof Error ? candidate.message : ""))
    .find((text) => text !== "") ?? code ?? "request failed";
  return { reason: "unreachable", error: message, code };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStatusResponse(body: unknown): StatusResponse | string {
  if (!isRecord(body)) {
    return "body is not a JSON object";
  }
  const { application, status, version, environment, startedAt, database } = body;
  if (application !== "galley") {
    return "application is not galley";
  }
  if (status !== "ok") {
    return "status is not ok";
  }
  if (typeof version !== "string") {
    return "version is not a string";
  }
  if (environment !== "development" && environment !== "production") {
    return "environment is not development or production";
  }
  if (typeof startedAt !== "string") {
    return "startedAt is not a string";
  }
  if (!isRecord(database)) {
    return "database is not an object";
  }
  const { status: dbStatus, migrationVersion, error } = database;
  if (dbStatus !== "ok" && dbStatus !== "error") {
    return "database.status is not ok or error";
  }
  if (migrationVersion !== null && typeof migrationVersion !== "number") {
    return "database.migrationVersion is not a number or null";
  }
  if (error !== undefined && typeof error !== "string") {
    return "database.error is not a string";
  }
  return {
    application,
    status,
    version,
    environment,
    startedAt,
    database: { status: dbStatus, migrationVersion, error },
  };
}
