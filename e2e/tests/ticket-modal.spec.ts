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
    await expect(modal.getByTestId("ticket-detail-title")).toHaveText(ticket.title);
    await expect(modal.getByTestId("ticket-detail-template")).toHaveText(ticket.template);
    await expect(modal.getByTestId("ticket-detail-status")).toHaveText(ticket.status);
    expect(new URL(page.url()).pathname).toBe(`/tickets/${ticket.id}`);
    await expect(page.getByTestId(view === "list" ? "ticket-list" : "ticket-board")).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.closest("dialog")?.open)).toBe(true);
    expect(await page.evaluate(() => {
      document.querySelector<HTMLElement>('[aria-label="Ticket views"] a')?.focus();
      return document.activeElement?.closest("dialog")?.open;
    })).toBe(true);
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
