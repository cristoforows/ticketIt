import { once } from "node:events";
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { pairRunnerViaUI, startMichelin } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, reorderTicketDirect, ticketCommand, updateTicketDirect, type Ticket } from "../support/tickets";

async function tickets(page: Page): Promise<Ticket[]> {
  const response = await page.request.get("/api/tickets");
  expect(response.ok()).toBe(true);
  return (await response.json() as { tickets: Ticket[] }).tickets;
}

async function ticket(page: Page, id: string): Promise<Ticket> {
  const response = await page.request.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test("a paired Michelin claims the top queued Ticket; it stays Ready, shows Claimed by runner, is locked against every mutation, and keeps its Round after Michelin stops", async ({ page, request }) => {
  await signIn(page, request, "owner");
  expect((await tickets(page)).filter((t) => t.openRound !== null)).toEqual([]);

  const agent = await createAgent(page, `Claimer ${Date.now()}`, "research");
  const queued = await createTicket(page, `Claim me ${Date.now()}`);
  expect((await updateTicketDirect(page, queued.id, { goal: "Summarise the findings", successCriteria: "A summary exists" })).ok).toBe(true);
  expect((await assignTicketDirect(page, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(page, queued.id, "Ready")).ok).toBe(true);
  const top = (await tickets(page)).find((t) => t.status === "Ready")!;
  if (top.id !== queued.id) expect((await reorderTicketDirect(page, queued.id, { before: top.id })).ok).toBe(true);
  const before = await ticket(page, queued.id);
  expect(before).toMatchObject({ status: "Ready", requestingAgentWork: true, openRound: null });

  const token = await pairRunnerViaUI(page);
  const michelin = startMichelin(token, 500);
  let stopped = false;
  try {
    await expect.poll(async () => (await ticket(page, queued.id)).openRound, { timeout: 15_000 }).not.toBeNull();
    const claimed = await ticket(page, queued.id);
    expect(claimed.status).toBe("Ready");
    expect(claimed.requestingAgentWork).toBe(false);
    expect(claimed.updatedAt).toBe(before.updatedAt);
    expect(claimed.openRound).toMatchObject({ sequence: 1, state: "claimed", agent: { id: agent.id, name: agent.name, kind: "research" }, startedAt: null });
    expect((await tickets(page)).filter((t) => t.openRound !== null).map((t) => t.id)).toEqual([queued.id]);
    await expect.poll(() => michelin.output()).toContain(claimed.openRound!.id);
    expect(michelin.output()).toContain("round claimed; claim polling stopped");
    const round = claimed.openRound!;
    const lockCopy = `Locked while ${round.agent.name} works on Round ${round.sequence}`;
    const reason = claimed.allowedActions.accept.reason!;
    expect(claimed.allowedActions).toEqual({ statusChanges: [], statusChangeRejections: [], accept: { available: false, reason: { code: "round_open", message: reason.message, roundId: round.id } } });

    await page.goto("/board");
    const slip = page.getByTestId(`board-ticket-${queued.id}`);
    await expect(page.getByTestId("board-status-Ready").getByTestId(`board-ticket-${queued.id}`)).toBeVisible();
    await expect(slip.getByTestId("board-claimed")).toHaveText("Claimed by runner");
    await expect(slip.getByTestId("board-queued")).toHaveCount(0);
    await expect(slip.getByRole("img", { name: lockCopy })).toBeVisible();
    await expect(slip).toHaveAttribute("draggable", "false");

    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Ready");
    await expect(page.getByTestId("ticket-detail-claimed")).toHaveText("Claimed by runner");
    await expect(page.getByTestId("ticket-detail-queued")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-locked")).toHaveText(lockCopy);
    for (const name of ["Edit", "Archive", "Unassign", "Add badge", "Assign"]) {
      const control = page.getByTestId("ticket-detail").getByRole("button", { name, exact: true });
      await expect(control).toBeDisabled();
      await expect(control).toHaveAttribute("title", reason.message);
    }
    await expect(page.getByLabel("Assign to")).toBeDisabled();
    await expect(page.getByTestId("ticket-detail-status-actions")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-accept-button")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-accept-unavailable")).toHaveText(reason.message);

    await expect(page.getByTestId("ticket-detail-archive-button")).toBeDisabled();
    const archive = await page.request.post(`/api/tickets/${queued.id}/archive`);
    expect(archive.status()).toBe(400);
    expect((await archive.json() as { error: { code: string; roundId: string } }).error).toMatchObject({ code: "round_open", roundId: claimed.openRound!.id });
    expect((await ticket(page, queued.id)).archivedAt).toBeNull();

    const badge = await page.request.post("/api/badges", { data: { name: `Lock ${Date.now()}` } });
    expect(badge.status()).toBe(201);
    const badgeId = (await badge.json() as { id: string }).id;
    const anchor = await createTicket(page, `Lock anchor ${Date.now()}`);
    expect((await changeTicketStatusDirect(page, anchor.id, "Ready")).ok).toBe(true);
    const path = `/api/tickets/${queued.id}`;
    const mutations: Array<[string, "POST" | "PUT" | "PATCH" | "DELETE", string, unknown?]> = [
      ["edit title", "PATCH", path, { title: "Changed while locked" }],
      ["edit goal", "PATCH", path, { goal: "Changed while locked" }],
      ["assign the Owner", "PUT", `${path}/assignee`, { type: "owner" }],
      ["unassign", "DELETE", `${path}/assignee`],
      ["attach a Badge", "PUT", `${path}/badges/${badgeId}`],
      ["change Status", "POST", `${path}/status`, { status: "Backlog" }],
      ["Accept", "POST", `${path}/accept`],
      ["reorder", "POST", `${path}/position`, { after: anchor.id }],
      ["archive", "POST", `${path}/archive`],
    ];
    for (const [name, method, target, data] of mutations) {
      const result = await ticketCommand(page, method, target, data);
      expect({ name, status: result.status, code: result.errorCode, roundId: result.roundId }).toEqual({ name, status: 400, code: "round_open", roundId: round.id });
      expect(result.errorMessage).toBe(reason.message);
    }
    expect(await ticket(page, queued.id)).toEqual(claimed);

    michelin.child.kill("SIGTERM");
    const [code] = await once(michelin.child, "exit");
    stopped = true;
    expect(code).toBe(0);
    expect(michelin.output()).not.toContain(token);

    const advanced = await page.request.post("/api/dev/clock/advance", { data: { seconds: 30 } });
    expect(advanced.status()).toBe(200);
    expect((await (await page.request.get("/api/runner-health")).json()).state).toBe("disconnected");
    const afterStop = await ticket(page, queued.id);
    expect(afterStop.openRound).toEqual(claimed.openRound);
    expect(afterStop.status).toBe("Ready");
    expect(afterStop.requestingAgentWork).toBe(false);
  } finally {
    if (!stopped) michelin.child.kill("SIGKILL");
  }
});
