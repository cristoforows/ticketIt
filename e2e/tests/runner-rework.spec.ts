import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep, type RunningMichelin } from "../support/runner";
import {
  acceptTicketDirect,
  assignTicketDirect,
  changeTicketStatusDirect,
  createAgent,
  createTicket,
  listRounds,
  updateTicketDirect,
  type Ticket,
} from "../support/tickets";

const CLAIM_INTERVAL_MS = 500;

const usage = (inputTokens: number, outputTokens: number, costUsd: string, activeMs: number): EngineScriptStep => (
  { step: "usage", provider: "controlled", model: "scripted", inputTokens, outputTokens, costUsd, activeMs, basis: "reported", providerGenerationId: null }
);

const ROUND_1: EngineScriptStep[] = [
  { step: "start" },
  { step: "progress", note: "Round 1 note" },
  usage(100, 20, "0.001500", 1_500),
  { step: "deliver", bodyMarkdown: "# First result\n\nThe first body.\n", summary: "First summary", criteriaAssessment: "First assessment" },
];

const ROUND_2: EngineScriptStep[] = [
  { step: "start" },
  { step: "progress", note: "Round 2 note" },
  usage(300, 60, "0.004500", 2_500),
  { step: "wait", ms: 6_000 },
  { step: "deliver", bodyMarkdown: "# Second result\n\nThe second body.\n", summary: "Second summary", criteriaAssessment: "Second assessment" },
];

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function stop(michelin: RunningMichelin): Promise<void> {
  if (michelin.child.exitCode !== null) return;
  michelin.child.kill("SIGTERM");
  const [code] = await once(michelin.child, "exit");
  expect(code).toBe(0);
}

test.setTimeout(120_000);

