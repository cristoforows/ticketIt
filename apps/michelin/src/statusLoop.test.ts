import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchFn } from "./galley/client.ts";
import { createLogger } from "./logger.ts";
import { startStatusLoop } from "./statusLoop.ts";

const GALLEY = new URL("http://galley.test:8080/");

const okBody = {
  application: "galley",
  status: "ok",
  version: "dev",
  environment: "development",
  startedAt: "2026-09-30T10:00:00Z",
  database: { status: "ok", migrationVersion: 12 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(fetchFn: FetchFn, overrides: { requestTimeoutMs?: number } = {}) {
  const records: Record<string, unknown>[] = [];
  const logger = createLogger((line) => records.push(JSON.parse(line) as Record<string, unknown>));
  const loop = startStatusLoop({ galleyUrl: GALLEY, intervalMs: 1000, fetch: fetchFn, logger, ...overrides });
  return { loop, records };
}

function hangingFetch(): FetchFn {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("status loop", () => {
  it("checks on start and then on every interval, logging success", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(okBody));
    const { loop, records } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("http://galley.test:8080/api/status");
    expect(records[0]).toMatchObject({
      level: "info",
      msg: "galley status ok",
      version: "dev",
      environment: "development",
      databaseStatus: "ok",
      migrationVersion: 12,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("warns when Galley is up but its database is not", async () => {
    const body = { ...okBody, database: { status: "error", migrationVersion: null, error: "database unreachable" } };
    const { loop, records } = setup(async () => json(body));
    await vi.advanceTimersByTimeAsync(0);
    expect(records[0]).toMatchObject({ level: "warn", databaseStatus: "error", databaseError: "database unreachable" });
    await loop.stop();
  });

  it("logs connection refused as unreachable with the OS error code", async () => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" }) });
    const { loop, records } = setup(async () => {
      throw refused;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(records[0]).toMatchObject({
      level: "error",
      msg: "galley status check failed",
      reason: "unreachable",
      code: "ECONNREFUSED",
      error: "connect ECONNREFUSED 127.0.0.1:8080",
    });
    await loop.stop();
  });

  it("logs a non-2xx response with its status", async () => {
    const { loop, records } = setup(async () => json({ error: "x" }, 503));
    await vi.advanceTimersByTimeAsync(0);
    expect(records[0]).toMatchObject({ level: "error", reason: "http_status", httpStatus: 503 });
    await loop.stop();
  });

  it.each([
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["wrong application", () => json({ ...okBody, application: "other" })],
    ["missing database", () => json({ ...okBody, database: undefined })],
  ])("logs a 2xx with a bad body (%s) as invalid_body", async (_name, respond) => {
    const { loop, records } = setup(async () => respond());
    await vi.advanceTimersByTimeAsync(0);
    expect(records[0]).toMatchObject({ level: "error", reason: "invalid_body" });
    await loop.stop();
  });

  it("times out a hung request, then keeps checking", async () => {
    const fetchFn = vi.fn<FetchFn>(hangingFetch());
    const { loop, records } = setup(fetchFn, { requestTimeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    expect(records[0]).toMatchObject({ level: "error", reason: "timeout", timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("never overlaps checks: the next waits for a slow one plus the interval", async () => {
    let release: (() => void) | undefined;
    const fetchFn = vi.fn<FetchFn>(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(okBody));
        }),
    );
    const { loop } = setup(fetchFn, { requestTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    release?.();
    await loop.stop();
  });

  describe("stop", () => {
    it("aborts the in-flight request without logging a failure", async () => {
      let signal: AbortSignal | null | undefined;
      const fetchFn: FetchFn = (_input, init) => {
        signal = init?.signal;
        return hangingFetch()(_input, init);
      };
      const { loop, records } = setup(fetchFn);
      await vi.advanceTimersByTimeAsync(0);
      await loop.stop();
      expect(signal?.aborted).toBe(true);
      expect(records).toEqual([]);
    });

    it("clears the pending interval timer so no further check runs", async () => {
      const fetchFn = vi.fn<FetchFn>(async () => json(okBody));
      const { loop } = setup(fetchFn);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      await loop.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("is safe to call twice", async () => {
      const { loop } = setup(async () => json(okBody));
      await vi.advanceTimersByTimeAsync(0);
      await loop.stop();
      await loop.stop();
    });
  });
});
