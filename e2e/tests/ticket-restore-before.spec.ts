import { test, expect } from "@playwright/test";
import { changeTicketStatusDirect, acceptTicketDirect, createTicket, type Ticket, statusLabel } from "../support/tickets";

const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });
test.beforeAll(() => { if (!STORAGE_STATE_PATH) throw new Error("run.sh must set E2E_STORAGE_STATE_PATH"); });

export const READY_TITLE = "restore: Ready before restart";
export const DONE_TITLE = "restore: Done before restart";
export const BADGE_NAME = "restore: Badge before restart";

test("Archived list combines Badge filter, restores Ready to Backlog and Done unchanged", async ({ page }) => {
  const ready = await createTicket(page, READY_TITLE);
  const done = await createTicket(page, DONE_TITLE);
  expect((await changeTicketStatusDirect(page, ready.id, "Ready")).ok).toBe(true);
  for (const status of ["Ready", "InProgress", "InReview"] as const) expect((await changeTicketStatusDirect(page, done.id, status)).ok).toBe(true);
  expect((await acceptTicketDirect(page, done.id)).ok).toBe(true);
  expect((await page.request.patch(`/api/tickets/${ready.id}`, { data: { goal: "Preserved after restore" } })).ok()).toBe(true);
  const badgeResponse = await page.request.post("/api/badges", { data: { name: BADGE_NAME } });
  expect(badgeResponse.ok()).toBe(true);
  const badge = await badgeResponse.json() as { id: string; name: string };
  for (const ticket of [ready, done]) {
    expect((await page.request.put(`/api/tickets/${ticket.id}/badges/${badge.id}`)).ok()).toBe(true);
    expect((await page.request.post(`/api/tickets/${ticket.id}/archive`)).ok()).toBe(true);
  }

  await page.goto("/list");
  await page.getByTestId("archived-filter").check();
  await page.getByTestId("badge-filter").getByRole("checkbox", { name: badge.name }).check();
  const filtered = await page.request.get(`/api/tickets?archived=true&badgeId=${badge.id}`);
  expect(filtered.ok()).toBe(true);
  expect((await filtered.json() as { tickets: Ticket[] }).tickets.map((item) => item.id)).toEqual([done.id, ready.id]);
  for (const ticket of [ready, done]) await expect(page.getByTestId(`ticket-item-${ticket.id}`)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("archived-filter")).toBeChecked();
  await expect(page.getByTestId("badge-filter").getByRole("checkbox", { name: badge.name })).toBeChecked();

  for (const [ticket, status] of [[ready, "Backlog"], [done, "Done"]] as const) {
    await page.getByTestId(`ticket-item-${ticket.id}`).getByRole("link").click();
    const modal = page.getByRole("dialog", { name: "Ticket details" });
    await modal.getByTestId("ticket-detail-restore-button").click();
    await expect(modal.getByTestId("ticket-detail-status")).toHaveText(statusLabel(status));
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByTestId(`ticket-item-${ticket.id}`)).toHaveCount(0);
    const response = await page.request.get(`/api/tickets/${ticket.id}`);
    expect(response.ok()).toBe(true);
    const saved = await response.json() as Ticket;
    expect(saved.status).toBe(status);
    expect(saved.archivedAt).toBeNull();
    expect(saved.badges).toEqual([{ id: badge.id, name: badge.name }]);
    if (ticket.id === ready.id) expect(saved.goal).toBe("Preserved after restore");
  }

  await page.getByRole("link", { name: "Board" }).click();
  expect(new URL(page.url()).searchParams.get("archived")).toBe("true");
  await expect(page.getByTestId(`board-ticket-${ready.id}`)).toBeVisible();
  await expect(page.getByTestId(`board-ticket-${done.id}`)).toBeVisible();
  await page.getByRole("link", { name: "List" }).click();
  await expect(page.getByTestId("ticket-list-empty")).toContainText("No archived tickets match");
  await page.getByTestId("archived-filter").uncheck();
  for (const ticket of [ready, done]) await expect(page.getByTestId(`ticket-item-${ticket.id}`)).toBeVisible();
  await page.getByRole("link", { name: "Board" }).click();
  await expect(page.getByTestId("board-status-Backlog").getByTestId(`board-ticket-${ready.id}`)).toBeVisible();
  await expect(page.getByTestId("board-status-Done").getByTestId(`board-ticket-${done.id}`)).toBeVisible();
});
