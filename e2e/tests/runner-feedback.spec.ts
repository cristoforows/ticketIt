import { once } from "node:events";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep, type RunningMichelin } from "../support/runner";
import { acceptTicketDirect, addFeedbackDirect, assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, updateTicketDirect, type Ticket } from "../support/tickets";

const CLAIM_INTERVAL_MS = 500;

const SCRIPT: EngineScriptStep[] = [
  { step: "start" },
  { step: "progress", note: "Reading the Ticket" },
  { step: "deliver", bodyMarkdown: "# Report\n\nThe findings.\n", summary: "Summarised the findings", criteriaAssessment: "A summary exists" },
];

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

async function deliveredRound(api: APIRequestContext, id: string, sequence: number): Promise<Ticket> {
  await expect.poll(async () => (await ticket(api, id)).delivery?.sequence, { timeout: 30_000 }).toBe(sequence);
  return ticket(api, id);
}

async function addFeedbackInSwiftlet(page: Page, ticketId: string, sequence: number, body: string): Promise<void> {
  const panel = page.getByRole("region", { name: "Feedback for the next Round" });
  await panel.getByLabel(`Your feedback on Round ${sequence}`).fill(body);
  const [posted] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/tickets/${ticketId}/rounds/`) && r.url().endsWith("/feedback") && r.request().method() === "POST"),
    panel.getByTestId("ticket-detail-feedback-submit").click(),
  ]);
  expect(posted.status()).toBe(201);
  await expect(panel.getByLabel(`Your feedback on Round ${sequence}`)).toHaveValue("");
}

async function exitCleanly(michelin: RunningMichelin): Promise<void> {
  if (michelin.child.exitCode !== null) return;
  michelin.child.kill("SIGTERM");
  const [code] = await once(michelin.child, "exit");
  expect(code).toBe(0);
}

test.setTimeout(120_000);

test("feedback on a delivered Round reaches a real Michelin's next Round through rework, once", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  await signInWithoutBrowser(api);
  const queued = await queueForAgent(api, `Feedback via rework ${stamp}`, `Reviewer ${stamp}`);
  const id = queued.id;
  expect((await ticket(api, id)).allowedActions.feedback).toMatchObject({ available: false, reason: { code: "feedback_not_available" } });

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, CLAIM_INTERVAL_MS, SCRIPT);
  const context = await browser.newContext({ baseURL });
  try {
    const first = await deliveredRound(api, id, 1);
    expect(first).toMatchObject({ status: "InReview", openRound: null });
    expect(first.allowedActions.feedback).toEqual({ available: true });
    const round1Id = first.delivery!.roundId;

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review");
    await addFeedbackInSwiftlet(page, id, 1, "Cover Asia too.");
    await addFeedbackInSwiftlet(page, id, 1, "Keep it under a page.\nCite sources.");

    const round1 = page.locator(`[data-testid="ticket-detail-round"][data-round-id="${round1Id}"]`);
    await expect(round1.getByTestId("ticket-detail-round-feedback-body")).toHaveText(["Cover Asia too.", "Keep it under a page.\nCite sources."]);
    await expect(round1.getByTestId("ticket-detail-round-feedback-consumed")).toHaveText(["Waiting for the next Round", "Waiting for the next Round"]);
    const stored = (await listRounds(api, id))[0]!.feedback;
    expect(stored.map((item) => [item.body, item.consumedBy])).toEqual([["Cover Asia too.", null], ["Keep it under a page.\nCite sources.", null]]);

    await page.getByTestId("ticket-detail-rework-button").click();
    const second = await deliveredRound(api, id, 2);
    expect(second.status).toBe("InReview");
    const round2Id = second.delivery!.roundId;

    const expectedNote = "Owner's feedback received (2 comments):\nRound 1: Cover Asia too.\nRound 1: Keep it under a page.\nCite sources.";
    const [round2Record, round1Record] = await listRounds(api, id);
    expect(round2Record!.id).toBe(round2Id);
    expect(round2Record!.activity.map((note) => note.note)).toEqual([expectedNote, "Reading the Ticket"]);
    expect(round1Record!.feedback.map((item) => item.consumedBy)).toEqual([{ roundId: round2Id, sequence: 2 }, { roundId: round2Id, sequence: 2 }]);
    expect(round2Record!.feedback).toEqual([]);

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review", { timeout: 20_000 });
    const round2 = page.locator(`[data-testid="ticket-detail-round"][data-round-id="${round2Id}"]`);
    await expect(round2.getByTestId("ticket-detail-round-note").first()).toContainText("Owner's feedback received (2 comments):");
    await expect(round2.getByTestId("ticket-detail-round-note").first()).toContainText("Round 1: Cover Asia too.");
    await expect(round2.getByTestId("ticket-detail-round-feedback")).toHaveCount(0);
    await round1.locator("summary").click();
    await expect(round1.getByTestId("ticket-detail-round-feedback-consumed")).toHaveText(["Sent to Round 2", "Sent to Round 2"]);

    expect((await ticket(api, id)).allowedActions.rework.available).toBe(true);
    await page.getByTestId("ticket-detail-rework-button").click();
    const third = await deliveredRound(api, id, 3);
    const round3Record = (await listRounds(api, id))[0]!;
    expect(round3Record.id).toBe(third.delivery!.roundId);
    expect(round3Record.activity.map((note) => note.note)).toEqual(["Reading the Ticket"]);
    expect(lines(michelin.output(), "round claimed").map((line) => line["feedback"])).toEqual([0, 2, 0]);
    expect(lines(michelin.output(), "feedback reported").map((line) => line["feedback"])).toEqual([2]);

    expect((await acceptTicketDirect(api, id)).ok).toBe(true);
  } finally {
    await exitCleanly(michelin);
    await context.close();
    await api.dispose();
  }
});

test("Done → Ready is the reopen route: feedback added on a Done Ticket reaches the reopened Ticket's next Round", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  await signInWithoutBrowser(api);
  const queued = await queueForAgent(api, `Feedback via reopen ${stamp}`, `Reopener ${stamp}`);
  const id = queued.id;

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, CLAIM_INTERVAL_MS, SCRIPT);
  const context = await browser.newContext({ baseURL });
  try {
    const first = await deliveredRound(api, id, 1);
    const round1Id = first.delivery!.roundId;
    expect((await acceptTicketDirect(api, id)).ok).toBe(true);
    const done = await ticket(api, id);
    expect(done).toMatchObject({ status: "Done", delivery: { roundId: round1Id, sequence: 1 } });
    expect(done.allowedActions.feedback).toEqual({ available: true });

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Done");
    await addFeedbackInSwiftlet(page, id, 1, "Reopening: add the 2026 figures.");
    const round1 = page.locator(`[data-testid="ticket-detail-round"][data-round-id="${round1Id}"]`);
    await expect(round1.getByTestId("ticket-detail-round-feedback-consumed")).toHaveText(["Waiting for the next Round"]);

    await page.getByTestId("ticket-detail-status-button-Ready").click();
    const second = await deliveredRound(api, id, 2);
    expect(second.status).toBe("InReview");
    const round2Id = second.delivery!.roundId;
    const [round2Record, round1Record] = await listRounds(api, id);
    expect(round2Record!.activity.map((note) => note.note)).toEqual(["Owner's feedback received (1 comment):\nRound 1: Reopening: add the 2026 figures.", "Reading the Ticket"]);
    expect(round1Record!.feedback.map((item) => [item.body, item.consumedBy])).toEqual([["Reopening: add the 2026 figures.", { roundId: round2Id, sequence: 2 }]]);

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review", { timeout: 20_000 });
    const round2 = page.locator(`[data-testid="ticket-detail-round"][data-round-id="${round2Id}"]`);
    await expect(round2.getByTestId("ticket-detail-round-note").first()).toContainText("Round 1: Reopening: add the 2026 figures.");

    const late = await addFeedbackDirect(api, id, round1Id, "On Round 1 again");
    expect(late).toMatchObject({ ok: true, status: 201 });
    expect((await listRounds(api, id))[1]!.feedback.map((item) => [item.body, item.consumedBy])).toEqual([
      ["Reopening: add the 2026 figures.", { roundId: round2Id, sequence: 2 }],
      ["On Round 1 again", null],
    ]);
    const tooLong = await addFeedbackDirect(api, id, round2Id, "x".repeat(10_001));
    expect(tooLong).toMatchObject({ ok: false, status: 400, errorCode: "invalid_request" });
    expect((await acceptTicketDirect(api, id)).ok).toBe(true);
  } finally {
    await exitCleanly(michelin);
    await context.close();
    await api.dispose();
  }
});
