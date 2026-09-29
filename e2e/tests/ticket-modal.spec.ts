import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { changeTicketStatusDirect, createTicket, type Ticket } from "../support/tickets";

async function populate(page: Page): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
  for (let index = 0; index < 32; index++) {
    tickets.push(await createTicket(page, `modal ${Date.now()} ${index}`));
  }
  return tickets;
}

for (const view of ["list", "board"] as const) {
  test(`${view}: modal preserves scroll, focus and history; reload and Open full page show dedicated detail`, async ({ page, request }) => {
    await signIn(page, request, "owner");
    const tickets = await populate(page);
    const ticket = view === "list" ? tickets[0] : tickets[12];
    const row = page.getByTestId(`${view === "list" ? "ticket-item" : "board-ticket"}-${ticket.id}`);
    await page.goto(view === "list" ? "/" : "/board");
    await row.getByRole("link").scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);
    await row.getByRole("link").click();

    const modal = page.getByRole("dialog", { name: "Ticket details" });
    await expect(modal).toBeVisible();
    await expect(modal).toHaveCSS("position", "fixed");
    await expect(modal.getByTestId("ticket-detail-title")).toHaveText(ticket.title);
    await expect(modal.getByTestId("ticket-detail-template")).toHaveText(ticket.template);
    await expect(modal.getByTestId("ticket-detail-status")).toHaveText(ticket.status);
    expect(new URL(page.url()).pathname).toBe(`/tickets/${ticket.id}`);
    await expect(page.getByTestId(view === "list" ? "ticket-list" : "ticket-board")).toBeVisible();
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    await expect(page.locator("#root")).toHaveAttribute("aria-hidden", "true");
    for (let index = 0; index < 5; index++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(view === "list" ? "/" : "/board");
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await expect(row.getByRole("link")).toBeFocused();

    await page.goForward();
    await expect(modal).toBeVisible();
    await page.goBack();
    await expect(modal).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await expect(row.getByRole("link")).toBeFocused();

    await row.getByRole("link").click();
    await modal.getByRole("button", { name: "Close" }).click();
    await expect(row.getByRole("link")).toBeFocused();
    await row.getByRole("link").click();
    await modal.getByRole("link", { name: "Open full page" }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-page").getByTestId("ticket-detail-title")).toHaveText(ticket.title);
    expect(new URL(page.url()).pathname).toBe(`/tickets/${ticket.id}`);

    await page.goto(view === "list" ? "/" : "/board");
    await row.getByRole("link").click();
    await expect(modal).toBeVisible();
    await page.reload();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-page").getByTestId("ticket-detail-title")).toHaveText(ticket.title);
    await page.goto(`/tickets/${ticket.id}`);
    await expect(page.getByTestId("ticket-detail-page")).toBeVisible();
  });
}

test("board: modal edits, assignment and Status change refresh from Galley on close", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const ticket = await createTicket(page, `modal board mutation ${Date.now()}`);
  await page.goto("/board");
  const card = page.getByTestId(`board-ticket-${ticket.id}`);
  await card.getByRole("link").click();
  const modal = page.getByRole("dialog", { name: "Ticket details" });
  await modal.getByTestId("ticket-detail-edit-button").click();
  await modal.getByTestId("ticket-detail-input-title").fill(`${ticket.title} edited`);
  await modal.getByTestId("ticket-detail-textarea-goal").fill("Modal goal");
  await modal.getByTestId("ticket-detail-save-button").click();
  await expect(modal.getByTestId("ticket-detail-title")).toHaveText(`${ticket.title} edited`);
  await modal.getByTestId("ticket-detail-assign-button").click();
  await expect(modal.getByTestId("ticket-detail-assignee")).toHaveText("Owner");
  await modal.getByTestId("ticket-detail-status-button-Ready").click();
  await expect(modal.getByTestId("ticket-detail-status")).toHaveText("Ready");
  const response = await page.request.get("/api/tickets");
  expect(response.ok()).toBe(true);
  const { tickets } = await response.json() as { tickets: Ticket[] };
  expect(tickets.find(({ id }) => id === ticket.id)).toMatchObject({ status: "Ready", title: `${ticket.title} edited`, goal: "Modal goal" });

  await modal.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("board-status-Ready").getByTestId(`board-ticket-${ticket.id}`)).toContainText(`${ticket.title} edited`);
  await expect(page.getByTestId("board-status-Backlog").getByTestId(`board-ticket-${ticket.id}`)).toHaveCount(0);
  await expect(card.getByRole("link")).toBeFocused();
});

