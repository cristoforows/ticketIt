import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startClaimLoop } from "./claimLoop.ts";
import { resolveRunnerCredential } from "./credentials.ts";
import type { EngineScript } from "./engineScript.ts";
import type { FetchFn } from "./galley/client.ts";
import { reconcile } from "./galley/runner.ts";
import { newRegistration, requireReconcile } from "./heartbeatLoop.ts";
import { createLogger } from "./logger.ts";
import { Reconciler, type HeldRoundState } from "./reconciler.ts";

const GALLEY = new URL("http://galley.test:8080/");
const TOKEN = `tir_${"f".repeat(43)}`;
const ROUND = "77777777-7777-4777-8777-777777777777";
const STOP_ID = "44444444-4444-4444-8444-444444444444";
const CLAIM = {
  roundId: ROUND,
  sequence: 1,
  claimEpoch: 3,
  ticket: { id: "88888888-8888-4888-8888-888888888888", title: "t", goal: "g", context: "c", successCriteria: "s", constraints: "", repository: "", feedback: [] },
  agent: { id: "99999999-9999-4999-8999-999999999999", name: "atlas", kind: "research" as const },
};
const STOP = { id: STOP_ID, type: "stop", claimEpoch: 3, issuedAt: "2026-10-01T12:00:00Z" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function credential() {
  const resolved = resolveRunnerCredential({ MICHELIN_RUNNER_TOKEN: TOKEN }, []);
  if (!resolved) throw new Error("test credential rejected");
  return resolved;
}

type Disposition = "continue" | "stop" | "report_cessation" | "hold";

function reconciled(disposition: Disposition, extra: Record<string, unknown> = {}) {
  return () => json({ round: { roundId: ROUND, state: "running", ticketStatus: "InProgress", claimEpoch: 3, disposition, commands: disposition === "stop" ? [STOP] : [], ...extra } });
}
const noRound = () => json({ round: null });
const noWork = () => new Response(null, { status: 204 });

const END: Record<string, string> = { delivered: "delivered", stop_confirmed: "stopped", interrupted: "interrupted", failed: "failed" };

function eventResponse(body: string): Response {
  const event = JSON.parse(body) as { type: string; data: Record<string, unknown> };
  const state = END[event.type] ?? (event.type === "question_raised" ? "waiting_for_input" : "running");
  return json(
    {
      roundId: ROUND,
      type: event.type,
      state,
      startedAt: "2026-10-01T12:00:00Z",
      ...(END[event.type] ? { endedAt: "2026-10-01T12:00:09Z" } : {}),
      ...(event.type === "progress" ? { seq: 1 } : {}),
      ...(event.type === "question_raised" ? { questionId: event.data["questionId"] } : {}),
    },
    201,
  );
}

interface Call {
  path: string;
  body?: unknown;
}

function galley(handlers: { reconcile?: (() => Response)[]; claims?: (() => Response)[]; commands?: () => Response; check?: (() => Response)[] }) {
  const calls: Call[] = [];
  const take = (queue: (() => Response)[] | undefined, fallback: () => Response) => {
    if (!queue || queue.length === 0) return fallback();
    return (queue.length > 1 ? queue.shift()! : queue[0]!)();
  };
  const fetchFn = vi.fn<FetchFn>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ path, body: raw === undefined ? undefined : JSON.parse(raw) });
    if (path === "/api/runner/reconcile") return take(handlers.reconcile, noRound);
    if (path === "/api/runner/claims") return take(handlers.claims, () => new Response(null, { status: 204 }));
    if (path === `/api/runner/rounds/${ROUND}/commands`) return (handlers.commands ?? (() => json({ commands: [] })))();
    if (path === `/api/runner/rounds/${ROUND}/events`) return eventResponse(raw!);
    if (path === `/api/runner/rounds/${ROUND}/authority-checks`) return take(handlers.check, () => json({ decision: "allow", grantId: "g" }));
    if (path.startsWith(`/api/runner/rounds/${ROUND}/commands/`) && path.endsWith("/ack")) {
      return json({ id: path.split("/")[6], outcome: (JSON.parse(raw!) as { outcome: string }).outcome, acknowledgedAt: "2026-10-01T12:00:10Z" });
    }
    throw new Error(`unexpected ${path}`);
  });
  const of = (path: string) => calls.filter((call) => call.path === path);
  const events = () => of(`/api/runner/rounds/${ROUND}/events`).map((call) => (call.body as { type: string }).type);
  const reconciles = () => of("/api/runner/reconcile").map((call) => call.body);
  const order = () => calls.map((call) => (call.path === `/api/runner/rounds/${ROUND}/events` ? `event:${(call.body as { type: string }).type}` : call.path.replace(`/api/runner/rounds/${ROUND}/`, "")));
  return { fetchFn, calls, of, events, reconciles, order };
}

