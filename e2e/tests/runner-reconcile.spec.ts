import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep, type RunningMichelin } from "../support/runner";
import { answerQuestionDirect, assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, requestStopDirect, updateTicketDirect, type Ticket } from "../support/tickets";

const RUNNING = "Reconciled with the runner: execution running";
const UNKNOWN = "Reconciled with the runner: the runner cannot confirm execution";
const QUESTION = "Which quarter should the report cover?";
const HOLDING: EngineScriptStep[] = [{ step: "start" }, { step: "progress", note: "Reading the Ticket" }, { step: "hold" }];

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

async function queueForAgent(api: APIRequestContext, title: string, agentName: string): Promise<Ticket> {
  const agent = await createAgent(api, agentName, "research");
  const queued = await createTicket(api, title);
  expect((await updateTicketDirect(api, queued.id, { goal: "Summarise the findings", successCriteria: "A summary exists" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);
  return queued;
}

async function pastTheHealthWindow(api: APIRequestContext): Promise<void> {
  const advanced = await api.post("/api/dev/clock/advance", { data: { seconds: 31 } });
  expect(advanced.status()).toBe(200);
}

async function exitCleanly(michelin: RunningMichelin): Promise<void> {
  michelin.child.kill("SIGTERM");
  const [code] = await once(michelin.child, "exit");
  expect(code).toBe(0);
}

async function notes(api: APIRequestContext, ticketId: string): Promise<string[]> {
  return (await listRounds(api, ticketId))[0]!.activity.map((note) => note.note);
}

test.setTimeout(90_000);

test("a runner seen again after the health window reconciles its running Round, which continues to delivery with one Reconcile note", async ({ playwright }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  await signInWithoutBrowser(api);
  const queued = await queueForAgent(api, `Reconcile and deliver ${stamp}`, `Reconciler ${stamp}`);
  const script: EngineScriptStep[] = [
    { step: "start" },
    { step: "progress", note: "Reading the Ticket" },
    { step: "ask", question: QUESTION },
    { step: "deliver", bodyMarkdown: "# Report\n\nQ3 only.", summary: "Covered Q3", criteriaAssessment: "A summary exists" },
  ];
  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, script);
  let exited = false;
  try {
    await expect.poll(async () => (await ticket(api, queued.id)).openRound?.question?.text, { timeout: 15_000 }).toBe(QUESTION);
    const waiting = await ticket(api, queued.id);
    const roundId = waiting.openRound!.id;

    await pastTheHealthWindow(api);
    await expect.poll(() => notes(api, queued.id), { timeout: 15_000 }).toEqual(["Reading the Ticket", RUNNING]);
    await expect.poll(async () => (await ticket(api, queued.id)).openRound?.waitingReason, { timeout: 5_000 }).toBe("waiting_for_answer");
    expect(lines(michelin.output(), "reconciled")).toEqual([expect.objectContaining({ roundId, execution: "running", disposition: "continue" })]);

    expect((await answerQuestionDirect(api, queued.id, roundId, waiting.openRound!.question!.id, "Q3 only")).ok).toBe(true);
    await expect.poll(async () => (await ticket(api, queued.id)).status, { timeout: 15_000 }).toBe("InReview");
    expect(await ticket(api, queued.id)).toMatchObject({ openRound: null, delivery: { roundId, sequence: 1 } });
    const rounds = await listRounds(api, queued.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ id: roundId, state: "delivered" });
    expect(rounds[0]!.activity.map((note) => note.note)).toEqual(["Reading the Ticket", RUNNING, "Owner's answer: Q3 only"]);

    const log = michelin.output();
    expect(lines(log, "round claimed").map((claim) => claim["roundId"])).toEqual([roundId]);
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);
    await exitCleanly(michelin);
    exited = true;
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await api.dispose();
  }
});