test("explicit rework delivers a second Round and the receipt keeps both Rounds' results and usage", async ({ playwright, browser, request }) => {
  const api = await playwright.request.newContext({ baseURL: process.env.E2E_BASE_URL });
  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Reworker ${Date.now()}`, "research");
  const created = await createTicket(api, `Rework me ${Date.now()}`, "Basic");
  expect((await updateTicketDirect(api, created.id, { goal: "Find the cause", successCriteria: "A written cause" })).ok).toBe(true);
  expect((await assignTicketDirect(api, created.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, created.id, "Ready")).ok).toBe(true);
  const id = created.id;

  const token = await pairRunnerViaApi(api);
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  let michelin = startMichelin(token, CLAIM_INTERVAL_MS, ROUND_1);
  try {
    await expect.poll(async () => (await ticket(api, id)).status, { timeout: 30_000 }).toBe("InReview");
    await stop(michelin);

    const first = await ticket(api, id);
    expect(first).toMatchObject({ openRound: null, requestingAgentWork: false, delivery: { sequence: 1 } });
    expect(first.allowedActions.rework.available).toBe(true);
    const round1Id = first.delivery!.roundId;
    const roundsBefore = await listRounds(api, id);
    expect(roundsBefore).toHaveLength(1);
    expect(roundsBefore[0]).toMatchObject({ id: round1Id, sequence: 1, state: "delivered" });

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review");
    await page.evaluate(() => { (window as { sameDocument?: boolean }).sameDocument = true; });
    await expect(page.getByTestId("ticket-detail-round")).toHaveCount(1);

    await page.getByTestId("ticket-detail-rework-button").click();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Ready");
    await expect(page.getByTestId("ticket-detail-queued")).toHaveText(`Queued for ${agent.name}`);
    await expect(page.getByTestId("ticket-detail-rework-button")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-round")).toHaveCount(1);
    await expect(page.getByTestId("ticket-detail-round")).toHaveAttribute("data-round-id", round1Id);

    const requeued = await ticket(api, id);
    expect(requeued).toMatchObject({ status: "Ready", requestingAgentWork: true, openRound: null });
    expect(requeued.allowedActions.rework).toMatchObject({ available: false, reason: { code: "rework_not_available" } });
    expect(await listRounds(api, id)).toEqual(roundsBefore);

    michelin = startMichelin(token, CLAIM_INTERVAL_MS, ROUND_2);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Progress", { timeout: 20_000 });
    await expect(page.getByTestId("ticket-detail-locked")).toBeVisible();
    await expect(page.getByTestId("ticket-detail-round")).toHaveCount(2);

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review", { timeout: 30_000 });
    await expect(page.getByTestId("ticket-detail-delivered")).toHaveText(`Delivered by ${agent.name}`);
    expect(await page.evaluate(() => (window as { sameDocument?: boolean }).sameDocument === true)).toBe(true);

    const entries = page.getByTestId("ticket-detail-round");
    await expect(entries).toHaveCount(2);
    await expect(entries.getByTestId("ticket-detail-round-number")).toHaveText(["Round 2", "Round 1"]);
    const [second, firstRound] = await listRounds(api, id);
    expect(second!.sequence).toBe(2);
    expect(firstRound!.id).toBe(round1Id);
    expect(second!.id).not.toBe(round1Id);
    await expect(entries.nth(0)).toHaveAttribute("data-round-id", second!.id);
    await expect(entries.nth(1)).toHaveAttribute("data-round-id", round1Id);

    const newest = entries.nth(0);
    const oldest = entries.nth(1);
    await expect(newest.locator("details")).toHaveJSProperty("open", true);
    await expect(oldest.locator("details")).toHaveJSProperty("open", false);
    await expect(newest.getByTestId("ticket-detail-round-summary")).toHaveText("Second summary");
    await expect(newest.getByTestId("ticket-detail-round-assessment")).toHaveText("Second assessment");
    await expect(newest.getByTestId("ticket-detail-round-body").getByRole("heading", { level: 1, name: "Second result" })).toBeVisible();
    await expect(newest.getByTestId("ticket-detail-round-note")).toContainText("Round 2 note");
    await expect(newest.getByTestId("ticket-detail-round-usage-cost")).toHaveText("$0.0045");
    await expect(newest.getByTestId("ticket-detail-round-usage-input-tokens")).toHaveText("300");
    await expect(newest.getByTestId("ticket-detail-round-usage-output-tokens")).toHaveText("60");

    await oldest.locator("summary").click();
    await expect(oldest.locator("details")).toHaveJSProperty("open", true);
    await expect(oldest.getByTestId("ticket-detail-round-summary")).toHaveText("First summary");
    await expect(oldest.getByTestId("ticket-detail-round-assessment")).toHaveText("First assessment");
    await expect(oldest.getByTestId("ticket-detail-round-body").getByRole("heading", { level: 1, name: "First result" })).toBeVisible();
    await expect(oldest.getByTestId("ticket-detail-round-note")).toContainText("Round 1 note");
    await expect(oldest.getByTestId("ticket-detail-round-usage-cost")).toHaveText("$0.0015");
    await expect(oldest.getByTestId("ticket-detail-round-usage-input-tokens")).toHaveText("100");
    await expect(oldest.getByTestId("ticket-detail-round-usage-output-tokens")).toHaveText("20");
    expect(await page.evaluate(() => (window as { sameDocument?: boolean }).sameDocument === true)).toBe(true);

    const inReview = await ticket(api, id);
    expect(inReview).toMatchObject({ status: "InReview", openRound: null, requestingAgentWork: false, delivery: { roundId: second!.id, sequence: 2 } });
    const rounds = await listRounds(api, id);
    expect(rounds.map((round) => [round.id, round.sequence, round.state])).toEqual([[second!.id, 2, "delivered"], [round1Id, 1, "delivered"]]);
    expect(rounds[0]).toMatchObject({
      deliverable: { bodyMarkdown: "# Second result\n\nThe second body.\n", summary: "Second summary", criteriaAssessment: "Second assessment" },
      usage: { costUsd: "0.004500", inputTokens: { sum: 300 }, outputTokens: { sum: 60 } },
    });
    expect(rounds[0]!.activity.map((note) => note.note)).toEqual(["Round 2 note"]);
    expect(rounds[1]).toMatchObject({
      deliverable: { bodyMarkdown: "# First result\n\nThe first body.\n", summary: "First summary", criteriaAssessment: "First assessment" },
      usage: { costUsd: "0.001500", inputTokens: { sum: 100 }, outputTokens: { sum: 20 } },
    });
    expect(rounds[1]).toEqual(roundsBefore[0]);

    // Nothing requeuing is an absence, so the wait is fixed: three claim intervals with Michelin polling.
    await page.waitForTimeout(CLAIM_INTERVAL_MS * 3);
    expect(await ticket(api, id)).toMatchObject({ status: "InReview", openRound: null, requestingAgentWork: false });
    expect(await listRounds(api, id)).toHaveLength(2);
    expect(michelin.output().match(/"msg":"round claimed"/g)).toHaveLength(1);
    await stop(michelin);

    expect((await acceptTicketDirect(api, id)).ok).toBe(true);
    expect((await ticket(api, id)).status).toBe("Done");
  } finally {
    await stop(michelin);
    await context.close();
    await api.dispose();
  }
});
