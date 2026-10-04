import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, runnerCalls, startMichelin, type EngineScriptStep, type RunningMichelin } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, decidePermissionDirect, listRounds, updateTicketDirect, type Ticket } from "../support/tickets";

const SCOPE = { account: "controlled", action: "write_note", resource: "notes/weekly-report" };

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

async function queueForAgent(api: APIRequestContext, title: string, agentName: string): Promise<Ticket> {
  const agent = await createAgent(api, agentName, "research");
  const queued = await createTicket(api, title);
  expect((await updateTicketDirect(api, queued.id, { goal: "Write the weekly report note", successCriteria: "The note is written" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);
  return queued;
}

async function waitingForPermission(api: APIRequestContext, id: string): Promise<Ticket> {
  await expect.poll(async () => (await ticket(api, id)).openRound?.waitingReason, { timeout: 15_000 }).toBe("waiting_for_permission");
  return ticket(api, id);
}

async function exitCleanly(michelin: RunningMichelin): Promise<void> {
  michelin.child.kill("SIGTERM");
  const [code] = await once(michelin.child, "exit");
  expect(code).toBe(0);
}

test.setTimeout(90_000);

test("a real Michelin's denied action blocks the Ticket, and one approval for this Ticket lets both actions run in the same Round", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const runner = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  const script: EngineScriptStep[] = [
    { step: "start" },
    { step: "act", ...SCOPE },
    { step: "act", ...SCOPE },
    { step: "deliver", bodyMarkdown: "# Weekly report\n\nWritten twice.", summary: "Wrote the weekly report note", criteriaAssessment: "The note is written" },
  ];

  await signInWithoutBrowser(api);
  const queued = await queueForAgent(api, `Permission ${stamp}`, `Actor ${stamp}`);
  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, script);
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    const waiting = await waitingForPermission(api, queued.id);
    const roundId = waiting.openRound!.id;
    const requestId = waiting.openRound!.permissionRequest!.id;
    expect(waiting).toMatchObject({
      status: "Blocked",
      permissionGrants: [],
      openRound: { sequence: 1, state: "waiting_for_input", question: null, permissionRequest: { ...SCOPE, substituteAccount: true, decision: null, decidedAt: null, grantId: null } },
    });
    expect(waiting.allowedActions.permissionDecision).toEqual({ available: true });
    expect(waiting.allowedActions.stop).toEqual({ available: true });
    expect(waiting.allowedActions.accept).toMatchObject({ available: false, reason: { code: "round_open" } });
    await expect.poll(() => lines(michelin.output(), "engine waiting for an approval").map((line) => line["requestId"]), { timeout: 5_000 }).toEqual([requestId]);

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto("/board");
    const slip = page.getByTestId("board-status-Blocked").getByTestId(`board-ticket-${queued.id}`);
    await expect(slip.getByTestId("board-waiting-reason")).toHaveText("Waiting for a Permission");
    await expect(slip).toHaveAttribute("data-active", "true");

    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-round-state")).toHaveText("Waiting for a Permission");
    const panel = page.getByRole("region", { name: "Permission request" });
    await expect(panel.getByTestId("ticket-detail-permission-account")).toHaveText("controlledSubstitute account");
    await expect(panel.getByTestId("ticket-detail-permission-action")).toHaveText("write_note");
    await expect(panel.getByTestId("ticket-detail-permission-resource")).toHaveText("notes/weekly-report");
    await expect(page.getByTestId("ticket-detail-round-authority-check")).toHaveText([/Denied write_note on notes\/weekly-report \(controlled\)/]);
    const [posted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/permission-requests/${requestId}/approve`) && r.request().method() === "POST"),
      panel.getByTestId("ticket-detail-permission-approve").click(),
    ]);
    expect(posted.status()).toBe(200);
    expect(posted.request().postDataJSON()).toEqual({ form: "ticket" });
    const approved = await posted.json() as Ticket;
    const grantId = approved.openRound!.permissionRequest!.grantId!;
    expect(approved.openRound).toMatchObject({ id: roundId, waitingReason: "resuming", permissionRequest: { decision: "approved", grantId: expect.any(String) } });
    expect(approved.permissionGrants).toEqual([expect.objectContaining({ id: grantId, ...SCOPE, substituteAccount: true, form: "ticket", state: "active", roundId })]);
    await expect(page.getByTestId("ticket-detail-permission-approved")).toBeVisible();

    await expect.poll(async () => (await ticket(api, queued.id)).status, { timeout: 15_000 }).toBe("InReview");
    expect(await ticket(api, queued.id)).toMatchObject({ openRound: null, delivery: { roundId, sequence: 1 }, permissionGrants: [{ id: grantId }] });

    const rounds = await listRounds(api, queued.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ id: roundId, state: "delivered" });
    expect(rounds[0]!.permissionRequests).toEqual([expect.objectContaining({ id: requestId, decision: "approved", grantId })]);
    expect(rounds[0]!.authorityChecks.map((check) => [check.decision, check.grantId])).toEqual([["deny", null], ["allow", grantId], ["allow", grantId]]);
    expect(rounds[0]!.authorityCheckCount).toBe(3);
    expect(rounds[0]!.activity.map((note) => note.note)).toEqual(["Performed write_note on notes/weekly-report", "Performed write_note on notes/weekly-report"]);

    const log = michelin.output();
    expect(lines(log, "permission requested").map((line) => line["requestId"])).toEqual([requestId]);
    expect(lines(log, "approval received").map((line) => [line["requestId"], line["grantId"]])).toEqual([[requestId, grantId]]);
    expect(lines(log, "authority checked").map((line) => line["decision"])).toEqual(["deny", "allow", "allow"]);
    const acks = lines(log, "command acknowledged");
    expect(acks.map((line) => [line["type"], line["outcome"]])).toEqual([["authority_changed", "applied"], ["approval", "applied"]]);
    const order = log.split("\n").filter((line) => line.includes('"msg":"resume reported"') || (line.includes('"msg":"command acknowledged"') && line.includes('"type":"approval"')));
    expect(order.map((line) => (JSON.parse(line) as Record<string, unknown>)["msg"])).toEqual(["resume reported", "command acknowledged"]);
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);

    expect(await decidePermissionDirect(api, queued.id, roundId, requestId, "approve")).toMatchObject({ ok: false, status: 400, errorCode: "permission_already_decided" });
    expect((await ticket(api, queued.id)).permissionGrants).toHaveLength(1);
    expect(await runnerCalls(runner, token).commands(roundId)).toEqual([]);

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review", { timeout: 10_000 });
    await expect(page.getByTestId("ticket-detail-permission")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-permission-grant")).toHaveText(/may write_note on notes\/weekly-report \(controlled\)Substitute account/);
    await expect(page.getByTestId("ticket-detail-round-permission-request")).toHaveAttribute("data-decision", "approved");

    await exitCleanly(michelin);
    exited = true;
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await context.close();
    await runner.dispose();
    await api.dispose();
  }
});

test("a declined Permission request leaves the Round waiting until the Owner's Stop ends it", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  const script: EngineScriptStep[] = [
    { step: "start" },
    { step: "act", ...SCOPE },
    { step: "deliver", bodyMarkdown: "# Report", summary: "never", criteriaAssessment: "never" },
  ];

  await signInWithoutBrowser(api);
  const queued = await queueForAgent(api, `Decline ${stamp}`, `Refused ${stamp}`);
  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, script);
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    const waiting = await waitingForPermission(api, queued.id);
    const roundId = waiting.openRound!.id;
    const requestId = waiting.openRound!.permissionRequest!.id;

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    const [declined] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/permission-requests/${requestId}/decline`) && r.request().method() === "POST"),
      page.getByTestId("ticket-detail-permission-decline").click(),
    ]);
    expect(declined.status()).toBe(200);
    const still = await declined.json() as Ticket;
    expect(still).toMatchObject({ status: "Blocked", permissionGrants: [], openRound: { id: roundId, state: "waiting_for_input", waitingReason: "waiting_for_permission", permissionRequest: { decision: "declined", grantId: null } } });
    expect(still.allowedActions.stop).toEqual({ available: true });
    await expect(page.getByTestId("ticket-detail-permission-declined")).toBeVisible();

    await page.waitForTimeout(2_000);
    expect(await ticket(api, queued.id)).toMatchObject({ status: "Blocked", openRound: { id: roundId, waitingReason: "waiting_for_permission" } });
    expect(lines(michelin.output(), "approval received")).toEqual([]);
    expect(await decidePermissionDirect(api, queued.id, roundId, requestId, "approve")).toMatchObject({ ok: false, status: 400, errorCode: "permission_already_decided" });

    const [stopped] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/stop`) && r.request().method() === "POST"),
      page.getByTestId("ticket-detail-stop-button").click(),
    ]);
    expect(stopped.status()).toBe(200);

    await expect.poll(() => michelin.output(), { timeout: 15_000 }).toContain('"msg":"command acknowledged"');
    const [halted] = lines(michelin.output(), "engine stopped");
    expect(halted).toMatchObject({ roundId, stepIndex: 1 });
    await expect.poll(async () => (await ticket(api, queued.id)).openRound, { timeout: 15_000 }).toBeNull();
    const ended = await ticket(api, queued.id);
    expect(ended).toMatchObject({ status: "Backlog", permissionGrants: [] });
    const [round] = await listRounds(api, queued.id);
    expect(round).toMatchObject({
      id: roundId,
      state: "stopped",
      outcomeNote: `Stopped while waiting for the approval to step 2 of 3 on Stop command ${halted!["commandId"]}`,
      permissionRequests: [{ id: requestId, decision: "declined", grantId: null }],
      authorityCheckCount: 1,
      activity: [],
    });
    expect(lines(michelin.output(), "action performed")).toEqual([]);

    await expect(page.getByTestId("ticket-detail-round-stopped")).toHaveText("Stopped", { timeout: 10_000 });
    await expect(page.getByTestId("ticket-detail-round-permission-request")).toHaveAttribute("data-decision", "declined");

    await exitCleanly(michelin);
    exited = true;
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await context.close();
    await api.dispose();
  }
});
