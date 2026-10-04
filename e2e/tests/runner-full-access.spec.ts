import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep, type RunningMichelin } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, updateTicketDirect, type Ticket } from "../support/tickets";

const ACCOUNT = "controlled";
const REQUESTED = { account: ACCOUNT, action: "write_note", resource: "notes/weekly-report" };
const DECLARED = [
  REQUESTED,
  { account: ACCOUNT, action: "read_note", resource: "notes/weekly-report" },
  { account: ACCOUNT, action: "post_message", resource: "channels/general" },
  { account: ACCOUNT, action: "write_note", resource: "notes/team-digest" },
];
const UNDECLARED = { account: ACCOUNT, action: "delete_note", resource: "notes/weekly-report" };
const REFUSAL = "Could not delete_note on notes/weekly-report with the controlled account: the Connected Account does not declare this capability";

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

async function exitCleanly(michelin: RunningMichelin): Promise<void> {
  michelin.child.kill("SIGTERM");
  const [code] = await once(michelin.child, "exit");
  expect(code).toBe(0);
}

test.setTimeout(120_000);

test("one full-access approval covers every declared capability of the account without another request, and an undeclared one still fails the Round", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  const script: EngineScriptStep[] = [
    { step: "start" },
    ...DECLARED.map((scope) => ({ step: "act" as const, ...scope })),
    { step: "act", ...UNDECLARED },
    { step: "deliver", bodyMarkdown: "# Never delivered", summary: "Unreachable", criteriaAssessment: "Unreachable" },
  ];

  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Full ${stamp}`, "research");
  const queued = await createTicket(api, `Full access ${stamp}`);
  expect((await updateTicketDirect(api, queued.id, { goal: "Tidy the controlled account's notes", successCriteria: "The notes are tidy" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);
  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, script);
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(async () => (await ticket(api, queued.id)).openRound?.waitingReason, { timeout: 15_000 }).toBe("waiting_for_permission");
    const asking = await ticket(api, queued.id);
    const roundId = asking.openRound!.id;
    const asked = asking.openRound!.permissionRequest!;
    expect(asked).toMatchObject({ ...REQUESTED, decision: null, renewsGrantId: null });

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    const panel = page.getByRole("region", { name: "Permission request" });
    const access = panel.getByRole("group", { name: "Access" });
    await expect(access.getByRole("radio", { name: /Only what was requested/ })).toBeChecked();
    await expect(panel.getByTestId("ticket-detail-permission-full-warning")).toHaveCount(0);
    await access.getByRole("radio", { name: /Full access to the controlled account/ }).check();
    await expect(panel.getByTestId("ticket-detail-permission-full-warning")).toContainText("This Agent may use every action and resource the controlled account declares");
    await expect(panel.getByTestId("ticket-detail-permission-approve")).toHaveText("Allow full access for this Ticket");
    const [posted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/permission-requests/${asked.id}/approve`) && r.request().method() === "POST"),
      panel.getByTestId("ticket-detail-permission-approve").click(),
    ]);
    expect(posted.status()).toBe(200);
    expect(posted.request().postDataJSON()).toEqual({ form: "ticket", scope: "full" });
    const approved = await posted.json() as Ticket;
    const grantId = approved.openRound!.permissionRequest!.grantId!;
    expect(approved.permissionGrants).toEqual([expect.objectContaining({ id: grantId, account: ACCOUNT, full: true, action: null, resource: null, form: "ticket", state: "active", roundId })]);
    await expect(page.getByTestId("ticket-detail-permission-approved")).toHaveText("Full access allowed for this Ticket. The Round resumes.");

    await expect.poll(async () => (await listRounds(api, queued.id))[0]!.state, { timeout: 15_000 }).toBe("failed");
    const [failed] = await listRounds(api, queued.id);
    expect(failed).toMatchObject({ id: roundId, state: "failed", outcomeNote: REFUSAL, authorityCheckCount: 5 });
    expect(failed!.permissionRequests.map((r) => [r.id, r.decision, r.grantId])).toEqual([[asked.id, "approved", grantId]]);
    expect(failed!.authorityChecks.map((check) => [check.action, check.resource, check.decision, check.grantId])).toEqual([
      [REQUESTED.action, REQUESTED.resource, "deny", null],
      ...DECLARED.map((scope) => [scope.action, scope.resource, "allow", grantId]),
    ]);
    expect(failed!.activity.map((note) => note.note)).toEqual(DECLARED.map((scope) => `Performed ${scope.action} on ${scope.resource}`));
    const blocked = await ticket(api, queued.id);
    expect(blocked).toMatchObject({ status: "Blocked", openRound: null, delivery: null, permissionGrantCount: 1 });

    const log = michelin.output();
    expect(lines(log, "permission requested")).toHaveLength(1);
    expect(lines(log, "action performed").map((line) => [line["action"], line["resource"]])).toEqual(DECLARED.map((scope) => [scope.action, scope.resource]));
    expect(lines(log, "authority check refused an undeclared capability")).toEqual([expect.objectContaining({ action: UNDECLARED.action, httpStatus: 400, errorCode: "capability_not_supported" })]);
    expect(lines(log, "failure reported")).toEqual([expect.objectContaining({ roundId, httpStatus: 201 })]);
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);

    await page.reload();
    const listed = page.locator(`[data-testid="ticket-detail-permission-grant"][data-grant-id="${grantId}"]`);
    await expect(listed).toHaveAttribute("data-full", "true");
    await expect(listed.getByTestId("ticket-detail-permission-grant-full")).toHaveText("Full access");
    await expect(page.getByTestId("ticket-detail-round-authority-check-full")).toHaveCount(DECLARED.length);

    await exitCleanly(michelin);
    exited = true;
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await context.close();
    await api.dispose();
  }
});