// The command poll is pushed past the test so the Stop reaches Michelin only in the Reconcile answer; SIGSTOP holds
// Michelin still while the clock passes the health window and the Owner stops, so the Stop is queued before it reconciles.
test("a Stop queued while the runner was away reaches it in the Reconcile answer: the Round ends Stopped, not delivered", async ({ playwright }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  await signInWithoutBrowser(api);
  const queued = await queueForAgent(api, `Reconcile and stop ${stamp}`, `Stopper ${stamp}`);
  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, HOLDING, { commandIntervalMs: 600_000 });
  let exited = false;
  try {
    await expect.poll(() => michelin.output(), { timeout: 15_000 }).toContain('"msg":"engine holding"');
    const roundId = (await ticket(api, queued.id)).openRound!.id;

    expect(michelin.child.kill("SIGSTOP")).toBe(true);
    await pastTheHealthWindow(api);
    expect((await ticket(api, queued.id)).openRound).toMatchObject({ id: roundId, state: "running", waitingReason: "runner_disconnected" });
    expect((await requestStopDirect(api, queued.id)).status).toBe(200);
    expect(michelin.child.kill("SIGCONT")).toBe(true);

    await expect.poll(async () => (await ticket(api, queued.id)).openRound, { timeout: 15_000 }).toBeNull();
    const ended = await ticket(api, queued.id);
    expect(ended).toMatchObject({ status: "Backlog", delivery: null });
    expect(ended.badges.map((badge) => badge.name)).toEqual(["Stopped"]);
    const rounds = await listRounds(api, queued.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ id: roundId, state: "stopped", deliverable: null });
    expect(rounds[0]!.activity.map((note) => note.note)).toEqual(["Reading the Ticket", RUNNING]);

    await expect.poll(() => michelin.output(), { timeout: 5_000 }).toContain('"msg":"command acknowledged"');
    const log = michelin.output();
    expect(lines(log, "reconciled")).toEqual([expect.objectContaining({ roundId, execution: "running", disposition: "stop" })]);
    expect(lines(log, "stop confirmation reported")).toEqual([expect.objectContaining({ roundId, httpStatus: 201 })]);
    expect(lines(log, "command acknowledged")).toEqual([expect.objectContaining({ roundId, outcome: "applied" })]);
    expect(log.indexOf('"msg":"reconciled"')).toBeLessThan(log.indexOf('"msg":"engine stopped"'));
    expect(log.indexOf('"msg":"engine stopped"')).toBeLessThan(log.indexOf('"msg":"stop confirmation reported"'));
    expect(log.indexOf('"msg":"stop confirmation reported"')).toBeLessThan(log.indexOf('"msg":"command acknowledged"'));
    expect(log).not.toContain('"msg":"engine delivered"');
    expect(log).not.toContain("round event refused");
    await exitCleanly(michelin);
    exited = true;
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await api.dispose();
  }
});

// Leaves the Round open with no runner able to end it: run.sh resets the database after this spec.
test("a restarted runner cannot confirm the Round an earlier process held: it stays open, the Ticket stays locked, and the slip and receipt say so", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  await signInWithoutBrowser(api);
  const title = `Reconcile unknown ${stamp}`;
  const queued = await queueForAgent(api, title, `Forgetter ${stamp}`);
  const token = await pairRunnerViaApi(api);
  const first = startMichelin(token, 500, HOLDING);
  let restarted: RunningMichelin | undefined;
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(() => first.output(), { timeout: 15_000 }).toContain('"msg":"engine holding"');
    const running = await ticket(api, queued.id);
    const roundId = running.openRound!.id;
    first.child.kill("SIGKILL");
    await once(first.child, "exit");

    restarted = startMichelin(token, 500, HOLDING);
    await expect.poll(async () => (await ticket(api, queued.id)).openRound?.waitingReason, { timeout: 15_000 }).toBe("execution_unknown");
    const later = restarted;
    await expect.poll(() => lines(later.output(), "reconciled").length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    const log = restarted.output();
    expect(new Set(lines(log, "reconciled").map((line) => `${line["roundId"]} ${line["execution"]} ${line["disposition"]}`))).toEqual(new Set([`${roundId} unknown hold`]));
    expect(lines(log, "round claimed")).toEqual([]);
    expect(log).not.toContain(token);

    const unknown = await ticket(api, queued.id);
    expect(unknown).toMatchObject({ status: "InProgress", openRound: { id: roundId, state: "running", waitingReason: "execution_unknown" } });
    expect(unknown.allowedActions.accept.reason).toMatchObject({ code: "round_open", roundId });
    expect(await notes(api, queued.id)).toEqual(["Reading the Ticket", UNKNOWN]);
    const archive = await api.post(`/api/tickets/${queued.id}/archive`);
    expect(archive.status()).toBe(400);
    expect((await archive.json() as { error: { code: string } }).error.code).toBe("round_open");

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto("/list");
    await expect(page.getByTestId(`ticket-item-${queued.id}`).getByTestId("ticket-waiting-reason")).toHaveText("Runner cannot confirm execution");
    await page.goto(`/tickets/${queued.id}`);
    const notice = page.getByTestId("ticket-detail-execution-unknown");
    await expect(notice).toHaveText("Runner cannot confirm execution The runner reconnected but cannot confirm this Round is running. It stays open and the Ticket stays locked.");
    await expect(notice).toHaveAttribute("role", "status");
    await expect(page.getByTestId("ticket-detail-runner-disconnected")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-locked")).toBeVisible();
    await expect(page.getByTestId("ticket-detail-round-note")).toContainText([UNKNOWN]);

    await exitCleanly(restarted);
    exited = true;
  } finally {
    if (!exited) restarted?.child.kill("SIGKILL");
    if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill("SIGKILL");
    await context.close();
    await api.dispose();
  }
});
