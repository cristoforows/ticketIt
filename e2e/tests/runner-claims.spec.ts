import { once } from "node:events";
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { pairRunnerViaUI, startMichelin } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, reorderTicketDirect, updateTicketDirect, type Ticket } from "../support/tickets";

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

test("a paired Michelin claims the top queued Ticket; it stays Ready, shows Claimed by runner, refuses archive, and keeps its Round after Michelin stops", async ({ page, request }) => {
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

    await page.goto("/board");
    const slip = page.getByTestId(`board-ticket-${queued.id}`);
    await expect(page.getByTestId("board-status-Ready").getByTestId(`board-ticket-${queued.id}`)).toBeVisible();
    await expect(slip.getByTestId("board-claimed")).toHaveText("Claimed by runner");
    await expect(slip.getByTestId("board-queued")).toHaveCount(0);

    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Ready");
    await expect(page.getByTestId("ticket-detail-claimed")).toHaveText("Claimed by runner");
    await expect(page.getByTestId("ticket-detail-queued")).toHaveCount(0);

    page.once("dialog", (dialog) => dialog.accept());
    const [archive] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${queued.id}/archive`) && r.request().method() === "POST"),
      page.getByTestId("ticket-detail-archive-button").click(),
    ]);
    expect(archive.status()).toBe(400);
    const rejection = (await archive.json() as { error: { code: string; message: string } }).error;
    expect(rejection.code).toBe("round_open");
    await expect(page.getByTestId("ticket-detail-action-error")).toHaveText(rejection.message);
    await expect(page).toHaveURL(new RegExp(`/tickets/${queued.id}$`));
    expect((await ticket(page, queued.id)).archivedAt).toBeNull();

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
