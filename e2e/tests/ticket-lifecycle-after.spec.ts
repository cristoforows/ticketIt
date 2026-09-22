import { test, expect } from "@playwright/test";

// Loads the same storage state ticket-lifecycle-before.spec.ts ran
// with -- proving the Status and Assignee it reached are readable from
// a genuinely restarted Galley process, the same two-file split every
// other before/after pair in this suite uses.
const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });

test.beforeAll(() => {
  if (!STORAGE_STATE_PATH) {
    throw new Error(
      "E2E_STORAGE_STATE_PATH is not set -- run.sh sets this for the Galley-restart phase.",
    );
  }
});

// Must match ticket-lifecycle-before.spec.ts's own constant exactly --
// see that file's comment for why it is duplicated rather than
// imported.
const TITLE = "ticket-lifecycle: before restart";

test("the Status and Assignee reached before a Galley restart are still there after it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();

  // Located by title, since the Ticket's id (generated at creation time
  // in the "before" process) cannot be shared across the two separate
  // `playwright test` process invocations that straddle run.sh's
  // restart.
  const ticketLink = page.locator('[data-testid="ticket-title"]', { hasText: TITLE });
  await expect(ticketLink).toHaveText(TITLE);
  await ticketLink.click();

  await expect(page.getByTestId("ticket-detail-status")).toHaveText("InProgress");
  await expect(page.getByTestId("ticket-detail-assignee")).toHaveText("Owner");
});
