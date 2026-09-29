import { test, expect, type APIResponse, type Locator, type Page, type Request } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { changeTicketStatusDirect, createTicket, type Ticket, type TicketStatus } from "../support/tickets";

async function readTicket(page: Page, id: string): Promise<Ticket> {
  const response = await page.request.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

function getCardInStatus(page: Page, status: TicketStatus, id: string): Locator {
  return page.getByTestId(`board-status-${status}`).getByTestId(`board-ticket-${id}`);
}

test("drag Backlog to an advertised target, update offered moves, and persist after reload", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const created = await createTicket(page, `drag move ${Date.now()}`);
  expect(created.allowedActions.statusChanges).toContain("Ready");
  await page.goto("/board");

  const source = getCardInStatus(page, "Backlog", created.id);
  await source.dragTo(page.getByTestId("board-status-Ready").getByRole("heading"));
  await expect.poll(async () => (await readTicket(page, created.id)).status).toBe("Ready");
  const saved = await readTicket(page, created.id);
  expect(saved.status).toBe("Ready");
  await expect(getCardInStatus(page, saved.status, created.id)).toBeVisible();
  await expect(getCardInStatus(page, "Backlog", created.id)).toHaveCount(0);

  const moved = getCardInStatus(page, saved.status, created.id);
  await moved.getByText("Move to…").click();
  expect(await page.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.getAttribute("data-move-target")))).toEqual(saved.allowedActions.statusChanges);
  await page.reload();
  await expect(getCardInStatus(page, saved.status, created.id)).toBeVisible();
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
  const source = getCardInStatus(page, before.status, created.id);
  const control = source.getByText("Move to…");
  await control.focus();
  await page.keyboard.press("Enter");
  expect(await page.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.getAttribute("data-move-target")))).toEqual(before.allowedActions.statusChanges);
  const target = page.getByRole("menuitem", { name: "In Review" });
  await target.focus();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes(`/api/tickets/${created.id}/status`) && response.request().method() === "POST"),
    page.keyboard.press("Enter"),
  ]);

  const saved = await readTicket(page, created.id);
  expect(saved.status).toBe("InReview");
  const moved = getCardInStatus(page, saved.status, created.id);
  await expect(moved).toBeVisible();
  await expect(moved.getByText("Move to…")).toBeFocused();
  await page.reload();
  await expect(getCardInStatus(page, saved.status, created.id)).toBeVisible();
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
  const source = getCardInStatus(page, "Backlog", created.id);
  await source.dragTo(page.getByTestId("board-status-InReview").getByRole("heading"));
  await expect(source).toBeVisible();
  await expect(getCardInStatus(page, "InReview", created.id)).toHaveCount(0);
  expect(commands).toEqual([]);
  expect((await readTicket(page, created.id)).status).toBe("Backlog");

  for (const status of ["Ready", "InProgress", "InReview"] as TicketStatus[]) {
    expect((await changeTicketStatusDirect(page, created.id, status)).ok).toBe(true);
  }
  await page.reload();
  const reviewing = getCardInStatus(page, "InReview", created.id);
  commands.length = 0;
  await reviewing.getByText("Move to…").click();
  expect((await readTicket(page, created.id)).allowedActions.statusChanges).not.toContain("Done");
  await expect(page.getByRole("menuitem", { name: "Done" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await reviewing.dragTo(page.getByTestId("board-status-Done").getByRole("heading"));
  await expect(reviewing).toBeVisible();
  expect(commands).toEqual([]);
  expect((await readTicket(page, created.id)).status).toBe("InReview");
});

test("stale move shows Galley's rejection and retains the original card", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const created = await createTicket(page, `stale move ${Date.now()}`);
  await page.goto("/board");
  const source = getCardInStatus(page, "Backlog", created.id);
  await expect(source).toBeVisible();
  expect((await changeTicketStatusDirect(page, created.id, "Ready")).ok).toBe(true);
  const rejection = await changeTicketStatusDirect(page, created.id, "Ready");
  expect(rejection.ok).toBe(false);
  expect(rejection.errorMessage).toBeTruthy();

  await source.dragTo(page.getByTestId("board-status-Ready").getByRole("heading"));
  await expect(page.getByTestId("ticket-board-move-error")).toHaveText(rejection.errorMessage!);
  await expect(source).toBeVisible();
  await expect(getCardInStatus(page, "Ready", created.id)).toHaveCount(0);
  expect((await readTicket(page, created.id)).status).toBe("Ready");
});

