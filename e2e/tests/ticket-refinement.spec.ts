import { test, expect } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { createTicket } from "../support/tickets";

// issue #58: manual refinement -- editing a Ticket's title and its four
// refinement fields (goal, context, Success Criteria, constraints) by
// hand from the full page, with save/cancel and Galley's own
// validation surfaced verbatim. No AI of any kind is involved.
// Persistence across a genuine backend restart is covered separately
// by ticket-refinement-before.spec.ts / ticket-refinement-after.spec.ts,
// which share run.sh's existing restart phase; the specs below only
// need a live Galley and cover reload, cancel, and validation.
test.describe("ticket manual refinement", () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, request, "owner");
  });

  test("capturing a title-only Ticket, then filling in the title and all four refinement fields, persists across reload", async ({
    page,
  }) => {
    const title = `ticket-refinement: reload ${Date.now()}`;
    const editedTitle = `${title} (edited)`;
    const ticket = await createTicket(page, title);

    await page.goto(`/tickets/${ticket.id}`);

    // Before editing, every refinement field shows the "unset"
    // placeholder -- this was a title-only capture (docs/ticket-creation.md,
    // "Quick capture").
    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Not set.");
    await expect(page.getByTestId("ticket-detail-field-context")).toHaveText("Not set.");
    await expect(page.getByTestId("ticket-detail-field-success-criteria")).toHaveText("Not set.");
    await expect(page.getByTestId("ticket-detail-field-constraints")).toHaveText("Not set.");

    await page.getByTestId("ticket-detail-edit-button").click();

    // The guidance prompts must match docs/ticket-creation.md verbatim
    // -- issue #58's own acceptance criterion.
    await expect(page.getByTestId("ticket-detail-guidance-goal")).toHaveText("What outcome do you want?");
    await expect(page.getByTestId("ticket-detail-guidance-context")).toHaveText(
      "Supply relevant background, links, repositories, or examples.",
    );
    await expect(page.getByTestId("ticket-detail-guidance-success-criteria")).toHaveText(
      "Describe observable conditions that demonstrate the outcome was achieved.",
    );
    await expect(page.getByTestId("ticket-detail-guidance-constraints")).toHaveText(
      "State what must stay unchanged or remain out of scope.",
    );

    await page.getByTestId("ticket-detail-input-title").fill(editedTitle);
    await page.getByTestId("ticket-detail-textarea-goal").fill("Ship the login fix.");
    await page.getByTestId("ticket-detail-textarea-context").fill("See the linked issue.");
    await page.getByTestId("ticket-detail-textarea-success-criteria").fill("Users can sign in again.");
    await page.getByTestId("ticket-detail-textarea-constraints").fill("Do not change the API.");
    await page.getByTestId("ticket-detail-save-button").click();

    await expect(page.getByTestId("ticket-detail-title")).toHaveText(editedTitle);
    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Ship the login fix.");
    await expect(page.getByTestId("ticket-detail-edit-form")).toHaveCount(0);

    await page.reload();

    await expect(page.getByTestId("ticket-detail-title")).toHaveText(editedTitle);
    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Ship the login fix.");
    await expect(page.getByTestId("ticket-detail-field-context")).toHaveText("See the linked issue.");
    await expect(page.getByTestId("ticket-detail-field-success-criteria")).toHaveText("Users can sign in again.");
    await expect(page.getByTestId("ticket-detail-field-constraints")).toHaveText("Do not change the API.");
  });

  test("Cancel discards unsaved edits without persisting them", async ({ page }) => {
    const title = `ticket-refinement: cancel ${Date.now()}`;
    const ticket = await createTicket(page, title);

    await page.goto(`/tickets/${ticket.id}`);
    await page.getByTestId("ticket-detail-edit-button").click();
    await page.getByTestId("ticket-detail-textarea-goal").fill("This should not be saved.");
    await page.getByTestId("ticket-detail-cancel-button").click();

    await expect(page.getByTestId("ticket-detail-edit-form")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Not set.");

    await page.reload();
    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Not set.");
  });

  test("clearing the title is rejected with Galley's own message, shown verbatim", async ({ page }) => {
    const title = `ticket-refinement: reject clear ${Date.now()}`;
    const ticket = await createTicket(page, title);

    await page.goto(`/tickets/${ticket.id}`);
    await page.getByTestId("ticket-detail-edit-button").click();
    await page.getByTestId("ticket-detail-input-title").fill("   ");
    await page.getByTestId("ticket-detail-save-button").click();

    await expect(page.getByTestId("ticket-detail-save-error")).toHaveText(
      '"title" cannot be cleared -- every ticket must have a title',
    );
    // Still in edit mode -- a rejected save does not silently discard
    // the Owner's other edits or leave a blank screen.
    await expect(page.getByTestId("ticket-detail-edit-form")).toBeVisible();

    await page.getByTestId("ticket-detail-cancel-button").click();
    await expect(page.getByTestId("ticket-detail-title")).toHaveText(title);
  });

  test("an over-length field is rejected with Galley's own message, and clearing a set field persists after reload", async ({
    page,
  }) => {
    const title = `ticket-refinement: over-length then clear ${Date.now()}`;
    const ticket = await createTicket(page, title);

    await page.goto(`/tickets/${ticket.id}`);
    await page.getByTestId("ticket-detail-edit-button").click();
    await page.getByTestId("ticket-detail-textarea-goal").fill("x".repeat(2001));
    await page.getByTestId("ticket-detail-save-button").click();

    await expect(page.getByTestId("ticket-detail-save-error")).toHaveText(
      '"goal" must be at most 2000 characters after trimming',
    );

    await page.getByTestId("ticket-detail-textarea-goal").fill("Set first.");
    await page.getByTestId("ticket-detail-save-button").click();
    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Set first.");

    await page.getByTestId("ticket-detail-edit-button").click();
    await page.getByTestId("ticket-detail-textarea-goal").fill("");
    await page.getByTestId("ticket-detail-save-button").click();

    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Not set.");
    await page.reload();
    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Not set.");
  });
});
