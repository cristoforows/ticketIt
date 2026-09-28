import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { changeTicketStatusDirect, createTicket, type Ticket, type TicketStatus } from "../support/tickets";

async function readTicket(page: Page, id: string): Promise<Ticket> {
  const response = await page.request.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function cardIn(page: Page, status: TicketStatus, id: string) {
  return page.getByTestId(`board-status-${status}`).getByTestId(`board-ticket-${id}`);
}

test("drag Backlog to an advertised target, update offered moves, and persist after reload", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const created = await createTicket(page, `drag move ${Date.now()}`);
  expect(created.allowedActions.statusChanges).toContain("Ready");
  await page.goto("/board");

  const source = await cardIn(page, "Backlog", created.id);
  await source.dragTo(page.getByTestId("board-status-Ready").getByRole("heading"));
  await expect.poll(async () => (await readTicket(page, created.id)).status).toBe("Ready");
  const saved = await readTicket(page, created.id);
  expect(saved.status).toBe("Ready");
  await expect(await cardIn(page, saved.status, created.id)).toBeVisible();
  await expect(await cardIn(page, "Backlog", created.id)).toHaveCount(0);

  const moved = await cardIn(page, saved.status, created.id);
  await moved.getByText("Move to…").click();
  expect(await moved.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-move-target")))).toEqual(saved.allowedActions.statusChanges);
  await page.reload();
  await expect(await cardIn(page, saved.status, created.id)).toBeVisible();
  expect((await readTicket(page, created.id)).status).toBe(saved.status);
});

test("keyboard Move to… uses advertised actions for In Progress to In Review and persists", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const created = await createTicket(page, `keyboard move ${Date.now()}`);
  for (const target of ["Ready", "InProgress"] as TicketStatus[]) {
    expect((await changeTicketStatusDirect(page, created.id, target)).ok).toBe(true);
  }
  const before = await readTicket(page, created.id);
  expect(before.allowedActions.statusChanges).toContain("InReview");
  await page.goto("/board");
  const source = await cardIn(page, before.status, created.id);
  const control = source.getByText("Move to…");
  await control.focus();
  await page.keyboard.press("Enter");
  expect(await source.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-move-target")))).toEqual(before.allowedActions.statusChanges);
  const target = source.getByRole("button", { name: "In Review" });
  await target.focus();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes(`/api/tickets/${created.id}/status`) && response.request().method() === "POST"),
    page.keyboard.press("Enter"),
  ]);

  const saved = await readTicket(page, created.id);
  expect(saved.status).toBe("InReview");
  const moved = await cardIn(page, saved.status, created.id);
  await expect(moved).toBeVisible();
  await expect(moved.getByText("Move to…")).toBeFocused();
  await page.reload();
  await expect(await cardIn(page, saved.status, created.id)).toBeVisible();
  expect((await readTicket(page, created.id)).status).toBe(saved.status);
});

test("disallowed drop sends no command; Done is never offered as a drop or Move to… target", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const created = await createTicket(page, `disallowed move ${Date.now()}`);
  const commands: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/api/tickets/${created.id}/status`)) {
      commands.push(request.postData() ?? "");
    }
  });
  await page.goto("/board");
  const source = await cardIn(page, "Backlog", created.id);
  await source.dragTo(page.getByTestId("board-status-InReview").getByRole("heading"));
  await expect(source).toBeVisible();
  await expect(await cardIn(page, "InReview", created.id)).toHaveCount(0);
  expect(commands).toEqual([]);
  expect((await readTicket(page, created.id)).status).toBe("Backlog");

  for (const status of ["Ready", "InProgress", "InReview"] as TicketStatus[]) {
    expect((await changeTicketStatusDirect(page, created.id, status)).ok).toBe(true);
  }
  await page.reload();
  const reviewing = await cardIn(page, "InReview", created.id);
  commands.length = 0;
  await reviewing.getByText("Move to…").click();
  expect((await readTicket(page, created.id)).allowedActions.statusChanges).not.toContain("Done");
  await expect(reviewing.getByRole("button", { name: "Done" })).toHaveCount(0);
  await reviewing.dragTo(page.getByTestId("board-status-Done").getByRole("heading"));
  await expect(reviewing).toBeVisible();
  expect(commands).toEqual([]);
  expect((await readTicket(page, created.id)).status).toBe("InReview");
});

test("stale move shows Galley's rejection and retains the original card", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const created = await createTicket(page, `stale move ${Date.now()}`);
  await page.goto("/board");
  const source = await cardIn(page, "Backlog", created.id);
  await expect(source).toBeVisible();
  expect((await changeTicketStatusDirect(page, created.id, "Ready")).ok).toBe(true);
  const rejection = await changeTicketStatusDirect(page, created.id, "Ready");
  expect(rejection.ok).toBe(false);
  expect(rejection.errorMessage).toBeTruthy();

  await source.dragTo(page.getByTestId("board-status-Ready").getByRole("heading"));
  await expect(page.getByTestId("ticket-board-move-error")).toHaveText(rejection.errorMessage!);
  await expect(source).toBeVisible();
  await expect(await cardIn(page, "Ready", created.id)).toHaveCount(0);
  expect((await readTicket(page, created.id)).status).toBe("Ready");
});