test("a pending board move blocks plain detail entry until Galley's returned Ticket is available", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const created = await createTicket(page, `pending detail ${Date.now()}`);
  await page.goto("/board");
  const source = getCardInStatus(page, "Backlog", created.id);
  await expect(source).toBeVisible();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let intercepted!: () => void;
  const started = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.route(`**/api/tickets/${created.id}/status`, async (route) => {
    intercepted();
    await gate;
    await route.continue();
  });
  await source.getByText("Move to…").click();
  await page.getByRole("menuitem", { name: "Ready" }).click();
  await started;

  const link = source.getByRole("link", { name: created.title });
  await expect(source).toHaveAttribute("aria-busy", "true");
  await expect(link).toHaveAttribute("aria-disabled", "true");
  await link.scrollIntoViewIfNeeded();
  const box = await link.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByRole("dialog", { name: "Ticket details" })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/board");
  release();

  const moved = getCardInStatus(page, "Ready", created.id);
  await expect(moved).toBeVisible();
  await expect(moved.getByRole("link")).not.toHaveAttribute("aria-disabled", "true");
  await moved.getByRole("link").click();
  const modal = page.getByRole("dialog", { name: "Ticket details" });
  const saved = await readTicket(page, created.id);
  await expect(modal.getByTestId("ticket-detail-status")).toHaveText(saved.status);
  expect(await modal.getByTestId("ticket-detail-status-actions").getByRole("button").allTextContents()).toEqual(saved.allowedActions.statusChanges);
});

test("a move reconciles a modal-close GET, including another Ticket's edits", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const moving = await createTicket(page, `overlapping move ${Date.now()}`);
  const edited = await createTicket(page, `overlapping edit ${Date.now()}`);
  await page.goto("/board");
  await getCardInStatus(page, "Backlog", edited.id).getByRole("link").click();
  const modal = page.getByRole("dialog", { name: "Ticket details" });
  await modal.getByTestId("ticket-detail-edit-button").click();
  await modal.getByTestId("ticket-detail-input-title").fill(`${edited.title} saved`);
  await modal.getByTestId("ticket-detail-save-button").click();
  await expect(modal.getByTestId("ticket-detail-title")).toHaveText(`${edited.title} saved`);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let intercepted!: (response: APIResponse) => void;
  const started = new Promise<APIResponse>((resolve) => { intercepted = resolve; });
  let first = true;
  let staleRequest!: Request;
  await page.route("**/api/tickets", async (route) => {
    if (!first) return route.continue();
    first = false;
    staleRequest = route.request();
    const response = await route.fetch();
    intercepted(response);
    await gate;
    await route.fulfill({ response });
  });
  await modal.getByRole("button", { name: "Close" }).click();
  const stale = await started;
  const { tickets } = await stale.json() as { tickets: Ticket[] };
  expect(tickets.find(({ id }) => id === edited.id)?.title).toBe(`${edited.title} saved`);
  expect(tickets.find(({ id }) => id === moving.id)?.status).toBe("Backlog");

  const source = getCardInStatus(page, "Backlog", moving.id);
  await expect(source).toBeVisible();
  await expect(getCardInStatus(page, "Backlog", edited.id).getByRole("link")).toHaveText(edited.title);
  await source.getByText("Move to…").click();
  const command = page.waitForResponse((response) => response.url().endsWith(`/api/tickets/${moving.id}/status`) && response.request().method() === "POST");
  await page.getByRole("menuitem", { name: "Ready" }).click();
  expect((await command).ok()).toBe(true);

  const lateResponse = page.waitForResponse((response) => response.request() === staleRequest);
  try {
    await expect(getCardInStatus(page, "Ready", moving.id)).toBeVisible();
    await expect(getCardInStatus(page, "Backlog", edited.id).getByRole("link")).toHaveText(`${edited.title} saved`);
  } finally {
    release();
  }
  expect((await lateResponse).ok()).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(getCardInStatus(page, "Ready", moving.id)).toBeVisible();
  await expect(getCardInStatus(page, "Backlog", edited.id).getByRole("link")).toHaveText(`${edited.title} saved`);
});
