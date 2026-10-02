import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, runnerCalls, startMichelin } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, requestStopDirect, updateTicketDirect, type Ticket } from "../support/tickets";

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test.setTimeout(60_000);

test("the Owner's Stop reaches a real Michelin, which halts its held Round and acknowledges it once, while the Ticket stays Stopping and locked", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const runner = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();

  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Stopper ${stamp}`, "research");
  const queued = await createTicket(api, `Stop me ${stamp}`);
  expect((await updateTicketDirect(api, queued.id, { goal: "Summarise the findings", successCriteria: "A summary exists" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);
  expect((await ticket(api, queued.id)).allowedActions.stop).toEqual({ available: false, reason: { code: "stop_not_available", message: expect.any(String) } });

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, [{ step: "start" }, { step: "hold" }]);
  let stopped = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(async () => (await ticket(api, queued.id)).openRound?.state, { timeout: 15_000 }).toBe("running");
    await expect.poll(() => michelin.output(), { timeout: 5_000 }).toContain('"msg":"engine holding"');
    const running = await ticket(api, queued.id);
    expect(running.openRound!.stopRequestedAt).toBeNull();
    expect(running.allowedActions.stop).toEqual({ available: true });

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-stopping")).toHaveCount(0);
    const stop = page.getByTestId("ticket-detail-stop-button");
    await expect(stop).toHaveText("Stop");
    const [posted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/stop`) && r.request().method() === "POST"),
      stop.click(),
    ]);
    expect(posted.status()).toBe(200);
    await expect(page.getByTestId("ticket-detail-stopping")).toHaveText("Stopping…");
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Progress");
    await expect(page.getByTestId("ticket-detail-locked")).toHaveText(`Locked while ${agent.name} works on Round 1`);
    await expect(stop).toHaveCount(0);

    await expect.poll(() => michelin.output(), { timeout: 15_000 }).toContain('"msg":"command acknowledged"');
    const log = michelin.output();
    expect(log).toContain('"msg":"stop requested"');
    expect(log).toContain('"msg":"engine stopped"');
    expect(log.indexOf('"msg":"engine stopped"')).toBeLessThan(log.indexOf('"msg":"command acknowledged"'));
    const acks = log.split("\n").filter((line) => line.includes('"msg":"command acknowledged"')).map((line) => JSON.parse(line) as { commandId: string; outcome: string; acknowledgedAt: string });
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ outcome: "applied" });
    expect(log).not.toContain("command acknowledgement");
    expect(log).not.toContain(token);

    const stopping = await ticket(api, queued.id);
    expect(stopping.status).toBe("InProgress");
    expect(stopping.openRound).toEqual({ ...running.openRound, stopRequestedAt: expect.any(String) });
    expect(stopping.allowedActions.stop).toEqual({ available: false, reason: { code: "stop_already_requested", message: expect.any(String) } });

    const repeated = await requestStopDirect(api, queued.id);
    expect(repeated.status).toBe(200);
    expect(repeated.ticket!.openRound!.stopRequestedAt).toBe(stopping.openRound!.stopRequestedAt);

    const calls = runnerCalls(runner, token);
    const roundId = running.openRound!.id;
    expect(await calls.commands(roundId)).toEqual([]);
    expect(await calls.ack(roundId, acks[0]!.commandId, "applied")).toEqual({ status: 200, body: { id: acks[0]!.commandId, acknowledgedAt: acks[0]!.acknowledgedAt, outcome: "applied" } });
    expect(await calls.ack(roundId, acks[0]!.commandId, "ignored")).toMatchObject({ status: 409, body: { error: { code: "command_already_acknowledged" } } });
    expect(await calls.claimStatus()).toBe(204);

    const edit = await updateTicketDirect(api, queued.id, { title: "Renamed while Stopping" });
    expect(edit).toMatchObject({ ok: false, status: 400, errorCode: "round_open", roundId });

    await page.goto("/board");
    const slip = page.getByTestId("board-status-InProgress").getByTestId(`board-ticket-${queued.id}`);
    await expect(slip.getByTestId("board-stopping")).toHaveText("Stopping…");
    await expect(slip.getByRole("img", { name: `Locked while ${agent.name} works on Round 1` })).toBeVisible();

    michelin.child.kill("SIGTERM");
    const [code] = await once(michelin.child, "exit");
    stopped = true;
    expect(code).toBe(0);
    expect((await ticket(api, queued.id)).openRound).toEqual(stopping.openRound);
  } finally {
    if (!stopped) michelin.child.kill("SIGKILL");
    await context.close();
    await runner.dispose();
    await api.dispose();
  }
});
