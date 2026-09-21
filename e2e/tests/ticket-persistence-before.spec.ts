import { test, expect } from "@playwright/test";
import { createTicket } from "../support/tickets";

// Shares session-restart-before.spec.ts's saved storage state (this
// runs immediately after it, in the same run.sh phase) so this spec
// starts already signed in, and reuses the one Galley restart run.sh
// performs in that phase rather than requesting a second one --
// README.md, "Adding a spec": "the spec cannot restart a process it
// did not start."
const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });

test.beforeAll(() => {
  if (!STORAGE_STATE_PATH) {
    throw new Error(
      "E2E_STORAGE_STATE_PATH is not set -- run.sh sets this for the Galley-restart phase.",
    );
  }
});

// Fixed, spec-unique titles. Duplicated (not imported) in
// ticket-persistence-after.spec.ts: each of these two files is its own
// `playwright test` process invocation, and the existing
// session-restart pair follows the same convention with its own fixed
// owner-login string rather than sharing state between the two halves.
const FIRST_TITLE = "ticket-persistence: first Ticket";
const SECOND_TITLE = "ticket-persistence: second Ticket";

test("the Owner captures two Tickets, newest first, before Galley restarts", async ({ page }) => {
  // Background data, not the behavior under test -- created via
  // e2e/support/tickets.ts's API-direct helper (issue #56's data-setup
  // convention) so the ordering assertion below proves "newest first"
  // against a list that already has something in it, not one that
  // merely happens to be empty.
  await createTicket(page, "ticket-persistence: pre-existing older Ticket");

  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();

  // The behavior actually under test (acceptance criterion 1: "a title
  // alone captures a Ticket in Backlog through the browser") -- driven
  // through the real quick-capture form, not the API-direct helper.
  for (const title of [FIRST_TITLE, SECOND_TITLE]) {
    await page.getByTestId("ticket-title-input").fill(title);
    await page.getByTestId("ticket-capture-submit").click();
    await expect(page.getByTestId("ticket-title-input")).toHaveValue("");
  }

  // Newest first (apps/galley/README.md, "Ticket ordering"): the
  // Ticket captured last (SECOND_TITLE) must be the very first item.
  const titles = page.locator('[data-testid="ticket-title"]');
  await expect(titles.first()).toHaveText(SECOND_TITLE);
  await expect(titles.nth(1)).toHaveText(FIRST_TITLE);

  const statuses = page.locator('[data-testid="ticket-status"]');
  await expect(statuses.first()).toHaveText("Backlog");
});
