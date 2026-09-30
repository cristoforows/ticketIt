import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRunnerCredential } from "./credentials.ts";
import type { FetchFn } from "./galley/client.ts";
import { startHeartbeatLoop } from "./heartbeatLoop.ts";
import { createLogger } from "./logger.ts";

const GALLEY = new URL("http://galley.test:8080/");
const TOKEN = `tir_${"b".repeat(43)}`;
const IDENTITY = { michelinVersion: "0.1.0", hostname: "runner-host" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const unauthenticated = () => json({ error: { code: "unauthenticated", message: "sign-in required" } }, 401);
const notRegistered = () => json({ error: { code: "runner_not_registered", message: "register first" } }, 409);

function setup(fetchFn: FetchFn) {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const credential = resolveRunnerCredential({ MICHELIN_RUNNER_TOKEN: TOKEN }, []);
  if (!credential) throw new Error("test credential rejected");
  const loop = startHeartbeatLoop({ galleyUrl: GALLEY, intervalMs: 1000, fetch: fetchFn, logger, credential, identity: IDENTITY, requestTimeoutMs: 300 });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { loop, lines, records };
}

function routes(handlers: Record<string, () => Response | Promise<Response>>) {
  return vi.fn<FetchFn>(async (input) => {
    const path = new URL(String(input)).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected ${path}`);
    return handler();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("heartbeat loop", () => {
  it("registers on start with the bearer credential, then heartbeats on the interval", async () => {
    const fetchFn = routes({
      "/api/runner/register": () => json({ registeredAt: "2026-10-01T12:00:00Z" }),
      "/api/runner/heartbeat": () => json({ lastSeenAt: "2026-10-01T12:00:01Z" }),
    });
    const { loop, records, lines } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://galley.test:8080/api/runner/register");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual(IDENTITY);
    expect(records()[0]).toMatchObject({ level: "info", msg: "runner registered", registeredAt: "2026-10-01T12:00:00Z", ...IDENTITY });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/api/runner/register",
      "/api/runner/heartbeat",
      "/api/runner/heartbeat",
    ]);
    expect(records()[1]).toMatchObject({ level: "info", msg: "runner heartbeat ok", lastSeenAt: "2026-10-01T12:00:01Z" });
    await loop.stop();
    expect(lines.join("\n")).not.toContain(TOKEN.slice(4));
  });

  it("logs a rejected credential distinctly, keeps running, and retries registration", async () => {
    const fetchFn = routes({ "/api/runner/register": unauthenticated });
    const { loop, records, lines } = setup(fetchFn);
    await vi.advanceTimersByTimeAsync(0);
    expect(records()[0]).toMatchObject({ level: "error", msg: "runner credential rejected", step: "register", httpStatus: 401 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(records()).toHaveLength(2);
    await loop.stop();
    expect(lines.join("\n")).not.toContain(TOKEN.slice(4));
  });

  it("falls back to registering after a revoked credential fails a heartbeat", async () => {
    let revoked = false;
    const fetchFn = routes({
      "/api/runner/register": () => (revoked ? unauthenticated() : json({ registeredAt: "2026-10-01T12:00:00Z" })),
      "/api/runner/heartbeat": unauthenticated,
    });
    const { loop, records } = setup(fetchFn);
    await vi.advanceTimersByTimeAsync(0);
    revoked = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(records()[1]).toMatchObject({ level: "error", msg: "runner credential rejected", step: "heartbeat" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(records()[2]).toMatchObject({ msg: "runner credential rejected", step: "register" });
    await loop.stop();
  });

  it("re-registers at once when Galley reports the runner unregistered", async () => {
    const fetchFn = routes({
      "/api/runner/register": () => json({ registeredAt: "2026-10-01T12:00:00Z" }),
      "/api/runner/heartbeat": notRegistered,
    });
    const { loop, records } = setup(fetchFn);
    await vi.advanceTimersByTimeAsync(1000);
    expect(records().map((record) => record["msg"])).toEqual([
      "runner registered",
      "runner not registered with galley; registering again",
      "runner registered",
    ]);
    await loop.stop();
  });

  it("logs an unreachable Galley distinctly and keeps retrying", async () => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" }) });
    let up = false;
    const fetchFn = vi.fn<FetchFn>(async (input) => {
      if (!up) throw refused;
      return new URL(String(input)).pathname.endsWith("register") ? json({ registeredAt: "t" }) : json({ lastSeenAt: "t" });
    });
    const { loop, records } = setup(fetchFn);
    await vi.advanceTimersByTimeAsync(0);
    expect(records()[0]).toMatchObject({ level: "error", msg: "runner register failed", reason: "unreachable", code: "ECONNREFUSED" });
    up = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(records()[1]).toMatchObject({ msg: "runner registered" });
    up = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(records()[2]).toMatchObject({ level: "error", msg: "runner heartbeat failed", reason: "unreachable" });
    up = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(records()[3]).toMatchObject({ msg: "runner heartbeat ok" });
    expect(fetchFn.mock.calls.filter(([input]) => String(input).endsWith("/register"))).toHaveLength(2);
    await loop.stop();
  });

  it.each([
    ["an unreachable Galley", "unreachable"],
    ["a server error", "http_status"],
    ["a non-JSON body", "invalid_body"],
    ["a timeout", "timeout"],
  ])("keeps heartbeating, without registering again, after %s", async (_name, reason) => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" }) });
    let heartbeats = 0;
    const fetchFn = vi.fn<FetchFn>(async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("register")) return json({ registeredAt: "t" });
      heartbeats += 1;
      if (heartbeats > 1) return json({ lastSeenAt: "t" });
      if (reason === "unreachable") throw refused;
      if (reason === "http_status") return json({ error: { code: "database_unavailable", message: "x" } }, 503);
      if (reason === "invalid_body") return new Response("<html>", { status: 200 });
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const { loop, records } = setup(fetchFn);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000 + 300);
    expect(records()[1]).toMatchObject({ level: "error", msg: "runner heartbeat failed", reason });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/api/runner/register",
      "/api/runner/heartbeat",
      "/api/runner/heartbeat",
    ]);
    expect(records()[2]).toMatchObject({ msg: "runner heartbeat ok" });
    await loop.stop();
  });

  it.each([
    ["server error", () => json({ error: { code: "database_unavailable", message: "x" } }, 503), { reason: "http_status", httpStatus: 503 }],
    ["conflict without the not-registered code", () => json({ error: { code: "other", message: "x" } }, 409), { reason: "http_status", httpStatus: 409 }],
    ["non-JSON success", () => new Response("<html>", { status: 200 }), { reason: "invalid_body" }],
    ["success without registeredAt", () => json({}), { reason: "invalid_body" }],
  ])("classifies a %s", async (_name, respond, expected) => {
    const { loop, records } = setup(routes({ "/api/runner/register": respond }));
    await vi.advanceTimersByTimeAsync(0);
    expect(records()[0]).toMatchObject({ level: "error", msg: "runner register failed", ...expected });
    await loop.stop();
  });

  it("times out a hung request", async () => {
    const fetchFn = vi.fn<FetchFn>(
      (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const { loop, records } = setup(fetchFn);
    await vi.advanceTimersByTimeAsync(300);
    expect(records()[0]).toMatchObject({ msg: "runner register failed", reason: "timeout", timeoutMs: 300 });
    await loop.stop();
  });

  it("stops cleanly mid-request without logging a failure and leaves no timer", async () => {
    const fetchFn = vi.fn<FetchFn>(
      (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const { loop, records } = setup(fetchFn);
    await vi.advanceTimersByTimeAsync(0);
    await loop.stop();
    expect(records()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
