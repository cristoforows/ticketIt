import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, runnerCalls, startMichelin, type EngineScriptStep } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, requestStopDirect, stopRoundThroughGalley, updateTicketDirect, type Ticket } from "../support/tickets";

const SCRIPT: EngineScriptStep[] = [
  { step: "start" },
  { step: "progress", note: "Reading the Ticket" },
  { step: "usage", provider: "controlled", model: "scripted", inputTokens: 1200, outputTokens: 300, costUsd: "0.004500", activeMs: 2000, basis: "reported", providerGenerationId: null },
  { step: "hold" },
];

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

test.setTimeout(90_000);

test("the Owner's Stop ends a real Michelin's Round as Stopped: Backlog with the Stopped Badge, its activity and usage kept, and an explicit Ready claims Round 2", async ({ playwright, browser, request }) => {
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
  const michelin = startMichelin(token, 500, SCRIPT);
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(async () => (await listRounds(api, queued.id))[0]?.usage.observations, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => michelin.output(), { timeout: 5_000 }).toContain('"msg":"engine holding"');
    const running = await ticket(api, queued.id);
    expect(running.openRound).toMatchObject({ sequence: 1, state: "running", stopRequestedAt: null });
    expect(running.allowedActions.stop).toEqual({ available: true });
    const roundId = running.openRound!.id;

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-round-note")).toHaveCount(1);
    const stop = page.getByTestId("ticket-detail-stop-button");
    await expect(stop).toHaveText("Stop");
    const [posted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/stop`) && r.request().method() === "POST"),
      stop.click(),
    ]);
    expect(posted.status()).toBe(200);
    const stopping = await posted.json() as Ticket;
    expect(stopping.status).toBe("InProgress");
    expect(stopping.openRound!.stopRequestedAt).not.toBeNull();

    await expect.poll(() => michelin.output(), { timeout: 15_000 }).toContain('"msg":"command acknowledged"');
    const log = michelin.output();
    const [halted] = lines(log, "engine stopped");
    const [confirmed] = lines(log, "stop confirmation reported");
    const acks = lines(log, "command acknowledged");
    expect(halted).toMatchObject({ roundId, stepIndex: 3 });
    expect(confirmed).toMatchObject({ roundId, step: "stop", httpStatus: 201, endedAt: expect.any(String) });
    expect(acks).toEqual([expect.objectContaining({ roundId, commandId: halted!["commandId"], outcome: "applied", attempt: 1 })]);
    expect(log.indexOf('"msg":"engine stopped"')).toBeLessThan(log.indexOf('"msg":"stop confirmation reported"'));
    expect(log.indexOf('"msg":"stop confirmation reported"')).toBeLessThan(log.indexOf('"msg":"command acknowledged"'));
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);

    const ended = await ticket(api, queued.id);
    expect(ended).toMatchObject({ status: "Backlog", openRound: null, delivery: null, requestingAgentWork: false });
    expect(ended.badges).toEqual([{ id: expect.any(String), name: "Stopped" }]);
    const stoppedBadge = ended.badges[0]!;
    expect(ended.allowedActions.stop).toEqual({ available: false, reason: { code: "stop_not_available", message: expect.any(String) } });
    const [round1] = await listRounds(api, queued.id);
    expect(round1).toMatchObject({
      id: roundId,
      sequence: 1,
      state: "stopped",
      endedAt: confirmed!["endedAt"],
      outcomeNote: `Stopped before step 4 of 4 on Stop command ${halted!["commandId"]}`,
      activity: [{ seq: 1, note: "Reading the Ticket", occurredAt: expect.any(String) }],
      deliverable: null,
    });
    expect(round1!.usage).toMatchObject({ observations: 1, costUsd: "0.004500", inputTokens: { sum: 1200 } });

    const section = page.getByTestId("ticket-detail-rounds");
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Backlog", { timeout: 10_000 });
    await expect(page.getByTestId("ticket-detail-stopping")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-locked")).toHaveCount(0);
    await expect(section.getByTestId("ticket-detail-round-stopped")).toHaveText("Stopped");
    await expect(section.getByTestId("ticket-detail-round-outcome-note")).toHaveText(round1!.outcomeNote!);
    await expect(section.getByTestId("ticket-detail-round-note")).toContainText("Reading the Ticket");
    await expect(section.getByTestId("ticket-detail-round-usage-cost")).toHaveText("$0.0045");
    await expect(section.getByTestId("ticket-detail-round-usage-input-tokens")).toHaveText("1,200");
    await expect(page.getByTestId("ticket-detail-badges").getByText("Stopped", { exact: true })).toBeVisible();

    await page.reload();
    await expect(section.getByTestId("ticket-detail-round-stopped")).toHaveText("Stopped");
    await expect(section.getByTestId("ticket-detail-round-usage-input-tokens")).toHaveText("1,200");

    const calls = runnerCalls(runner, token);
    const late = await runner.post(`/api/runner/rounds/${roundId}/events`, {
      headers: { authorization: `Bearer ${token}` },
      data: { type: "progress", idempotencyKey: `late-${stamp}`, claimEpoch: 1, occurredAt: new Date().toISOString(), data: { note: "too late" } },
    });
    expect(late.status()).toBe(409);
    expect((await late.json() as { error: { code: string } }).error.code).toBe("round_not_open");
    expect(await calls.commands(roundId)).toEqual([]);
    const commandId = String(halted!["commandId"]);
    expect(await calls.ack(roundId, commandId, "applied")).toEqual({ status: 200, body: { id: commandId, acknowledgedAt: acks[0]!["acknowledgedAt"], outcome: "applied" } });
    expect(await calls.ack(roundId, commandId, "ignored")).toMatchObject({ status: 409, body: { error: { code: "command_already_acknowledged" } } });
    expect(await requestStopDirect(api, queued.id)).toMatchObject({ ok: false, status: 400, errorCode: "stop_not_available" });

    await page.goto("/board");
    const slip = page.getByTestId("board-status-Backlog").getByTestId(`board-ticket-${queued.id}`);
    await expect(slip.getByText("Stopped", { exact: true })).toBeVisible();
    await expect(slip.getByTestId("board-stopping")).toHaveCount(0);

    await page.goto(`/tickets/${queued.id}`);
    const [detached] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/badges/${stoppedBadge.id}`) && r.request().method() === "DELETE"),
      page.getByRole("button", { name: "Remove Stopped" }).click(),
    ]);
    expect(detached.status()).toBe(200);
    await expect(page.getByTestId("ticket-detail-badges")).toContainText("No badges.");
    expect(await listRounds(api, queued.id)).toEqual([round1]);

    const [readied] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/status`) && r.request().method() === "POST"),
      page.getByTestId("ticket-detail-status-button-Ready").click(),
    ]);
    expect(readied.status()).toBe(200);
    await expect.poll(async () => (await ticket(api, queued.id)).openRound?.sequence, { timeout: 15_000 }).toBe(2);
    const second = (await ticket(api, queued.id)).openRound!;
    expect(second.id).not.toBe(roundId);
    await expect.poll(() => lines(michelin.output(), "round claimed").map((claim) => [claim["roundId"], claim["sequence"], claim["claimEpoch"]]), { timeout: 5_000 }).toEqual([[roundId, 1, 1], [second.id, 2, 2]]);
    await expect(page.getByTestId("ticket-detail-round")).toHaveCount(2, { timeout: 10_000 });
    await expect(page.getByTestId("ticket-detail-round").nth(1)).toHaveAttribute("data-state", "stopped");
    const [, stillStopped] = await listRounds(api, queued.id);
    expect(stillStopped).toEqual(round1);

    await expect.poll(() => lines(michelin.output(), "engine holding").length, { timeout: 15_000 }).toBe(2);
    const again = await stopRoundThroughGalley(api, queued.id);
    expect(again.status).toBe("Backlog");
    expect(again.badges).toEqual([stoppedBadge]);
    const badges = await (await api.get("/api/badges")).json() as { badges: { id: string; name: string }[] };
    expect(badges.badges.filter((badge) => badge.name.toLowerCase() === "stopped")).toEqual([expect.objectContaining({ id: stoppedBadge.id })]);
    expect((await listRounds(api, queued.id)).map((round) => [round.sequence, round.state])).toEqual([[2, "stopped"], [1, "stopped"]]);
    await expect.poll(() => lines(michelin.output(), "command acknowledged").length, { timeout: 15_000 }).toBe(2);

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
