import { test, expect, type Page } from "@playwright/test";
import { createTicket, type Ticket } from "../support/tickets";

const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });
test.beforeAll(() => { if (!STORAGE_STATE_PATH) throw new Error("run.sh must set E2E_STORAGE_STATE_PATH"); });

const FIRST = "ticket-badges: first before restart";
const SECOND = "ticket-badges: second before restart";
const SHARED = "Badge shared across restart";
const EXTRA = "Badge second on first";

async function liveTickets(page: Page): Promise<Ticket[]> {
  const response = await page.request.get("/api/tickets");
  expect(response.ok()).toBe(true);
  return (await response.json() as { tickets: Ticket[] }).tickets;
}

const names = (ticket: Ticket) => ticket.badges.map((badge) => badge.name);

test("creates two Badges, attaches one to two Tickets through modal and full-page picker, and shows list and board", async ({ page }) => {
  const first = await createTicket(page, FIRST);
  const second = await createTicket(page, SECOND);
  await page.goto("/list");
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
  const firstFromList = (await liveTickets(page)).find(({ id }) => id === first.id)!;
  expect(names(firstFromList)).toEqual([EXTRA, SHARED]);
  const catalogResponse = await page.request.get("/api/badges");
  expect(catalogResponse.ok()).toBe(true);
  const catalog = (await catalogResponse.json() as { badges: { id: string; name: string }[] }).badges;
  expect(firstFromList.badges).toEqual(catalog.filter(({ name }) => name === EXTRA || name === SHARED).map(({ id, name }) => ({ id, name })));
  const firstDetailResponse = await page.request.get(`/api/tickets/${first.id}`);
  expect(firstDetailResponse.ok()).toBe(true);
  expect((await firstDetailResponse.json() as Ticket).badges).toEqual(firstFromList.badges);
  await expect(modal.getByTestId("ticket-detail-badges").getByRole("listitem").locator("span")).toHaveText(names(firstFromList));

  const duplicate = await page.request.post("/api/badges", { data: { name: SHARED.toUpperCase() } });
  expect(duplicate.status()).toBe(409);
  const reason = (await duplicate.json() as { error: { code: string; message: string } }).error;
  expect(reason.code).toBe("duplicate_badge_name");
  await modal.getByTestId("new-badge-name").fill(SHARED.toUpperCase());
  await modal.getByRole("button", { name: "Create and attach" }).click();
  await expect(modal.getByTestId("badge-picker-error")).toHaveText(reason.message);

  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row.getByTestId("ticket-badges")).toHaveText(names(firstFromList).join(", "));
  await page.goto(`/tickets/${second.id}`);
  await page.getByTestId("badge-picker-toggle").click();
  await page.getByTestId("badge-picker-select").selectOption({ label: SHARED });
  await page.getByRole("button", { name: "Attach badge" }).click();
  await expect(page.getByTestId("ticket-detail-badges").getByRole("listitem")).toHaveCount(1);
  const tickets = await liveTickets(page);
  const secondFromList = tickets.find(({ id }) => id === second.id)!;
  expect(secondFromList.badges).toEqual(firstFromList.badges.filter(({ name }) => name === SHARED));
  const secondDetailResponse = await page.request.get(`/api/tickets/${second.id}`);
  expect(secondDetailResponse.ok()).toBe(true);
  expect((await secondDetailResponse.json() as Ticket).badges).toEqual(secondFromList.badges);
  await expect(page.getByTestId("ticket-detail-badges").getByRole("listitem").locator("span")).toHaveText(names(secondFromList));
  const attached = await page.request.put(`/api/tickets/${second.id}/badges/${secondFromList.badges[0].id}`);
  expect(attached.ok()).toBe(true);
  expect((await attached.json() as Ticket).badges).toEqual(secondFromList.badges);
  expect(tickets.find(({ id }) => id === first.id)?.badges).toEqual(firstFromList.badges);
  await page.goto("/board");
  await expect(page.getByTestId(`board-ticket-${first.id}`).getByTestId("board-badges")).toHaveText(names(firstFromList).join(", "));
  await expect(page.getByTestId(`board-ticket-${second.id}`).getByTestId("board-badges")).toHaveText(names(secondFromList).join(", "));
});
