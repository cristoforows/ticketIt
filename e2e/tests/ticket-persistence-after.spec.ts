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
  await expect(titles.filter({ hasText: SECOND_TITLE })).toHaveCount(1);
  await expect(titles.filter({ hasText: FIRST_TITLE })).toHaveCount(1);

  // Relative order, not absolute list positions. Every spec shares one
  // database, so asserting on the newest two entries makes this spec
  // fail whenever an unrelated spec captures a Ticket between the
  // before/after pair -- which already happened once when #58 added its
  // own restart-phase spec (docs/evidence/m2/58-refinement-fields.md).
  const rendered = await titles.allTextContents();
  expect(rendered.indexOf(SECOND_TITLE)).toBeLessThan(rendered.indexOf(FIRST_TITLE));
});
