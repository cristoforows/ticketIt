import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryDelayMs, runControlledEngine, type EngineOutcome } from "./engine.ts";
import { DEFAULT_ENGINE_SCRIPT, type EngineStep } from "./engineScript.ts";
import { resolveRunnerCredential } from "./credentials.ts";
import type { FetchFn } from "./galley/client.ts";
import type { RunnerClaim } from "./galley/runner.ts";
import { createLogger } from "./logger.ts";

const GALLEY = new URL("http://galley.test:8080/");
const TOKEN = `tir_${"f".repeat(43)}`;
const ROUND_ID = "77777777-7777-4777-8777-777777777777";
const EVENTS_PATH = `/api/runner/rounds/${ROUND_ID}/events`;

const CLAIM: RunnerClaim = {
  roundId: ROUND_ID,
  sequence: 2,
  claimEpoch: 3,
  ticket: { id: "88888888-8888-4888-8888-888888888888", title: "Write the report", goal: "g", context: "c", successCriteria: "s", constraints: "", repository: "" },
  agent: { id: "99999999-9999-4999-8999-999999999999", name: "atlas", kind: "research" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const result = { roundId: ROUND_ID, type: "execution_started", state: "running", startedAt: "2026-10-01T12:00:00Z" };
const created = () => json(result, 201);
const replayed = () => json(result, 200);
const error = (status: number, code: string) => () => json({ error: { code, message: "x" } }, status);
const refused = (): Response => {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" }) });
};
const hang: FetchFn = (_input, init) =>
  new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

function credential() {
  const resolved = resolveRunnerCredential({ MICHELIN_RUNNER_TOKEN: TOKEN }, []);
  if (!resolved) throw new Error("test credential rejected");
  return resolved;
}

function sequence(...responses: (() => Response | Promise<Response>)[]) {
  return vi.fn<FetchFn>(async (input) => {
    if (new URL(String(input)).pathname !== EVENTS_PATH) throw new Error(`unexpected ${String(input)}`);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (!next) throw new Error("no response queued");
    return next();
  });
}

interface Harness {
  controller: AbortController;
  lines: string[];
  records: () => Record<string, unknown>[];
  sleeps: number[];
  references: string[];
  observationIds: string[];
  clockReads: number;
  run: Promise<EngineOutcome>;
}

function start(steps: EngineStep[], fetchFn: FetchFn, options: { instantSleep?: boolean; claim?: RunnerClaim } = {}): Harness {
  const controller = new AbortController();
  const lines: string[] = [];
  const sleeps: number[] = [];
  const references: string[] = [];
  const observationIds: string[] = [];
  const harness = { controller, lines, sleeps, references, observationIds, clockReads: 0 } as Harness;
  let tick = 0;
  harness.records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  harness.run = runControlledEngine({
    galleyUrl: GALLEY,
    fetch: fetchFn,
    logger: createLogger((line) => lines.push(line)),
    credential: credential(),
    claim: options.claim ?? CLAIM,
    script: { steps },
    signal: controller.signal,
    requestTimeoutMs: 300,
    deps: {
      now: () => {
        harness.clockReads++;
        return new Date(Date.UTC(2026, 9, 1, 12, 0, tick++, 123));
      },
      newReference: () => {
        const reference = `controlled:test-${references.length + 1}`;
        references.push(reference);
        return reference;
      },
      newObservationId: () => {
        const id = `0000000${observationIds.length + 1}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
        observationIds.push(id);
        return id;
      },
      ...(options.instantSleep
        ? {
            sleep: async (ms: number) => {
              sleeps.push(ms);
            },
          }
        : {}),
    },
  });
  return harness;
}

const START: EngineStep = { step: "start" };
const HOLD: EngineStep = { step: "hold" };
const wait = (ms: number): EngineStep => ({ step: "wait", ms });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("retryDelayMs", () => {
  it("doubles from one second and is capped at thirty", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 40].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  });
});

describe("the controlled engine's start step", () => {
  it("reports Execution started once, with the claim's epoch and a controlled reference generated once", async () => {
    const fetchFn = sequence(created);
    const harness = start([START, wait(100)], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe(`http://galley.test:8080${EVENTS_PATH}`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      type: "execution_started",
      idempotencyKey: `${ROUND_ID}:0`,
      claimEpoch: 3,
      occurredAt: "2026-10-01T12:00:00.123Z",
      data: { engineReference: "controlled:test-1" },
    });
    expect(harness.references).toHaveLength(1);
    expect(harness.sleeps).toEqual([100]);
  });

  it("uses a controlled:<uuid> reference by default", async () => {
    const fetchFn = sequence(created);
    const controller = new AbortController();
    const run = runControlledEngine({
      galleyUrl: GALLEY, fetch: fetchFn, logger: createLogger(() => {}), credential: credential(), claim: CLAIM, script: { steps: [START] }, signal: controller.signal,
    });
    expect(await run).toBe("completed");
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as { data: { engineReference: string }; occurredAt: string };
    expect(body.data.engineReference).toMatch(/^controlled:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.isNaN(Date.parse(body.occurredAt))).toBe(false);
  });

  it("sends the event before the script's later steps and logs it with the Round, step and attempt", async () => {
    const harness = start([START, wait(1500), HOLD], sequence(created));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.records()).toEqual([
      expect.objectContaining({ level: "info", msg: "execution started reported", roundId: ROUND_ID, step: "start", stepIndex: 0, attempt: 1, httpStatus: 201, replayed: false, engineReference: "controlled:test-1" }),
    ]);
    await vi.advanceTimersByTimeAsync(1499);
    expect(vi.getTimerCount()).toBe(1);
    expect(harness.records().map((record) => record["msg"])).toEqual(["execution started reported"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.records().map((record) => record["msg"])).toEqual(["execution started reported", "engine holding"]);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
  });

  it.each([
    ["201", created, false],
    ["200", replayed, true],
  ])("treats %s as success and goes on to the next step", async (_status, respond, isReplay) => {
    const fetchFn = sequence(respond);
    const harness = start([START, wait(10)], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([10]);
    expect(harness.records()[0]).toMatchObject({ msg: "execution started reported", replayed: isReplay });
  });
});

describe("retrying a failed report", () => {
  it.each([
    ["an unreachable Galley", refused],
    ["a server error", error(503, "database_unavailable")],
    ["a 500 without a JSON body", () => new Response("<html>", { status: 500 })],
    ["a 502", () => new Response("bad gateway", { status: 502 })],
    ["a 201 that is not JSON", () => new Response("<html>", { status: 201 })],
    ["a 201 for another Round", () => json({ ...result, roundId: "00000000-0000-4000-8000-000000000000" }, 201)],
    ["a 200 without a state", () => json({ roundId: ROUND_ID, type: "execution_started", startedAt: "t" }, 200)],
  ])("retries %s with the identical request and backs off 1 s, 2 s, 4 s", async (_name, failure) => {
    const fetchFn = sequence(failure, failure, failure, created);
    const harness = start([START], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");

    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(harness.sleeps).toEqual([1000, 2000, 4000]);
    const bodies = fetchFn.mock.calls.map(([, init]) => String(init?.body));
    expect(new Set(bodies).size).toBe(1);
    expect(harness.references).toHaveLength(1);
    expect(harness.clockReads).toBe(1);
    const warnings = harness.records().filter((record) => record["level"] === "warn");
    expect(warnings.map((record) => [record["attempt"], record["retryInMs"]])).toEqual([[1, 1000], [2, 2000], [3, 4000]]);
    expect(warnings[0]).toMatchObject({ msg: "round event failed; retrying", roundId: ROUND_ID, step: "start", stepIndex: 0 });
  });

  it("times out a hung request and retries it", async () => {
    let calls = 0;
    const fetchFn = vi.fn<FetchFn>((input, init) => (++calls === 1 ? hang(input, init) : Promise.resolve(created())));
    const harness = start([START], fetchFn, { instantSleep: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(await harness.run).toBe("completed");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(harness.sleeps).toEqual([1000]);
    expect(harness.records().find((record) => record["level"] === "warn")).toMatchObject({ reason: "timeout", timeoutMs: 300 });
  });

  it("follows 1, 2, 4, 8, 16, 30, 30 seconds and never gives up on a Galley that stays down", async () => {
    const fetchFn = sequence(refused, refused, refused, refused, refused, refused, refused, refused, created);
    const harness = start([START], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");
    expect(harness.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(new Set(fetchFn.mock.calls.map(([, init]) => String(init?.body))).size).toBe(1);
  });

  it("logs the reason and the HTTP status of each failed attempt without the token", async () => {
    const fetchFn = sequence(refused, error(503, "database_unavailable"), created);
    const harness = start([START], fetchFn, { instantSleep: true });
    await harness.run;
    const warnings = harness.records().filter((record) => record["level"] === "warn");
    expect(warnings[0]).toMatchObject({ reason: "unreachable", code: "ECONNREFUSED" });
    expect(warnings[1]).toMatchObject({ reason: "http_status", httpStatus: 503, errorCode: "database_unavailable" });
    expect(harness.lines.join("\n")).not.toContain(TOKEN.slice(4));
  });
});

describe("a report Galley refuses", () => {
  it.each([
    [400, "invalid_request"],
    [401, "unauthenticated"],
    [404, "not_found"],
    [409, "stale_claim_epoch"],
    [409, "idempotency_key_conflict"],
    [409, "round_not_open"],
    [409, "event_out_of_order"],
    [403, "forbidden"],
  ])("abandons the Round on %i %s without retrying, closing anything or sending another event", async (status, code) => {
    const fetchFn = sequence(error(status, code));
    const harness = start([START, wait(10), HOLD], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("abandoned");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
    expect(harness.records()).toEqual([
      expect.objectContaining({ level: "error", msg: "round event refused; round abandoned locally", roundId: ROUND_ID, step: "start", stepIndex: 0, attempt: 1, httpStatus: status, errorCode: code }),
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abandons on an unexpected success status and on a refusal without a JSON body", async () => {
    for (const respond of [() => new Response(null, { status: 204 }), () => new Response("nope", { status: 404 })]) {
      const fetchFn = sequence(respond);
      const harness = start([START, HOLD], fetchFn, { instantSleep: true });
      expect(await harness.run).toBe("abandoned");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(harness.records()[0]).toMatchObject({ level: "error", msg: "round event refused; round abandoned locally" });
      expect(harness.records()[0]).not.toHaveProperty("errorCode");
    }
  });

  it("abandons after earlier retries too, once Galley refuses", async () => {
    const fetchFn = sequence(refused, error(409, "stale_claim_epoch"));
    const harness = start([START, HOLD], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("abandoned");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(harness.sleeps).toEqual([1000]);
    expect(harness.records().at(-1)).toMatchObject({ level: "error", attempt: 2, errorCode: "stale_claim_epoch" });
  });
});

describe("stopping", () => {
  it("stops promptly during a wait and leaves no timer", async () => {
    const fetchFn = sequence(created);
    const harness = start([START, wait(60_000), HOLD], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.records().map((record) => record["msg"])).toEqual(["execution started reported"]);
  });

  it("stops promptly while holding", async () => {
    const harness = start([START, HOLD], sequence(created));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
  });

  it("stops promptly during a backoff without sending again", async () => {
    const fetchFn = sequence(refused, created);
    const harness = start([START, HOLD], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.records().filter((record) => record["level"] === "error")).toEqual([]);
  });

  it("stops promptly during a request without logging a failure", async () => {
    const fetchFn = vi.fn<FetchFn>(hang);
    const harness = start([START, HOLD], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
    expect(harness.records()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start when already stopped", async () => {
    const fetchFn = sequence(created);
    const controller = new AbortController();
    controller.abort();
    const run = runControlledEngine({ galleyUrl: GALLEY, fetch: fetchFn, logger: createLogger(() => {}), credential: credential(), claim: CLAIM, script: { steps: [START, HOLD] }, signal: controller.signal });
    expect(await run).toBe("aborted");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("the script", () => {
  it("runs a script that ends without holding to completion", async () => {
    const harness = start([START, wait(5), wait(7)], sequence(created), { instantSleep: true });
    expect(await harness.run).toBe("completed");
    expect(harness.sleeps).toEqual([5, 7]);
    expect(harness.records().map((record) => record["msg"])).toEqual(["execution started reported", "engine script finished"]);
  });
});

const NOTE = (note: string): EngineStep => ({ step: "progress", note });
const USAGE: EngineStep = {
  step: "usage",
  provider: "controlled",
  model: "scripted",
  inputTokens: 1200,
  outputTokens: null,
  costUsd: "0.004500",
  activeMs: 2000,
  basis: "estimated",
  providerGenerationId: null,
};

type SentEvent = { type: string; idempotencyKey: string; claimEpoch: number; occurredAt: string; data: Record<string, unknown> };

function answering(...failures: (() => Response)[]) {
  let notes = 0;
  let calls = 0;
  return vi.fn<FetchFn>(async (_input, init) => {
    // With instant sleeps an endless retry would never yield; a refusal ends the Round so the test fails instead.
    if (++calls > 50) return json({ error: { code: "invalid_request", message: "runaway retries" } }, 400);
    const failure = failures.shift();
    if (failure) return failure();
    const event = JSON.parse(String(init?.body)) as SentEvent;
    return json(
      {
        roundId: ROUND_ID,
        type: event.type,
        state: "running",
        startedAt: "2026-10-01T12:00:00Z",
        ...(event.type === "progress" ? { seq: ++notes } : {}),
        ...(event.type === "usage_observed" ? { observationId: event.data["observationId"] } : {}),
      },
      201,
    );
  });
}

const sent = (fetchFn: ReturnType<typeof answering>) => fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as SentEvent);

describe("progress and usage steps", () => {
  it("reports a progress note keyed by Round and step index, and logs its seq", async () => {
    const fetchFn = answering();
    const harness = start([START, wait(5), NOTE("Reading the Ticket"), NOTE("Done reading")], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");

    expect(sent(fetchFn).slice(1)).toEqual([
      { type: "progress", idempotencyKey: `${ROUND_ID}:2`, claimEpoch: 3, occurredAt: "2026-10-01T12:00:01.123Z", data: { note: "Reading the Ticket" } },
      { type: "progress", idempotencyKey: `${ROUND_ID}:3`, claimEpoch: 3, occurredAt: "2026-10-01T12:00:02.123Z", data: { note: "Done reading" } },
    ]);
    expect(harness.records().filter((record) => record["msg"] === "progress reported")).toEqual([
      expect.objectContaining({ roundId: ROUND_ID, step: "progress", stepIndex: 2, attempt: 1, seq: 1, httpStatus: 201 }),
      expect.objectContaining({ stepIndex: 3, seq: 2 }),
    ]);
  });

  it("reports a usage observation whose idempotency key is its observationId, carrying the cost as a string and unknowns as null", async () => {
    const fetchFn = answering();
    const harness = start([START, USAGE], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");

    const [observationId] = harness.observationIds;
    expect(sent(fetchFn)[1]).toEqual({
      type: "usage_observed",
      idempotencyKey: observationId,
      claimEpoch: 3,
      occurredAt: "2026-10-01T12:00:01.123Z",
      data: { observationId, provider: "controlled", model: "scripted", inputTokens: 1200, outputTokens: null, costUsd: "0.004500", activeMs: 2000, basis: "estimated", providerGenerationId: null },
    });
    expect(harness.records().find((record) => record["msg"] === "usage observation reported")).toMatchObject({ step: "usage", stepIndex: 1, observationId });
  });

  it("generates one observationId per usage step and resends it, in the identical body, on every retry", async () => {
    const fetchFn = answering(created, refused, error(503, "database_unavailable"), () => new Response("<html>", { status: 201 }));
    const harness = start([START, USAGE, USAGE], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");

    const bodies = fetchFn.mock.calls.map(([, init]) => String(init?.body));
    expect(bodies).toHaveLength(6);
    expect(new Set(bodies.slice(1, 5)).size).toBe(1);
    expect(harness.observationIds).toHaveLength(2);
    expect(sent(fetchFn).slice(1).map((event) => event.idempotencyKey)).toEqual([...Array(4).fill(harness.observationIds[0]), harness.observationIds[1]]);
    expect(harness.sleeps).toEqual([1000, 2000, 4000]);
  });

  it("retries a progress note with the identical body and key", async () => {
    const fetchFn = answering(created, refused, refused);
    const harness = start([START, NOTE("n")], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");
    const bodies = fetchFn.mock.calls.map(([, init]) => String(init?.body));
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies.slice(1)).size).toBe(1);
    expect(harness.clockReads).toBe(2);
  });

  it.each([
    ["a progress result without a seq", NOTE("n"), { type: "progress" }],
    ["a progress result with seq 0", NOTE("n"), { type: "progress", seq: 0 }],
    ["a result naming another event type", NOTE("n"), { type: "execution_started" }],
    ["a usage result for another observation", USAGE, { type: "usage_observed", observationId: "00000009-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["a usage result without an observationId", USAGE, { type: "usage_observed" }],
  ])("retries %s as an invalid body", async (_name, step, wrong) => {
    const fetchFn = answering(created, () => json({ roundId: ROUND_ID, state: "running", startedAt: "2026-10-01T12:00:00Z", ...wrong }, 201));
    const harness = start([START, step], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(harness.records().find((record) => record["level"] === "warn")).toMatchObject({ reason: "invalid_body", stepIndex: 1 });
  });

  it.each([
    [409, "observation_id_conflict"],
    [409, "event_out_of_order"],
    [400, "invalid_request"],
  ])("abandons the Round when Galley refuses a usage observation with %i %s", async (status, code) => {
    const fetchFn = answering(created, error(status, code));
    const harness = start([START, USAGE, NOTE("after"), HOLD], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("abandoned");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(harness.records().at(-1)).toMatchObject({ level: "error", step: "usage", stepIndex: 1, errorCode: code });
  });
});

describe("the default script", () => {
  it("starts, notes progress a second apart on the injected clock, observes usage once, then holds", async () => {
    const fetchFn = answering();
    const harness = start([...DEFAULT_ENGINE_SCRIPT.steps], fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(sent(fetchFn).map((event) => event.type)).toEqual(["execution_started", "progress"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(sent(fetchFn)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent(fetchFn)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);

    const events = sent(fetchFn);
    expect(events.map((event) => event.type)).toEqual(["execution_started", "progress", "progress", "progress", "usage_observed"]);
    expect(events.map((event) => event.idempotencyKey)).toEqual([`${ROUND_ID}:0`, `${ROUND_ID}:1`, `${ROUND_ID}:3`, `${ROUND_ID}:5`, harness.observationIds[0]]);
    expect(events.slice(1, 4).map((event) => event.data["note"])).toEqual(["Reading the Ticket", "Working towards the goal", "Writing up the result"]);
    expect(harness.records().map((record) => record["msg"])).toEqual([
      "execution started reported",
      "progress reported",
      "progress reported",
      "progress reported",
      "usage observation reported",
      "engine holding",
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
  });
});
