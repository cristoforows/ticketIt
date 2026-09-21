import { test, expect } from "@playwright/test";

// Loads the same storage state ticket-persistence-before.spec.ts ran
// with -- proving the Tickets it captured are readable from a genuinely
// restarted Galley process (README.md, "Adding a spec"), the same
// two-file split session-restart-before/after.spec.ts use for the
// session itself.
const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });

test.beforeAll(() => {
  if (!STORAGE_STATE_PATH) {
    throw new Error(
      "E2E_STORAGE_STATE_PATH is not set -- run.sh sets this for the Galley-restart phase.",
    );
  }
});

// Must match ticket-persistence-before.spec.ts's own two constants
// exactly -- see that file's comment for why they are duplicated
// rather than imported.
const FIRST_TITLE = "ticket-persistence: first Ticket";
const SECOND_TITLE = "ticket-persistence: second Ticket";

test("the two captured Tickets are still listed, in the same order, after a Galley restart", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();

  const titles = page.locator('[data-testid="ticket-title"]');
  await expect(titles.first()).toHaveText(SECOND_TITLE);
  await expect(titles.nth(1)).toHaveText(FIRST_TITLE);
});