test("list: modal edit and Accept refresh the list from Galley", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const ticket = await createTicket(page, `modal list mutation ${Date.now()}`);
  for (const status of ["Ready", "InProgress", "InReview"] as const) {
    expect((await changeTicketStatusDirect(page, ticket.id, status)).ok).toBe(true);
  }
  await page.goto("/");
  const row = page.getByTestId(`ticket-item-${ticket.id}`);
  await row.getByRole("link").click();
  const modal = page.getByRole("dialog", { name: "Ticket details" });
  await modal.getByTestId("ticket-detail-edit-button").click();
  await modal.getByTestId("ticket-detail-input-title").fill(`${ticket.title} accepted`);
  await modal.getByTestId("ticket-detail-save-button").click();
  await expect(modal.getByTestId("ticket-detail-title")).toHaveText(`${ticket.title} accepted`);
  await modal.getByTestId("ticket-detail-assign-button").click();
  await expect(modal.getByTestId("ticket-detail-assignee")).toHaveText("Owner");
  await modal.getByTestId("ticket-detail-unassign-button").click();
  await expect(modal.getByTestId("ticket-detail-assignee")).toHaveText("Unassigned");
  await modal.getByTestId("ticket-detail-accept-button").click();
  await expect(modal.getByTestId("ticket-detail-status")).toHaveText("Done");
  const response = await page.request.get("/api/tickets");
  expect(response.ok()).toBe(true);
  const { tickets } = await response.json() as { tickets: Ticket[] };
  expect(tickets.find(({ id }) => id === ticket.id)).toMatchObject({ status: "Done", title: `${ticket.title} accepted` });
  await modal.getByRole("button", { name: "Close" }).click();
  await expect(row).toContainText(`${ticket.title} accepted`);
  await expect(row.getByTestId("ticket-status")).toHaveText("Done");
  await expect(row.getByRole("link")).toBeFocused();
});

for (const view of ["list", "board"] as const) {
  test(`${view}: failed close-time refresh retains rows, scroll and origin focus`, async ({ page, request }) => {
    await signIn(page, request, "owner");
    const tickets = await populate(page);
    const ticket = view === "list" ? tickets[0] : tickets[12];
    await page.goto(view === "list" ? "/" : "/board");
    const row = page.getByTestId(`${view === "list" ? "ticket-item" : "board-ticket"}-${ticket.id}`);
    await row.getByRole("link").scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);
    await row.getByRole("link").click();
    await expect(page.getByRole("dialog", { name: "Ticket details" })).toBeVisible();
    await page.route("**/api/tickets", (route) => route.fulfill({ status: 503, body: "unavailable" }));
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId(view === "list" ? "ticket-list-refresh-error" : "ticket-board-refresh-error")).toBeVisible();
    await expect(row.getByRole("link")).toBeVisible();
    await expect(row.getByRole("link")).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  });
}

