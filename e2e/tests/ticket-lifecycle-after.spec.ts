import { test, expect } from "@playwright/test";

// The same storage state the "before" half ran with, so the Status and
// Assignee it reached are read back from a genuinely restarted Galley.
const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });

test.beforeAll(() => {
  if (!STORAGE_STATE_PATH) {
    throw new Error(
      "E2E_STORAGE_STATE_PATH is not set -- run.sh sets this for the Galley-restart phase.",
    );
  }
});

// Must match ticket-lifecycle-before.spec.ts's constant exactly.
const TITLE = "ticket-lifecycle: before restart";

test("the Status and Assignee reached before a Galley restart are still there after it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();

  // Located by title: the id was generated in the "before" process and
  // cannot cross the two `playwright test` invocations.
  const ticketLink = page.locator('[data-testid="ticket-title"]', { hasText: TITLE });
  await expect(ticketLink).toHaveText(TITLE);
  await ticketLink.click();

  await expect(page.getByTestId("ticket-detail-status")).toHaveText("InProgress");
  await expect(page.getByTestId("ticket-detail-assignee")).toHaveText("Owner");
});
