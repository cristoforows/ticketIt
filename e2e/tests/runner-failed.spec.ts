import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, updateTicketDirect, type Ticket } from "../support/tickets";

const NOTE = "The goal needs a repository this Ticket does not name.";

const SCRIPT: EngineScriptStep[] = [
  { step: "start" },
  { step: "progress", note: "Reading the Ticket" },
  { step: "usage", provider: "controlled", model: "scripted", inputTokens: 1200, outputTokens: 300, costUsd: "0.004500", activeMs: 2000, basis: "reported", providerGenerationId: null },
  { step: "fail", explanation: NOTE },
];

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

test.setTimeout(90_000);

test("a real Michelin's failed report ends the Round as Failed: Blocked with its explanation, activity and usage kept, no Round until the Owner's Ready claims Round 2", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const runner = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();

  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Failer ${stamp}`, "research");
  const queued = await createTicket(api, `Fail me ${stamp}`);
  expect((await updateTicketDirect(api, queued.id, { goal: "Summarise the findings", successCriteria: "A summary exists" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, SCRIPT);
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(() => michelin.output(), { timeout: 15_000 }).toContain('"msg":"engine failed"');
    const log = michelin.output();
    const [claim] = lines(log, "round claimed");
    const [reported] = lines(log, "failure reported");
    const roundId = String(claim!["roundId"]);
    expect(reported).toMatchObject({ roundId, step: "fail", stepIndex: 3, httpStatus: 201, endedAt: expect.any(String) });
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);

    const blocked = await ticket(api, queued.id);
    expect(blocked).toMatchObject({ status: "Blocked", openRound: null, delivery: null, requestingAgentWork: false, badges: [] });
    expect(blocked.allowedActions.statusChanges).toContain("Ready");
    const [round1] = await listRounds(api, queued.id);
    expect(round1).toMatchObject({
      id: roundId,
      sequence: 1,
      state: "failed",
      endedAt: reported!["endedAt"],
      outcomeNote: NOTE,
      activity: [{ seq: 1, note: "Reading the Ticket", occurredAt: expect.any(String) }],
      deliverable: null,
    });
    expect(round1!.usage).toMatchObject({ observations: 1, costUsd: "0.004500", inputTokens: { sum: 1200 } });

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(lines(michelin.output(), "round claimed")).toHaveLength(1);
    expect(await listRounds(api, queued.id)).toEqual([round1]);

    const late = await runner.post(`/api/runner/rounds/${roundId}/events`, {
      headers: { authorization: `Bearer ${token}` },
      data: { type: "progress", idempotencyKey: `late-${stamp}`, claimEpoch: 1, occurredAt: new Date().toISOString(), data: { note: "too late" } },
    });
    expect(late.status()).toBe(409);
    expect((await late.json() as { error: { code: string } }).error.code).toBe("round_not_open");

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    const section = page.getByTestId("ticket-detail-rounds");
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Blocked");
    await expect(page.getByTestId("ticket-detail-locked")).toHaveCount(0);
    await expect(section.getByTestId("ticket-detail-round-failed")).toHaveText("Failed");
    await expect(section.getByTestId("ticket-detail-round-outcome-note")).toHaveText(NOTE);
    await expect(section.getByTestId("ticket-detail-round-failed-at")).toHaveText(round1!.endedAt!);
    await expect(section.getByTestId("ticket-detail-round-note")).toContainText("Reading the Ticket");
    await expect(section.getByTestId("ticket-detail-round-usage-cost")).toHaveText("$0.0045");
    await expect(section.getByTestId("ticket-detail-round-usage-input-tokens")).toHaveText("1,200");
    await expect(section.getByTestId("ticket-detail-round-summary")).toHaveCount(0);

    const [readied] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/status`) && r.request().method() === "POST"),
      page.getByTestId("ticket-detail-status-button-Ready").click(),
    ]);
    expect(readied.status()).toBe(200);
    expect(await readied.json()).toMatchObject({ status: "Ready", openRound: null });

    await expect.poll(() => lines(michelin.output(), "engine failed").length, { timeout: 15_000 }).toBe(2);
    const claims = lines(michelin.output(), "round claimed").map((each) => [each["roundId"], each["sequence"], each["claimEpoch"]]);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toEqual([roundId, 1, 1]);
    expect(claims[1]![0]).not.toBe(roundId);
    expect(claims[1]!.slice(1)).toEqual([2, 2]);
    const rounds = await listRounds(api, queued.id);
    expect(rounds.map((round) => [round.sequence, round.state])).toEqual([[2, "failed"], [1, "failed"]]);
    expect(rounds[1]).toEqual(round1);
    expect(await ticket(api, queued.id)).toMatchObject({ status: "Blocked", openRound: null });
    await expect(page.getByTestId("ticket-detail-round")).toHaveCount(2, { timeout: 10_000 });
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Blocked");

    michelin.child.kill("SIGTERM");
    const [code] = await once(michelin.child, "exit");
    exited = true;
    expect(code).toBe(0);
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await context.close();
    await runner.dispose();
    await api.dispose();
  }
});