function setup(fetchFn: FetchFn, script: EngineScript, commandIntervalMs = 1_000_000) {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const registration = { ...newRegistration(), registered: true };
  const loop = startClaimLoop({ galleyUrl: GALLEY, intervalMs: 1000, commandIntervalMs, fetch: fetchFn, logger, credential: credential(), registration, requestTimeoutMs: 300, engineScript: script });
  const messages = () => lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
  return { loop, registration, messages, lines };
}

const held = (execution: string) => ({ held: [{ roundId: ROUND, claimEpoch: 3, execution }] });
const START_ASK: EngineScript = { steps: [{ step: "start" }, { step: "ask", question: "Which?" }, { step: "progress", note: "after" }] };
const START_PROGRESS: EngineScript = { steps: [{ step: "start" }, { step: "wait", ms: 5000 }, { step: "progress", note: "next" }, { step: "deliver", bodyMarkdown: "# D", summary: "s", criteriaAssessment: "c" }] };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reconcile client", () => {
  const request = () => ({ fetch: undefined as unknown as FetchFn, galleyUrl: GALLEY, signal: new AbortController().signal, credential: credential() });
  const one = { roundId: ROUND, claimEpoch: 3, execution: "running" as const };

  it("posts what it holds and parses each disposition", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => reconciled("report_cessation", { cessationEvent: "interrupted" })());
    const result = await reconcile({ ...request(), fetch: fetchFn }, [one]);
    expect(result).toMatchObject({ ok: true, value: { roundId: ROUND, claimEpoch: 3, disposition: "report_cessation", cessationEvent: "interrupted", commands: [] } });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("http://galley.test:8080/api/runner/reconcile");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ held: [one] });
    const none = await reconcile({ ...request(), fetch: vi.fn<FetchFn>(async () => noRound()) }, []);
    expect(none).toMatchObject({ ok: true, value: null });
  });

  it.each([
    ["a null round for a held Round", noRound, [one]],
    ["another Round", () => json({ round: { roundId: "x", claimEpoch: 3, disposition: "continue", commands: [] } }), [one]],
    ["another epoch", () => json({ round: { roundId: ROUND, claimEpoch: 4, disposition: "continue", commands: [] } }), [one]],
    ["an unknown disposition", () => json({ round: { roundId: ROUND, claimEpoch: 3, disposition: "resume", commands: [] } }), [one]],
    ["a cessation without its event", reconciled("report_cessation"), [one]],
    ["an event without a cessation", reconciled("continue", { cessationEvent: "interrupted" }), [one]],
    ["an unknown cessation event", reconciled("report_cessation", { cessationEvent: "delivered" }), [one]],
    ["commands that are not a list", reconciled("continue", { commands: null }), [one]],
    ["a non-hold disposition while holding nothing", reconciled("continue"), []],
    ["a body without round", () => json({}), []],
    ["a non-JSON body", () => new Response("<html>", { status: 200 }), []],
  ])("refuses %s as invalid_body", async (_name, respond, sent) => {
    const result = await reconcile({ ...request(), fetch: vi.fn<FetchFn>(async () => respond()) }, sent);
    expect(result).toMatchObject({ ok: false, failure: { reason: "invalid_body" } });
  });

  it("carries Galley's error code", async () => {
    const result = await reconcile({ ...request(), fetch: vi.fn<FetchFn>(async () => json({ error: { code: "stale_claim_epoch", message: "x" } }, 409)) }, [one]);
    expect(result).toMatchObject({ ok: false, failure: { reason: "http_status", httpStatus: 409, errorCode: "stale_claim_epoch" } });
  });
});