test("list: Save completing after modal closes re-fetches Galley", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const ticket = await createTicket(page, `deferred modal edit ${Date.now()}`);
  await page.goto("/");
  const row = page.getByTestId(`ticket-item-${ticket.id}`);
  await row.getByRole("link").click();
  const modal = page.getByRole("dialog", { name: "Ticket details" });
  await modal.getByTestId("ticket-detail-edit-button").click();
  await modal.getByTestId("ticket-detail-input-title").fill(`${ticket.title} saved`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let intercepted!: () => void;
  const started = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.route(`**/api/tickets/${ticket.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    intercepted();
    await gate;
    await route.continue();
  });
  await modal.getByTestId("ticket-detail-save-button").click();
  await started;
  const staleResponse = page.waitForResponse((response) => response.url().endsWith("/api/tickets") && response.ok());
  await modal.getByRole("button", { name: "Close" }).click();
  const stale = await staleResponse;
  expect((await stale.json() as { tickets: Ticket[] }).tickets.find(({ id }) => id === ticket.id)?.title).toBe(ticket.title);
  release();
  await expect(row.getByRole("link")).toHaveText(`${ticket.title} saved`, { timeout: 5000 });
});

test("board: Status change completing after Back re-fetches Galley", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const ticket = await createTicket(page, `deferred modal Status ${Date.now()}`);
  await page.goto("/board");
  const card = page.getByTestId(`board-ticket-${ticket.id}`);
  await card.getByRole("link").click();
  const modal = page.getByRole("dialog", { name: "Ticket details" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let intercepted!: () => void;
  const started = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.route(`**/api/tickets/${ticket.id}/status`, async (route) => {
    intercepted();
    await gate;
    await route.continue();
  });
  await modal.getByTestId("ticket-detail-status-button-Ready").click();
  await started;
  const staleResponse = page.waitForResponse((response) => response.url().endsWith("/api/tickets") && response.ok());
  await page.goBack();
  await expect(modal).toHaveCount(0);
  const stale = await staleResponse;
  expect((await stale.json() as { tickets: Ticket[] }).tickets.find(({ id }) => id === ticket.id)?.status).toBe("Backlog");
  release();
  await expect(page.getByTestId("board-status-Ready").getByTestId(`board-ticket-${ticket.id}`)).toBeVisible({ timeout: 5000 });
});

test("navigating to board after closing list modal keeps focus on board navigation", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const ticket = await createTicket(page, `focus origin ${Date.now()}`);
  await page.goto("/");
  await page.getByTestId(`ticket-item-${ticket.id}`).getByRole("link").click();
  await page.getByRole("dialog", { name: "Ticket details" }).getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId(`ticket-item-${ticket.id}`).getByRole("link")).toBeFocused();
  const boardLink = page.getByRole("navigation", { name: "Ticket views" }).getByRole("link", { name: "Board" });
  await boardLink.click();
  await expect(page.getByTestId(`board-ticket-${ticket.id}`)).toBeVisible();
  await expect(boardLink).toBeFocused();
});

test("Open full page retains modal edits and workflow controls", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const ticket = await createTicket(page, `modal parity ${Date.now()}`, "Coding");
  await page.goto("/board");
  await page.getByTestId(`board-ticket-${ticket.id}`).getByRole("link").click();
  const modal = page.getByRole("dialog", { name: "Ticket details" });
  await modal.getByTestId("ticket-detail-edit-button").click();
  await modal.getByTestId("ticket-detail-textarea-goal").fill("Goal edited in modal");
  await modal.getByTestId("ticket-detail-save-button").click();
  await expect(modal.getByTestId("ticket-detail-field-goal")).toHaveText("Goal edited in modal");
  await modal.getByTestId("ticket-detail-assign-button").click();
  await expect(modal.getByTestId("ticket-detail-assignee")).toHaveText("Owner");
  await modal.getByRole("link", { name: "Open full page" }).click();
  const detail = page.getByTestId("ticket-detail-page");
  await expect(detail.getByTestId("ticket-detail-field-goal")).toHaveText("Goal edited in modal");
  await expect(detail.getByTestId("ticket-detail-assignee")).toHaveText("Owner");
  await expect(detail.getByTestId("ticket-detail-unassign-button")).toBeVisible();
  await expect(detail.getByTestId("ticket-detail-pr-section")).toBeVisible();
});
