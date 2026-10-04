import { once } from "node:events";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, runnerCalls, startMichelin, type EngineScriptStep } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRoundActivity, listRounds, reorderTicketDirect, updateTicketDirect, type Ticket } from "../support/tickets";

const NOTES = 55;
const SCRIPT: EngineScriptStep[] = [
  { step: "start" },
  ...Array.from({ length: NOTES }, (_, index): EngineScriptStep => ({ step: "progress", note: `Step ${index + 1} of ${NOTES}` })),
  { step: "hold" },
];
const TIMEZONE = "Asia/Kolkata";
const GREYED = "rgb(214, 211, 209)";

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function queueForAgent(api: APIRequestContext, title: string, agentId: string): Promise<Ticket> {
  const queued = await createTicket(api, title);
  expect((await updateTicketDirect(api, queued.id, { goal: "Summarise the findings", successCriteria: "A summary exists" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);
  const top = ((await (await api.get("/api/tickets")).json()) as { tickets: Ticket[] }).tickets.find((t) => t.status === "Ready" && t.requestingAgentWork)!;
  if (top.id !== queued.id) expect((await reorderTicketDirect(api, queued.id, { before: top.id })).ok).toBe(true);
  return queued;
}

function kolkata(iso: string): string {
  const date = new Date(Date.parse(iso) + 330 * 60_000);
  const two = (value: number) => String(value).padStart(2, "0");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()];
  return `${two(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} UTC+05:30`;
}

const riderAnimation = (slip: Locator) => slip.getByTestId("delivery-indicator").locator(".delivery-rider").evaluate((rider) => getComputedStyle(rider).animationName);

async function expectActive(slip: Locator, prefix: "ticket" | "board", title: string, reason: string, animation: string, stop: boolean) {
  await expect(slip).toHaveAttribute("data-active", "true");
  await expect(slip.getByTestId(`${prefix}-waiting-reason`)).toHaveText(reason);
  await expect(slip.getByRole("link", { name: `View ${title}` })).toBeVisible();
  await expect(slip.getByRole("button", { name: `Stop ${title}` })).toHaveCount(stop ? 1 : 0);
  await expect.poll(() => riderAnimation(slip)).toBe(animation);
}

const listRow = (page: Page, id: string) => page.getByTestId(`ticket-item-${id}`);
const boardSlip = (page: Page, id: string) => page.getByTestId(`board-ticket-${id}`);

test.setTimeout(120_000);

test("a real Michelin's Working Round shows the active slip on list and board, keeps its meaning under reduced motion, pages past 50 notes in local time, and stops from the slip", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Courier ${stamp}`, "research");
  const title = `Deliver me ${stamp}`;
  const queued = await queueForAgent(api, title, agent.id);

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, SCRIPT);
  let exited = false;
  const context = await browser.newContext({ baseURL, timezoneId: TIMEZONE });
  try {
    await expect.poll(() => michelin.output(), { timeout: 20_000 }).toContain('"msg":"engine holding"');
    const working = await ticket(api, queued.id);
    expect(working.openRound).toMatchObject({ state: "running", stopRequestedAt: null, waitingReason: "working" });
    expect(working.allowedActions.stop).toEqual({ available: true });
    const roundId = working.openRound!.id;
    const [round] = await listRounds(api, queued.id);
    expect(round!.activity.map((note) => note.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 6));
    expect(round!.earlierActivityCursor).not.toBeNull();
    const earlier = await listRoundActivity(api, queued.id, roundId, round!.earlierActivityCursor!);
    expect(earlier.activity.map((note) => note.note)).toEqual(["Step 1 of 55", "Step 2 of 55", "Step 3 of 55", "Step 4 of 55", "Step 5 of 55"]);
    expect(earlier.earlierActivityCursor).toBeNull();
    const bad = await api.get(`/api/tickets/${queued.id}/rounds/${roundId}/activity?before=not-a-cursor`);
    expect(bad.status()).toBe(400);
    expect((await bad.json() as { error: { code: string } }).error.code).toBe("invalid_cursor");

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto("/list");
    const row = listRow(page, queued.id);
    await expectActive(row, "ticket", title, "Working", "delivery-ride", true);
    await expect(row).toHaveCSS("background-color", GREYED);
    await expect(row.getByRole("img", { name: `Locked while ${agent.name} works on Round 1` })).toBeVisible();

    await row.getByRole("link", { name: `View ${title}` }).press("Enter");
    const receipt = page.getByTestId("ticket-detail-modal-content");
    const notes = receipt.getByTestId("ticket-detail-round-note");
    await expect(notes).toHaveCount(50);
    await expect(notes.first()).toContainText("Step 6 of 55");
    await expect(notes.first().locator("time")).toHaveText(kolkata(round!.activity[0]!.occurredAt));
    await expect(receipt.getByTestId("ticket-detail-round-claimed-at")).toHaveText(kolkata(round!.claimedAt));
    const loadEarlier = receipt.getByRole("button", { name: "Load earlier activity for Round 1" });
    await loadEarlier.focus();
    await page.keyboard.press("Enter");
    await expect(notes).toHaveCount(NOTES);
    await expect(notes.first()).toContainText("Step 1 of 55");
    await expect(notes.first().locator("time")).toHaveText(kolkata(earlier.activity[0]!.occurredAt));
    await expect(loadEarlier).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(receipt).toHaveCount(0);

    await page.goto("/board");
    const slip = page.getByTestId("board-status-InProgress").getByTestId(`board-ticket-${queued.id}`);
    await expectActive(slip, "board", title, "Working", "delivery-ride", true);
    await expect(slip.locator("[data-surface=paper]")).toHaveCSS("background-color", GREYED);
    await expect(slip).toHaveAttribute("draggable", "false");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expectActive(slip, "board", title, "Working", "none", true);
    await page.goto("/list");
    await expectActive(listRow(page, queued.id), "ticket", title, "Working", "none", true);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/board");
    await expectActive(slip, "board", title, "Working", "delivery-ride", true);

    const [posted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/stop`) && r.request().method() === "POST"),
      slip.getByRole("button", { name: `Stop ${title}` }).click(),
    ]);
    expect(posted.status()).toBe(200);
    expect((await posted.json() as Ticket).openRound).toMatchObject({ id: roundId, waitingReason: "stopping" });
    await expect.poll(async () => (await ticket(api, queued.id)).openRound, { timeout: 15_000 }).toBeNull();
    const stopped = page.getByTestId("board-status-Backlog").getByTestId(`board-ticket-${queued.id}`);
    await expect(stopped).toBeVisible({ timeout: 10_000 });
    await expect(stopped).not.toHaveAttribute("data-active");
    await expect(stopped.getByTestId("board-active-order")).toHaveCount(0);
    await expect(stopped).toHaveAttribute("draggable", "true");

    michelin.child.kill("SIGTERM");
    const [code] = await once(michelin.child, "exit");
    exited = true;
    expect(code).toBe(0);
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await context.close();
    await api.dispose();
  }
});

