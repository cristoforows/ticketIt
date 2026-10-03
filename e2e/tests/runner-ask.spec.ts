import { once } from "node:events";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, runnerCalls, startMichelin, type EngineScriptStep, type RunningMichelin } from "../support/runner";
import { answerQuestionDirect, assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, updateTicketDirect, type Ticket } from "../support/tickets";

const REGION = "Which region should the report cover?";
const APPENDIX = "Should the appendix be included?";

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

async function waitingOn(api: APIRequestContext, id: string, text: string): Promise<Ticket> {
  await expect.poll(async () => (await ticket(api, id)).openRound?.question?.text, { timeout: 15_000 }).toBe(text);
  return ticket(api, id);
}

async function answerInSwiftlet(page: Page, ticketId: string, text: string, answer: string): Promise<Ticket> {
  const panel = page.getByRole("region", { name: "Question from the Agent" });
  await expect(panel.getByTestId("ticket-detail-question-text")).toHaveText(text, { timeout: 10_000 });
  await panel.getByLabel("Your answer").fill(answer);
  const [posted] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/tickets/${ticketId}/rounds/`) && r.url().endsWith("/answer") && r.request().method() === "POST"),
    panel.getByTestId("ticket-detail-answer-submit").click(),
  ]);
  expect(posted.status()).toBe(200);
  return posted.json();
}

async function exitCleanly(michelin: RunningMichelin): Promise<void> {
  michelin.child.kill("SIGTERM");
  const [code] = await once(michelin.child, "exit");
  expect(code).toBe(0);
}

test.setTimeout(90_000);

test("a real Michelin's questions block the Ticket, show on the slip and receipt, and the Owner's answers resume the same Round to delivery", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const runner = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  const script: EngineScriptStep[] = [
    { step: "start" },
    { step: "progress", note: "Reading the Ticket" },
    { step: "ask", question: REGION },
    { step: "progress", note: "Drafting the report" },
    { step: "ask", question: APPENDIX },
    { step: "deliver", bodyMarkdown: "# Report\n\nEurope only, with the appendix.", summary: "Covered Europe with the appendix", criteriaAssessment: "A summary exists" },
  ];

  await signInWithoutBrowser(api);
  const queued = await queueForAgent(api, `Ask me ${stamp}`, `Asker ${stamp}`);
  expect((await ticket(api, queued.id)).allowedActions.answer).toEqual({ available: false, reason: { code: "answer_not_available", message: expect.any(String) } });

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, script);
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    const first = await waitingOn(api, queued.id, REGION);
    const roundId = first.openRound!.id;
    expect(first).toMatchObject({ status: "Blocked", openRound: { sequence: 1, state: "waiting_for_input", waitingReason: "waiting_for_answer", stopRequestedAt: null, question: { text: REGION, answer: null, answeredAt: null } } });
    expect(first.allowedActions.answer).toEqual({ available: true });
    expect(first.allowedActions.stop).toEqual({ available: true });
    await expect.poll(() => lines(michelin.output(), "engine waiting for an answer").map((line) => line["questionId"]), { timeout: 5_000 }).toEqual([first.openRound!.question!.id]);

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto("/list");
    const row = page.getByTestId(`ticket-item-${queued.id}`);
    await expect(row.getByTestId("ticket-waiting-reason")).toHaveText("Waiting for your answer");
    await page.goto("/board");
    const slip = page.getByTestId("board-status-Blocked").getByTestId(`board-ticket-${queued.id}`);
    await expect(slip.getByTestId("board-waiting-reason")).toHaveText("Waiting for your answer");
    await expect(slip).toHaveAttribute("data-active", "true");

    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Blocked");
    await expect(page.getByTestId("ticket-detail-round-state")).toHaveText("Waiting for your answer");
    await expect(page.getByTestId("ticket-detail-round-question-unanswered")).toHaveText("Awaiting your answer");
    const resuming = await answerInSwiftlet(page, queued.id, REGION, "Europe only");
    expect(resuming.openRound).toMatchObject({ id: roundId, state: "waiting_for_input", waitingReason: "resuming", question: { text: REGION, answer: "Europe only" } });
    expect(resuming.allowedActions.answer).toMatchObject({ available: false, reason: { code: "question_already_answered" } });
    await expect(page.getByTestId("ticket-detail-question-answered")).toHaveText("Your answer: Europe only");

    const second = await waitingOn(api, queued.id, APPENDIX);
    expect(second.openRound).toMatchObject({ id: roundId, sequence: 1, waitingReason: "waiting_for_answer" });
    const [midway] = await listRounds(api, queued.id);
    expect(midway!.questions.map((question) => [question.text, question.answer])).toEqual([[REGION, "Europe only"], [APPENDIX, null]]);
    expect(midway!.activity.map((note) => note.note)).toEqual(["Reading the Ticket", "Owner's answer: Europe only", "Drafting the report"]);

    await answerInSwiftlet(page, queued.id, APPENDIX, "Yes, include it");
    await expect.poll(async () => (await ticket(api, queued.id)).status, { timeout: 15_000 }).toBe("InReview");
    const delivered = await ticket(api, queued.id);
    expect(delivered).toMatchObject({ openRound: null, delivery: { roundId, sequence: 1 } });

    const rounds = await listRounds(api, queued.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ id: roundId, state: "delivered", deliverable: { summary: "Covered Europe with the appendix" } });
    expect(rounds[0]!.questions.map((question) => [question.text, question.answer])).toEqual([[REGION, "Europe only"], [APPENDIX, "Yes, include it"]]);
    expect(rounds[0]!.activity.map((note) => note.note)).toEqual(["Reading the Ticket", "Owner's answer: Europe only", "Drafting the report", "Owner's answer: Yes, include it"]);

    const log = michelin.output();
    expect(lines(log, "round claimed").map((claim) => claim["roundId"])).toEqual([roundId]);
    expect(lines(log, "answer received").map((line) => line["questionId"])).toEqual(rounds[0]!.questions.map((question) => question.id));
    expect(lines(log, "resume reported").map((line) => line["httpStatus"])).toEqual([201, 201]);
    expect(lines(log, "command acknowledged").map((line) => line["outcome"])).toEqual(["applied", "applied"]);
    expect(log.indexOf('"msg":"resume reported"')).toBeLessThan(log.indexOf('"msg":"command acknowledged"'));
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review", { timeout: 10_000 });
    await expect(page.getByTestId("ticket-detail-question")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-round")).toHaveCount(1);
    await expect(page.getByTestId("ticket-detail-round-question-answer")).toHaveText(["A: Europe only", "A: Yes, include it"]);
    await page.reload();
    await expect(page.getByTestId("ticket-detail-round-question")).toHaveCount(2);

    expect(await answerQuestionDirect(api, queued.id, roundId, rounds[0]!.questions[0]!.id, "Asia")).toMatchObject({ ok: false, status: 400, errorCode: "question_already_answered" });
    expect(await runnerCalls(runner, token).commands(roundId)).toEqual([]);

    await exitCleanly(michelin);
    exited = true;
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await context.close();
    await runner.dispose();
    await api.dispose();
  }
});

test("the Owner's Stop ends a Round waiting for an answer as Stopped, its question kept unanswered", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  const script: EngineScriptStep[] = [
    { step: "start" },
    { step: "ask", question: REGION },
    { step: "deliver", bodyMarkdown: "# Report", summary: "never", criteriaAssessment: "never" },
  ];

  await signInWithoutBrowser(api);
  const queued = await queueForAgent(api, `Stop my question ${stamp}`, `Silent ${stamp}`);
  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, script);
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    const waiting = await waitingOn(api, queued.id, REGION);
    const roundId = waiting.openRound!.id;
    const questionId = waiting.openRound!.question!.id;

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-answer-form")).toBeVisible();
    const [posted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/stop`) && r.request().method() === "POST"),
      page.getByTestId("ticket-detail-stop-button").click(),
    ]);
    expect(posted.status()).toBe(200);
    const stopping = await posted.json() as Ticket;
    expect(stopping).toMatchObject({ status: "Blocked", openRound: { state: "waiting_for_input", waitingReason: "stopping" } });
    expect(stopping.allowedActions.answer).toMatchObject({ available: false, reason: { code: "stop_already_requested" } });
    await expect(page.getByTestId("ticket-detail-answer-form")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-answer-unavailable")).toHaveText(stopping.allowedActions.answer.reason!.message);

    await expect.poll(() => michelin.output(), { timeout: 15_000 }).toContain('"msg":"command acknowledged"');
    const log = michelin.output();
    const [halted] = lines(log, "engine stopped");
    expect(halted).toMatchObject({ roundId, stepIndex: 1 });
    expect(lines(log, "resume reported")).toEqual([]);
    expect(lines(log, "command acknowledged")).toEqual([expect.objectContaining({ commandId: halted!["commandId"], outcome: "applied" })]);

    const ended = await ticket(api, queued.id);
    expect(ended).toMatchObject({ status: "Backlog", openRound: null, delivery: null });
    expect(ended.badges.map((badge) => badge.name)).toEqual(["Stopped"]);
    const [round] = await listRounds(api, queued.id);
    expect(round).toMatchObject({
      id: roundId,
      state: "stopped",
      outcomeNote: `Stopped while waiting for the answer to step 2 of 3 on Stop command ${halted!["commandId"]}`,
      questions: [{ id: questionId, text: REGION, answer: null, answeredAt: null }],
      deliverable: null,
    });

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Backlog", { timeout: 10_000 });
    await expect(page.getByTestId("ticket-detail-question")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-round-stopped")).toHaveText("Stopped");
    await expect(page.getByTestId("ticket-detail-round-question-unanswered")).toHaveText("Not answered");
    expect(await answerQuestionDirect(api, queued.id, roundId, questionId, "Too late")).toMatchObject({ ok: false, status: 400, errorCode: "round_not_open" });

    await exitCleanly(michelin);
    exited = true;
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await context.close();
    await api.dispose();
  }
});
