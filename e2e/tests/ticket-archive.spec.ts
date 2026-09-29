import { test, expect } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { changeTicketStatusDirect, acceptTicketDirect, createTicket, type Ticket } from "../support/tickets";

test("archive Ready and Done from modal; retain direct read-only detail and exclude filtered collections", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const ready = await createTicket(page, `archive Ready ${Date.now()}`);
  const done = await createTicket(page, `archive Done ${Date.now()}`);
  for (const ticket of [ready, done]) expect((await changeTicketStatusDirect(page, ticket.id, "Ready")).ok).toBe(true);
  for (const status of ["InProgress", "InReview"] as const) expect((await changeTicketStatusDirect(page, done.id, status)).ok).toBe(true);
  expect((await acceptTicketDirect(page, done.id)).ok).toBe(true);
  const badgeResponse = await page.request.post("/api/badges", { data: { name: `Archive badge ${Date.now()}` } });
  expect(badgeResponse.ok()).toBe(true);
  const badge = await badgeResponse.json() as { id: string; name: string };
  for (const ticket of [ready, done]) expect((await page.request.put(`/api/tickets/${ticket.id}/badges/${badge.id}`)).ok()).toBe(true);

  await page.goto("/");
  await page.getByTestId("badge-filter").getByRole("checkbox", { name: badge.name }).check();
  for (const ticket of [ready, done]) await expect(page.getByTestId(`ticket-item-${ticket.id}`)).toBeVisible();
  for (const ticket of [ready, done]) {
    const view = ticket.id === ready.id ? "ticket-item" : "board-ticket";
    if (ticket.id === done.id) {
      await page.getByRole("link", { name: "Board" }).click();
      await expect(page.getByTestId(`board-ticket-${ready.id}`)).toHaveCount(0);
    }
    await page.getByTestId(`${view}-${ticket.id}`).getByRole("link").click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("dialog", { name: "Ticket details" }).getByTestId("ticket-detail-archive-button").click();
    await expect(page.getByRole("dialog", { name: "Ticket details" })).toHaveCount(0);
    await expect(page.getByTestId(`${view}-${ticket.id}`)).toHaveCount(0);
    const response = await page.request.get(`/api/tickets/${ticket.id}`);
    expect(response.ok()).toBe(true);
    const archived = await response.json() as Ticket;
    expect(archived.status).toBe(ticket.id === ready.id ? "Ready" : "Done");
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.badges).toEqual([{ id: badge.id, name: badge.name }]);
  }
  await expect(page.getByTestId("ticket-board-filter-empty")).toBeVisible();
  const filtered = await page.request.get(`/api/tickets?badgeId=${badge.id}`);
  expect((await filtered.json() as { tickets: Ticket[] }).tickets).toEqual([]);
  await page.goto(`/tickets/${ready.id}`);
  await expect(page.getByTestId("ticket-detail-archived")).toContainText("archived tickets are read-only");
  await expect(page.getByTestId("ticket-detail-status")).toHaveText("Ready");
  await expect(page.getByTestId("ticket-detail-edit-button")).toBeDisabled();
  await expect(page.getByRole("button", { name: `Remove ${badge.name}` })).toBeDisabled();
  const rejected = await page.request.patch(`/api/tickets/${ready.id}`, { data: { title: "cannot edit" } });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json() as { error: { code: string } }).error.code).toBe("archived_ticket");

  const fromBoard = await createTicket(page, `archive full page ${Date.now()}`);
  expect((await page.request.put(`/api/tickets/${fromBoard.id}/badges/${badge.id}`)).ok()).toBe(true);
  await page.goto(`/board?badgeId=${badge.id}`);
  await page.getByTestId(`board-ticket-${fromBoard.id}`).getByRole("link").click();
  await page.getByRole("dialog", { name: "Ticket details" }).getByRole("link", { name: "Open full page" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("ticket-detail-archive-button").click();
  await expect(page).toHaveURL(new RegExp(`/board\\?badgeId=${badge.id}$`));
  await expect(page.getByTestId(`board-ticket-${fromBoard.id}`)).toHaveCount(0);

  const newTabTicket = await createTicket(page, `archive new tab ${Date.now()}`);
  expect((await page.request.put(`/api/tickets/${newTabTicket.id}/badges/${badge.id}`)).ok()).toBe(true);
  await page.reload();
  const [newTab] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByTestId(`board-ticket-${newTabTicket.id}`).getByRole("link").click({ modifiers: ["ControlOrMeta"] }),
  ]);
  await expect(newTab.getByTestId("ticket-detail-page")).toBeVisible();
  newTab.once("dialog", (dialog) => dialog.accept());
  await newTab.getByTestId("ticket-detail-archive-button").click();
  await expect(newTab).toHaveURL(new RegExp(`/board\\?badgeId=${badge.id}$`));
  await expect(newTab.getByTestId(`board-ticket-${newTabTicket.id}`)).toHaveCount(0);
  await newTab.close();
});
