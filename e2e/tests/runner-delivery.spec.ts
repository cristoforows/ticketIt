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
  reorderTicketDirect,
  updateTicketDirect,
  type AgentKind,
  type Ticket,
  type TicketTemplate,
} from "../support/tickets";

const DELIVER: EngineScriptStep = {
  step: "deliver",
  bodyMarkdown: "# Findings\n\nThe cache was **stale**.\n\n- Reproduced it\n- Wrote it up\n\n<script>window.pwned = true</script>\n\n[unsafe](javascript:window.pwned=true)\n\n[docs](https://example.com/docs)\n\n![tracking pixel](https://tracker.invalid/pixel.png)\n",
  summary: "The cache was stale.",
  criteriaAssessment: "A written cause: met.",
};

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function queueTicket(api: APIRequestContext, title: string, agentId: string, template: TicketTemplate = "Basic"): Promise<Ticket> {
  const created = await createTicket(api, title, template);
  expect((await updateTicketDirect(api, created.id, { goal: "Find the cause", successCriteria: "A written cause", repository: template === "Coding" ? "owner/repo" : "" })).ok).toBe(true);
  expect((await assignTicketDirect(api, created.id, { type: "agent", agentId })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, created.id, "Ready")).ok).toBe(true);
  return ticket(api, created.id);
}

async function stop(michelin: RunningMichelin): Promise<void> {
  if (michelin.child.exitCode !== null) return;
  michelin.child.kill("SIGTERM");
  const [code] = await once(michelin.child, "exit");
  expect(code).toBe(0);
}

async function setUp(playwright: { request: { newContext: (options: { baseURL?: string }) => Promise<APIRequestContext> } }, name: string, kind: AgentKind) {
  const api = await playwright.request.newContext({ baseURL: process.env.E2E_BASE_URL });
  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `${name} ${Date.now()}`, kind);
  return { api, agent };
}

test.setTimeout(90_000);

test("a Basic Ticket goes Ready, claimed, running, delivered to In Review on the open receipt without a reload, then Accept makes it Done", async ({ playwright, browser, request }) => {
  const { api, agent } = await setUp(playwright, "Deliverer", "research");
  const queued = await queueTicket(api, `Deliver me ${Date.now()}`, agent.id);
  expect(queued).toMatchObject({ status: "Ready", requestingAgentWork: true, openRound: null, delivery: null });

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, [{ step: "start" }, { step: "progress", note: "Reading the Ticket" }, { step: "wait", ms: 6_000 }, DELIVER]);
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  try {
    await expect.poll(async () => (await ticket(api, queued.id)).openRound?.state, { timeout: 15_000 }).toBe("running");

    const page = await context.newPage();
    const trackerRequests: string[] = [];
    page.on("request", (sent) => { if (sent.url().includes("tracker.invalid")) trackerRequests.push(sent.url()); });
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Progress");
    await expect(page.getByTestId("ticket-detail-locked")).toBeVisible();
    await expect(page.getByTestId("ticket-detail-delivered")).toHaveCount(0);
    await page.evaluate(() => { (window as { sameDocument?: boolean }).sameDocument = true; });

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review", { timeout: 20_000 });
    await expect(page.getByTestId("ticket-detail-delivered")).toHaveText(`Delivered by ${agent.name}`);
    await expect(page.getByTestId("ticket-detail-locked")).toHaveCount(0);
    const delivered = page.getByTestId("ticket-detail-delivered-round");
    await expect(delivered.getByTestId("ticket-detail-delivered-summary")).toHaveText("The cache was stale.");
    await expect(delivered.getByTestId("ticket-detail-delivered-assessment")).toHaveText("A written cause: met.");
    const body = delivered.getByTestId("ticket-detail-delivered-body");
    await expect(body.getByRole("heading", { level: 1, name: "Findings" })).toBeVisible();
    await expect(body.locator("strong")).toHaveText("stale");
    await expect(body.locator("li")).toHaveText(["Reproduced it", "Wrote it up"]);
    await expect(body.locator("script")).toHaveCount(0);
    expect(await body.getByText("unsafe").getAttribute("href") ?? "").not.toMatch(/javascript:/i);
    await expect(body.getByRole("link", { name: "docs" })).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(body.getByRole("link", { name: "docs" })).toHaveAttribute("target", "_blank");
    await expect(body.locator("img")).toHaveCount(0);
    await expect(body.getByText("tracking pixel")).toBeVisible();
    await expect(body.getByRole("link", { name: "https://tracker.invalid/pixel.png" })).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(delivered.getByTestId("ticket-detail-delivered-note")).toHaveCount(1);
    expect(await page.evaluate(() => (window as { sameDocument?: boolean; pwned?: boolean }).sameDocument === true && (window as { pwned?: boolean }).pwned === undefined)).toBe(true);

    const inReview = await ticket(api, queued.id);
    expect(inReview).toMatchObject({ status: "InReview", openRound: null, requestingAgentWork: false, delivery: { sequence: 1, agent: { id: agent.id } } });
    expect(inReview.allowedActions).toMatchObject({ statusChanges: [], accept: { available: true } });
    const [round] = await listRounds(api, queued.id);
    expect(round).toMatchObject({ id: inReview.delivery!.roundId, state: "delivered", endedAt: inReview.delivery!.deliveredAt, deliverable: { bodyMarkdown: (DELIVER as { bodyMarkdown: string }).bodyMarkdown, summary: "The cache was stale.", criteriaAssessment: "A written cause: met." } });
    expect(michelin.output()).toMatch(/"msg":"engine delivered"/);

    await page.getByTestId("ticket-detail-accept-button").click();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Done");
    expect((await ticket(api, queued.id)).status).toBe("Done");
    await page.reload();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Done");
    await expect(page.getByTestId("ticket-detail-delivered-summary")).toHaveText("The cache was stale.");
    await expect(page.getByTestId("ticket-detail-delivered-body").getByRole("heading", { level: 1, name: "Findings" })).toBeVisible();
    expect(trackerRequests).toEqual([]);
  } finally {
    await stop(michelin);
    await context.close();
    await api.dispose();
  }
});

