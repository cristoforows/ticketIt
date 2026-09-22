import { test, expect } from "@playwright/test";
import { createTicket } from "../support/tickets";

// Shares session-restart-before.spec.ts's saved storage state (this
// runs in the same run.sh phase, before the restart) and reuses the
// one Galley restart run.sh performs in that phase rather than
// requesting a second one -- README.md, "Adding a spec": "the spec
// cannot restart a process it did not start." Runs before
// ticket-persistence-before.spec.ts, like ticket-refinement-before.spec.ts
// already does, so this spec's own Ticket capture sorts older than
// ticket-persistence's two and does not disturb its newest-two
// assertion (see run.sh's own comment on that ordering).
const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });

test.beforeAll(() => {
  if (!STORAGE_STATE_PATH) {
    throw new Error(
      "E2E_STORAGE_STATE_PATH is not set -- run.sh sets this for the Galley-restart phase.",
    );
  }
});

// Fixed, spec-unique title. Duplicated (not imported) in
// ticket-lifecycle-after.spec.ts -- each half is its own `playwright
// test` process invocation, the same convention every other
// before/after pair in this suite already uses.
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
