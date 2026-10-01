import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startClaimLoop } from "./claimLoop.ts";
import { resolveRunnerCredential } from "./credentials.ts";
import type { FetchFn } from "./galley/client.ts";
import { startHeartbeatLoop } from "./heartbeatLoop.ts";
import { createLogger } from "./logger.ts";

const GALLEY = new URL("http://galley.test:8080/");
const TOKEN = `tir_${"e".repeat(43)}`;
const IDENTITY = { michelinVersion: "0.1.0", hostname: "runner-host" };

const CLAIM = {
  roundId: "77777777-7777-4777-8777-777777777777",
  sequence: 2,
  claimEpoch: 1,
  ticket: { id: "88888888-8888-4888-8888-888888888888", title: "Write the report", goal: "g", context: "c", successCriteria: "s", constraints: "", repository: "" },
  agent: { id: "99999999-9999-4999-8999-999999999999", name: "atlas", kind: "research" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const noWork = () => new Response(null, { status: 204 });
const claimed = () => json(CLAIM, 201);
const unauthenticated = () => json({ error: { code: "unauthenticated", message: "sign-in required" } }, 401);
const refused = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" }) });
const hang: FetchFn = (_input, init) =>
  new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

function credential() {
  const resolved = resolveRunnerCredential({ MICHELIN_RUNNER_TOKEN: TOKEN }, []);
  if (!resolved) throw new Error("test credential rejected");
  return resolved;
}

function setup(fetchFn: FetchFn, registered = true) {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const registration = { registered };
  const loop = startClaimLoop({ galleyUrl: GALLEY, intervalMs: 1000, fetch: fetchFn, logger, credential: credential(), registration, requestTimeoutMs: 300 });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { loop, lines, records, registration };
}

function sequence(...responses: (() => Response)[]) {
  return vi.fn<FetchFn>(async (input) => {
    if (new URL(String(input)).pathname !== "/api/runner/claims") throw new Error(`unexpected ${String(input)}`);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (!next) throw new Error("no response queued");
    return next();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("claim loop", () => {
  it("polls with the bearer credential and no body, quietly while Galley has no work", async () => {
    const fetchFn = sequence(noWork);
    const { loop, records } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://galley.test:8080/api/runner/claims");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(init?.body).toBeUndefined();
    expect(records()).toEqual([]);
    await loop.stop();
  });

  it("never claims until registered, and pauses while registration is lost", async () => {
    const fetchFn = sequence(noWork);
    const { loop, registration } = setup(fetchFn, false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).not.toHaveBeenCalled();

    registration.registered = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    registration.registered = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it("logs the claimed Round and stops polling", async () => {
    const fetchFn = sequence(noWork, claimed, noWork);
    const { loop, records } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(2000);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      level: "info",
      msg: "round claimed; claim polling stopped",
      roundId: CLAIM.roundId,
      sequence: 2,
      claimEpoch: 1,
      ticketId: CLAIM.ticket.id,
      ticketTitle: CLAIM.ticket.title,
    });
    expect(Object.keys(records()[0] ?? {})).not.toContain("goal");

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await loop.stop();
  });

  it("logs a rejected credential distinctly and keeps polling", async () => {
    const fetchFn = sequence(unauthenticated, noWork);
    const { loop, records, lines } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(2000);
    expect(records()).toEqual([expect.objectContaining({ level: "error", msg: "runner credential rejected", step: "claim", httpStatus: 401 })]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).not.toContain(TOKEN.slice(4));
    await loop.stop();
  });

  it.each([
    ["an unreachable Galley", (): Response => { throw refused(); }, { reason: "unreachable", code: "ECONNREFUSED" }],
    ["a server error", () => json({ error: { code: "database_unavailable", message: "x" } }, 503), { reason: "http_status", httpStatus: 503 }],
    ["a 200 instead of 201 or 204", () => json(CLAIM, 200), { reason: "http_status", httpStatus: 200 }],
    ["a non-JSON claim", () => new Response("<html>", { status: 201 }), { reason: "invalid_body" }],
    ["a claim without a round id", () => json({ ...CLAIM, roundId: 7 }, 201), { reason: "invalid_body" }],
    ["a claim without a Ticket", () => json({ ...CLAIM, ticket: { id: "x" } }, 201), { reason: "invalid_body" }],
  ])("logs %s as a claim failure and keeps polling", async (_name, respond, expected) => {
    const fetchFn = sequence(respond, noWork);
    const { loop, records } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(2000);
    expect(records()).toEqual([expect.objectContaining({ level: "error", msg: "runner claim failed", ...expected })]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("times out a hung claim and keeps polling", async () => {
    let calls = 0;
    const fetchFn = vi.fn<FetchFn>((input, init) => (++calls === 1 ? hang(input, init) : Promise.resolve(noWork())));
    const { loop, records } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(1000 + 300 + 1000);
    expect(records()).toEqual([expect.objectContaining({ msg: "runner claim failed", reason: "timeout", timeoutMs: 300 })]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("stops cleanly mid-request without logging a failure and leaves no timer", async () => {
    const fetchFn = vi.fn<FetchFn>(hang);
    const { loop, records } = setup(fetchFn);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await loop.stop();
    expect(records()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("claim loop beside the heartbeat loop", () => {
  function both(handlers: Record<string, () => Response>) {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const registration = { registered: false };
    const fetchFn = vi.fn<FetchFn>(async (input) => {
      const handler = handlers[new URL(String(input)).pathname];
      if (!handler) throw new Error(`unexpected ${String(input)}`);
      return handler();
    });
    const common = { galleyUrl: GALLEY, fetch: fetchFn, logger, credential: credential(), registration, requestTimeoutMs: 300 };
    const loops = [
      startHeartbeatLoop({ ...common, intervalMs: 1000, identity: IDENTITY }),
      startClaimLoop({ ...common, intervalMs: 500 }),
    ];
    const paths = () => fetchFn.mock.calls.map(([input]) => new URL(String(input)).pathname);
    const stop = () => Promise.all(loops.map((loop) => loop.stop()));
    return { paths, stop, lines };
  }

  it("claims only after registration succeeds", async () => {
    let accepted = false;
    const { paths, stop } = both({
      "/api/runner/register": () => (accepted ? json({ registeredAt: "t" }) : unauthenticated()),
      "/api/runner/heartbeat": () => json({ lastSeenAt: "t" }),
      "/api/runner/claims": noWork,
    });

    await vi.advanceTimersByTimeAsync(2500);
    expect(paths()).not.toContain("/api/runner/claims");

    accepted = true;
    await vi.advanceTimersByTimeAsync(1000);
    const all = paths();
    expect(all.lastIndexOf("/api/runner/register")).toBeLessThan(all.indexOf("/api/runner/claims"));
    await stop();
  });

  it("keeps heartbeating while claims fail", async () => {
    const { paths, stop } = both({
      "/api/runner/register": () => json({ registeredAt: "t" }),
      "/api/runner/heartbeat": () => json({ lastSeenAt: "t" }),
      "/api/runner/claims": () => json({ error: { code: "database_unavailable", message: "x" } }, 503),
    });

    await vi.advanceTimersByTimeAsync(3000);
    expect(paths().filter((path) => path === "/api/runner/heartbeat")).toHaveLength(3);
    expect(paths().filter((path) => path === "/api/runner/claims").length).toBeGreaterThanOrEqual(5);
    await stop();
  });
});
