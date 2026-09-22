import { test, expect } from "@playwright/test";

// Loads the same storage state ticket-refinement-before.spec.ts ran
// with -- proving the title edit and manual refinement fields it saved
// are readable from a genuinely restarted Galley process, the same
// two-file split session-restart-before/after.spec.ts and
// ticket-persistence-before/after.spec.ts use.
const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });

test.beforeAll(() => {
  if (!STORAGE_STATE_PATH) {
    throw new Error(
      "E2E_STORAGE_STATE_PATH is not set -- run.sh sets this for the Galley-restart phase.",
    );
  }
});

// Must match ticket-refinement-before.spec.ts's own constants exactly
// -- see that file's comment for why they are duplicated rather than
// imported.
const EDITED_TITLE = "ticket-refinement: before restart (edited)";
const GOAL = "Restore sign-in for existing users on Safari.";
const CONTEXT = "See the linked issue and the attached screenshot.";
const SUCCESS_CRITERIA = "Existing users can sign in on Safari.";
const CONSTRAINTS = "Preserve the existing login flow.";

test("the edited title and manual refinement fields are still there after a Galley restart", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();

  // Located by the edited title, since the Ticket's id (generated at
  // creation time in the "before" process) cannot be shared across the
  // two separate `playwright test` process invocations that straddle
  // run.sh's restart.
  const editedTicketLink = page.locator('[data-testid="ticket-title"]', { hasText: EDITED_TITLE });
  await expect(editedTicketLink).toHaveText(EDITED_TITLE);
  await editedTicketLink.click();

  await expect(page.getByTestId("ticket-detail-title")).toHaveText(EDITED_TITLE);
  await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText(GOAL);
  await expect(page.getByTestId("ticket-detail-field-context")).toHaveText(CONTEXT);
  await expect(page.getByTestId("ticket-detail-field-success-criteria")).toHaveText(SUCCESS_CRITERIA);
  await expect(page.getByTestId("ticket-detail-field-constraints")).toHaveText(CONSTRAINTS);
});