// The claim is made directly with the runner credential, as in runner-claims.spec.ts: a real Michelin starts the Round
// within milliseconds and confirms a Stop within a poll, so Starting and Stopping would not hold still to be seen.
test("a directly claimed Round shows Starting, Runner disconnected on the slip and the receipt with the header, Reconciling after the runner registers again, and Stopping once stopped from the slip, on desktop and phone", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const runner = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Claimer ${stamp}`, "research");
  const title = `Wait for me ${stamp}`;
  const queued = await queueForAgent(api, title, agent.id);

  const token = await pairRunnerViaApi(api);
  const calls = runnerCalls(runner, token);
  const desktop = await browser.newContext({ baseURL, timezoneId: TIMEZONE });
  const phone = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await calls.register();
    const claim = await calls.claim();
    expect(claim.ticket.id).toBe(queued.id);
    expect((await ticket(api, queued.id)).openRound).toMatchObject({ id: claim.roundId, state: "claimed", waitingReason: "starting" });

    const page = await desktop.newPage();
    await signIn(page, request, "owner");
    await page.goto("/list");
    await expectActive(listRow(page, queued.id), "ticket", title, "Starting", "delivery-idle", true);
    await page.goto("/board");
    await expectActive(page.getByTestId("board-status-Ready").getByTestId(`board-ticket-${queued.id}`), "board", title, "Starting", "delivery-idle", true);

    const advanced = await api.post("/api/dev/clock/advance", { data: { seconds: 30 } });
    expect(advanced.status()).toBe(200);
    expect((await ticket(api, queued.id)).openRound!.waitingReason).toBe("runner_disconnected");
    await page.goto("/list");
    const row = listRow(page, queued.id);
    await expectActive(row, "ticket", title, "Runner disconnected", "none", true);
    await row.getByRole("link", { name: `View ${title}` }).click();
    const header = page.locator("header").getByTestId("runner-health-pill");
    const notice = page.getByTestId("ticket-detail-runner-disconnected");
    await expect(header).toHaveAttribute("data-health", "disconnected");
    await expect(notice).toBeVisible({ timeout: 2_000 });
    await page.keyboard.press("Escape");

    expect(await calls.register()).toEqual({ registeredAt: expect.any(String), reconcileRequired: true });
    expect((await ticket(api, queued.id)).openRound!.waitingReason).toBe("reconciling");
    await expect(row.getByTestId("ticket-waiting-reason")).toHaveText("Reconciling with the runner", { timeout: 10_000 });
    expect(await calls.reconcile([{ roundId: claim.roundId, claimEpoch: claim.claimEpoch, execution: "running" }])).toMatchObject({ roundId: claim.roundId, disposition: "continue" });
    await expect.poll(async () => (await ticket(api, queued.id)).openRound!.waitingReason).toBe("starting");
    await expect(row.getByTestId("ticket-waiting-reason")).toHaveText("Starting", { timeout: 10_000 });
    await expect(header).toHaveAttribute("data-health", "connected", { timeout: 15_000 });
    await row.getByRole("link", { name: `View ${title}` }).click();
    await expect(page.getByTestId("ticket-detail-modal-content").getByTestId("ticket-detail-round-state")).toHaveText("Claimed, waiting for the runner to start");
    await expect(notice).toHaveCount(0);
    await page.keyboard.press("Escape");

    const handset = await phone.newPage();
    await signIn(handset, request, "owner");
    await handset.goto("/board?stage=Ready");
    const phoneSlip = boardSlip(handset, queued.id);
    await expectActive(phoneSlip, "board", title, "Starting", "delivery-idle", true);
    await expect(phoneSlip.getByTestId("board-slip-toggle")).toHaveCount(0);
    await handset.goto("/list");
    const phoneRow = listRow(handset, queued.id);
    await expectActive(phoneRow, "ticket", title, "Starting", "delivery-idle", true);

    const [posted] = await Promise.all([
      handset.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/stop`) && r.request().method() === "POST"),
      phoneRow.getByRole("button", { name: `Stop ${title}` }).click(),
    ]);
    expect(posted.status()).toBe(200);
    await expectActive(phoneRow, "ticket", title, "Stopping", "delivery-return", false);
    expect((await ticket(api, queued.id)).openRound).toMatchObject({ id: claim.roundId, state: "claimed", stopRequestedAt: expect.any(String), waitingReason: "stopping" });

    await page.goto("/board");
    await expectActive(page.getByTestId("board-status-Ready").getByTestId(`board-ticket-${queued.id}`), "board", title, "Stopping", "delivery-return", false);
    await page.goto("/list");
    await expectActive(listRow(page, queued.id), "ticket", title, "Stopping", "delivery-return", false);
  } finally {
    await desktop.close();
    await phone.close();
    await runner.dispose();
    await api.dispose();
  }
});
