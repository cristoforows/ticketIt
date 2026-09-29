import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { acceptTicketDirect, changeTicketStatusDirect, createTicket, type Ticket, type TicketStatus } from "../support/tickets";

const statuses: TicketStatus[] = ["Backlog", "Ready", "InProgress", "Blocked", "InReview", "Done"];

async function moveTo(page: Page, ticket: Ticket, target: TicketStatus) {
  const path: TicketStatus[] = ["Ready", "InProgress", "InReview", "Done"];
  const steps = target === "Blocked" ? [target] : target === "Backlog" ? [] : path.slice(0, path.indexOf(target) + 1);
  for (const status of steps) {
    const result = status === "Done"
      ? await acceptTicketDirect(page, ticket.id)
      : await changeTicketStatusDirect(page, ticket.id, status);
    expect(result.ok).toBe(true);
    expect(result.ticket?.status).toBe(status);
  }
}

test("board and list render the same live Tickets in Galley order, with reloadable columns and one session", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const placements: { ticket: Ticket; status: TicketStatus }[] = [];
  for (const [index, status] of [...statuses, "Blocked"].entries()) {
    const ticket = await createTicket(page, `board ${Date.now()} ${index}`, index % 2 && status !== "Done" ? "Coding" : "Basic");
    placements.push({ ticket, status });
    await moveTo(page, ticket, status);
  }

  const response = await page.request.get("/api/tickets");
  expect(response.ok()).toBe(true);
  const { tickets } = await response.json() as { tickets: Ticket[] };
  for (const { ticket, status } of placements) {
    expect(tickets.find((item) => item.id === ticket.id)?.status).toBe(status);
  }

  await page.goto("/board");
  await expect(page.getByTestId("ticket-board")).toBeVisible();
  await expect(page.getByTestId("board-columns")).toHaveCSS("display", "grid");
  await page.reload();
  await expect(page.getByTestId("signed-in-owner")).toBeVisible();
  await expect(page.getByTestId("board-status-Done")).toBeVisible();
  await expect(page.getByTestId("ticket-capture-form")).toHaveCount(0);
  expect(await page.locator('[data-testid^="board-status-"]').locator("h3").allTextContents()).toEqual([
    "Backlog", "Ready", "In Progress", "Blocked", "In Review", "Done",
  ]);
  for (const status of statuses) {
    const column = page.getByTestId(`board-status-${status}`);
    const expected = tickets.filter((ticket) => ticket.status === status);
    await expect(column.locator('[data-testid^="board-ticket-"]')).toHaveCount(expected.length);
    expect(await column.locator('[data-testid^="board-ticket-"]').evaluateAll(
      (cards) => cards.map((card) => card.getAttribute("data-testid")?.replace("board-ticket-", "")),
    )).toEqual(expected.map((ticket) => ticket.id));
    for (const ticket of expected) {
      const card = column.getByTestId(`board-ticket-${ticket.id}`);
      await expect(card.getByRole("link", { name: ticket.title })).toHaveAttribute("href", `/tickets/${ticket.id}?from=board`);
      await expect(card).toContainText(`Template: ${ticket.template}`);
    }
  }

  const views = page.getByRole("navigation", { name: "Ticket views" });
  await views.getByRole("link", { name: "List", exact: true }).click();
  await expect(page.getByTestId("ticket-list-items")).toBeVisible();
  await expect(page.getByTestId("signed-in-owner")).toBeVisible();
  expect(await page.locator('[data-testid^="ticket-item-"]').evaluateAll(
    (items) => items.map((item) => item.getAttribute("data-testid")?.replace("ticket-item-", "")),
  )).toEqual(tickets.map((ticket) => ticket.id));
  await views.getByRole("link", { name: "Board", exact: true }).click();
  const blocked = placements[placements.length - 1].ticket;
  await expect(page.getByTestId("board-status-Blocked").getByTestId(`board-ticket-${blocked.id}`)).toBeVisible();
  await page.getByTestId(`board-ticket-${blocked.id}`).getByRole("link").click();
  await expect(page.getByRole("dialog", { name: "Ticket details" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/tickets/${blocked.id}`);
});
