import { test, expect } from "@playwright/test";
import { createTicket } from "../support/tickets";

// Reuses the one Galley restart run.sh already performs in this phase:
// "the spec cannot restart a process it did not start" (README.md,
// "Adding a spec"). Ordered before ticket-persistence-before.spec.ts so
// this Ticket sorts older than its two and leaves its newest-two
// assertion alone.
const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });

test.beforeAll(() => {
  if (!STORAGE_STATE_PATH) {
    throw new Error(
      "E2E_STORAGE_STATE_PATH is not set -- run.sh sets this for the Galley-restart phase.",
    );
  }
});

// Duplicated rather than imported in ticket-lifecycle-after.spec.ts:
// each half is its own `playwright test` process invocation.
const TITLE = "ticket-lifecycle: before restart";

test("a Status and Assignee reached through the real controls survive a Galley restart", async ({ page }) => {
  const ticket = await createTicket(page, TITLE);

  await page.goto(`/tickets/${ticket.id}`);
  await page.getByTestId("ticket-detail-status-button-Ready").click();
  await expect(page.getByTestId("ticket-detail-status")).toHaveText("Ready");

  await page.getByTestId("ticket-detail-status-button-InProgress").click();
  await expect(page.getByTestId("ticket-detail-status")).toHaveText("InProgress");

  await page.getByTestId("ticket-detail-assign-button").click();
  await expect(page.getByTestId("ticket-detail-assignee")).toHaveText("Owner");
});
