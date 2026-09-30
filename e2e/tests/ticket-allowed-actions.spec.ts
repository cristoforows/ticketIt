import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { createTicket, changeTicketStatusDirect, acceptTicketDirect, type Ticket, type TicketStatus, statusLabel } from "../support/tickets";

async function assertPublishedControls(page: Page, id: string) {
  const response = await page.request.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  const ticket = await response.json() as Ticket;
  await page.goto(`/tickets/${id}`);
  await expect(page.getByTestId("ticket-detail-status")).toHaveText(statusLabel(ticket.status));
  const targets = await page.getByTestId("ticket-detail-status-actions").getByRole("button").allTextContents();
  expect(targets).toEqual(ticket.allowedActions.statusChanges.map(statusLabel));
  if (ticket.allowedActions.accept.available) {
    await expect(page.getByTestId("ticket-detail-accept-button")).toBeVisible();
    await expect(page.getByTestId("ticket-detail-accept-unavailable")).toHaveCount(0);
  } else {
    await expect(page.getByTestId("ticket-detail-accept-button")).toHaveCount(0);
    await expect(page.getByTestId("ticket-detail-accept-unavailable")).toHaveText(ticket.allowedActions.accept.reason!.message);
  }
  return ticket;
}

test("full-page controls follow Galley's published actions across Backlog and both In Review conditions", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const basic = await createTicket(page, `allowed actions basic ${Date.now()}`);
  const backlog = await assertPublishedControls(page, basic.id);
  expect(backlog.status).toBe("Backlog");
  expect(backlog.allowedActions.statusChanges).toContain("Blocked");
  expect(backlog.allowedActions.accept.available).toBe(false);
  const rejected = await acceptTicketDirect(page, basic.id);
  expect(rejected.errorCode).toBe(backlog.allowedActions.accept.reason?.code);
  expect(rejected.errorMessage).toBe(backlog.allowedActions.accept.reason?.message);

  async function moveTicketToInReview(id: string) {
    for (const status of ["Ready", "InProgress", "InReview"] as TicketStatus[]) {
      const result = await changeTicketStatusDirect(page, id, status);
      expect(result.ok).toBe(true);
    }
  }
  await moveTicketToInReview(basic.id);
  const human = await assertPublishedControls(page, basic.id);
  expect(human.allowedActions.accept.available).toBe(true);
  expect(human.allowedActions.accept.reason).toBeUndefined();
  await page.getByTestId("ticket-detail-accept-button").click();
  await expect(page.getByTestId("ticket-detail-status")).toHaveText("Done");

  const coding = await createTicket(page, `allowed actions coding ${Date.now()}`, "Coding");
  await moveTicketToInReview(coding.id);
  const reviewed = await assertPublishedControls(page, coding.id);
  expect(reviewed.allowedActions.accept.available).toBe(false);
  const denied = await acceptTicketDirect(page, coding.id);
  expect(denied.ok).toBe(false);
  expect(denied.errorCode).toBe(reviewed.allowedActions.accept.reason?.code);
  expect(denied.errorMessage).toBe(reviewed.allowedActions.accept.reason?.message);
});
