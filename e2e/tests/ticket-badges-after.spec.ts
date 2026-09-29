import { test, expect } from "@playwright/test";
import type { Ticket } from "../support/tickets";

const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });
test.beforeAll(() => { if (!STORAGE_STATE_PATH) throw new Error("run.sh must set E2E_STORAGE_STATE_PATH"); });

test("Badge definitions and both Ticket attachments survive a Galley process restart", async ({ page }) => {
  const first = "ticket-badges: first before restart";
  const second = "ticket-badges: second before restart";
  const shared = "Badge shared across restart";
  const extra = "Badge second on first";
  const badgesResponse = await page.request.get("/api/badges");
  expect(badgesResponse.ok()).toBe(true);
  const { badges } = await badgesResponse.json() as { badges: { id: string; name: string }[] };
  expect(badges.find(({ name }) => name === shared)).toBeDefined();
  expect(badges.find(({ name }) => name === extra)).toBeDefined();
  const listResponse = await page.request.get("/api/tickets");
  expect(listResponse.ok()).toBe(true);
  const { tickets } = await listResponse.json() as { tickets: Ticket[] };
  const firstTicket = tickets.find(({ title }) => title === first)!;
  const secondTicket = tickets.find(({ title }) => title === second)!;
  expect(firstTicket.badges.map(({ name }) => name)).toEqual([extra, shared]);
  expect(secondTicket.badges.map(({ name }) => name)).toEqual([shared]);
  const expected = badges.filter(({ name }) => name === shared || name === extra).map(({ id, name }) => ({ id, name }));
  expect(firstTicket.badges).toEqual(expected);
  expect(secondTicket.badges).toEqual(expected.filter(({ name }) => name === shared));
  for (const ticket of [firstTicket, secondTicket]) {
    const detailResponse = await page.request.get(`/api/tickets/${ticket.id}`);
    expect(detailResponse.ok()).toBe(true);
    expect((await detailResponse.json() as Ticket).badges).toEqual(ticket.badges);
  }
  await page.goto("/");
  await expect(page.getByTestId(`ticket-item-${firstTicket.id}`).getByTestId("ticket-badges")).toHaveText(firstTicket.badges.map(({ name }) => name).join(", "));
  await expect(page.getByTestId(`ticket-item-${secondTicket.id}`).getByTestId("ticket-badges")).toHaveText(secondTicket.badges.map(({ name }) => name).join(", "));
  await page.getByTestId(`ticket-item-${firstTicket.id}`).getByRole("link").click();
  await expect(page.getByRole("dialog").getByTestId("ticket-detail-badges").getByRole("listitem")).toHaveText(firstTicket.badges.map(({ name }) => name));
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.goto("/board");
  await expect(page.getByTestId(`board-ticket-${firstTicket.id}`).getByTestId("board-badges")).toHaveText(firstTicket.badges.map(({ name }) => name).join(", "));
  await expect(page.getByTestId(`board-ticket-${secondTicket.id}`).getByTestId("board-badges")).toHaveText(secondTicket.badges.map(({ name }) => name).join(", "));
});
