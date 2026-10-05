import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, NO_USAGE, updateTicketDirect, type Ticket } from "../support/tickets";

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test("a real Michelin starts a claimed Round with no browser open, and the slip and receipt then show it from Galley's live data", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();

  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Engine ${stamp}`, "research");
  const queued = await createTicket(api, `Start me ${stamp}`);
  expect((await updateTicketDirect(api, queued.id, { goal: "Summarise the findings", successCriteria: "A summary exists" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);
  expect(await ticket(api, queued.id)).toMatchObject({ status: "Ready", requestingAgentWork: true, openRound: null });

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, [{ step: "start" }, { step: "hold" }]);
  let stopped = false;
  try {
    await expect.poll(async () => (await ticket(api, queued.id)).openRound?.state, { timeout: 15_000 }).toBe("running");
    const started = await ticket(api, queued.id);
    expect(started.status).toBe("InProgress");
    expect(started.requestingAgentWork).toBe(false);
    expect(started.openRound).toMatchObject({ sequence: 1, state: "running", agent: { id: agent.id, name: agent.name, kind: "research" } });
    expect(started.openRound!.startedAt).not.toBeNull();
    expect(started.allowedActions).toMatchObject({ statusChanges: [], accept: { available: false, reason: { code: "round_open", roundId: started.openRound!.id } } });

    const rounds = await listRounds(api, queued.id);
    expect(rounds).toEqual([{
      id: started.openRound!.id,
      sequence: 1,
      state: "running",
      agent: { id: agent.id, name: agent.name, kind: "research" },
      claimedAt: started.openRound!.claimedAt,
      startedAt: started.openRound!.startedAt,
      endedAt: null,
      outcomeNote: null,
      activity: [],
      earlierActivityCursor: null,
      questions: [],
      feedback: [],
      permissionRequests: [],
      authorityChecks: [],
      authorityCheckCount: 0,
      usage: NO_USAGE,
      deliverable: null,
      attestation: null,
      limitBreach: null,
    }]);
    expect(Date.parse(rounds[0]!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(rounds[0]!.claimedAt));

    const log = michelin.output();
    expect(log).toContain(started.openRound!.id);
    expect(log).toContain('"msg":"round claimed"');
    expect(log).toMatch(/"msg":"execution started reported".*"engineReference":"controlled:[0-9a-f-]{36}"/);
    expect(log).toContain('"msg":"engine holding"');
    expect(log).not.toContain(token);

    const first = await browser.newContext({ baseURL });
    const page = await first.newPage();
    await signIn(page, request, "owner");
    await page.goto("/board");
    const slip = page.getByTestId("board-status-InProgress").getByTestId(`board-ticket-${queued.id}`);
    await expect(slip).toBeVisible();
    await expect(slip.getByTestId("board-assignee")).toHaveText(`Assignee: ${agent.name}`);
    await expect(slip.getByRole("img", { name: `Locked while ${agent.name} works on Round 1` })).toBeVisible();
    await expect(slip.getByTestId("board-waiting-reason")).toHaveText("Working");
    await expect(page.getByTestId("board-status-Ready").getByTestId(`board-ticket-${queued.id}`)).toHaveCount(0);

    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Progress");
    const section = page.getByTestId("ticket-detail-rounds");
    await expect(section.getByTestId("ticket-detail-round-number")).toHaveText("Round 1");
    await expect(section.getByTestId("ticket-detail-round-agent")).toHaveText(agent.name);
    await expect(section.getByTestId("ticket-detail-round-started").locator("time")).toHaveAttribute("datetime", started.openRound!.startedAt!);
    await expect(section.getByTestId("ticket-detail-round-state")).toHaveText("Running");
    await expect(page.getByTestId("ticket-detail-claimed")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-locked")).toHaveText(`Locked while ${agent.name} works on Round 1`);
    await first.close();

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(michelin.child.exitCode).toBeNull();
    const afterClose = await ticket(api, queued.id);
    expect(afterClose.status).toBe("InProgress");
    expect(afterClose.openRound).toEqual(started.openRound);
    expect(await listRounds(api, queued.id)).toEqual(rounds);

    const second = await browser.newContext({ baseURL });
    const reopened = await second.newPage();
    await signIn(reopened, request, "owner");
    const healthRead = reopened.waitForResponse((r) => r.url().endsWith("/api/runner-health"));
    await reopened.goto(`/tickets/${queued.id}`);
    // This navigation can discard the body of a response from the page signIn left.
    expect((await healthRead).status()).toBe(200);
    expect((await (await api.get("/api/runner-health")).json()).state).toBe("connected");
    await expect(reopened.getByTestId("ticket-detail-round-started").locator("time")).toHaveAttribute("datetime", started.openRound!.startedAt!);
    await expect(reopened.getByTestId("ticket-detail-runner-disconnected")).toHaveCount(0);

    michelin.child.kill("SIGTERM");
    const [code] = await once(michelin.child, "exit");
    stopped = true;
    expect(code).toBe(0);
    expect(michelin.output()).not.toContain(token);
    expect(michelin.output()).toContain("michelin stopped");

    const advanced = await api.post("/api/dev/clock/advance", { data: { seconds: 30 } });
    expect(advanced.status()).toBe(200);
    expect((await (await api.get("/api/runner-health")).json()).state).toBe("disconnected");
    await expect(reopened.getByTestId("ticket-detail-runner-disconnected")).toContainText("Runner disconnected", { timeout: 20_000 });
    await expect(reopened.getByTestId("ticket-detail-status")).toHaveText("In Progress");
    await expect(reopened.getByTestId("ticket-detail-round-started").locator("time")).toHaveAttribute("datetime", started.openRound!.startedAt!);

    const afterLoss = await ticket(api, queued.id);
    expect(afterLoss.status).toBe("InProgress");
    expect(afterLoss.openRound).toEqual({ ...started.openRound, waitingReason: "runner_disconnected" });
    await second.close();
  } finally {
    if (!stopped) michelin.child.kill("SIGKILL");
    await api.dispose();
  }
});
