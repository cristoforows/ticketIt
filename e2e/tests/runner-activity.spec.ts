import { once } from "node:events";
import { test, expect, type APIRequestContext, type Locator } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, NO_USAGE, stopRoundThroughGalley, updateTicketDirect, type Round } from "../support/tickets";

const SCRIPT: EngineScriptStep[] = [
  { step: "start" },
  { step: "progress", note: "Reading the Ticket" },
  { step: "wait", ms: 10_000 },
  { step: "usage", provider: "controlled", model: "scripted", inputTokens: 1200, outputTokens: 300, costUsd: "0.004500", activeMs: 2000, basis: "estimated", providerGenerationId: null },
  { step: "wait", ms: 10_000 },
  { step: "usage", provider: "controlled", model: "scripted", inputTokens: 50, outputTokens: null, costUsd: null, activeMs: 500, basis: "reported", providerGenerationId: null },
  { step: "progress", note: "Writing up the result" },
  { step: "hold" },
];

async function round(api: APIRequestContext, ticketId: string): Promise<Round | undefined> {
  return (await listRounds(api, ticketId))[0];
}

async function expectUsage(usage: Locator, figures: Record<string, string>) {
  for (const [figure, text] of Object.entries(figures)) {
    await expect(usage.getByTestId(`ticket-detail-round-usage-${figure}`)).toHaveText(text, { timeout: 15_000 });
  }
}

// The script's two 10 s waits give the browser a window on each usage state.
test.setTimeout(90_000);

test("a real Michelin's activity notes and usage observations appear on the receipt while the Round runs, and survive a reload", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();

  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Activity ${stamp}`, "research");
  const queued = await createTicket(api, `Report activity ${stamp}`);
  expect((await updateTicketDirect(api, queued.id, { goal: "Summarise the findings", successCriteria: "A summary exists" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, SCRIPT);
  let stopped = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(async () => (await round(api, queued.id))?.activity.length, { timeout: 15_000 }).toBe(1);
    const first = (await round(api, queued.id))!;
    expect(first.activity).toEqual([{ seq: 1, note: "Reading the Ticket", occurredAt: expect.any(String) }]);
    expect(first.usage).toEqual(NO_USAGE);

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    const section = page.getByTestId("ticket-detail-rounds");
    const notes = section.getByTestId("ticket-detail-round-note");
    const usage = section.getByTestId("ticket-detail-round-usage");
    await expect(notes).toHaveCount(1);
    await expect(notes.first()).toContainText("Reading the Ticket");
    await expect(usage.getByTestId("ticket-detail-round-usage-cost")).toHaveText("Unknown");
    await expect(usage.getByTestId("ticket-detail-round-usage-input-tokens")).toHaveText("Unknown");
    await expect(usage).not.toContainText("$0");

    await expectUsage(usage, { cost: "$0.0045 est.", "input-tokens": "1,200 est.", "output-tokens": "300 est.", "active-time": "2.0 s est." });
    await expect(notes).toHaveCount(1);

    await expect(notes).toHaveCount(2, { timeout: 20_000 });
    await expect(notes.nth(1)).toContainText("Writing up the result");
    const incomplete = { cost: "≥ $0.0045 (incomplete) est.", "input-tokens": "1,250 est.", "output-tokens": "≥ 300 (incomplete) est.", "active-time": "2.5 s est." };
    await expectUsage(usage, incomplete);

    const settled = (await round(api, queued.id))!;
    expect(settled.activity.map(({ seq, note }) => ({ seq, note }))).toEqual([
      { seq: 1, note: "Reading the Ticket" },
      { seq: 2, note: "Writing up the result" },
    ]);
    expect(settled.usage).toEqual({
      observations: 2,
      complete: false,
      estimated: true,
      costUsd: "0.004500",
      inputTokens: { sum: 1250, complete: true, estimated: true },
      outputTokens: { sum: 300, complete: false, estimated: true },
      activeMs: { sum: 2500, complete: true, estimated: true },
    });

    const log = michelin.output();
    expect(log.match(/"msg":"progress reported"/g)).toHaveLength(2);
    const observationIds = [...log.matchAll(/"msg":"usage observation reported".*?"observationId":"([0-9a-f-]{36})"/g)].map((match) => match[1]);
    expect(observationIds).toHaveLength(2);
    expect(new Set(observationIds).size).toBe(2);
    expect(log).not.toContain(token);

    await page.reload();
    await expect(notes).toHaveCount(2);
    await expectUsage(usage, incomplete);

    const ended = await stopRoundThroughGalley(api, queued.id);
    expect(ended.status).toBe("Backlog");
    expect(await round(api, queued.id)).toEqual({ ...settled, state: "stopped", endedAt: expect.any(String), outcomeNote: expect.stringMatching(/^Stopped before step 8 of 8 on Stop command [0-9a-f-]{36}$/) });

    michelin.child.kill("SIGTERM");
    const [code] = await once(michelin.child, "exit");
    stopped = true;
    expect(code).toBe(0);
  } finally {
    if (!stopped) michelin.child.kill("SIGKILL");
    await context.close();
    await api.dispose();
  }
});
