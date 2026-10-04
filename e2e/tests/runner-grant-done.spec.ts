import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep, type RunningMichelin } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, updateTicketDirect, type Ticket } from "../support/tickets";

const SCOPE = { account: "controlled", action: "write_note", resource: "notes/weekly-report" };
const SCRIPT: EngineScriptStep[] = [
  { step: "start" },
  { step: "act", ...SCOPE },
  { step: "deliver", bodyMarkdown: "# Weekly report\n\nWritten.", summary: "Wrote the weekly report note", criteriaAssessment: "The note is written" },
];

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

async function waitingForPermission(api: APIRequestContext, id: string, sequence: number): Promise<Ticket> {
  await expect.poll(async () => {
    const current = await ticket(api, id);
    return [current.openRound?.sequence, current.openRound?.waitingReason];
  }, { timeout: 20_000 }).toEqual([sequence, "waiting_for_permission"]);
  return ticket(api, id);
}

async function exitCleanly(michelin: RunningMichelin): Promise<void> {
  if (michelin.child.exitCode !== null) return;
  michelin.child.kill("SIGTERM");
  const [code] = await once(michelin.child, "exit");
  expect(code).toBe(0);
}

test.setTimeout(120_000);

test("a ticket grant ends at Done in the browser, the reopened Round asks for the Permission again, and a fresh approval lets it deliver", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();

  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Ender ${stamp}`, "research");
  const queued = await createTicket(api, `Grant ends at Done ${stamp}`);
  expect((await updateTicketDirect(api, queued.id, { goal: "Write the weekly report note", successCriteria: "The note is written" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);
  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, SCRIPT);
  const context = await browser.newContext({ baseURL });
  try {
    const first = await waitingForPermission(api, queued.id, 1);
    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    const [approvedFirst] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/permission-requests/${first.openRound!.permissionRequest!.id}/approve`) && r.request().method() === "POST"),
      page.getByRole("region", { name: "Permission request" }).getByTestId("ticket-detail-permission-approve").click(),
    ]);
    expect(approvedFirst.status()).toBe(200);
    const grantId = (await approvedFirst.json() as Ticket).permissionGrants[0]!.id;

    await expect.poll(async () => (await ticket(api, queued.id)).status, { timeout: 20_000 }).toBe("InReview");
    const grant = page.locator(`[data-testid="ticket-detail-permission-grant"][data-grant-id="${grantId}"]`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review", { timeout: 10_000 });
    await expect(grant).toHaveAttribute("data-state", "active");
    expect(lines(michelin.output(), "action performed")).toHaveLength(1);

    const [accepted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/accept`) && r.request().method() === "POST"),
      page.getByTestId("ticket-detail-accept-button").click(),
    ]);
    expect(accepted.status()).toBe(200);
    const done = await accepted.json() as Ticket;
    expect(done).toMatchObject({ status: "Done", permissionGrants: [{ id: grantId, state: "ended_at_done", revokedAt: null, expiresAt: null, endedAt: expect.any(String), allowedActions: { revoke: { available: false, reason: { code: "grant_ended" } } } }] });
    const endedAt = done.permissionGrants[0]!.endedAt!;
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Done");
    await expect(grant).toHaveAttribute("data-state", "ended_at_done");
    await expect(grant.getByTestId("ticket-detail-permission-grant-ended")).toHaveText("Ended at Done");
    await expect(grant.getByTestId("ticket-detail-permission-grant-ended-at")).toHaveAttribute("datetime", endedAt);
    await expect(grant.getByTestId("ticket-detail-permission-grant-revoke")).toHaveCount(0);
    await expect(grant.getByTestId("ticket-detail-permission-grant-revoked")).toHaveCount(0);
    await expect(grant.getByTestId("ticket-detail-permission-grant-expired")).toHaveCount(0);

    await page.getByTestId("ticket-detail-status-button-Ready").click();
    const second = await waitingForPermission(api, queued.id, 2);
    expect(second).toMatchObject({ status: "Blocked", permissionGrants: [{ id: grantId, state: "ended_at_done", endedAt }], openRound: { permissionRequest: { ...SCOPE, decision: null, renewsGrantId: null } } });
    await expect(page.getByTestId("ticket-detail-round-state").first()).toHaveText("Waiting for a Permission");
    await expect(grant).toHaveAttribute("data-state", "ended_at_done");
    await expect(page.getByTestId("ticket-detail-round-authority-check-expired")).toHaveCount(0);

    const [approvedSecond] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/permission-requests/${second.openRound!.permissionRequest!.id}/approve`) && r.request().method() === "POST"),
      page.getByRole("region", { name: "Permission request" }).getByTestId("ticket-detail-permission-approve").click(),
    ]);
    expect(approvedSecond.status()).toBe(200);
    const freshId = (await approvedSecond.json() as Ticket).permissionGrants.find((g) => g.id !== grantId)!.id;

    await expect.poll(async () => (await ticket(api, queued.id)).delivery?.sequence, { timeout: 20_000 }).toBe(2);
    const delivered = await ticket(api, queued.id);
    expect(delivered.status).toBe("InReview");
    expect(delivered.permissionGrants.map((g) => [g.id, g.state])).toEqual([[grantId, "ended_at_done"], [freshId, "active"]]);
    const [round2] = await listRounds(api, queued.id);
    expect(round2!.authorityChecks.map((check) => [check.decision, check.grantId, check.expiredGrantId])).toEqual([["deny", null, null], ["allow", freshId, null]]);
    expect(lines(michelin.output(), "permission requested")).toHaveLength(2);
    expect(lines(michelin.output(), "authority checked").map((line) => line["decision"])).toEqual(["deny", "allow", "deny", "allow"]);
    expect(lines(michelin.output(), "action performed")).toHaveLength(2);
    expect(michelin.output()).not.toContain("round event refused");

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("In Review", { timeout: 10_000 });
    await expect(page.locator(`[data-testid="ticket-detail-permission-grant"][data-grant-id="${freshId}"]`)).toHaveAttribute("data-state", "active");
    await expect(grant).toHaveAttribute("data-state", "ended_at_done");
  } finally {
    await exitCleanly(michelin);
    await context.close();
    await api.dispose();
  }
});
