import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startClaimLoop } from "./claimLoop.ts";
import { resolveRunnerCredential } from "./credentials.ts";
import { questionIdFor, requestIdFor } from "./engine.ts";
import type { EngineScript } from "./engineScript.ts";
import type { FetchFn } from "./galley/client.ts";
import { createLogger } from "./logger.ts";

const GALLEY = new URL("http://galley.test:8080/");
const TOKEN = `tir_${"c".repeat(43)}`;
const START_HOLD: EngineScript = { steps: [{ step: "start" }, { step: "hold" }] };
const START_WAIT: EngineScript = { steps: [{ step: "start" }, { step: "wait", ms: 60_000 }, { step: "progress", note: "after the wait" }] };

const CLAIM = {
  roundId: "77777777-7777-4777-8777-777777777777",
  sequence: 1,
  claimEpoch: 2,
  ticket: { id: "88888888-8888-4888-8888-888888888888", title: "Write the report", goal: "g", context: "c", successCriteria: "s", constraints: "", repository: "", feedback: [] },
  agent: { id: "99999999-9999-4999-8999-999999999999", name: "atlas", kind: "research" },
};
const STOP = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "stop", claimEpoch: 2, issuedAt: "2026-10-02T12:00:00Z" };
const STALE_STOP = { ...STOP, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", claimEpoch: 1 };
const UNKNOWN = { ...STOP, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", type: "pause" };

const claimsPath = "/api/runner/claims";
const eventPath = `/api/runner/rounds/${CLAIM.roundId}/events`;
const commandsPath = `/api/runner/rounds/${CLAIM.roundId}/commands`;
const ackPath = (commandId: string) => `${commandsPath}/${commandId}/ack`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const noWork = () => new Response(null, { status: 204 });
const claimed = () => json(CLAIM, 201);
const created = () => json({ roundId: CLAIM.roundId, type: "execution_started", state: "running", startedAt: "2026-10-02T11:59:00Z" }, 201);
const stopConfirmed = () => json({ roundId: CLAIM.roundId, type: "stop_confirmed", state: "stopped", startedAt: "2026-10-02T11:59:00Z", endedAt: "2026-10-02T12:00:04Z" }, 201);
const listing = (...commands: unknown[]) => () => json({ commands });
const unavailable = (status: number) => () => json({ error: { code: "database_unavailable", message: "try again" } }, status);
const alreadyAcknowledged = () => json({ error: { code: "command_already_acknowledged", message: "another outcome" } }, 409);

type Route = (() => Response)[];

const checksPath = `/api/runner/rounds/${CLAIM.roundId}/authority-checks`;

function galley(routes: { claims?: Route; commands: Route; ack?: Route; events?: Route; checks?: Route }) {
  const claims = routes.claims ?? [noWork, claimed, noWork];
  const acks = routes.ack ?? [];
  const events = routes.events ?? [created, stopConfirmed];
  return vi.fn<FetchFn>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const queue =
      path === claimsPath
        ? claims
        : path === eventPath
          ? events
          : path === commandsPath
            ? routes.commands
            : path.startsWith(`${commandsPath}/`)
              ? acks
              : path === checksPath
                ? routes.checks
                : undefined;
    if (!queue) throw new Error(`unexpected ${String(input)}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next) return next();
    const { outcome } = JSON.parse(String(init?.body)) as { outcome: string };
    return json({ id: path.split("/")[6], acknowledgedAt: "2026-10-02T12:00:05Z", outcome });
  });
}

function credential() {
  const resolved = resolveRunnerCredential({ MICHELIN_RUNNER_TOKEN: TOKEN }, []);
  if (!resolved) throw new Error("test credential rejected");
  return resolved;
}

function setup(fetchFn: FetchFn, engineScript: EngineScript = START_HOLD) {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const loop = startClaimLoop({
    galleyUrl: GALLEY,
    intervalMs: 1000,
    commandIntervalMs: 1000,
    fetch: fetchFn,
    logger,
    credential: credential(),
    registration: { registered: true, reconcileRequired: false, reconcileRaised: 0 },
    requestTimeoutMs: 300,
    engineScript,
  });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const messages = () => records().map((record) => record["msg"]);
  return { loop, records, messages };
}

const calls = (fetchFn: ReturnType<typeof galley>, path: string) => fetchFn.mock.calls.filter(([input]) => new URL(String(input)).pathname === path);
const ackBodies = (fetchFn: ReturnType<typeof galley>, commandId: string) => calls(fetchFn, ackPath(commandId)).map(([, init]) => JSON.parse(String(init?.body)) as unknown);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("command loop", () => {
  it("polls the Round's commands only while a Round is held", async () => {
    const fetchFn = galley({ claims: [noWork, noWork, claimed], commands: [listing()] });
    const { loop } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(2000);
    expect(calls(fetchFn, commandsPath)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls(fetchFn, eventPath)).toHaveLength(1);
    expect(calls(fetchFn, commandsPath)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3000);
    expect(calls(fetchFn, commandsPath)).toHaveLength(3);
    const [, init] = calls(fetchFn, commandsPath)[0] ?? [];
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
    await loop.stop();
  });

  it.each([
    ["hold", START_HOLD, 1],
    ["wait", START_WAIT, 2],
  ] as const)("stops the engine during a %s, then acknowledges the Stop applied once and resumes claiming", async (_step, script, stepIndex) => {
    const fetchFn = galley({ commands: [listing(), listing(STOP), listing()] });
    const { loop, records, messages } = setup(fetchFn, script);

    await vi.advanceTimersByTimeAsync(4000);

    expect(messages()).toEqual(["round claimed", "execution started reported", ...(script === START_HOLD ? ["engine holding"] : []), "stop requested", "engine stopped", "stop confirmation reported", "command acknowledged"]);
    expect(records().find((record) => record["msg"] === "engine stopped")).toMatchObject({ roundId: CLAIM.roundId, stepIndex });
    expect(records().find((record) => record["msg"] === "command acknowledged")).toMatchObject({ commandId: STOP.id, outcome: "applied", attempt: 1 });
    expect(ackBodies(fetchFn, STOP.id)).toEqual([{ outcome: "applied" }]);
    const events = calls(fetchFn, eventPath).map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(events.map((event) => event["type"])).toEqual(["execution_started", "stop_confirmed"]);
    expect(events[1]).toMatchObject({ idempotencyKey: `${CLAIM.roundId}:stop`, claimEpoch: CLAIM.claimEpoch, data: { evidence: `Stopped before step ${stepIndex + 1} of ${script.steps.length} on Stop command ${STOP.id}` } });
    const ackAt = fetchFn.mock.calls.findIndex(([input]) => new URL(String(input)).pathname === ackPath(STOP.id));
    expect(fetchFn.mock.calls.slice(ackAt + 1).every(([input]) => new URL(String(input)).pathname === claimsPath)).toBe(true);

    const claimsBefore = calls(fetchFn, claimsPath).length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls(fetchFn, claimsPath).length).toBe(claimsBefore + 2);
    expect(calls(fetchFn, commandsPath)).toHaveLength(2);
    await loop.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("acknowledges the Stop applied only once the confirmation lands through 5xx retries", async () => {
    const fetchFn = galley({ commands: [listing(STOP), listing()], events: [created, unavailable(503), unavailable(500), stopConfirmed] });
    const { loop, messages } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(3000);
    expect(calls(fetchFn, eventPath)).toHaveLength(2);
    expect(calls(fetchFn, ackPath(STOP.id))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls(fetchFn, eventPath)).toHaveLength(3);
    expect(calls(fetchFn, ackPath(STOP.id))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);

    expect(calls(fetchFn, eventPath)).toHaveLength(4);
    expect(ackBodies(fetchFn, STOP.id)).toEqual([{ outcome: "applied" }]);
    const confirmedAt = fetchFn.mock.calls.findLastIndex(([input]) => new URL(String(input)).pathname === eventPath);
    const ackAt = fetchFn.mock.calls.findIndex(([input]) => new URL(String(input)).pathname === ackPath(STOP.id));
    expect(ackAt).toBeGreaterThan(confirmedAt);
    expect(messages().slice(-2)).toEqual(["stop confirmation reported", "command acknowledged"]);
    await loop.stop();
  });

  it("acknowledges nothing and resumes claiming when Galley refuses the confirmation", async () => {
    const refusal = () => json({ error: { code: "round_not_open", message: "this Round is no longer open" } }, 409);
    const fetchFn = galley({ commands: [listing(STOP), listing()], events: [created, refusal] });
    const { loop, records, messages } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(6000);

    expect(records().find((record) => record["msg"] === "round event refused; round abandoned locally")).toMatchObject({ level: "error", step: "stop", httpStatus: 409, errorCode: "round_not_open" });
    expect(messages()).not.toContain("stop confirmation reported");
    expect(calls(fetchFn, ackPath(STOP.id))).toHaveLength(0);
    expect(calls(fetchFn, eventPath)).toHaveLength(2);
    expect(calls(fetchFn, claimsPath).length).toBeGreaterThan(2);
    await loop.stop();
  });

  it("sends no acknowledgement when the delivery in flight lands after the Stop", async () => {
    const delivered = () => json({ roundId: CLAIM.roundId, type: "delivered", state: "delivered", startedAt: "2026-10-02T11:59:00Z", endedAt: "2026-10-02T12:00:04Z" }, 201);
    const fetchFn = galley({ commands: [listing(STOP), listing()], events: [created, unavailable(503), unavailable(503), delivered] });
    const { loop, messages } = setup(fetchFn, { steps: [{ step: "start" }, { step: "deliver", bodyMarkdown: "# Result", summary: "Done.", criteriaAssessment: "Met." }] });

    await vi.advanceTimersByTimeAsync(6000);

    expect(messages()).toContain("stop requested");
    expect(messages()).toContain("engine delivered");
    expect(messages()).not.toContain("engine stopped");
    expect(calls(fetchFn, ackPath(STOP.id))).toHaveLength(0);
    expect(calls(fetchFn, eventPath)).toHaveLength(4);
    await loop.stop();
  });

  it("acknowledges a Stop for another claim epoch as ignored once, and the engine keeps holding", async () => {
    const fetchFn = galley({ commands: [listing(STALE_STOP)] });
    const { loop, records, messages } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(6000);

    expect(records().find((record) => record["msg"] === "command for another claim epoch ignored")).toMatchObject({ level: "warn", commandId: STALE_STOP.id, commandEpoch: 1, claimEpoch: 2 });
    expect(ackBodies(fetchFn, STALE_STOP.id)).toEqual([{ outcome: "ignored" }]);
    expect(messages()).not.toContain("engine stopped");
    expect(messages()).not.toContain("stop requested");
    expect(calls(fetchFn, commandsPath).length).toBeGreaterThanOrEqual(4);
    expect(calls(fetchFn, claimsPath)).toHaveLength(2);
    await loop.stop();
  });

  it("retries the acknowledgement through 5xx answers with growing backoff", async () => {
    const fetchFn = galley({ commands: [listing(STOP), listing()], ack: [unavailable(503), unavailable(502), () => json({ id: STOP.id, acknowledgedAt: "2026-10-02T12:00:05Z", outcome: "applied" })] });
    const { loop, records } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(3000);
    expect(ackBodies(fetchFn, STOP.id)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ackBodies(fetchFn, STOP.id)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(ackBodies(fetchFn, STOP.id)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ackBodies(fetchFn, STOP.id)).toHaveLength(3);

    const retries = records().filter((record) => record["msg"] === "command acknowledgement failed; retrying");
    expect(retries.map((record) => [record["httpStatus"], record["retryInMs"]])).toEqual([
      [503, 1000],
      [502, 2000],
    ]);
    expect(records().find((record) => record["msg"] === "command acknowledged")).toMatchObject({ attempt: 3, outcome: "applied" });
    await loop.stop();
  });

  it("does not retry an acknowledgement Galley refuses", async () => {
    const fetchFn = galley({ commands: [listing(STOP), listing()], ack: [alreadyAcknowledged] });
    const { loop, records } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(ackBodies(fetchFn, STOP.id)).toHaveLength(1);
    expect(records().find((record) => record["msg"] === "command acknowledgement refused")).toMatchObject({ level: "error", httpStatus: 409, errorCode: "command_already_acknowledged" });
    expect(calls(fetchFn, claimsPath).length).toBeGreaterThan(2);
    await loop.stop();
  });

  it("leaves an unknown command type unacknowledged, warns once, and keeps holding", async () => {
    const fetchFn = galley({ commands: [listing(UNKNOWN)] });
    const { loop, records, messages } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(6000);

    expect(calls(fetchFn, commandsPath).length).toBeGreaterThanOrEqual(4);
    expect(calls(fetchFn, ackPath(UNKNOWN.id))).toHaveLength(0);
    expect(records().filter((record) => record["msg"] === "unknown command left unacknowledged")).toEqual([expect.objectContaining({ level: "warn", commandId: UNKNOWN.id, type: "pause" })]);
    expect(messages()).not.toContain("engine stopped");
    await loop.stop();
  });

  it("logs a failed poll and keeps polling", async () => {
    const fetchFn = galley({ commands: [unavailable(503), listing(STOP), listing()] });
    const { loop, records, messages } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(4000);

    expect(records().find((record) => record["msg"] === "round commands poll failed")).toMatchObject({ level: "error", roundId: CLAIM.roundId, httpStatus: 503 });
    expect(messages()).toContain("engine stopped");
    expect(ackBodies(fetchFn, STOP.id)).toEqual([{ outcome: "applied" }]);
    await loop.stop();
  });

  it("stops polling on shutdown without logging a failure and leaves no timer", async () => {
    const fetchFn = galley({ commands: [listing()] });
    const { loop, messages } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(3000);
    expect(calls(fetchFn, commandsPath)).toHaveLength(1);
    await loop.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(messages()).not.toContain("round commands poll failed");
    expect(messages()).not.toContain("engine stopped");
  });
});

describe("answers", () => {
  const ASK: EngineScript = { steps: [{ step: "start" }, { step: "ask", question: "Which region?" }, { step: "hold" }] };
  const questionId = questionIdFor(CLAIM.roundId, 1);
  const ANSWER = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", type: "answer", claimEpoch: 2, issuedAt: "2026-10-02T12:00:01Z", answer: { questionId, text: "Only the EU" } };
  const STALE_ANSWER = { ...ANSWER, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", claimEpoch: 1 };
  const raised = () => json({ roundId: CLAIM.roundId, type: "question_raised", state: "waiting_for_input", startedAt: "2026-10-02T11:59:00Z", questionId }, 201);
  const resumed = () => json({ roundId: CLAIM.roundId, type: "resumed", state: "running", startedAt: "2026-10-02T11:59:00Z", questionId }, 201);
  const noted = () => json({ roundId: CLAIM.roundId, type: "progress", state: "running", startedAt: "2026-10-02T11:59:00Z", seq: 1 }, 201);
  const eventTypes = (fetchFn: ReturnType<typeof galley>) => calls(fetchFn, eventPath).map(([, init]) => (JSON.parse(String(init?.body)) as { type: string }).type);

  it("hands the answer to the waiting engine, which resumes the same Round and then acknowledges it applied", async () => {
    const fetchFn = galley({ commands: [listing(), listing(ANSWER), listing()], events: [created, raised, resumed, noted, stopConfirmed] });
    const { loop, messages } = setup(fetchFn, ASK);

    await vi.advanceTimersByTimeAsync(3000);
    expect(eventTypes(fetchFn)).toEqual(["execution_started", "question_raised"]);
    await vi.advanceTimersByTimeAsync(2000);

    expect(eventTypes(fetchFn)).toEqual(["execution_started", "question_raised", "resumed", "progress"]);
    expect(ackBodies(fetchFn, ANSWER.id)).toEqual([{ outcome: "applied" }]);
    const resumedAt = fetchFn.mock.calls.findIndex(([input, init]) => new URL(String(input)).pathname === eventPath && String(init?.body).includes('"resumed"'));
    const ackAt = fetchFn.mock.calls.findIndex(([input]) => new URL(String(input)).pathname === ackPath(ANSWER.id));
    expect(ackAt).toBeGreaterThan(resumedAt);
    expect(messages()).toEqual(expect.arrayContaining(["question raised", "engine waiting for an answer", "answer received", "resume reported", "command acknowledged", "engine holding"]));
    expect(calls(fetchFn, claimsPath)).toHaveLength(2);
    await loop.stop();
  });

  it("acknowledges an answer for another claim epoch as ignored and keeps waiting", async () => {
    const fetchFn = galley({ commands: [listing(STALE_ANSWER)], events: [created, raised] });
    const { loop, messages } = setup(fetchFn, ASK);

    await vi.advanceTimersByTimeAsync(6000);

    expect(ackBodies(fetchFn, STALE_ANSWER.id)).toEqual([{ outcome: "ignored" }]);
    expect(eventTypes(fetchFn)).toEqual(["execution_started", "question_raised"]);
    expect(messages()).not.toContain("answer received");
    await loop.stop();
  });

  it("stops while waiting when Stop is listed beside the answer, confirms it, and leaves the answer unacknowledged", async () => {
    const fetchFn = galley({ commands: [listing(), listing(STOP, ANSWER), listing()], events: [created, raised, stopConfirmed] });
    const { loop, records } = setup(fetchFn, ASK);

    await vi.advanceTimersByTimeAsync(6000);

    expect(eventTypes(fetchFn)).toEqual(["execution_started", "question_raised", "stop_confirmed"]);
    const confirmation = calls(fetchFn, eventPath).map(([, init]) => JSON.parse(String(init?.body)) as { data: { evidence?: string } })[2];
    expect(confirmation?.data.evidence).toBe(`Stopped while waiting for the answer to step 2 of 3 on Stop command ${STOP.id}`);
    expect(ackBodies(fetchFn, STOP.id)).toEqual([{ outcome: "applied" }]);
    expect(calls(fetchFn, ackPath(ANSWER.id))).toHaveLength(0);
    expect(records().some((record) => record["msg"] === "engine stopped")).toBe(true);
    await loop.stop();
  });

  it("treats an answer command without its payload as a malformed listing", async () => {
    const { answer: _answer, ...bare } = ANSWER;
    const fetchFn = galley({ commands: [listing(bare)], events: [created, raised] });
    const { loop, records } = setup(fetchFn, ASK);

    await vi.advanceTimersByTimeAsync(4000);

    expect(records().find((record) => record["msg"] === "round commands poll failed")).toMatchObject({ reason: "invalid_body" });
    expect(calls(fetchFn, ackPath(ANSWER.id))).toHaveLength(0);
    await loop.stop();
  });
});

describe("approvals", () => {
  const ACT: EngineScript = { steps: [{ step: "start" }, { step: "act", account: "controlled", action: "write_note", resource: "notes/weekly-report" }, { step: "hold" }] };
  const requestId = requestIdFor(CLAIM.roundId, 1);
  const grantId = "12121212-1212-4212-8212-121212121212";
  const APPROVAL = { id: "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0", type: "approval", claimEpoch: 2, issuedAt: "2026-10-02T12:00:01Z", approval: { requestId, grantId } };
  const STALE_APPROVAL = { ...APPROVAL, id: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1", claimEpoch: 1 };
  const requested = () => json({ roundId: CLAIM.roundId, type: "permission_requested", state: "waiting_for_input", startedAt: "2026-10-02T11:59:00Z", requestId }, 201);
  const resumed = () => json({ roundId: CLAIM.roundId, type: "resumed", state: "running", startedAt: "2026-10-02T11:59:00Z", requestId }, 201);
  const performed = () => json({ roundId: CLAIM.roundId, type: "progress", state: "running", startedAt: "2026-10-02T11:59:00Z", seq: 1 }, 201);
  const deny = () => json({ decision: "deny" });
  const allow = () => json({ decision: "allow", grantId });
  const eventTypes = (fetchFn: ReturnType<typeof galley>) => calls(fetchFn, eventPath).map(([, init]) => (JSON.parse(String(init?.body)) as { type: string }).type);

  it("hands the approval to the waiting engine, which resumes, acknowledges it applied, checks again and performs", async () => {
    const fetchFn = galley({ commands: [listing(), listing(APPROVAL), listing()], events: [created, requested, resumed, performed, stopConfirmed], checks: [deny, allow] });
    const { loop, messages } = setup(fetchFn, ACT);

    await vi.advanceTimersByTimeAsync(3000);
    expect(eventTypes(fetchFn)).toEqual(["execution_started", "permission_requested"]);
    await vi.advanceTimersByTimeAsync(2000);

    expect(eventTypes(fetchFn)).toEqual(["execution_started", "permission_requested", "resumed", "progress"]);
    expect(ackBodies(fetchFn, APPROVAL.id)).toEqual([{ outcome: "applied" }]);
    const index = (match: (path: string, body: string) => boolean) => fetchFn.mock.calls.findIndex(([input, init]) => match(new URL(String(input)).pathname, String(init?.body)));
    const resumedAt = index((path, body) => path === eventPath && body.includes('"resumed"'));
    const ackAt = index((path) => path === ackPath(APPROVAL.id));
    const checks = fetchFn.mock.calls.map(([input], i) => (new URL(String(input)).pathname === checksPath ? i : -1)).filter((i) => i >= 0);
    expect(checks).toHaveLength(2);
    expect(ackAt).toBeGreaterThan(resumedAt);
    expect(checks[1]).toBeGreaterThan(ackAt);
    expect(messages()).toEqual(expect.arrayContaining(["permission requested", "engine waiting for an approval", "approval received", "resume reported", "command acknowledged", "action performed"]));
    await loop.stop();
  });

  it("acknowledges an approval for another claim epoch as ignored and keeps waiting", async () => {
    const fetchFn = galley({ commands: [listing(STALE_APPROVAL)], events: [created, requested], checks: [deny] });
    const { loop, messages } = setup(fetchFn, ACT);

    await vi.advanceTimersByTimeAsync(6000);

    expect(ackBodies(fetchFn, STALE_APPROVAL.id)).toEqual([{ outcome: "ignored" }]);
    expect(eventTypes(fetchFn)).toEqual(["execution_started", "permission_requested"]);
    expect(messages()).not.toContain("approval received");
    await loop.stop();
  });

  it("stops while waiting when Stop is listed beside the approval, and leaves the approval unacknowledged", async () => {
    const fetchFn = galley({ commands: [listing(), listing(STOP, APPROVAL), listing()], events: [created, requested, stopConfirmed], checks: [deny] });
    const { loop } = setup(fetchFn, ACT);

    await vi.advanceTimersByTimeAsync(6000);

    expect(eventTypes(fetchFn)).toEqual(["execution_started", "permission_requested", "stop_confirmed"]);
    expect(ackBodies(fetchFn, STOP.id)).toEqual([{ outcome: "applied" }]);
    expect(calls(fetchFn, ackPath(APPROVAL.id))).toHaveLength(0);
    await loop.stop();
  });

  it("treats an approval command without its payload as a malformed listing", async () => {
    const { approval: _approval, ...bare } = APPROVAL;
    const fetchFn = galley({ commands: [listing(bare)], events: [created, requested], checks: [deny] });
    const { loop, records } = setup(fetchFn, ACT);

    await vi.advanceTimersByTimeAsync(4000);

    expect(records().find((record) => record["msg"] === "round commands poll failed")).toMatchObject({ reason: "invalid_body" });
    expect(calls(fetchFn, ackPath(APPROVAL.id))).toHaveLength(0);
    await loop.stop();
  });
});

describe("authority changed", () => {
  const CHANGED = { id: "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2", type: "authority_changed", claimEpoch: 2, issuedAt: "2026-10-02T12:00:02Z" };
  const STALE_CHANGED = { ...CHANGED, id: "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3", claimEpoch: 1 };
  const requestId = requestIdFor(CLAIM.roundId, 3);
  const grantId = "12121212-1212-4212-8212-121212121212";
  const performed = () => json({ roundId: CLAIM.roundId, type: "progress", state: "running", startedAt: "2026-10-02T11:59:00Z", seq: 1 }, 201);
  const requested = () => json({ roundId: CLAIM.roundId, type: "permission_requested", state: "waiting_for_input", startedAt: "2026-10-02T11:59:00Z", requestId }, 201);
  const allow = () => json({ decision: "allow", grantId });
  const deny = () => json({ decision: "deny" });
  const eventTypes = (fetchFn: ReturnType<typeof galley>) => calls(fetchFn, eventPath).map(([, init]) => (JSON.parse(String(init?.body)) as { type: string }).type);

  it.each([
    ["its claim epoch", CHANGED],
    ["another claim epoch", STALE_CHANGED],
  ] as const)("acknowledges an authority change at %s applied once, however often it is listed, and the engine keeps holding", async (_epoch, command) => {
    const fetchFn = galley({ commands: [listing(command)] });
    const { loop, records, messages } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(6000);

    expect(calls(fetchFn, commandsPath).length).toBeGreaterThanOrEqual(4);
    expect(ackBodies(fetchFn, command.id)).toEqual([{ outcome: "applied" }]);
    expect(records().filter((record) => record["msg"] === "authority changed; the next action checks it again")).toEqual([
      expect.objectContaining({ level: "info", commandId: command.id, commandEpoch: command.claimEpoch, claimEpoch: CLAIM.claimEpoch }),
    ]);
    expect(messages()).not.toContain("command for another claim epoch ignored");
    expect(messages()).not.toContain("engine stopped");
    await loop.stop();
  });

  it("acknowledges a redelivered authority change applied again after a restart, and Galley's stored acknowledgement stands", async () => {
    const stored = () => json({ id: CHANGED.id, acknowledgedAt: "2026-10-02T12:00:05Z", outcome: "applied" });
    for (let run = 0; run < 2; run++) {
      const fetchFn = galley({ commands: [listing(CHANGED)], ack: [stored] });
      const { loop, messages } = setup(fetchFn);
      await vi.advanceTimersByTimeAsync(4000);
      expect(ackBodies(fetchFn, CHANGED.id)).toEqual([{ outcome: "applied" }]);
      expect(messages()).not.toContain("command acknowledgement refused");
      await loop.stop();
    }
  });

  it("applies the Stop listed before the authority change, then acknowledges both applied", async () => {
    const fetchFn = galley({ commands: [listing(), listing(STOP, CHANGED), listing()] });
    const { loop, messages } = setup(fetchFn);

    await vi.advanceTimersByTimeAsync(4000);

    const shown = messages();
    expect(shown.indexOf("stop requested")).toBeGreaterThan(-1);
    expect(shown.indexOf("authority changed; the next action checks it again")).toBeGreaterThan(shown.indexOf("stop requested"));
    expect(shown).toContain("stop confirmation reported");
    expect(ackBodies(fetchFn, STOP.id)).toEqual([{ outcome: "applied" }]);
    expect(ackBodies(fetchFn, CHANGED.id)).toEqual([{ outcome: "applied" }]);
    await loop.stop();
  });

  it("checks authority afresh at the next action after an authority change, and asks when Galley now denies", async () => {
    const ACT_TWICE: EngineScript = {
      steps: [
        { step: "start" },
        { step: "act", account: "controlled", action: "write_note", resource: "notes/weekly-report" },
        { step: "wait", ms: 3000 },
        { step: "act", account: "controlled", action: "write_note", resource: "notes/weekly-report" },
        { step: "hold" },
      ],
    };
    const fetchFn = galley({ commands: [listing(CHANGED), listing()], events: [created, performed, requested], checks: [allow, deny] });
    const { loop } = setup(fetchFn, ACT_TWICE);

    await vi.advanceTimersByTimeAsync(3500);
    expect(eventTypes(fetchFn)).toEqual(["execution_started", "progress"]);
    expect(calls(fetchFn, checksPath)).toHaveLength(1);
    expect(ackBodies(fetchFn, CHANGED.id)).toEqual([{ outcome: "applied" }]);

    await vi.advanceTimersByTimeAsync(3000);
    expect(calls(fetchFn, checksPath)).toHaveLength(2);
    expect(eventTypes(fetchFn)).toEqual(["execution_started", "progress", "permission_requested"]);
    await loop.stop();
  });
});