describe("Reconciler", () => {
  function reconciler(responses: (() => Response)[], state?: Partial<HeldRoundState>) {
    const registration = { ...newRegistration(), registered: true };
    requireReconcile(registration);
    const fetchFn = vi.fn<FetchFn>(async () => (responses.length > 1 ? responses.shift()! : responses[0]!)());
    const lines: string[] = [];
    const r = new Reconciler({ galleyUrl: GALLEY, fetch: fetchFn, logger: createLogger((line) => lines.push(line)), credential: credential(), registration, signal: new AbortController().signal });
    const onStop = vi.fn();
    const onDrop = vi.fn();
    if (state !== undefined) {
      r.hold({ claim: CLAIM, execution: () => "running", onStop, onDrop, ...state });
    }
    return { r, registration, fetchFn, onStop, onDrop, lines };
  }

  it("asks Galley nothing while no Reconcile is owed", async () => {
    const { r, registration, fetchFn } = reconciler([reconciled("continue")], {});
    registration.reconcileRequired = false;
    expect(await r.gate()).toEqual({ kind: "proceed" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["continue", reconciled("continue"), { kind: "proceed" }, false, 0, 0],
    ["stop", reconciled("stop"), { kind: "stop" }, false, 1, 0],
    ["report_cessation", reconciled("report_cessation", { cessationEvent: "stop_confirmed" }), { kind: "cessation", event: "stop_confirmed" }, true, 0, 0],
    ["hold", reconciled("hold"), { kind: "drop" }, true, 0, 1],
    ["a 409", () => json({ error: { code: "round_not_open", message: "x" } }, 409), { kind: "drop" }, true, 0, 1],
    ["a 404", () => json({ error: { code: "not_found", message: "x" } }, 404), { kind: "drop" }, true, 0, 1],
  ] as const)("gates on %s", async (_name, respond, gate, stillRequired, stops, drops) => {
    const { r, registration, onStop, onDrop } = reconciler([respond], {});
    expect(await r.gate()).toEqual(gate);
    expect(registration.reconcileRequired).toBe(stillRequired);
    expect(onStop).toHaveBeenCalledTimes(stops);
    if (stops > 0) expect(onStop.mock.calls[0]?.[0]).toMatchObject({ id: STOP_ID, type: "stop" });
    expect(onDrop).toHaveBeenCalledTimes(drops);
  });

  it("clears the flag on round null", async () => {
    const { r, registration, fetchFn } = reconciler([noRound]);
    expect(await r.reconcile()).toEqual({ kind: "none" });
    expect(registration.reconcileRequired).toBe(false);
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({ held: [] });
  });

  it("reports what the engine believes", async () => {
    const { r, fetchFn } = reconciler([reconciled("report_cessation", { cessationEvent: "interrupted" })], { execution: () => "stopped" });
    await r.reconcile();
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual(held("stopped"));
  });

  it("keeps the flag when it was raised again while the Reconcile was in flight", async () => {
    let answer: (response: Response) => void = () => {};
    const registration = { ...newRegistration(), registered: true };
    requireReconcile(registration);
    const fetchFn = vi.fn<FetchFn>(() => new Promise((resolve) => (answer = resolve)));
    const r = new Reconciler({ galleyUrl: GALLEY, fetch: fetchFn, logger: createLogger(() => {}), credential: credential(), registration, signal: new AbortController().signal });
    r.hold({ claim: CLAIM, execution: () => "running", onStop: vi.fn(), onDrop: vi.fn() });
    const pending = r.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    requireReconcile(registration);
    answer(reconciled("continue")());
    expect(await pending).toEqual({ kind: "continue" });
    expect(registration.reconcileRequired).toBe(true);
  });

  it("shares one request between concurrent callers", async () => {
    const { r, fetchFn } = reconciler([reconciled("continue")], {});
    const [a, b] = await Promise.all([r.gate(), r.reconcile()]);
    expect(a).toEqual({ kind: "proceed" });
    expect(b).toEqual({ kind: "continue" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries an unreachable Galley or a server error on the engine's backoff", async () => {
    const { r, fetchFn, registration } = reconciler(
      [() => json({ error: { code: "database_unavailable", message: "x" } }, 503), () => new Response("<html>", { status: 200 }), reconciled("continue")],
      {},
    );
    const gate = r.gate();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(await gate).toEqual({ kind: "proceed" });
    expect(registration.reconcileRequired).toBe(false);
  });
});

describe("claim loop with a Reconcile owed", () => {
  it("reconciles holding nothing before each claim poll, and claims only after round null", async () => {
    const g = galley({ reconcile: [reconciled("hold"), reconciled("hold"), noRound] });
    const { loop, registration } = setup(g.fetchFn, { steps: [{ step: "start" }, { step: "hold" }] });
    requireReconcile(registration);

    await vi.advanceTimersByTimeAsync(2000);
    expect(g.order()).toEqual(["/api/runner/reconcile", "/api/runner/reconcile"]);
    expect(g.reconciles()).toEqual([{ held: [] }, { held: [] }]);
    expect(registration.reconcileRequired).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.order()).toEqual(["/api/runner/reconcile", "/api/runner/reconcile", "/api/runner/reconcile", "/api/runner/claims"]);
    expect(registration.reconcileRequired).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.of("/api/runner/reconcile")).toHaveLength(3);
    await loop.stop();
  });

  it("gates the next event: continue lets it through", async () => {
    const g = galley({ claims: [() => json(CLAIM, 201), noWork], reconcile: [reconciled("continue")] });
    const { loop, registration, messages } = setup(g.fetchFn, START_PROGRESS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.events()).toEqual(["execution_started"]);
    requireReconcile(registration);
    await vi.advanceTimersByTimeAsync(5000);
    expect(g.reconciles()[0]).toEqual(held("running"));
    expect(g.events()).toEqual(["execution_started", "progress", "delivered"]);
    expect(g.order().indexOf("/api/runner/reconcile")).toBeLessThan(g.order().indexOf("event:progress"));
    expect(registration.reconcileRequired).toBe(false);
    expect(messages()).toContain("engine delivered");
    await loop.stop();
  });

  it("gates the next event: stop halts without the next step, confirms the Stop and acknowledges it", async () => {
    const g = galley({ claims: [() => json(CLAIM, 201), noWork], reconcile: [reconciled("stop")] });
    const { loop, registration, messages } = setup(g.fetchFn, START_PROGRESS);
    await vi.advanceTimersByTimeAsync(1000);
    requireReconcile(registration);
    await vi.advanceTimersByTimeAsync(5000);
    expect(g.events()).toEqual(["execution_started", "stop_confirmed"]);
    expect(g.of(`/api/runner/rounds/${ROUND}/commands/${STOP_ID}/ack`).map((call) => call.body)).toEqual([{ outcome: "applied" }]);
    expect(messages()).toContain("engine stopped");
    expect(messages()).not.toContain("progress reported");
    await loop.stop();
  });

  it.each([
    ["hold", reconciled("hold")],
    ["a 409", () => json({ error: { code: "stale_claim_epoch", message: "x" } }, 409)],
  ])("gates the next event: %s drops the Round without reporting anything", async (_name, respond) => {
    const g = galley({ claims: [() => json(CLAIM, 201), noWork], reconcile: [respond, noRound] });
    const { loop, registration } = setup(g.fetchFn, START_PROGRESS);
    await vi.advanceTimersByTimeAsync(1000);
    requireReconcile(registration);
    await vi.advanceTimersByTimeAsync(5000);
    expect(g.events()).toEqual(["execution_started"]);
    expect(g.reconciles()[0]).toEqual(held("running"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.reconciles()[1]).toEqual({ held: [] });
    expect(g.events()).toEqual(["execution_started"]);
    await loop.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("watches while the engine waits on the Owner: a Reconcile runs on the claim interval with no event to gate", async () => {
    const g = galley({ claims: [() => json(CLAIM, 201), noWork], reconcile: [reconciled("continue")] });
    const { loop, registration } = setup(g.fetchFn, START_ASK);
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.events()).toEqual(["execution_started", "question_raised"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(g.reconciles()).toEqual([]);
    requireReconcile(registration);
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.reconciles()).toEqual([held("running")]);
    expect(registration.reconcileRequired).toBe(false);
    expect(g.events()).toEqual(["execution_started", "question_raised"]);
    await loop.stop();
  });

  it("watches while the engine waits: stop ends the wait with a confirmed Stop", async () => {
    const g = galley({ claims: [() => json(CLAIM, 201), noWork], reconcile: [reconciled("stop")] });
    const { loop, registration, messages } = setup(g.fetchFn, START_ASK);
    await vi.advanceTimersByTimeAsync(1000);
    requireReconcile(registration);
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.events()).toEqual(["execution_started", "question_raised", "stop_confirmed"]);
    expect(g.of(`/api/runner/rounds/${ROUND}/commands/${STOP_ID}/ack`)).toHaveLength(1);
    expect(messages()).not.toContain("resume reported");
    await loop.stop();
  });

  it("watches while the engine waits: hold leaves the Round without a cessation report", async () => {
    const g = galley({ claims: [() => json(CLAIM, 201), noWork], reconcile: [reconciled("hold")] });
    const { loop, registration, messages } = setup(g.fetchFn, START_ASK);
    await vi.advanceTimersByTimeAsync(1000);
    requireReconcile(registration);
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.events()).toEqual(["execution_started", "question_raised"]);
    expect(messages()).not.toContain("engine stopped");
    await loop.stop();
  });

  it.each(["stop_confirmed", "interrupted"])("lets the halted engine's one cessation event through, as Galley names it: %s", async (named) => {
    let stopSeen = false;
    const g = galley({
      claims: [() => json(CLAIM, 201), noWork],
      commands: () => (stopSeen ? json({ commands: [] }) : ((stopSeen = true), json({ commands: [STOP] }))),
      reconcile: [reconciled("report_cessation", { cessationEvent: named })],
    });
    const { loop, registration } = setup(g.fetchFn, START_PROGRESS, 500);
    await vi.advanceTimersByTimeAsync(1000);
    requireReconcile(registration);
    await vi.advanceTimersByTimeAsync(2000);
    expect(g.reconciles()[0]).toEqual(held("stopped"));
    expect(g.events()).toEqual(["execution_started", named]);
    expect(registration.reconcileRequired).toBe(true);
    expect(g.reconciles().slice(1)).toEqual(g.reconciles().slice(1).map(() => ({ held: [] })));
    await loop.stop();
  });

  it("gates each authority check, and asks again after Galley says a Reconcile is owed", async () => {
    const act: EngineScript = { steps: [{ step: "start" }, { step: "act", account: "controlled", action: "write_note", resource: "notes/a" }] };
    const g = galley({
      claims: [() => json(CLAIM, 201), noWork],
      check: [() => json({ error: { code: "reconcile_required", message: "x" } }, 409), () => json({ decision: "allow", grantId: "g" })],
      reconcile: [reconciled("continue")],
    });
    const { loop, registration } = setup(g.fetchFn, act);
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.order().slice(-1)).toEqual(["authority-checks"]);
    expect(registration.reconcileRequired).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    const order = g.order();
    expect(order.slice(order.indexOf("authority-checks"))).toEqual(["authority-checks", "/api/runner/reconcile", "authority-checks", "event:progress"]);
    await loop.stop();
  });

  it("retries a runner_disconnected check without dropping the Round", async () => {
    const act: EngineScript = { steps: [{ step: "start" }, { step: "act", account: "controlled", action: "write_note", resource: "notes/a" }] };
    const g = galley({
      claims: [() => json(CLAIM, 201), noWork],
      check: [() => json({ error: { code: "runner_disconnected", message: "x" } }, 409), () => json({ decision: "allow", grantId: "g" })],
    });
    const { loop } = setup(g.fetchFn, act);
    await vi.advanceTimersByTimeAsync(2000);
    expect(g.of(`/api/runner/rounds/${ROUND}/authority-checks`)).toHaveLength(2);
    expect(g.events()).toEqual(["execution_started", "progress"]);
    await loop.stop();
  });

  it("gates the authority check itself: stop halts before checking", async () => {
    const act: EngineScript = { steps: [{ step: "start" }, { step: "wait", ms: 5000 }, { step: "act", account: "controlled", action: "write_note", resource: "notes/a" }] };
    const g = galley({ claims: [() => json(CLAIM, 201), noWork], reconcile: [reconciled("stop")] });
    const { loop, registration } = setup(g.fetchFn, act, 1_000_000);
    await vi.advanceTimersByTimeAsync(1000);
    requireReconcile(registration);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(5000);
    expect(g.of(`/api/runner/rounds/${ROUND}/authority-checks`)).toHaveLength(0);
    expect(g.events()).toEqual(["execution_started", "stop_confirmed"]);
    await loop.stop();
  });
});
