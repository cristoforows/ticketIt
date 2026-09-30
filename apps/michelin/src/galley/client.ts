import type { components } from "../api/generated/schema.d.ts";

export type StatusResponse = components["schemas"]["StatusResponse"];

export type StatusFailure =
  | { reason: "unreachable"; error: string; code?: string }
  | { reason: "timeout"; timeoutMs: number }
  | { reason: "http_status"; httpStatus: number }
  | { reason: "invalid_body"; error: string }
  | { reason: "aborted" };

export type StatusResult =
  | { ok: true; status: StatusResponse; durationMs: number }
  | { ok: false; failure: StatusFailure; durationMs: number };

export type FetchFn = typeof fetch;

export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export interface StatusRequest {
  fetch: FetchFn;
  galleyUrl: URL;
  signal: AbortSignal;
  timeoutMs?: number;
}

export async function fetchStatus(request: StatusRequest): Promise<StatusResult> {
  const { fetch: fetchFn, galleyUrl, signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = request;
  const started = performance.now();
  const done = (result: { ok: true; status: StatusResponse } | { ok: false; failure: StatusFailure }): StatusResult => ({
    ...result,
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
    const response = await fetchFn(new URL("api/status", galleyUrl), {
      headers: { accept: "application/json" },
      signal: attempt.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return done({ ok: false, failure: { reason: "http_status", httpStatus: response.status } });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (attempt.signal.aborted) {
        throw error;
      }
      return done({ ok: false, failure: { reason: "invalid_body", error: "response is not valid JSON" } });
    }
    const parsed = parseStatusResponse(body);
    if (typeof parsed === "string") {
      return done({ ok: false, failure: { reason: "invalid_body", error: parsed } });
    }
    return done({ ok: true, status: parsed });
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

function unreachable(error: unknown): StatusFailure {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) && typeof cause["code"] === "string" ? cause["code"] : undefined;
  const nested = cause instanceof AggregateError ? cause.errors[0] : undefined;
  const message = [cause, nested, error]
    .map((candidate) => (candidate instanceof Error ? candidate.message : ""))
    .find((text) => text !== "") ?? code ?? "request failed";
  return { reason: "unreachable", error: message, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
