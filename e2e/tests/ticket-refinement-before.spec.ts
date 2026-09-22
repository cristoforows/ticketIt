import { test, expect } from "@playwright/test";
import { createTicket } from "../support/tickets";

// Shares session-restart-before.spec.ts's saved storage state (this
// runs in the same run.sh phase, before the restart) and reuses the
// one Galley restart run.sh performs in that phase rather than
// requesting a second one -- README.md, "Adding a spec": "the spec
// cannot restart a process it did not start."
const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });

test.beforeAll(() => {
  if (!STORAGE_STATE_PATH) {
    throw new Error(
      "E2E_STORAGE_STATE_PATH is not set -- run.sh sets this for the Galley-restart phase.",
    );
  }
});

// Fixed text, duplicated (not imported) in
// ticket-refinement-after.spec.ts -- each half is its own `playwright
// test` process invocation, the same convention
// ticket-persistence-before/after.spec.ts already use for their own
// fixed titles. The edited title is how the "after" half locates this
// exact Ticket on the Backlog list, since the two halves cannot share
// the Ticket's id (generated at creation time, in this process) across
// processes.
const ORIGINAL_TITLE = "ticket-refinement: before restart";
const EDITED_TITLE = "ticket-refinement: before restart (edited)";
const GOAL = "Restore sign-in for existing users on Safari.";
const CONTEXT = "See the linked issue and the attached screenshot.";
const SUCCESS_CRITERIA = "Existing users can sign in on Safari.";
const CONSTRAINTS = "Preserve the existing login flow.";

test("the title and manual refinement fields, edited from the full page, survive a Galley restart", async ({
  page,
}) => {
  // Background data, not the behavior under test (README.md, "Adding a
  // spec"): title-only capture is issue #56's behavior, not this
  // slice's -- created via the API-direct helper.
  const ticket = await createTicket(page, ORIGINAL_TITLE);

  await page.goto(`/tickets/${ticket.id}`);
  await page.getByTestId("ticket-detail-edit-button").click();

  await page.getByTestId("ticket-detail-input-title").fill(EDITED_TITLE);
  await page.getByTestId("ticket-detail-textarea-goal").fill(GOAL);
  await page.getByTestId("ticket-detail-textarea-context").fill(CONTEXT);
  await page.getByTestId("ticket-detail-textarea-success-criteria").fill(SUCCESS_CRITERIA);
  await page.getByTestId("ticket-detail-textarea-constraints").fill(CONSTRAINTS);
  await page.getByTestId("ticket-detail-save-button").click();

  await expect(page.getByTestId("ticket-detail-title")).toHaveText(EDITED_TITLE);
  await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText(GOAL);
  await expect(page.getByTestId("ticket-detail-field-context")).toHaveText(CONTEXT);
  await expect(page.getByTestId("ticket-detail-field-success-criteria")).toHaveText(SUCCESS_CRITERIA);
  await expect(page.getByTestId("ticket-detail-field-constraints")).toHaveText(CONSTRAINTS);
});
