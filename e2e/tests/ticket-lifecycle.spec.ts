import { test, expect } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { createTicket, changeTicketStatusDirect, acceptTicketDirect } from "../support/tickets";

// Swiftlet enforces no workflow rule of its own (ADR 0001), so every
// assertion here either drives the real controls end to end, or proves
// a rejection Galley actually returned is shown verbatim rather than
// hidden, retried, or applied optimistically.
test.describe("ticket lifecycle controls", () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, request, "owner");
  });

  test("the full human path: capture, refine, Ready, In Progress, In Review, Accept, Done", async ({ page }) => {
    const title = `ticket-lifecycle: full path ${Date.now()}`;

    await page.goto("/");
    await page.getByTestId("ticket-title-input").fill(title);
    await page.getByTestId("ticket-capture-submit").click();
    await page.getByRole("link", { name: title, exact: true }).click();

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Backlog");

    // Background on the way to Ready, not re-tested for its own sake.
    await page.getByTestId("ticket-detail-edit-button").click();
    await page.getByTestId("ticket-detail-textarea-goal").fill("Ship the feature end to end.");
    await page
      .getByTestId("ticket-detail-textarea-success-criteria")
      .fill("The feature works as described and is reviewed.");
    await page.getByTestId("ticket-detail-save-button").click();
    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Ship the feature end to end.");

    // Assignment is independent of Status, so it runs before any
    // transition.
    await expect(page.getByTestId("ticket-detail-assignee")).toHaveText("Unassigned");
    await page.getByTestId("ticket-detail-assign-button").click();
    await expect(page.getByTestId("ticket-detail-assignee")).toHaveText("Owner");

    await page.getByTestId("ticket-detail-status-button-Ready").click();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Ready");

    await page.getByTestId("ticket-detail-status-button-InProgress").click();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("InProgress");

    await page.getByTestId("ticket-detail-status-button-InReview").click();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("InReview");

    // A humanAcceptance Ticket: Accept is offered, and reaches Done
    // where no Status button can.
    await expect(page.getByTestId("ticket-detail-accept-button")).toBeVisible();
    await expect(page.getByTestId("ticket-detail-status-button-Done")).toHaveCount(0);
    await page.getByTestId("ticket-detail-accept-button").click();

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Done");
    await expect(page.getByTestId("ticket-detail-accept-button")).toHaveCount(0);

    // Still available after Done: assignment has no Status precondition.
    await page.getByTestId("ticket-detail-unassign-button").click();
    await expect(page.getByTestId("ticket-detail-assignee")).toHaveText("Unassigned");

    await page.reload();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Done");
    await expect(page.getByTestId("ticket-detail-assignee")).toHaveText("Unassigned");
  });

  test("manual Blocked and resume return work to In Progress, and Blocked never offers a shortcut straight to Ready", async ({
    page,
  }) => {
    const ticket = await createTicket(page, `ticket-lifecycle: blocked and resume ${Date.now()}`);
    // Background setup, not the behavior under test (README.md,
    // "Adding a spec") -- the full-path test above already proves it.
    await changeTicketStatusDirect(page, ticket.id, "Ready");
    await changeTicketStatusDirect(page, ticket.id, "InProgress");

    await page.goto(`/tickets/${ticket.id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("InProgress");

    await page.getByTestId("ticket-detail-status-button-Blocked").click();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Blocked");

    // D3 S2: only Blocked -> InProgress is offered, never Blocked -> Ready.
    await expect(page.getByTestId("ticket-detail-status-button-Ready")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-status-button-InProgress")).toBeVisible();

    await page.getByTestId("ticket-detail-status-button-InProgress").click();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("InProgress");
  });

  test("a rejected skip is surfaced with Galley's actual reason -- never hidden, retried, or applied as if it had succeeded", async ({
    page,
  }) => {
    const ticket = await createTicket(page, `ticket-lifecycle: rejected skip ${Date.now()}`);
    await changeTicketStatusDirect(page, ticket.id, "Ready");

    await page.goto(`/tickets/${ticket.id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Ready");
    await expect(page.getByTestId("ticket-detail-status-button-InProgress")).toBeVisible();

    // Moving the real Status behind the loaded page's back is what makes
    // the still-rendered "InProgress" button a genuine skip, rather than
    // one Swiftlet should never have offered.
    const movedBack = await changeTicketStatusDirect(page, ticket.id, "Backlog");
    expect(movedBack.ok).toBe(true);

    // Assert against what the backend actually returned, not literals
    // (README.md, "Adding a spec").
    const directRejection = await changeTicketStatusDirect(page, ticket.id, "InProgress");
    expect(directRejection.ok).toBe(false);
    expect(directRejection.errorCode).toBe("invalid_transition");
    expect(directRejection.errorMessage).toBeTruthy();

    // The still-stale UI attempts the same now-invalid move.
    await page.getByTestId("ticket-detail-status-button-InProgress").click();

    await expect(page.getByTestId("ticket-detail-action-error")).toHaveText(directRejection.errorMessage!);
    // Never an optimistic update: the last-known-good Status stays on
    // screen, neither the attempted nor the true current one.
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Ready");
  });

  test("a Coding-Template Ticket In Review has no Accept button and states Galley's actual not-yet-implemented reason", async ({
    page,
  }) => {
    const ticket = await createTicket(page, `ticket-lifecycle: coding accept unavailable ${Date.now()}`, "Coding");
    await changeTicketStatusDirect(page, ticket.id, "Ready");
    await changeTicketStatusDirect(page, ticket.id, "InProgress");
    await changeTicketStatusDirect(page, ticket.id, "InReview");

    // Assert against Galley's live response, not a literal.
    const directAccept = await acceptTicketDirect(page, ticket.id);
    expect(directAccept.ok).toBe(false);
    expect(directAccept.errorCode).toBe("reviewed_pr_merge_not_implemented");
    expect(directAccept.errorMessage).toBeTruthy();

    await page.goto(`/tickets/${ticket.id}`);
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("InReview");
    await expect(page.getByTestId("ticket-detail-accept-button")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-accept-unavailable")).toHaveText(directAccept.errorMessage!);
  });
});
