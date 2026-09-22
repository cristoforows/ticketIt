import { test, expect } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { createTicket } from "../support/tickets";

// issue #57: the canonical full-page Ticket view -- list-to-detail
// navigation, a direct URL load, a reload of that direct URL (the
// classic SPA static-server failure point), and the not-found page for
// an identifier that does not exist.
test.describe("ticket detail page", () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, request, "owner");
  });

  test("opening a Ticket from the list shows its full page, and a reload renders the same content", async ({
    page,
  }) => {
    const title = `ticket-detail: opened from the list ${Date.now()}`;
    const ticket = await createTicket(page, title);

    await page.goto("/");
    await page.getByTestId(`ticket-item-${ticket.id}`).getByTestId("ticket-title").click();

    expect(new URL(page.url()).pathname).toBe(`/tickets/${ticket.id}`);
    await expect(page.getByTestId("ticket-detail-title")).toHaveText(title);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText(ticket.status);
    await expect(page.getByTestId("ticket-detail-created-at")).toHaveText(ticket.createdAt);

    // The classic failure point named in issue #57: the static server
    // (vite preview) must fall back to index.html for this path, not
    // 404 -- a reload must render the same page directly, not a blank
    // screen or the server's own error page.
    await page.reload();
    await expect(page.getByTestId("ticket-detail-title")).toHaveText(title);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText(ticket.status);
  });

  test("loading a Ticket's URL directly renders its full page", async ({ page }) => {
    const title = `ticket-detail: direct URL ${Date.now()}`;
    const ticket = await createTicket(page, title);

    await page.goto(`/tickets/${ticket.id}`);

    await expect(page.getByTestId("ticket-detail-title")).toHaveText(title);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText(ticket.status);
  });

  test("an unknown Ticket identifier renders a clear not-found page, not a blank screen or a raw error", async ({
    page,
  }) => {
    await page.goto("/tickets/00000000-0000-4000-8000-000000000000");

    await expect(page.getByTestId("ticket-detail-not-found")).toBeVisible();
    await expect(page.getByTestId("ticket-detail-title")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-error")).toHaveCount(0);
  });

  test("the Backlog list still renders correctly after visiting a Ticket's page", async ({ page }) => {
    const title = `ticket-detail: back to backlog ${Date.now()}`;
    const ticket = await createTicket(page, title);

    await page.goto(`/tickets/${ticket.id}`);
    await expect(page.getByTestId("ticket-detail-title")).toHaveText(title);

    await page.getByTestId("back-to-backlog-link").click();

    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByTestId(`ticket-item-${ticket.id}`)).toBeVisible();
  });
});
