import { test, expect } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { createTicket } from "../support/tickets";

// issue #59, D3 (docs/decisions/d3-agent-template-compatibility.md): the
// two built-in Ticket Templates, each Ticket's own retained completion
// condition, and the one repository reference available on either
// Template. No restart coverage here -- the retained-completion-condition
// guarantee is already proven across a genuine Galley restart at the Go
// level (apps/galley/cmd/galley's
// TestRestartDurability_CompletionConditionSurvivesFreshProcess); this
// spec covers what only a real browser can: the actual Template selector
// on the capture form, and the full page's presentation of both
// Templates.
test.describe("ticket templates", () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, request, "owner");
  });

  test("capturing a Ticket through the real form with the Coding Template shows its own retained completion condition and an honest Pull Request section", async ({
    page,
  }) => {
    const title = `ticket-templates: coding via form ${Date.now()}`;

    await page.goto("/");
    await page.getByTestId("ticket-title-input").fill(title);
    await page.getByTestId("ticket-template-select").selectOption("Coding");
    await page.getByTestId("ticket-capture-submit").click();

    await page.getByRole("link", { name: title, exact: true }).click();

    await expect(page.getByTestId("ticket-detail-title")).toHaveText(title);
    await expect(page.getByTestId("ticket-detail-template")).toHaveText("Coding");
    await expect(page.getByTestId("ticket-detail-completion-condition")).toHaveText(
      "Reviewed pull request merged",
    );
    await expect(page.getByTestId("ticket-detail-pr-section")).toBeVisible();
    await expect(page.getByTestId("ticket-detail-pr-empty-state")).toContainText(
      "PR delivery arrives with coding execution",
    );
  });

  test("capturing a Ticket through the real form with the default Basic Template retains human acceptance and shows no Pull Request section", async ({
    page,
  }) => {
    const title = `ticket-templates: basic via form ${Date.now()}`;

    await page.goto("/");
    await expect(page.getByTestId("ticket-template-select")).toHaveValue("Basic");
    await page.getByTestId("ticket-title-input").fill(title);
    await page.getByTestId("ticket-capture-submit").click();

    await page.getByRole("link", { name: title, exact: true }).click();

    await expect(page.getByTestId("ticket-detail-title")).toHaveText(title);
    await expect(page.getByTestId("ticket-detail-template")).toHaveText("Basic");
    await expect(page.getByTestId("ticket-detail-completion-condition")).toHaveText("Human acceptance");
    await expect(page.getByTestId("ticket-detail-pr-section")).toHaveCount(0);
  });

  test("the repository reference can be set on either Template, and persists across reload", async ({ page }) => {
    const basic = await createTicket(page, `ticket-templates: basic repository ${Date.now()}`, "Basic");
    const coding = await createTicket(page, `ticket-templates: coding repository ${Date.now()}`, "Coding");

    for (const [ticket, repo] of [
      [basic, "owner/basic-repo"],
      [coding, "owner/coding-repo"],
    ] as const) {
      await page.goto(`/tickets/${ticket.id}`);
      await expect(page.getByTestId("ticket-detail-field-repository")).toHaveText("Not set.");

      await page.getByTestId("ticket-detail-edit-button").click();
      await page.getByTestId("ticket-detail-input-repository").fill(repo);
      await page.getByTestId("ticket-detail-save-button").click();

      await expect(page.getByTestId("ticket-detail-field-repository")).toHaveText(repo);

      await page.reload();
      await expect(page.getByTestId("ticket-detail-field-repository")).toHaveText(repo);
    }
  });

  test("the completion condition does not change when another field is edited from the full page", async ({
    page,
  }) => {
    const ticket = await createTicket(page, `ticket-templates: condition stable ${Date.now()}`, "Coding");

    await page.goto(`/tickets/${ticket.id}`);
    await expect(page.getByTestId("ticket-detail-completion-condition")).toHaveText(
      "Reviewed pull request merged",
    );

    await page.getByTestId("ticket-detail-edit-button").click();
    await page.getByTestId("ticket-detail-textarea-goal").fill("Ship the feature.");
    await page.getByTestId("ticket-detail-save-button").click();

    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Ship the feature.");
    await expect(page.getByTestId("ticket-detail-completion-condition")).toHaveText(
      "Reviewed pull request merged",
    );
    // Template itself has no edit control anywhere on this page --
    // changing it after creation is out of scope for M2 (D4, M8).
    await expect(page.getByTestId("ticket-detail-template")).toHaveText("Coding");
  });
});
