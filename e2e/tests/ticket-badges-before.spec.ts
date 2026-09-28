import { test, expect } from "@playwright/test";
import { createTicket, type Ticket } from "../support/tickets";

const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });
test.beforeAll(() => { if (!STORAGE_STATE_PATH) throw new Error("run.sh must set E2E_STORAGE_STATE_PATH"); });

const FIRST = "ticket-badges: first before restart";
const SECOND = "ticket-badges: second before restart";
const SHARED = "Badge shared across restart";
const EXTRA = "Badge second on first";

test("creates two Badges, attaches one to two Tickets through modal and full-page picker, and shows list and board", async ({ page }) => {
  const first = await createTicket(page, FIRST);
  const second = await createTicket(page, SECOND);
  await page.goto("/");
  const row = page.getByTestId(`ticket-item-${first.id}`);
  await row.getByRole("link").click();
  const modal = page.getByRole("dialog", { name: "Ticket details" });
  await modal.getByTestId("badge-picker-toggle").click();
  await modal.getByTestId("new-badge-name").fill(SHARED);
  await modal.getByRole("button", { name: "Create and attach" }).click();
  await expect(modal.getByTestId("ticket-detail-badges")).toContainText(SHARED);
  await modal.getByTestId("new-badge-name").fill(EXTRA);
  await modal.getByRole("button", { name: "Create and attach" }).click();
  await expect(modal.getByTestId("ticket-detail-badges").getByRole("listitem")).toHaveCount(2);

  const duplicate = await page.request.post("/api/badges", { data: { name: SHARED.toUpperCase() } });
  expect(duplicate.status()).toBe(409);
  const reason = (await duplicate.json() as { error: { code: string; message: string } }).error;
  expect(reason.code).toBe("duplicate_badge_name");
  await modal.getByTestId("new-badge-name").fill(SHARED.toUpperCase());
  await modal.getByRole("button", { name: "Create and attach" }).click();
  await expect(modal.getByTestId("badge-picker-error")).toHaveText(reason.message);

  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row.getByTestId("ticket-badges")).toContainText(SHARED);
  await expect(row.getByTestId("ticket-badges")).toContainText(EXTRA);
  await page.goto(`/tickets/${second.id}`);
  await page.getByTestId("badge-picker-toggle").click();
  await page.getByTestId("badge-picker-select").selectOption({ label: SHARED });
  await page.getByRole("button", { name: "Attach badge" }).click();
  await expect(page.getByTestId("ticket-detail-badges")).toContainText(SHARED);
  const attached = await page.request.put(`/api/tickets/${second.id}/badges/${(await (await page.request.get("/api/badges")).json() as { badges: { id: string; name: string }[] }).badges.find(({ name }) => name === SHARED)!.id}`);
  expect(attached.ok()).toBe(true);
  expect((await attached.json() as Ticket).badges).toHaveLength(1);
  const list = await page.request.get("/api/tickets");
  expect(list.ok()).toBe(true);
  const { tickets } = await list.json() as { tickets: Ticket[] };
  expect(tickets.find(({ id }) => id === first.id)?.badges.map(({ name }) => name)).toEqual([EXTRA, SHARED]);
  expect(tickets.find(({ id }) => id === second.id)?.badges.map(({ name }) => name)).toEqual([SHARED]);
  await page.goto("/board");
  await expect(page.getByTestId(`board-ticket-${first.id}`).getByTestId("board-badges")).toContainText(SHARED);
  await expect(page.getByTestId(`board-ticket-${second.id}`).getByTestId("board-badges")).toHaveText(SHARED);
});
