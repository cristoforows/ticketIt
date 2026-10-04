import { once } from "node:events";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep, type RunningMichelin } from "../support/runner";
import { acceptTicketDirect, answerQuestionDirect, assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, decidePermissionDirect, listRounds, updateTicketDirect, type Agent, type Ticket } from "../support/tickets";

const TIMED = { account: "controlled", action: "write_note", resource: "notes/weekly-report" };
const OTHER = { account: "controlled", action: "write_note", resource: "notes/team-digest" };
const ADVANCE_SECONDS = 7_200;

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

async function queue(api: APIRequestContext, title: string, agent: Agent): Promise<Ticket> {
  const queued = await createTicket(api, title);
  expect((await updateTicketDirect(api, queued.id, { goal: "Write the weekly report note", successCriteria: "The note is written" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);
  return queued;
}

async function waitingOn(api: APIRequestContext, id: string, reason: "waiting_for_permission" | "waiting_for_answer", resource?: string): Promise<Ticket> {
  await expect.poll(async () => {
    const current = await ticket(api, id);
    return current.openRound?.waitingReason === reason && (resource === undefined || current.openRound.permissionRequest?.resource === resource);
  }, { timeout: 15_000 }).toBe(true);
  return ticket(api, id);
}

async function exitCleanly(michelin: RunningMichelin): Promise<void> {
  michelin.child.kill("SIGTERM");
  const [code] = await once(michelin.child, "exit");
  expect(code).toBe(0);
}

async function approveInBrowser(page: Page, requestId: string, duration: string) {
  const panel = page.getByRole("region", { name: "Permission request" });
  await panel.getByTestId("ticket-detail-permission-form-time").check();
  await panel.getByLabel("Expires after").selectOption({ label: duration });
  await expect(panel.getByTestId("ticket-detail-permission-approve")).toHaveText("Allow for a time");
  const [posted] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/permission-requests/${requestId}/approve`) && r.request().method() === "POST"),
    panel.getByTestId("ticket-detail-permission-approve").click(),
  ]);
  return posted;
}

test.setTimeout(120_000);

test("a time grant allows its Agent across Tickets until Galley's clock passes its expiry, then only that scope asks for a renewal", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  const firstScript: EngineScriptStep[] = [
    { step: "start" },
    { step: "act", ...OTHER },
    { step: "act", ...TIMED },
    { step: "act", ...TIMED },
    { step: "ask", question: "Continue after the break?" },
    { step: "act", ...OTHER },
    { step: "act", ...TIMED },
    { step: "deliver", bodyMarkdown: "# Weekly report\n\nWritten across the break.", summary: "Wrote the weekly report note", criteriaAssessment: "The note is written" },
  ];

  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Timed ${stamp}`, "research");
  const first = await queue(api, `Time grant ${stamp}`, agent);
  const token = await pairRunnerViaApi(api);
  let michelin = startMichelin(token, 500, firstScript);
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    const askedOther = await waitingOn(api, first.id, "waiting_for_permission", OTHER.resource);
    const roundId = askedOther.openRound!.id;
    const otherApproval = await decidePermissionDirect(api, first.id, roundId, askedOther.openRound!.permissionRequest!.id, "approve");
    expect(otherApproval.ok).toBe(true);

    const askedTimed = await waitingOn(api, first.id, "waiting_for_permission", TIMED.resource);
    const timedRequestId = askedTimed.openRound!.permissionRequest!.id;
    expect(askedTimed.openRound!.permissionRequest).toMatchObject({ ...TIMED, renewsGrantId: null, decision: null });

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${first.id}`);
    const posted = await approveInBrowser(page, timedRequestId, "1 hour");
    expect(posted.status()).toBe(200);
    const sent = posted.request().postDataJSON() as { form: string; expiresAt: string };
    expect(Object.keys(sent).sort()).toEqual(["expiresAt", "form"]);
    expect(sent.form).toBe("time");
    const approved = await posted.json() as Ticket;
    const timedGrantId = approved.openRound!.permissionRequest!.grantId!;
    const timedGrant = approved.permissionGrants.find((grant) => grant.id === timedGrantId)!;
    expect(timedGrant).toMatchObject({ ...TIMED, form: "time", state: "active", roundId });
    expect(Date.parse(timedGrant.expiresAt!)).toBe(Date.parse(sent.expiresAt));
    expect(timedGrant.remainingSeconds).toBeGreaterThan(0);
    expect(timedGrant.remainingSeconds).toBeLessThanOrEqual(3_600);
    const otherGrant = approved.permissionGrants.find((grant) => grant.resource === OTHER.resource)!;
    expect(otherGrant).toMatchObject({ form: "ticket", state: "active", expiresAt: null, remainingSeconds: null });
    await expect(page.getByTestId("ticket-detail-permission-approved")).toHaveText("Allowed for a time. The Round resumes.");

    const waitingAnswer = await waitingOn(api, first.id, "waiting_for_answer");
    const beforeBreak = await listRounds(api, first.id);
    expect(beforeBreak[0]!.authorityChecks.map((check) => [check.resource, check.decision, check.grantId, check.expiredGrantId])).toEqual([
      [OTHER.resource, "deny", null, null],
      [OTHER.resource, "allow", otherGrant.id, null],
      [TIMED.resource, "deny", null, null],
      [TIMED.resource, "allow", timedGrantId, null],
      [TIMED.resource, "allow", timedGrantId, null],
    ]);

    const advanced = await api.post("/api/dev/clock/advance", { data: { seconds: ADVANCE_SECONDS } });
    expect(advanced.status()).toBe(200);
    const atBreak = await ticket(api, first.id);
    expect(atBreak.permissionGrants.find((grant) => grant.id === timedGrantId)).toMatchObject({ state: "expired", remainingSeconds: 0, expiresAt: timedGrant.expiresAt });
    expect(atBreak.permissionGrants.find((grant) => grant.id === otherGrant.id)).toMatchObject({ state: "active" });
    const answered = await answerQuestionDirect(api, first.id, roundId, waitingAnswer.openRound!.question!.id, "Yes");
    expect(answered.ok).toBe(true);

    const renewalAsked = await waitingOn(api, first.id, "waiting_for_permission", TIMED.resource);
    const renewal = renewalAsked.openRound!.permissionRequest!;
    expect(renewal).toMatchObject({ ...TIMED, renewsGrantId: timedGrantId, decision: null });
    expect(renewal.id).not.toBe(timedRequestId);
    const afterBreak = await listRounds(api, first.id);
    expect(afterBreak[0]!.authorityChecks.slice(5).map((check) => [check.resource, check.decision, check.grantId, check.expiredGrantId])).toEqual([
      [OTHER.resource, "allow", otherGrant.id, null],
      [TIMED.resource, "deny", null, timedGrantId],
    ]);
    expect(afterBreak[0]!.activity.map((note) => note.note)).toContain(`Performed write_note on ${OTHER.resource}`);

    await page.reload();
    const panel = page.getByRole("region", { name: "Permission request" });
    await expect(panel.getByTestId("ticket-detail-permission-renewal")).toBeVisible();
    await expect(page.getByTestId("ticket-detail-round-authority-check-expired")).toHaveCount(1);
    const listedTimed = page.locator(`[data-testid="ticket-detail-permission-grant"][data-grant-id="${timedGrantId}"]`);
    await expect(listedTimed).toHaveAttribute("data-state", "expired");
    await expect(listedTimed.getByTestId("ticket-detail-permission-grant-expired")).toHaveText("Expired");

    // Galley's clock now runs ADVANCE_SECONDS ahead of the browser's, so an hour from the browser's now is already past by Galley's.
    const refused = await approveInBrowser(page, renewal.id, "1 hour");
    expect(refused.status()).toBe(400);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("invalid_grant_expiry");
    await expect(page.getByTestId("ticket-detail-permission-error")).toContainText("Galley refused this expiry");
    expect((await ticket(api, first.id)).openRound!.permissionRequest).toMatchObject({ id: renewal.id, decision: null });

    const renewed = await approveInBrowser(page, renewal.id, "1 day");
    expect(renewed.status()).toBe(200);
    const renewedTicket = await renewed.json() as Ticket;
    const renewedGrantId = renewedTicket.openRound!.permissionRequest!.grantId!;
    expect(renewedGrantId).not.toBe(timedGrantId);
    expect(renewedTicket.permissionGrants.map((grant) => [grant.id, grant.form, grant.state])).toEqual([
      [otherGrant.id, "ticket", "active"],
      [timedGrantId, "time", "expired"],
      [renewedGrantId, "time", "active"],
    ]);
    expect(renewedTicket.permissionGrantCount).toBe(3);
    expect(renewedTicket.permissionGrants.find((grant) => grant.id === timedGrantId)).toMatchObject({ expiresAt: timedGrant.expiresAt, approvedAt: timedGrant.approvedAt, remainingSeconds: 0 });

    await expect.poll(async () => (await ticket(api, first.id)).status, { timeout: 15_000 }).toBe("InReview");
    const [delivered] = await listRounds(api, first.id);
    expect(delivered).toMatchObject({ id: roundId, state: "delivered", authorityCheckCount: 8 });
    expect(delivered!.authorityChecks.at(-1)).toMatchObject({ ...TIMED, decision: "allow", grantId: renewedGrantId, expiredGrantId: null });
    expect(delivered!.permissionRequests.map((asked) => [asked.resource, asked.renewsGrantId, asked.decision])).toEqual([
      [OTHER.resource, null, "approved"],
      [TIMED.resource, null, "approved"],
      [TIMED.resource, timedGrantId, "approved"],
    ]);
    const log = michelin.output();
    expect(lines(log, "permission requested").map((line) => line["renewsGrantId"] ?? null)).toEqual([null, null, timedGrantId]);
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);
    await exitCleanly(michelin);

    expect((await acceptTicketDirect(api, first.id)).ok).toBe(true);
    expect((await ticket(api, first.id)).status).toBe("Done");

    const second = await queue(api, `Time grant elsewhere ${stamp}`, agent);
    michelin = startMichelin(token, 500, [
      { step: "start" },
      { step: "act", ...TIMED },
      { step: "deliver", bodyMarkdown: "# Weekly report\n\nWritten on another Ticket.", summary: "Wrote it again", criteriaAssessment: "The note is written" },
    ]);
    await expect.poll(async () => (await ticket(api, second.id)).status, { timeout: 15_000 }).toBe("InReview");
    const [elsewhere] = await listRounds(api, second.id);
    expect(elsewhere).toMatchObject({ state: "delivered", permissionRequests: [], authorityCheckCount: 1 });
    expect(elsewhere!.authorityChecks).toEqual([expect.objectContaining({ ...TIMED, decision: "allow", grantId: renewedGrantId, expiredGrantId: null })]);
    const secondTicket = await ticket(api, second.id);
    expect(secondTicket.permissionGrants.map((grant) => [grant.id, grant.state])).toEqual([[timedGrantId, "expired"], [renewedGrantId, "active"]]);
    expect(secondTicket.permissionGrantCount).toBe(2);

    await page.goto(`/tickets/${second.id}`);
    const listedRenewed = page.locator(`[data-testid="ticket-detail-permission-grant"][data-grant-id="${renewedGrantId}"]`);
    await expect(listedRenewed).toHaveAttribute("data-form", "time");
    await expect(listedRenewed.getByTestId("ticket-detail-permission-grant-remaining")).toHaveText(/left$/);

    await exitCleanly(michelin);
    exited = true;
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await context.close();
    await api.dispose();
  }
});
