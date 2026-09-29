import { test, expect } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { createTicket, type Ticket } from "../support/tickets";

test("Badge OR filter survives reload, board switch and full-page return; detaching in modal removes the matching Ticket", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const createBadge = async (name: string): Promise<{ id: string; name: string }> => {
    const response = await page.request.post("/api/badges", { data: { name } });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const suffix = Date.now();
  const a = await createBadge(`Filter A ${suffix}`);
  const b = await createBadge(`Filter B ${suffix}`);
  const first = await createTicket(page, `filter first ${suffix}`);
  const second = await createTicket(page, `filter second ${suffix}`);
  const none = await createTicket(page, `filter none ${suffix}`);
  expect((await page.request.put(`/api/tickets/${first.id}/badges/${a.id}`)).ok()).toBe(true);
  expect((await page.request.put(`/api/tickets/${second.id}/badges/${b.id}`)).ok()).toBe(true);

  await page.goto("/");
  const filter = page.getByTestId("badge-filter");
  await filter.getByRole("checkbox", { name: a.name }).check();
  await filter.getByRole("checkbox", { name: b.name }).check();
  expect(new URL(page.url()).searchParams.getAll("badgeId")).toEqual([a.id, b.id]);
  const filtered = await page.request.get(`/api/tickets?badgeId=${a.id}&badgeId=${b.id}`);
  expect(filtered.ok()).toBe(true);
  expect((await filtered.json() as { tickets: Ticket[] }).tickets.map((ticket) => ticket.id)).toEqual([second.id, first.id]);
  await expect(page.getByTestId(`ticket-item-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`ticket-item-${second.id}`)).toBeVisible();
  await expect(page.getByTestId(`ticket-item-${none.id}`)).toHaveCount(0);
  await page.reload();
  await expect(filter.getByRole("checkbox", { name: a.name })).toBeChecked();
  await expect(filter.getByRole("checkbox", { name: b.name })).toBeChecked();
  await page.getByRole("link", { name: "Board" }).click();
  expect(new URL(page.url()).searchParams.getAll("badgeId")).toEqual([a.id, b.id]);
  await expect(page.getByTestId(`board-ticket-${second.id}`)).toBeVisible();
  await expect(page.getByTestId(`board-ticket-${none.id}`)).toHaveCount(0);

  await page.getByTestId(`board-ticket-${second.id}`).getByRole("link").click();
  const modal = page.getByRole("dialog", { name: "Ticket details" });
  expect(new URL(page.url()).searchParams.getAll("badgeId")).toEqual([a.id, b.id]);
  await modal.getByRole("button", { name: `Remove ${b.name}` }).click();
  await expect(modal.getByRole("button", { name: `Remove ${b.name}` })).toHaveCount(0);
  const saved = await page.request.get(`/api/tickets/${second.id}`);
  expect(saved.ok()).toBe(true);
  expect((await saved.json() as Ticket).badges).toEqual([]);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId(`board-ticket-${second.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`board-ticket-${first.id}`)).toBeVisible();
  expect(new URL(page.url()).searchParams.getAll("badgeId")).toEqual([a.id, b.id]);

  await page.getByTestId(`board-ticket-${first.id}`).getByRole("link").click();
  await modal.getByRole("link", { name: "Open full page" }).click();
  await expect(page.getByTestId("ticket-detail-page")).toBeVisible();
  await page.getByTestId("back-to-backlog-link").click();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).searchParams.getAll("badgeId")).toEqual([a.id, b.id]);
  await expect(filter.getByRole("checkbox", { name: a.name })).toBeChecked();
  await expect(page.getByTestId(`ticket-item-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`ticket-item-${none.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`ticket-item-${second.id}`)).toHaveCount(0);

  await filter.getByRole("button", { name: "Clear filter" }).click();
  await expect(page.getByTestId(`ticket-item-${second.id}`)).toBeVisible();
  await expect(page.getByTestId(`ticket-item-${none.id}`)).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
});
