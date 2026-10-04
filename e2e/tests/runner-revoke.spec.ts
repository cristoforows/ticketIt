import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, decidePermissionDirect, listRounds, updateTicketDirect, type Ticket } from "../support/tickets";

const SCOPE = { account: "controlled", action: "write_note", resource: "notes/weekly-report" };
const SCRIPT: EngineScriptStep[] = [{ step: "start" }, { step: "act", ...SCOPE }, { step: "hold" }];

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

test.setTimeout(120_000);

test("revoking a grant mid-Round in the browser stops the Round it covers: Stopping, then Backlog with the Stopped Badge, and the receipt keeps the allowed check and the action performed", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();

  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Revoked ${stamp}`, "research");
  const title = `Revoke me ${stamp}`;
  const queued = await createTicket(api, title);
  expect((await updateTicketDirect(api, queued.id, { goal: "Write the weekly report note", successCriteria: "The note exists" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);
  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, SCRIPT);
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(async () => (await ticket(api, queued.id)).openRound?.waitingReason, { timeout: 15_000 }).toBe("waiting_for_permission");
    const asking = await ticket(api, queued.id);
    const roundId = asking.openRound!.id;
    const asked = asking.openRound!.permissionRequest!;
    expect((await decidePermissionDirect(api, queued.id, roundId, asked.id, "approve")).ok).toBe(true);
    await expect.poll(() => michelin.output(), { timeout: 15_000 }).toContain('"msg":"engine holding"');
    const holding = await ticket(api, queued.id);
    const grantId = holding.permissionGrants[0]!.id;
    expect(holding.permissionGrants).toEqual([expect.objectContaining({ id: grantId, state: "active", revokedAt: null, allowedActions: { revoke: { available: true } }, coveredOpenRounds: [{ roundId, sequence: 1, ticketId: queued.id, ticketTitle: title }] })]);
    expect(holding.openRound).toMatchObject({ id: roundId, stopRequestedAt: null });

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    const listed = page.locator(`[data-testid="ticket-detail-permission-grant"][data-grant-id="${grantId}"]`);
    await listed.getByRole("button", { name: "Revoke: write_note on notes/weekly-report (controlled)" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke this grant?" });
    await expect(dialog.getByTestId("ticket-detail-permission-revoke-cancel")).toBeFocused();
    await expect(dialog.getByTestId("ticket-detail-permission-revoke-effect")).toContainText(`This stops the open Round it covers: Round 1 of “${title}”.`);
    await expect(dialog.getByTestId("ticket-detail-permission-revoke-undone")).toHaveText("Actions the Agent already completed are not undone.");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await ticket(api, queued.id)).permissionGrants[0]!.state).toBe("active");

    await listed.getByTestId("ticket-detail-permission-grant-revoke").click();
    // Paused so Michelin cannot confirm the Stop before the receipt shows Stopping.
    michelin.child.kill("SIGSTOP");
    const [posted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/grants/${grantId}/revoke`) && r.request().method() === "POST"),
      dialog.getByTestId("ticket-detail-permission-revoke-confirm").click(),
    ]);
    expect(posted.status()).toBe(200);
    expect(await posted.json()).toMatchObject({ id: grantId, state: "revoked", revokedAt: expect.any(String), coveredOpenRounds: [] });
    await expect(dialog).toHaveCount(0);
    await expect(listed).toHaveAttribute("data-state", "revoked");
    await expect(listed.getByTestId("ticket-detail-permission-grant-revoked")).toHaveText("Revoked");
    await expect(listed.getByTestId("ticket-detail-permission-grant-revoke")).toHaveCount(0);
    await expect(listed.getByTestId("ticket-detail-permission-grant-revoked-at")).toHaveAttribute("datetime", (await posted.json() as { revokedAt: string }).revokedAt);
    await expect(page.getByTestId("ticket-detail-stopping")).toBeVisible();
    expect((await ticket(api, queued.id)).openRound).toMatchObject({ id: roundId, stopRequestedAt: expect.any(String) });
    michelin.child.kill("SIGCONT");

    await expect.poll(async () => (await ticket(api, queued.id)).status, { timeout: 15_000 }).toBe("Backlog");
    const ended = await ticket(api, queued.id);
    expect(ended).toMatchObject({ openRound: null, delivery: null, permissionGrantCount: 1 });
    expect(ended.badges).toEqual([{ id: expect.any(String), name: "Stopped" }]);
    expect(ended.permissionGrants).toEqual([expect.objectContaining({ id: grantId, state: "revoked" })]);
    const [stopped] = await listRounds(api, queued.id);
    expect(stopped).toMatchObject({ id: roundId, state: "stopped" });
    expect(stopped!.authorityChecks.map((check) => [check.decision, check.grantId])).toEqual([["deny", null], ["allow", grantId]]);
    expect(stopped!.activity.map((note) => note.note)).toEqual([`Performed ${SCOPE.action} on ${SCOPE.resource}`]);

    const log = michelin.output();
    expect(lines(log, "action performed")).toHaveLength(1);
    expect(lines(log, "engine stopped")).toEqual([expect.objectContaining({ roundId })]);
    expect(lines(log, "stop confirmation reported")).toEqual([expect.objectContaining({ roundId, httpStatus: 201 })]);
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);

    const section = page.getByTestId("ticket-detail-rounds");
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Backlog", { timeout: 10_000 });
    await expect(page.getByTestId("ticket-detail-stopping")).toHaveCount(0);
    await expect(section.getByTestId("ticket-detail-round-stopped")).toHaveText("Stopped");
    await expect(page.getByTestId("ticket-detail-badges").getByText("Stopped", { exact: true })).toBeVisible();
    await expect(section.getByTestId("ticket-detail-round-authority-check")).toHaveCount(2);
    await expect(section.getByTestId("ticket-detail-round-authority-check").nth(1)).toHaveAttribute("data-decision", "allow");
    await expect(section.getByTestId("ticket-detail-round-note")).toContainText(`Performed ${SCOPE.action} on ${SCOPE.resource}`);
    await expect(listed.getByTestId("ticket-detail-permission-grant-revoked")).toHaveText("Revoked");

    michelin.child.kill("SIGTERM");
    const [code] = await once(michelin.child, "exit");
    expect(code).toBe(0);
    exited = true;
  } finally {
    if (!exited) {
      michelin.child.kill("SIGCONT");
      michelin.child.kill("SIGKILL");
    }
    await context.close();
    await api.dispose();
  }
});
