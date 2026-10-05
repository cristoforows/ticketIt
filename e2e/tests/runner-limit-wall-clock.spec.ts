import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, updateTicketDirect, type Ticket } from "../support/tickets";

// Galley's default active-time limit (GALLEY_ROUND_MAX_ACTIVE_DURATION): run.sh starts Galley with no override.
const LIMIT_SECONDS = 4 * 60 * 60;
const STEP_SECONDS = 20;
const SCRIPT: EngineScriptStep[] = [{ step: "start" }, { step: "progress", note: "Reading the Ticket" }, { step: "hold" }];

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

function goDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${m}m${s}s` : `${s}s`;
}

test.setTimeout(180_000);

test("a real Michelin's Round past Galley's active-time limit by the dev clock is stopped by Galley and ends Failed, Blocked, with the limit named and its work kept", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const runner = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();

  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Overtimer ${stamp}`, "research");
  const queued = await createTicket(api, `Run past the limit ${stamp}`);
  expect((await updateTicketDirect(api, queued.id, { goal: "Summarise the findings", successCriteria: "A summary exists" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, SCRIPT, { commandIntervalMs: 500 });
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(() => michelin.output(), { timeout: 15_000 }).toContain('"msg":"engine holding"');
    const roundId = (await ticket(api, queued.id)).openRound!.id;

    expect(michelin.child.kill("SIGSTOP")).toBe(true);
    // Heartbeats inside the health window keep the runner connected, so the Round runs on rather than Reconciling.
    const runFor = async (seconds: number) => {
      for (let elapsed = 0; elapsed < seconds; elapsed += STEP_SECONDS) {
        expect((await api.post("/api/dev/clock/advance", { data: { seconds: STEP_SECONDS } })).status()).toBe(200);
        expect((await runner.post("/api/runner/heartbeat", { headers: { authorization: `Bearer ${token}` } })).status()).toBe(200);
      }
    };
    await runFor(LIMIT_SECONDS - 60);
    expect((await ticket(api, queued.id)).openRound).toMatchObject({ id: roundId, state: "running", stopRequestedAt: null, limitBreach: null });
    await runFor(120);

    const stopping = await ticket(api, queued.id);
    expect(stopping).toMatchObject({ status: "InProgress", openRound: { id: roundId, state: "running", waitingReason: "stopping", stopRequestedAt: expect.any(String) } });
    const breach = stopping.openRound!.limitBreach!;
    expect(breach).toMatchObject({ kind: "wall_clock", limit: LIMIT_SECONDS, breachedAt: stopping.openRound!.stopRequestedAt });
    expect(breach.measured).toBeGreaterThanOrEqual(LIMIT_SECONDS);
    expect(breach.measured).toBeLessThan(LIMIT_SECONDS + 120);

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-stopping")).toHaveText("Technical limit reached. Stopping the Round.");
    await expect(page.getByTestId("ticket-detail-rounds").getByTestId("ticket-detail-round-limit-breach")).toHaveText(`Active time limit reached: ${goDuration(breach.measured)} of 4h0m0s`);

    expect(michelin.child.kill("SIGCONT")).toBe(true);
    await expect.poll(async () => (await ticket(api, queued.id)).openRound, { timeout: 15_000 }).toBeNull();
    const explanation = `Technical limit reached: active time ${goDuration(breach.measured)} exceeded the ${goDuration(LIMIT_SECONDS)} limit.`;
    expect(explanation).toMatch(/^Technical limit reached: active time 4h\d+m\d+s exceeded the 4h0m0s limit\.$/);
    const blocked = await ticket(api, queued.id);
    expect(blocked).toMatchObject({ status: "Blocked", openRound: null, delivery: null, requestingAgentWork: false, badges: [] });
    const [round1] = await listRounds(api, queued.id);
    expect(round1).toMatchObject({ id: roundId, state: "failed", outcomeNote: explanation, limitBreach: breach, deliverable: null });
    expect(round1!.activity.map((note) => note.note)).toContain("Reading the Ticket");

    await expect.poll(() => michelin.output(), { timeout: 5_000 }).toContain('"msg":"stop confirmation reported"');
    const log = michelin.output();
    expect(lines(log, "stop confirmation reported")).toEqual([expect.objectContaining({ roundId, httpStatus: 201 })]);
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);

    await page.reload();
    const section = page.getByTestId("ticket-detail-rounds");
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Blocked");
    await expect(page.getByTestId("ticket-detail-stopping")).toHaveCount(0);
    await expect(section.getByTestId("ticket-detail-round-failed")).toHaveText("Failed");
    await expect(section.getByTestId("ticket-detail-round-limit-breach")).toHaveText(`Active time limit reached: ${goDuration(breach.measured)} of 4h0m0s`);
    await expect(section.getByTestId("ticket-detail-round-outcome-note")).toHaveText(explanation);

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(lines(michelin.output(), "round claimed")).toHaveLength(1);

    michelin.child.kill("SIGTERM");
    const [code] = await once(michelin.child, "exit");
    exited = true;
    expect(code).toBe(0);
  } finally {
    if (!exited) {
      michelin.child.kill("SIGCONT");
      michelin.child.kill("SIGKILL");
    }
    await context.close();
    await runner.dispose();
    await api.dispose();
  }
});