test("a Coding Ticket delivered by the default script stops at In Review, with Accept refused by both the receipt and the command", async ({ playwright, browser, request }) => {
  const { api, agent } = await setUp(playwright, "Coder", "coding");
  const queued = await queueTicket(api, `Code me ${Date.now()}`, agent.id, "Coding");
  expect(queued).toMatchObject({ status: "Ready", requestingAgentWork: true });

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500);
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  try {
    await expect.poll(async () => (await ticket(api, queued.id)).status, { timeout: 20_000 }).toBe("InReview");
    const inReview = await ticket(api, queued.id);
    expect(inReview).toMatchObject({ openRound: null, delivery: { agent: { id: agent.id } } });
    expect(inReview.allowedActions.accept).toMatchObject({ available: false, reason: { code: "reviewed_pr_merge_not_implemented" } });
    const refused = await acceptTicketDirect(api, queued.id);
    expect(refused).toMatchObject({ ok: false, status: 400, errorCode: inReview.allowedActions.accept.reason!.code, errorMessage: inReview.allowedActions.accept.reason!.message });
    expect((await listRounds(api, queued.id))[0]!.deliverable!.bodyMarkdown).toMatch(/^# Result\n/);

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review");
    await expect(page.getByTestId("ticket-detail-delivered")).toHaveText(`Delivered by ${agent.name}`);
    await expect(page.getByTestId("ticket-detail-accept-button")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-accept-unavailable")).toHaveText(inReview.allowedActions.accept.reason!.message);
    await expect(page.getByTestId("ticket-detail-delivered-body").getByRole("heading", { level: 1, name: "Result" })).toBeVisible();
    expect((await ticket(api, queued.id)).status).toBe("InReview");
  } finally {
    await stop(michelin);
    await context.close();
    await api.dispose();
  }
});

test("a second queued Ticket is claimed only once the first delivers, and the board shows each in turn", async ({ playwright, browser, request }) => {
  const { api, agent } = await setUp(playwright, "Sequencer", "research");
  const stamp = Date.now();
  const later = await queueTicket(api, `Second ${stamp}`, agent.id);
  const first = await queueTicket(api, `First ${stamp}`, agent.id);
  expect((await reorderTicketDirect(api, first.id, { before: later.id })).ok).toBe(true);

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 300, [{ step: "start" }, { step: "progress", note: "Working" }, { step: "wait", ms: 4_000 }, DELIVER]);
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  try {
    await expect.poll(async () => (await ticket(api, first.id)).openRound?.state, { timeout: 15_000 }).toBe("running");
    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto("/board");
    await expect(page.getByTestId("board-status-InProgress").getByTestId(`board-ticket-${first.id}`)).toBeVisible();

    while ((await ticket(api, first.id)).status !== "InReview") {
      expect(await ticket(api, later.id)).toMatchObject({ status: "Ready", openRound: null, requestingAgentWork: true });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await expect.poll(async () => (await ticket(api, later.id)).delivery?.sequence, { timeout: 20_000 }).toBe(1);
    const [firstRound] = await listRounds(api, first.id);
    const [laterRound] = await listRounds(api, later.id);
    expect(firstRound!.state).toBe("delivered");
    expect(laterRound!.state).toBe("delivered");
    expect(Date.parse(laterRound!.claimedAt)).toBeGreaterThanOrEqual(Date.parse(firstRound!.endedAt!));

    const log = michelin.output();
    const order = [...log.matchAll(/"msg":"(round claimed|engine delivered)".*?"roundId":"([0-9a-f-]{36})"/g)].map((match) => `${match[1]} ${match[2]}`);
    expect(order).toEqual([`round claimed ${firstRound!.id}`, `engine delivered ${firstRound!.id}`, `round claimed ${laterRound!.id}`, `engine delivered ${laterRound!.id}`]);

    for (const id of [first.id, later.id]) {
      const slip = page.getByTestId("board-status-InReview").getByTestId(`board-ticket-${id}`);
      await expect(slip.getByTestId("board-delivered")).toHaveText(`Delivered by ${agent.name}`, { timeout: 15_000 });
    }
  } finally {
    await stop(michelin);
    await context.close();
    await api.dispose();
  }
});
