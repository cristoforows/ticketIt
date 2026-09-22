import { test, expect } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { createTicket, changeTicketStatusDirect, acceptTicketDirect } from "../support/tickets";

// issue #61, D3 (docs/decisions/d3-agent-template-compatibility.md S2):
// the Swiftlet controls for Status, Assignee, and Accept added on top
// of #60's Galley-only lifecycle enforcement. Per ADR 0001, Swiftlet
// never enforces a workflow rule of its own -- every assertion below
// either drives the real controls end to end, or proves a rejection
// Galley actually returned is shown verbatim rather than hidden,
// retried, or applied optimistically.
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

    // Refine (issue #58's behavior, driven here only as background
    // context on the way to Ready -- not re-tested for its own sake).
    await page.getByTestId("ticket-detail-edit-button").click();
    await page.getByTestId("ticket-detail-textarea-goal").fill("Ship the feature end to end.");
    await page
      .getByTestId("ticket-detail-textarea-success-criteria")
      .fill("The feature works as described and is reviewed.");
    await page.getByTestId("ticket-detail-save-button").click();
    await expect(page.getByTestId("ticket-detail-field-goal")).toHaveText("Ship the feature end to end.");

    // Assigning and unassigning the Owner (issue #61's own requirement)
    // is independent of Status -- exercised here before any transition.
    await expect(page.getByTestId("ticket-detail-assignee")).toHaveText("Unassigned");
    await page.getByTestId("ticket-detail-assign-button").click();
    await expect(page.getByTestId("ticket-detail-assignee")).toHaveText("Owner");

    await page.getByTestId("ticket-detail-status-button-Ready").click();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Ready");

    await page.getByTestId("ticket-detail-status-button-InProgress").click();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("InProgress");

    await page.getByTestId("ticket-detail-status-button-InReview").click();
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("InReview");

    // Basic Template retains humanAcceptance -- Accept is offered, and
    // it alone reaches Done (there is no plain Status button for Done
    // at all -- presentationNextStatuses never lists it).
    await expect(page.getByTestId("ticket-detail-accept-button")).toBeVisible();
    await expect(page.getByTestId("ticket-detail-status-button-Done")).toHaveCount(0);
    await page.getByTestId("ticket-detail-accept-button").click();

    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Done");
    await expect(page.getByTestId("ticket-detail-accept-button")).toHaveCount(0);

    // Assign/unassign remain available after Done (no Status precondition -- #60's own guarantee).
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
    // "Adding a spec"): reaching In Progress is issue #61's own
    // Status-button behavior, already proven by the full-path test
    // above.
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

    // Behind this already-loaded page's back, the Ticket's real Status
    // moves on -- this is what turns the still-rendered "InProgress"
    // button into a genuine skip (Backlog -> InProgress is not on D3
    // S2's table) rather than a button Swiftlet should never have shown
    // in the first place.
    const movedBack = await changeTicketStatusDirect(page, ticket.id, "Backlog");
    expect(movedBack.ok).toBe(true);

    // Ask Galley directly what it will actually say for this exact
    // rejected request -- asserted against below, not a hardcoded
    // literal (README.md, "Adding a spec": "Assert against what the
    // backend actually returned, not literals").
    const directRejection = await changeTicketStatusDirect(page, ticket.id, "InProgress");
    expect(directRejection.ok).toBe(false);
    expect(directRejection.errorCode).toBe("invalid_transition");
    expect(directRejection.errorMessage).toBeTruthy();

    // The still-stale UI attempts the same now-invalid move.
    await page.getByTestId("ticket-detail-status-button-InProgress").click();

    await expect(page.getByTestId("ticket-detail-action-error")).toHaveText(directRejection.errorMessage!);
    // Never an optimistic update: the last-known-good Status stays
    // shown, not "InProgress" and not the true current "Backlog" either
    // -- this component only ever renders what its own last successful
    // command (or the initial fetch) returned.
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Ready");
  });

  test("a Coding-Template Ticket In Review has no Accept button and states Galley's actual not-yet-implemented reason", async ({
    page,
  }) => {
    const ticket = await createTicket(page, `ticket-lifecycle: coding accept unavailable ${Date.now()}`, "Coding");
    await changeTicketStatusDirect(page, ticket.id, "Ready");
    await changeTicketStatusDirect(page, ticket.id, "InProgress");
    await changeTicketStatusDirect(page, ticket.id, "InReview");

    // Ask Galley directly what Accept would actually say for this exact
    // Ticket -- asserted against below, not a hardcoded literal.
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
