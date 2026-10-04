import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerInbox, ApprovalInbox, type AwaitAnswer, type AwaitApproval } from "./answerInbox.ts";
import { answerNote, feedbackNote, performedNote, questionIdFor, requestIdFor, retryDelayMs, runControlledEngine, type EngineOutcome } from "./engine.ts";
import { DEFAULT_ENGINE_SCRIPT, type DeliverStep, type EngineStep } from "./engineScript.ts";
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
  ticket: { id: "88888888-8888-4888-8888-888888888888", title: "Write the report", goal: "g", context: "c", successCriteria: "s", constraints: "", repository: "", feedback: [] },
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
  stopper: AbortController;
  lines: string[];
  records: () => Record<string, unknown>[];
  sleeps: number[];
  references: string[];
  observationIds: string[];
  clockReads: number;
  run: Promise<EngineOutcome>;
}

function start(steps: EngineStep[], fetchFn: FetchFn, options: { instantSleep?: boolean; claim?: RunnerClaim; awaitAnswer?: AwaitAnswer; awaitApproval?: AwaitApproval } = {}): Harness {
  const controller = new AbortController();
  const stopper = new AbortController();
  const lines: string[] = [];
  const sleeps: number[] = [];
  const references: string[] = [];
  const observationIds: string[] = [];
  const harness = { controller, stopper, lines, sleeps, references, observationIds, clockReads: 0 } as Harness;
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
    stop: stopper.signal,
    awaitAnswer: options.awaitAnswer,
    awaitApproval: options.awaitApproval,
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
      galleyUrl: GALLEY, fetch: fetchFn, logger: createLogger(() => {}), credential: credential(), claim: CLAIM, script: { steps: [START] }, signal: controller.signal, stop: new AbortController().signal,
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
    const run = runControlledEngine({ galleyUrl: GALLEY, fetch: fetchFn, logger: createLogger(() => {}), credential: credential(), claim: CLAIM, script: { steps: [START, HOLD] }, signal: controller.signal, stop: new AbortController().signal });
    expect(await run).toBe("aborted");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("a Stop request", () => {
  const deferred = () => {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => (resolve = done));
    return { promise, resolve };
  };
  const COMMAND_ID = "55555555-5555-4555-8555-555555555555";
  const stopConfirmed = (evidence: string) => ({
    type: "stop_confirmed",
    idempotencyKey: `${ROUND_ID}:stop`,
    claimEpoch: CLAIM.claimEpoch,
    occurredAt: expect.stringMatching(/^2026-10-01T12:00:\d\d\.123Z$/),
    data: { evidence },
  });
  const stoppedResult = { roundId: ROUND_ID, type: "stop_confirmed", state: "stopped", startedAt: "2026-10-01T12:00:00Z", endedAt: "2026-10-01T12:00:09Z" };

  it.each([
    ["a wait", [START, wait(60_000), NOTE("after"), HOLD], 2, "Stopped before step 3 of 4"],
    ["a hold", [START, HOLD], 1, "Stopped before step 2 of 2"],
  ])("ends %s at once, confirms the Stop with its evidence and returns stopped", async (_name, steps, haltedAt, where) => {
    const fetchFn = answering();
    const harness = start(steps, fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort(COMMAND_ID);
    expect(await harness.run).toBe("stopped");
    expect(vi.getTimerCount()).toBe(0);
    expect(sent(fetchFn).map((event) => event.type)).toEqual(["execution_started", "stop_confirmed"]);
    expect(sent(fetchFn)[1]).toEqual(stopConfirmed(`${where} on Stop command ${COMMAND_ID}`));
    expect(harness.records().map((record) => record["msg"]).filter((msg) => msg !== "engine holding")).toEqual(["execution started reported", "engine stopped", "stop confirmation reported"]);
    expect(harness.records().find((record) => record["msg"] === "engine stopped")).toMatchObject({ roundId: ROUND_ID, stepIndex: haltedAt, commandId: COMMAND_ID });
    expect(harness.records().at(-1)).toMatchObject({ roundId: ROUND_ID, step: "stop", httpStatus: 201, endedAt: "2026-10-01T12:00:09Z" });
  });

  it("confirms a Stop that lands during the last step's wait as stopped after the last step", async () => {
    const fetchFn = answering();
    const harness = start([START, wait(60_000)], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort(COMMAND_ID);
    expect(await harness.run).toBe("stopped");
    expect(sent(fetchFn)[1]).toEqual(stopConfirmed(`Stopped after step 2 of 2 on Stop command ${COMMAND_ID}`));
  });

  it("lets an in-flight event finish, then halts at the next step boundary and confirms", async () => {
    const pending = deferred();
    let calls = 0;
    const fetchFn = vi.fn<FetchFn>(() => (++calls === 1 ? pending.promise : Promise.resolve(json(stoppedResult, 201))));
    const harness = start([START, NOTE("never sent"), HOLD], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort(COMMAND_ID);
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.records()).toEqual([]);
    pending.resolve(created());
    expect(await harness.run).toBe("stopped");
    expect(fetchFn.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as SentEvent).type)).toEqual(["execution_started", "stop_confirmed"]);
    expect(harness.records().map((record) => record["msg"])).toEqual(["execution started reported", "engine stopped", "stop confirmation reported"]);
  });

  it("keeps retrying an in-flight event through its backoff before halting", async () => {
    const fetchFn = answering(refused);
    const harness = start([START, NOTE("never sent"), HOLD], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort(COMMAND_ID);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await harness.run).toBe("stopped");
    expect(sent(fetchFn).map((event) => event.type)).toEqual(["execution_started", "execution_started", "stop_confirmed"]);
    expect(harness.records().map((record) => record["msg"])).toEqual(["round event failed; retrying", "execution started reported", "engine stopped", "stop confirmation reported"]);
  });

  it("retries the confirmation through 5xx and network failures with the same bytes", async () => {
    const fetchFn = answering(created, error(503, "database_unavailable"), refused, () => new Response("<html>", { status: 201 }));
    const harness = start([START, HOLD], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort(COMMAND_ID);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(await harness.run).toBe("stopped");
    const bodies = fetchFn.mock.calls.slice(1).map(([, init]) => String(init?.body));
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies).size).toBe(1);
    expect(harness.records().filter((record) => record["msg"] === "round event failed; retrying").map((record) => record["retryInMs"])).toEqual([1000, 2000, 4000]);
  });

  it("accepts a replayed confirmation and a Round stopped before it started", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json({ ...stoppedResult, startedAt: null }, 200));
    const harness = start([wait(60_000), START], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort(COMMAND_ID);
    expect(await harness.run).toBe("stopped");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(harness.records().at(-1)).toMatchObject({ msg: "stop confirmation reported", httpStatus: 200, replayed: true });
  });

  it.each([
    ["a wrong state", { state: "running" }, "state is not stopped"],
    ["no endedAt", { endedAt: undefined }, "endedAt is not a string"],
    ["another Round", { roundId: "66666666-6666-4666-8666-666666666666" }, "roundId is not the Round the event was sent for"],
  ])("retries a confirmation answered with %s", async (_name, wrong, why) => {
    const fetchFn = answering(created, () => json({ ...stoppedResult, ...wrong }, 201));
    const harness = start([START, HOLD], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort(COMMAND_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await harness.run).toBe("stopped");
    expect(harness.records().find((record) => record["msg"] === "round event failed; retrying")).toMatchObject({ step: "stop", reason: "invalid_body", error: why });
  });

  it.each([
    [409, "round_not_open"],
    [409, "stop_not_requested"],
    [409, "stale_claim_epoch"],
    [400, "invalid_request"],
  ])("abandons the Round locally when Galley refuses the confirmation with %i %s", async (status, code) => {
    const fetchFn = answering(created, error(status, code));
    const harness = start([START, HOLD], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort(COMMAND_ID);
    expect(await harness.run).toBe("abandoned");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(harness.records().at(-1)).toMatchObject({ level: "error", msg: "round event refused; round abandoned locally", step: "stop", httpStatus: status, errorCode: code });
  });

  it("answers shutdown during the confirmation's backoff with aborted", async () => {
    const fetchFn = answering(created, refused);
    const harness = start([START, HOLD], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort(COMMAND_ID);
    await vi.advanceTimersByTimeAsync(10);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("returns delivered when the delivery in flight lands, and confirms nothing", async () => {
    const pending = deferred();
    let calls = 0;
    const fetchFn = vi.fn<FetchFn>(() => (++calls === 1 ? Promise.resolve(created()) : pending.promise));
    const harness = start([START, DELIVER], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort(COMMAND_ID);
    pending.resolve(json({ roundId: ROUND_ID, type: "delivered", state: "delivered", startedAt: "2026-10-01T12:00:00Z", endedAt: "2026-10-01T12:00:09Z" }, 201));
    expect(await harness.run).toBe("delivered");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("still answers shutdown with aborted and confirms nothing", async () => {
    const fetchFn = answering();
    const harness = start([START, HOLD], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.controller.abort();
    harness.stopper.abort(COMMAND_ID);
    expect(await harness.run).toBe("aborted");
    expect(harness.records().map((record) => record["msg"])).not.toContain("engine stopped");
    expect(sent(fetchFn).map((event) => event.type)).toEqual(["execution_started"]);
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

const ENDED_STATES: Record<string, string> = { delivered: "delivered", stop_confirmed: "stopped", failed: "failed", interrupted: "interrupted" };

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
        state: ENDED_STATES[event.type] ?? "running",
        startedAt: "2026-10-01T12:00:00Z",
        ...(event.type in ENDED_STATES ? { endedAt: "2026-10-01T12:00:09Z" } : {}),
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
  it("starts, notes progress a second apart on the injected clock, observes usage once, delivers, then returns", async () => {
    const fetchFn = answering();
    const harness = start([...DEFAULT_ENGINE_SCRIPT.steps], fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(sent(fetchFn).map((event) => event.type)).toEqual(["execution_started", "progress"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(sent(fetchFn)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent(fetchFn)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await harness.run).toBe("delivered");

    const events = sent(fetchFn);
    expect(events.map((event) => event.type)).toEqual(["execution_started", "progress", "progress", "progress", "usage_observed", "delivered"]);
    expect(events.map((event) => event.idempotencyKey)).toEqual([`${ROUND_ID}:0`, `${ROUND_ID}:1`, `${ROUND_ID}:3`, `${ROUND_ID}:5`, harness.observationIds[0], `${ROUND_ID}:7`]);
    expect(events.slice(1, 4).map((event) => event.data["note"])).toEqual(["Reading the Ticket", "Working towards the goal", "Writing up the result"]);
    const { step: _step, ...deliverable } = DEFAULT_ENGINE_SCRIPT.steps.at(-1) as DeliverStep;
    expect(events[5]!.data).toEqual(deliverable);
    expect(harness.records().map((record) => record["msg"])).toEqual([
      "execution started reported",
      "progress reported",
      "progress reported",
      "progress reported",
      "usage observation reported",
      "delivery reported",
      "engine delivered",
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });
});

const DELIVER: DeliverStep = { step: "deliver", bodyMarkdown: "# Done\n\n- one\n", summary: "Done.", criteriaAssessment: "Met." };

describe("the deliver step", () => {
  it("reports the deliverable keyed by Round and step index, logs the end, and returns delivered", async () => {
    const fetchFn = answering();
    const harness = start([START, NOTE("n"), DELIVER], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("delivered");
    expect(sent(fetchFn)[2]).toEqual({
      type: "delivered",
      idempotencyKey: `${ROUND_ID}:2`,
      claimEpoch: 3,
      occurredAt: "2026-10-01T12:00:02.123Z",
      data: { bodyMarkdown: "# Done\n\n- one\n", summary: "Done.", criteriaAssessment: "Met." },
    });
    expect(harness.records().find((record) => record["msg"] === "delivery reported")).toMatchObject({ roundId: ROUND_ID, step: "deliver", stepIndex: 2, attempt: 1, httpStatus: 201, endedAt: "2026-10-01T12:00:09Z" });
    expect(harness.records().at(-1)).toMatchObject({ msg: "engine delivered", roundId: ROUND_ID });
  });

  it("resends the identical bytes under the same key on every retry, and accepts a replay", async () => {
    const replay = () => json({ roundId: ROUND_ID, type: "delivered", state: "delivered", startedAt: "2026-10-01T12:00:00Z", endedAt: "2026-10-01T12:00:09Z" }, 200);
    const fetchFn = answering(created, refused, error(503, "database_unavailable"), () => new Response("<html>", { status: 201 }), replay);
    const harness = start([START, DELIVER], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("delivered");
    const bodies = fetchFn.mock.calls.map(([, init]) => String(init?.body));
    expect(bodies).toHaveLength(5);
    expect(new Set(bodies.slice(1)).size).toBe(1);
    expect(harness.clockReads).toBe(2);
    expect(harness.records().find((record) => record["msg"] === "delivery reported")).toMatchObject({ attempt: 4, httpStatus: 200, replayed: true });
  });

  it.each([
    ["a result still running", { type: "delivered", state: "running", endedAt: "2026-10-01T12:00:09Z" }],
    ["a result without endedAt", { type: "delivered", state: "delivered" }],
    ["a result naming another event type", { type: "progress", state: "delivered", seq: 1, endedAt: "2026-10-01T12:00:09Z" }],
  ])("retries %s as an invalid body", async (_name, wrong) => {
    const fetchFn = answering(created, () => json({ roundId: ROUND_ID, startedAt: "2026-10-01T12:00:00Z", ...wrong }, 201));
    const harness = start([START, DELIVER], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("delivered");
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(harness.records().find((record) => record["level"] === "warn")).toMatchObject({ reason: "invalid_body", stepIndex: 1 });
  });

  it("rejects a delivered state on any other event type", async () => {
    const fetchFn = answering(() => json({ roundId: ROUND_ID, type: "execution_started", state: "delivered", startedAt: "2026-10-01T12:00:00Z", endedAt: "2026-10-01T12:00:09Z" }, 201));
    const harness = start([START], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");
    expect(harness.records().find((record) => record["level"] === "warn")).toMatchObject({ reason: "invalid_body", error: "state is not claimed or running" });
  });

  it.each([
    [409, "round_not_open"],
    [409, "stale_claim_epoch"],
    [409, "idempotency_key_conflict"],
    [413, "request_too_large"],
    [400, "invalid_request"],
  ])("abandons the Round when Galley refuses the delivery with %i %s", async (status, code) => {
    const fetchFn = answering(created, error(status, code));
    const harness = start([START, DELIVER], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("abandoned");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(harness.records().at(-1)).toMatchObject({ level: "error", step: "deliver", stepIndex: 1, errorCode: code });
  });

  it("stops promptly during a delivery backoff without sending again", async () => {
    const fetchFn = answering(created, refused);
    const harness = start([START, DELIVER], fetchFn);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe.each([
  { name: "fail", type: "failed", field: "explanation", state: "failed", reported: "failure reported", ended: "engine failed" },
  { name: "interrupt", type: "interrupted", field: "evidence", state: "interrupted", reported: "interruption reported", ended: "engine interrupted" },
] as const)("the $name step", ({ name, type, field, state, reported, ended }) => {
  const step = (note: string): EngineStep => (name === "fail" ? { step: "fail", explanation: note } : { step: "interrupt", evidence: note });
  const endedResult = (status: number) => () => json({ roundId: ROUND_ID, type, state, startedAt: "2026-10-01T12:00:00Z", endedAt: "2026-10-01T12:00:09Z" }, status);

  it(`reports ${type} keyed by Round and step index with its ${field}, logs the end, and returns ${state}`, async () => {
    const fetchFn = answering();
    const harness = start([START, NOTE("n"), step("Ran out of road")], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe(state);
    expect(sent(fetchFn)[2]).toEqual({
      type,
      idempotencyKey: `${ROUND_ID}:2`,
      claimEpoch: 3,
      occurredAt: "2026-10-01T12:00:02.123Z",
      data: { [field]: "Ran out of road" },
    });
    expect(harness.records().find((record) => record["msg"] === reported)).toMatchObject({ roundId: ROUND_ID, step: name, stepIndex: 2, attempt: 1, httpStatus: 201, endedAt: "2026-10-01T12:00:09Z" });
    expect(harness.records().at(-1)).toMatchObject({ msg: ended, roundId: ROUND_ID });
  });

  it("resends the identical bytes under the same key through 5xx and network failures, and accepts a replay", async () => {
    const fetchFn = answering(created, refused, error(503, "database_unavailable"), () => new Response("<html>", { status: 201 }), endedResult(200));
    const harness = start([START, step("x")], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe(state);
    const bodies = fetchFn.mock.calls.map(([, init]) => String(init?.body));
    expect(bodies).toHaveLength(5);
    expect(new Set(bodies.slice(1)).size).toBe(1);
    expect(harness.sleeps).toEqual([1000, 2000, 4000]);
    expect(harness.records().find((record) => record["msg"] === reported)).toMatchObject({ attempt: 4, httpStatus: 200, replayed: true });
  });

  it.each([
    ["a result still running", { state: "running", endedAt: "2026-10-01T12:00:09Z" }],
    ["a result without endedAt", { endedAt: undefined }],
    ["another ended state", { state: state === "failed" ? "interrupted" : "failed" }],
  ])("retries %s as an invalid body", async (_name, wrong) => {
    const fetchFn = answering(created, () => json({ roundId: ROUND_ID, type, state, startedAt: "2026-10-01T12:00:00Z", endedAt: "2026-10-01T12:00:09Z", ...wrong }, 201));
    const harness = start([START, step("x")], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe(state);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(harness.records().find((record) => record["level"] === "warn")).toMatchObject({ reason: "invalid_body", stepIndex: 1 });
  });

  it.each([
    [409, "round_not_open"],
    [409, "event_out_of_order"],
    [409, "stale_claim_epoch"],
    [409, "idempotency_key_conflict"],
    [400, "invalid_request"],
  ])("abandons the Round when Galley refuses it with %i %s", async (status, code) => {
    const fetchFn = answering(created, error(status, code));
    const harness = start([START, step("x")], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("abandoned");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(harness.records().at(-1)).toMatchObject({ level: "error", step: name, stepIndex: 1, errorCode: code });
  });

  it(`confirms a Stop that arrives before the ${name} step instead of sending it`, async () => {
    const fetchFn = answering();
    const harness = start([START, wait(60_000), step("never sent")], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort("55555555-5555-4555-8555-555555555555");
    expect(await harness.run).toBe("stopped");
    expect(sent(fetchFn).map((event) => event.type)).toEqual(["execution_started", "stop_confirmed"]);
  });

  it(`returns ${state} when the report in flight lands after a Stop request, and confirms nothing`, async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => (resolve = done));
    let calls = 0;
    const fetchFn = vi.fn<FetchFn>(() => (++calls === 1 ? Promise.resolve(created()) : pending));
    const harness = start([START, step("x")], fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    harness.stopper.abort("55555555-5555-4555-8555-555555555555");
    resolve(endedResult(201)());
    expect(await harness.run).toBe(state);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("the ask step", () => {
  const QUESTION = "Which region should the report cover?";
  const ASK: EngineStep = { step: "ask", question: QUESTION };
  const questionId = questionIdFor(ROUND_ID, 1);
  const raised = () => json({ roundId: ROUND_ID, type: "question_raised", state: "waiting_for_input", startedAt: "2026-10-01T12:00:00Z", questionId }, 201);
  const resumed = () => json({ roundId: ROUND_ID, type: "resumed", state: "running", startedAt: "2026-10-01T12:00:00Z", questionId }, 201);
  const noted = (seq: number) => () => json({ roundId: ROUND_ID, type: "progress", state: "running", startedAt: "2026-10-01T12:00:00Z", seq }, 201);
  const stopped = () => json({ roundId: ROUND_ID, type: "stop_confirmed", state: "stopped", startedAt: "2026-10-01T12:00:00Z", endedAt: "2026-10-01T12:00:09Z" }, 201);
  const bodies = (fetchFn: ReturnType<typeof sequence>) => fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

  it("derives a stable version 5 questionId from the Round and the step index", () => {
    expect(questionIdFor(ROUND_ID, 1)).toBe(questionId);
    expect(questionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(questionIdFor(ROUND_ID, 2)).not.toBe(questionId);
    expect(questionIdFor("77777777-7777-4777-8777-777777777778", 1)).not.toBe(questionId);
  });

  it("raises the question keyed by its id, waits for the answer, resumes the same Round, acknowledges, notes the answer and continues", async () => {
    const inbox = new AnswerInbox();
    const acknowledged: string[] = [];
    const fetchFn = sequence(created, raised, resumed, noted(1), noted(2));
    const harness = start([START, ASK, { step: "progress", note: "after the answer" }], fetchFn, { awaitAnswer: inbox.wait });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(bodies(fetchFn).map((body) => body["type"])).toEqual(["execution_started", "question_raised"]);
    expect(bodies(fetchFn)[1]).toMatchObject({ idempotencyKey: questionId, claimEpoch: 3, data: { questionId, text: QUESTION } });
    expect(harness.records().map((record) => record["msg"])).toContain("engine waiting for an answer");

    inbox.deliver(questionId, { text: "Only the EU", acknowledge: async () => void acknowledged.push(questionId) });
    expect(await harness.run).toBe("completed");
    const sent = bodies(fetchFn);
    expect(sent.map((body) => body["type"])).toEqual(["execution_started", "question_raised", "resumed", "progress", "progress"]);
    expect(sent[2]).toMatchObject({ idempotencyKey: `${ROUND_ID}:1`, data: { questionId } });
    expect(sent[3]).toMatchObject({ idempotencyKey: `${ROUND_ID}:1:answer`, data: { note: "Owner's answer: Only the EU" } });
    expect(sent[4]).toMatchObject({ idempotencyKey: `${ROUND_ID}:2`, data: { note: "after the answer" } });
    expect(acknowledged).toEqual([questionId]);
  });

  it("acknowledges the answer only after Galley records the resume", async () => {
    const inbox = new AnswerInbox();
    const order: string[] = [];
    const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { type: string };
      order.push(body.type);
      return { execution_started: created, question_raised: raised, resumed, progress: noted(1) }[body.type as "resumed"]();
    });
    inbox.deliver(questionId, { text: "yes", acknowledge: async () => void order.push("ack") });
    const harness = start([START, ASK], fetchFn, { awaitAnswer: inbox.wait });
    expect(await harness.run).toBe("completed");
    expect(order).toEqual(["execution_started", "question_raised", "resumed", "ack", "progress"]);
  });

  it("truncates the answer note to Galley's note limit", () => {
    expect([...answerNote("界".repeat(2000))]).toHaveLength(2000);
    expect(answerNote("yes")).toBe("Owner's answer: yes");
  });

  it("confirms a Stop that arrives while waiting, without resuming", async () => {
    const inbox = new AnswerInbox();
    const fetchFn = sequence(created, raised, stopped);
    const harness = start([START, ASK, { step: "progress", note: "never" }], fetchFn, { awaitAnswer: inbox.wait });
    await vi.advanceTimersByTimeAsync(5_000);
    harness.stopper.abort("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(await harness.run).toBe("stopped");
    const sent = bodies(fetchFn);
    expect(sent.map((body) => body["type"])).toEqual(["execution_started", "question_raised", "stop_confirmed"]);
    expect(sent[2]).toMatchObject({
      idempotencyKey: `${ROUND_ID}:stop`,
      data: { evidence: "Stopped while waiting for the answer to step 2 of 3 on Stop command aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
  });

  it("prefers a Stop delivered beside the answer and leaves the answer unacknowledged", async () => {
    const inbox = new AnswerInbox();
    let acknowledged = false;
    const fetchFn = sequence(created, raised, stopped);
    const harness = start([START, ASK], fetchFn, { awaitAnswer: inbox.wait });
    await vi.advanceTimersByTimeAsync(1_000);
    harness.stopper.abort("stop");
    inbox.deliver(questionId, { text: "late", acknowledge: async () => void (acknowledged = true) });
    expect(await harness.run).toBe("stopped");
    expect(bodies(fetchFn).map((body) => body["type"])).not.toContain("resumed");
    expect(acknowledged).toBe(false);
  });

  it("prefers a Stop that lands in the same tick as an answer already handed over", async () => {
    const inbox = new AnswerInbox();
    let acknowledged = false;
    const fetchFn = sequence(created, raised, stopped);
    const harness = start([START, ASK], fetchFn, { awaitAnswer: inbox.wait });
    await vi.advanceTimersByTimeAsync(1_000);
    inbox.deliver(questionId, { text: "just in time", acknowledge: async () => void (acknowledged = true) });
    harness.stopper.abort("stop");
    expect(await harness.run).toBe("stopped");
    expect(bodies(fetchFn).map((body) => body["type"])).toEqual(["execution_started", "question_raised", "stop_confirmed"]);
    expect(acknowledged).toBe(false);
  });

  it("answers shutdown while waiting with aborted and reports nothing more", async () => {
    const inbox = new AnswerInbox();
    const fetchFn = sequence(created, raised);
    const harness = start([START, ASK], fetchFn, { awaitAnswer: inbox.wait });
    await vi.advanceTimersByTimeAsync(1_000);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("waits until stopped when no answer channel is wired", async () => {
    const fetchFn = sequence(created, raised, stopped);
    const harness = start([START, ASK], fetchFn);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    harness.stopper.abort("stop");
    expect(await harness.run).toBe("stopped");
  });

  it.each([
    ["a state other than waiting_for_input", { state: "running" }],
    ["another questionId", { questionId: questionIdFor(ROUND_ID, 9) }],
    ["no questionId", { questionId: undefined }],
  ])("retries rather than waits when the question result carries %s", async (_name, change) => {
    const inbox = new AnswerInbox();
    inbox.deliver(questionId, { text: "yes", acknowledge: async () => {} });
    const fetchFn = sequence(created, () => json({ roundId: ROUND_ID, type: "question_raised", state: "waiting_for_input", startedAt: "2026-10-01T12:00:00Z", questionId, ...change }, 201));
    const harness = start([START, ASK], fetchFn, { awaitAnswer: inbox.wait });
    await vi.advanceTimersByTimeAsync(3_500);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
    expect(bodies(fetchFn).map((body) => body["type"])).toEqual(["execution_started", "question_raised", "question_raised", "question_raised"]);
    expect(harness.records().some((record) => record["msg"] === "round event failed; retrying" && record["reason"] === "invalid_body")).toBe(true);
  });

  it("abandons the Round when Galley refuses the resume, without acknowledging the answer", async () => {
    const inbox = new AnswerInbox();
    let acknowledged = false;
    inbox.deliver(questionId, { text: "yes", acknowledge: async () => void (acknowledged = true) });
    const fetchFn = sequence(created, raised, error(409, "answer_not_supplied"));
    const harness = start([START, ASK], fetchFn, { awaitAnswer: inbox.wait });
    expect(await harness.run).toBe("abandoned");
    expect(acknowledged).toBe(false);
  });

  it("raises a fresh question for a second ask step", async () => {
    const inbox = new AnswerInbox();
    const second = questionIdFor(ROUND_ID, 2);
    inbox.deliver(questionId, { text: "one", acknowledge: async () => {} });
    inbox.deliver(second, { text: "two", acknowledge: async () => {} });
    const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { type: string; data: { questionId?: string } };
      const id = body.data.questionId;
      switch (body.type) {
        case "question_raised":
          return json({ roundId: ROUND_ID, type: "question_raised", state: "waiting_for_input", startedAt: "2026-10-01T12:00:00Z", questionId: id }, 201);
        case "resumed":
          return json({ roundId: ROUND_ID, type: "resumed", state: "running", startedAt: "2026-10-01T12:00:00Z", questionId: id }, 201);
        case "progress":
          return noted(1)();
        default:
          return created();
      }
    });
    const harness = start([START, ASK, { step: "ask", question: "And the year?" }], fetchFn, { awaitAnswer: inbox.wait });
    expect(await harness.run).toBe("completed");
    const raisedIds = bodies(fetchFn).filter((body) => body["type"] === "question_raised").map((body) => (body["data"] as { questionId: string }).questionId);
    expect(raisedIds).toEqual([questionId, second]);
  });
});

describe("the act step", () => {
  const CHECKS_PATH = `/api/runner/rounds/${ROUND_ID}/authority-checks`;
  const ACT: EngineStep = { step: "act", account: "controlled", action: "write_note", resource: "notes/weekly-report" };
  const SCOPE = { account: "controlled", action: "write_note", resource: "notes/weekly-report" };
  const GRANT = "12121212-1212-4212-8212-121212121212";
  const requestId = requestIdFor(ROUND_ID, 1);
  const startedAt = "2026-10-01T12:00:00Z";

  // A Galley whose grants the test changes between calls; each check answers from them as they are then.
  function galley(options: { checks?: (() => Response)[]; answer?: (body: Record<string, unknown>) => Response } = {}) {
    const state = { granted: false, checks: 0, sent: [] as { path: string; body: Record<string, unknown> }[] };
    const fetchFn = vi.fn<FetchFn>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.sent.push({ path, body });
      if (path === CHECKS_PATH) {
        state.checks++;
        const scripted = options.checks?.shift();
        if (scripted) return scripted();
        if (options.answer) return options.answer(body);
        return json(state.granted ? { decision: "allow", grantId: GRANT } : { decision: "deny" });
      }
      if (path !== EVENTS_PATH) throw new Error(`unexpected ${path}`);
      const data = body["data"] as Record<string, unknown>;
      switch (body["type"]) {
        case "permission_requested":
          return json({ roundId: ROUND_ID, type: "permission_requested", state: "waiting_for_input", startedAt, requestId: data["requestId"] }, 201);
        case "resumed":
          return json({ roundId: ROUND_ID, type: "resumed", state: "running", startedAt, requestId: data["requestId"] }, 201);
        case "progress":
          return json({ roundId: ROUND_ID, type: "progress", state: "running", startedAt, seq: state.sent.length }, 201);
        case "failed":
          return json({ roundId: ROUND_ID, type: "failed", state: "failed", startedAt, endedAt: startedAt }, 201);
        case "stop_confirmed":
          return json({ roundId: ROUND_ID, type: "stop_confirmed", state: "stopped", startedAt, endedAt: startedAt }, 201);
        default:
          return created();
      }
    });
    return { state, fetchFn };
  }
  const kinds = (sent: { path: string; body: Record<string, unknown> }[]) => sent.map(({ path, body }) => (path === CHECKS_PATH ? "check" : String(body["type"])));

  it("derives a stable version 5 requestId apart from the question ids", () => {
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requestIdFor(ROUND_ID, 1)).toBe(requestId);
    expect(requestId).not.toBe(questionIdFor(ROUND_ID, 1));
    expect(requestIdFor(ROUND_ID, 2)).not.toBe(requestId);
  });

  it("checks authority with the claim's epoch and performs an allowed action as a progress note", async () => {
    const { state, fetchFn } = galley();
    state.granted = true;
    const harness = start([START, ACT], fetchFn);
    expect(await harness.run).toBe("completed");
    expect(kinds(state.sent)).toEqual(["execution_started", "check", "progress"]);
    expect(state.sent[1]?.body).toEqual({ ...SCOPE, epoch: 3 });
    expect(state.sent[2]?.body).toMatchObject({ idempotencyKey: `${ROUND_ID}:1`, data: { note: "Performed write_note on notes/weekly-report" } });
    expect(harness.records().find((record) => record["msg"] === "authority checked")).toMatchObject({ decision: "allow", grantId: GRANT, stepIndex: 1 });
  });

  it("asks for a Permission on a deny, waits, resumes on the approval, acknowledges, checks again and performs", async () => {
    const { state, fetchFn } = galley();
    const inbox = new ApprovalInbox();
    const order: string[] = [];
    fetchFn.mockImplementation(((original) => async (input, init) => {
      const response = await original(input, init);
      order.push(kinds(state.sent.slice(-1))[0]!);
      return response;
    })(fetchFn.getMockImplementation()!));
    const harness = start([START, ACT, { step: "progress", note: "after the action" }], fetchFn, { awaitApproval: inbox.wait });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(kinds(state.sent)).toEqual(["execution_started", "check", "permission_requested"]);
    expect(state.sent[2]?.body).toMatchObject({ idempotencyKey: requestId, claimEpoch: 3, data: { requestId, ...SCOPE } });
    expect(harness.records().map((record) => record["msg"])).toContain("engine waiting for an approval");

    state.granted = true;
    inbox.deliver(requestId, { grantId: GRANT, acknowledge: async () => void order.push("ack") });
    expect(await harness.run).toBe("completed");
    expect(order).toEqual(["execution_started", "check", "permission_requested", "resumed", "ack", "check", "progress", "progress"]);
    const resumed = state.sent.find(({ body }) => body["type"] === "resumed");
    expect(resumed?.body).toMatchObject({ idempotencyKey: `${ROUND_ID}:1:resumed`, data: { requestId } });
    expect(state.sent.filter(({ body }) => body["type"] === "progress").map(({ body }) => (body["data"] as { note: string }).note)).toEqual([
      "Performed write_note on notes/weekly-report",
      "after the action",
    ]);
  });

  it("never caches an allow: each act step checks again, and a grant gone by the second check is not used", async () => {
    const { state, fetchFn } = galley({ checks: [() => json({ decision: "allow", grantId: GRANT }), () => json({ decision: "deny" })] });
    const harness = start([START, ACT, ACT], fetchFn);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kinds(state.sent)).toEqual(["execution_started", "check", "progress", "check", "permission_requested"]);
    expect(state.checks).toBe(2);
    harness.stopper.abort("stop");
    expect(await harness.run).toBe("stopped");
  });

  it("reuses a grant across act steps without a second request, checking before each", async () => {
    const { state, fetchFn } = galley();
    const inbox = new ApprovalInbox();
    inbox.deliver(requestId, { grantId: GRANT, acknowledge: async () => void (state.granted = true) });
    const harness = start([START, ACT, ACT], fetchFn, { awaitApproval: inbox.wait });
    expect(await harness.run).toBe("completed");
    expect(kinds(state.sent)).toEqual(["execution_started", "check", "permission_requested", "resumed", "check", "progress", "check", "progress"]);
  });

  it("fails the Round rather than asking again when Galley still denies after the approval", async () => {
    const { state, fetchFn } = galley();
    const inbox = new ApprovalInbox();
    inbox.deliver(requestId, { grantId: GRANT, acknowledge: async () => {} });
    const harness = start([START, ACT, { step: "progress", note: "never" }], fetchFn, { awaitApproval: inbox.wait });
    expect(await harness.run).toBe("failed");
    expect(kinds(state.sent)).toEqual(["execution_started", "check", "permission_requested", "resumed", "check", "failed"]);
    expect(state.sent.at(-1)?.body).toMatchObject({
      idempotencyKey: `${ROUND_ID}:1:failed`,
      data: { explanation: "Could not write_note on notes/weekly-report with the controlled account: Galley still denies it after the Owner's approval" },
    });
  });

  it("fails the Round on a capability the Connected Account does not declare, without asking for a Permission", async () => {
    const { state, fetchFn } = galley({ checks: [error(400, "capability_not_supported")] });
    const harness = start([START, { step: "act", account: "github", action: "push", resource: "repo" }], fetchFn);
    expect(await harness.run).toBe("failed");
    expect(kinds(state.sent)).toEqual(["execution_started", "check", "failed"]);
    expect(state.sent.at(-1)?.body).toMatchObject({ data: { explanation: "Could not push on repo with the github account: the Connected Account does not declare this capability" } });
    expect(harness.records().find((record) => record["msg"] === "authority check refused an undeclared capability")).toMatchObject({ httpStatus: 400, errorCode: "capability_not_supported" });
  });

  it("abandons the Round on M5.7's retired unsupported_scope code like any other refusal", async () => {
    const { state, fetchFn } = galley({ checks: [error(400, "unsupported_scope")] });
    const harness = start([START, ACT], fetchFn);
    expect(await harness.run).toBe("abandoned");
    expect(kinds(state.sent)).toEqual(["execution_started", "check"]);
  });

  it("performs different declared actions under one full-access approval with one request, and fails on an undeclared one", async () => {
    const FULL = "34343434-3434-4434-8434-343434343434";
    const declared = new Set(["write_note", "read_note", "post_message"]);
    const { state, fetchFn } = galley({
      answer: (body) => {
        if (!declared.has(String(body["action"]))) return error(400, "capability_not_supported")();
        return json(state.granted ? { decision: "allow", grantId: FULL } : { decision: "deny" });
      },
    });
    const inbox = new ApprovalInbox();
    inbox.deliver(requestId, { grantId: FULL, acknowledge: async () => void (state.granted = true) });
    const READ: EngineStep = { step: "act", account: "controlled", action: "read_note", resource: "notes/team-digest" };
    const POST: EngineStep = { step: "act", account: "controlled", action: "post_message", resource: "channels/general" };
    const DELETE: EngineStep = { step: "act", account: "controlled", action: "delete_note", resource: "notes/weekly-report" };
    const harness = start([START, ACT, READ, POST, ACT, DELETE, { step: "progress", note: "never" }], fetchFn, { awaitApproval: inbox.wait });
    expect(await harness.run).toBe("failed");
    expect(kinds(state.sent)).toEqual([
      "execution_started", "check", "permission_requested", "resumed", "check", "progress", "check", "progress", "check", "progress", "check", "progress", "check", "failed",
    ]);
    expect(state.sent.filter(({ body }) => body["type"] === "permission_requested")).toHaveLength(1);
    expect(state.sent.filter(({ body }) => body["type"] === "progress").map(({ body }) => (body["data"] as { note: string }).note)).toEqual([
      "Performed write_note on notes/weekly-report",
      "Performed read_note on notes/team-digest",
      "Performed post_message on channels/general",
      "Performed write_note on notes/weekly-report",
    ]);
    expect(state.sent.at(-1)?.body).toMatchObject({ data: { explanation: "Could not delete_note on notes/weekly-report with the controlled account: the Connected Account does not declare this capability" } });
  });

  it("confirms a Stop that arrives while waiting for the approval, without resuming", async () => {
    const { state, fetchFn } = galley();
    const inbox = new ApprovalInbox();
    let acknowledged = false;
    const harness = start([START, ACT], fetchFn, { awaitApproval: inbox.wait });
    await vi.advanceTimersByTimeAsync(5_000);
    harness.stopper.abort("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    inbox.deliver(requestId, { grantId: GRANT, acknowledge: async () => void (acknowledged = true) });
    expect(await harness.run).toBe("stopped");
    expect(kinds(state.sent)).toEqual(["execution_started", "check", "permission_requested", "stop_confirmed"]);
    expect(state.sent.at(-1)?.body).toMatchObject({
      data: { evidence: "Stopped while waiting for the approval to step 2 of 2 on Stop command aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    expect(acknowledged).toBe(false);
  });

  it("waits until stopped when no approval arrives, as after a decline", async () => {
    const { state, fetchFn } = galley();
    const harness = start([START, ACT], fetchFn, { awaitApproval: new ApprovalInbox().wait });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(kinds(state.sent)).toEqual(["execution_started", "check", "permission_requested"]);
    harness.stopper.abort("stop");
    expect(await harness.run).toBe("stopped");
  });

  it("retries a check through 5xx and network failures and abandons on a refusal", async () => {
    const retried = galley({ checks: [error(503, "database_unavailable"), refused] });
    retried.state.granted = true;
    const harness = start([START, ACT], retried.fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");
    expect(kinds(retried.state.sent)).toEqual(["execution_started", "check", "check", "check", "progress"]);

    for (const code of ["stale_claim_epoch", "round_not_open", "round_not_running"]) {
      const refusedCheck = galley({ checks: [error(409, code)] });
      expect(await start([START, ACT], refusedCheck.fetchFn).run).toBe("abandoned");
      expect(kinds(refusedCheck.state.sent)).toEqual(["execution_started", "check"]);
    }
  });

  it.each([
    ["an allow without its grant", { decision: "allow" }],
    ["a deny naming a grant", { decision: "deny", grantId: GRANT }],
    ["another decision", { decision: "maybe" }],
    ["an allow naming an expired grant", { decision: "allow", grantId: GRANT, expiredGrantId: GRANT }],
    ["a deny naming an expired grant that is not a string", { decision: "deny", expiredGrantId: 7 }],
    ["a deny naming an expired grant as null", { decision: "deny", expiredGrantId: null }],
  ])("retries a check whose result is %s", async (_name, body) => {
    const { state, fetchFn } = galley({ checks: [() => json(body)] });
    state.granted = true;
    const harness = start([START, ACT], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");
    expect(kinds(state.sent)).toEqual(["execution_started", "check", "check", "progress"]);
    expect(harness.records().some((record) => record["msg"] === "authority check failed; retrying" && record["reason"] === "invalid_body")).toBe(true);
  });

  it("retries rather than waits when the request result names another request", async () => {
    const { state, fetchFn } = galley();
    const original = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body["type"] === "permission_requested") {
        state.sent.push({ path: EVENTS_PATH, body });
        return json({ roundId: ROUND_ID, type: "permission_requested", state: "waiting_for_input", startedAt, requestId: requestIdFor(ROUND_ID, 9) }, 201);
      }
      return original(input, init);
    });
    const harness = start([START, ACT], fetchFn);
    await vi.advanceTimersByTimeAsync(3_500);
    harness.controller.abort();
    expect(await harness.run).toBe("aborted");
    expect(kinds(state.sent)).toEqual(["execution_started", "check", "permission_requested", "permission_requested", "permission_requested"]);
  });

  describe("an expired time grant", () => {
    const EXPIRED = "34343434-3434-4434-8434-343434343434";
    const RENEWED = "56565656-5656-4656-8656-565656565656";
    const READ: EngineStep = { step: "act", account: "controlled", action: "read_note", resource: "notes/weekly-report" };
    const READ_GRANT = "78787878-7878-4878-8878-787878787878";

    // write_note's time grant has expired; read_note holds a live grant throughout.
    function expiredWrite(renewed: { value: boolean }) {
      return galley({
        answer: (body) => {
          if (body["action"] === "read_note") return json({ decision: "allow", grantId: READ_GRANT });
          return json(renewed.value ? { decision: "allow", grantId: RENEWED } : { decision: "deny", expiredGrantId: EXPIRED });
        },
      });
    }

    it("raises a renewal naming the expired grant only at the act step that needs it, while other act steps keep running", async () => {
      const renewed = { value: false };
      const { state, fetchFn } = expiredWrite(renewed);
      const inbox = new ApprovalInbox();
      const renewal = requestIdFor(ROUND_ID, 2);
      inbox.deliver(renewal, { grantId: RENEWED, acknowledge: async () => void (renewed.value = true) });
      const harness = start([START, READ, ACT, READ], fetchFn, { awaitApproval: inbox.wait });
      expect(await harness.run).toBe("completed");
      expect(kinds(state.sent)).toEqual(["execution_started", "check", "progress", "check", "permission_requested", "resumed", "check", "progress", "check", "progress"]);
      const requests = state.sent.filter(({ body }) => body["type"] === "permission_requested");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toMatchObject({ idempotencyKey: renewal, data: { requestId: renewal, ...SCOPE, renewsGrantId: EXPIRED } });
      expect(Object.keys(requests[0]?.body["data"] as object).sort()).toEqual(["account", "action", "renewsGrantId", "requestId", "resource"]);
      expect(state.sent.filter(({ path }) => path === CHECKS_PATH).map(({ body }) => body["action"])).toEqual(["read_note", "write_note", "write_note", "read_note"]);
      expect(harness.records().filter((record) => record["msg"] === "authority checked").map((record) => record["expiredGrantId"])).toEqual([undefined, EXPIRED, undefined, undefined]);
      expect(harness.records().find((record) => record["msg"] === "permission requested")).toMatchObject({ requestId: renewal, renewsGrantId: EXPIRED });
    });

    it("never raises a request while every act step's scope is still granted", async () => {
      const { state, fetchFn } = expiredWrite({ value: false });
      const harness = start([START, READ, READ, READ], fetchFn);
      expect(await harness.run).toBe("completed");
      expect(kinds(state.sent)).toEqual(["execution_started", "check", "progress", "check", "progress", "check", "progress"]);
    });

    it("names no grant to renew after a plain deny", async () => {
      const { state, fetchFn } = galley();
      const harness = start([START, ACT], fetchFn, { awaitApproval: new ApprovalInbox().wait });
      await vi.advanceTimersByTimeAsync(5_000);
      const request = state.sent.find(({ body }) => body["type"] === "permission_requested");
      expect(Object.keys(request?.body["data"] as object).sort()).toEqual(["account", "action", "requestId", "resource"]);
      harness.stopper.abort("stop");
      expect(await harness.run).toBe("stopped");
    });

    it("fails the Round rather than renewing twice when the scope is still denied after the approval", async () => {
      const { state, fetchFn } = expiredWrite({ value: false });
      const inbox = new ApprovalInbox();
      inbox.deliver(requestIdFor(ROUND_ID, 1), { grantId: RENEWED, acknowledge: async () => {} });
      const harness = start([START, ACT, ACT], fetchFn, { awaitApproval: inbox.wait });
      expect(await harness.run).toBe("failed");
      expect(kinds(state.sent)).toEqual(["execution_started", "check", "permission_requested", "resumed", "check", "failed"]);
    });
  });

  it("truncates the performance note to Galley's note limit", () => {
    expect([...performedNote({ step: "act", account: "controlled", action: "a".repeat(200), resource: "界".repeat(2000) })]).toHaveLength(2000);
  });
});

describe("feedback from earlier Rounds", () => {
  const FEEDBACK: RunnerClaim["ticket"]["feedback"] = [
    { roundId: "66666666-6666-4666-8666-666666666666", roundSequence: 1, body: "Cover the EU too.", createdAt: "2026-10-01T11:00:00Z" },
    { roundId: "66666666-6666-4666-8666-666666666666", roundSequence: 1, body: "Line one\n\tline two", createdAt: "2026-10-01T11:05:00Z" },
  ];
  const claimWith = (feedback: RunnerClaim["ticket"]["feedback"]): RunnerClaim => ({ ...CLAIM, ticket: { ...CLAIM.ticket, feedback } });

  it("notes the feedback it received right after starting, keyed apart from the script's steps", async () => {
    const fetchFn = answering();
    const harness = start([START, NOTE("Reading the Ticket")], fetchFn, { instantSleep: true, claim: claimWith(FEEDBACK) });
    expect(await harness.run).toBe("completed");

    expect(sent(fetchFn).map((event) => [event.type, event.idempotencyKey])).toEqual([
      ["execution_started", `${ROUND_ID}:0`],
      ["progress", `${ROUND_ID}:0:feedback`],
      ["progress", `${ROUND_ID}:1`],
    ]);
    expect(sent(fetchFn)[1]!.data).toEqual({ note: "Owner's feedback received (2 comments):\nRound 1: Cover the EU too.\nRound 1: Line one\n\tline two" });
    expect(harness.records().find((record) => record["msg"] === "feedback reported")).toMatchObject({ step: "progress", stepIndex: 0, feedback: 2, seq: 1 });
  });

  it("adds no note when the claim carries no feedback", async () => {
    const fetchFn = answering();
    const harness = start([START, NOTE("Reading the Ticket")], fetchFn, { instantSleep: true });
    expect(await harness.run).toBe("completed");
    expect(sent(fetchFn).map((event) => event.type)).toEqual(["execution_started", "progress"]);
  });

  it("retries the feedback note with the identical body and abandons the Round when Galley refuses it", async () => {
    const retried = answering(created, refused, error(503, "database_unavailable"));
    expect(await start([START], retried, { instantSleep: true, claim: claimWith(FEEDBACK) }).run).toBe("completed");
    const bodies = retried.mock.calls.map(([, init]) => String(init?.body));
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies.slice(1)).size).toBe(1);

    const refusedNote = sequence(created, error(400, "invalid_request"));
    expect(await start([START, NOTE("never sent")], refusedNote, { instantSleep: true, claim: claimWith(FEEDBACK) }).run).toBe("abandoned");
    expect(refusedNote).toHaveBeenCalledTimes(2);
  });

  it("writes one deterministic note and truncates it to Galley's note limit", () => {
    expect(feedbackNote(FEEDBACK.slice(0, 1))).toBe("Owner's feedback received (1 comment):\nRound 1: Cover the EU too.");
    const long = [1, 2, 3].map((n) => ({ ...FEEDBACK[0]!, roundSequence: n, body: "界".repeat(10_000) }));
    const note = feedbackNote(long);
    expect([...note]).toHaveLength(2000);
    expect(note.startsWith("Owner's feedback received (3 comments):\nRound 1: 界")).toBe(true);
    expect(feedbackNote(long)).toBe(note);
  });
});
