import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { changeTicketStatusDirect, createTicket, type Ticket, type TicketStatus } from "../support/tickets";

const stages: TicketStatus[] = ["Backlog", "Ready", "InProgress", "Blocked", "InReview", "Done"];

async function readTicket(page: Page, id: string): Promise<Ticket> {
  const response = await page.request.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function expectOnlyStageInView(page: Page, stage: TicketStatus) {
  const width = page.viewportSize()!.width;
  for (const other of stages) {
    const column = page.getByTestId(`board-status-${other}`);
    await expect.poll(async () => {
      const box = await column.boundingBox();
      return box !== null && box.x >= 0 && box.x + box.width <= width;
    }).toBe(other === stage);
  }
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });

  test("shows one stage at a time, driven by Previous, Next and the step markers", async ({ page, request }) => {
    await signIn(page, request, "owner");
    await page.goto("/board");
    const switcher = page.getByTestId("board-stage-switcher");
    await expect(switcher).toBeVisible();
    await expectOnlyStageInView(page, "Backlog");
    await expect(page.getByTestId("board-stage-prev")).toBeDisabled();

    await page.getByTestId("board-stage-next").click();
    await expectOnlyStageInView(page, "Ready");
    await expect(page.getByTestId("board-stage-current")).toContainText("Ready");
    await expect(page.getByTestId("board-stage-step-Ready")).toHaveAttribute("aria-current", "true");

    await page.getByTestId("board-stage-step-InReview").click();
    await expectOnlyStageInView(page, "InReview");
    await expect(page.getByTestId("board-stage-next")).toHaveAccessibleName("Next stage: Done");

    await page.getByTestId("board-stage-next").click();
    await expectOnlyStageInView(page, "Done");
    await expect(page.getByTestId("board-stage-next")).toBeDisabled();

    await page.getByTestId("board-stage-prev").click();
    await expectOnlyStageInView(page, "InReview");
    await expect(page.getByTestId("board-stage-prev")).toHaveAccessibleName("Previous stage: Blocked");
  });

  test("follows a swipe", async ({ page, request }) => {
    await signIn(page, request, "owner");
    await page.goto("/board");
    await page.getByTestId("board-columns").evaluate((element) => {
      const column = element.children[2] as HTMLElement;
      element.scrollTo({ left: column.getBoundingClientRect().left - element.getBoundingClientRect().left + element.scrollLeft });
    });
    await expect(page.getByTestId("board-stage-current")).toContainText("In Progress");
    await expect(page.getByTestId("board-stage-step-InProgress")).toHaveAttribute("aria-current", "true");
  });

  test("tapping a slip selects it alone, and Escape deselects it", async ({ page, request }) => {
    await signIn(page, request, "owner");
    const first = await createTicket(page, `mobile select ${Date.now()} a`);
    const second = await createTicket(page, `mobile select ${Date.now()} b`);
    await page.goto("/board");
    const firstSlip = page.getByTestId(`board-ticket-${first.id}`);
    const secondSlip = page.getByTestId(`board-ticket-${second.id}`);
    await expect(firstSlip.getByTestId("move-to-trigger")).toHaveCount(0);

    await secondSlip.getByTestId("board-slip-toggle").click();
    await expect(secondSlip.getByTestId("board-slip-actions")).toBeVisible();
    await expect(secondSlip.getByTestId("board-slip-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(new URL(page.url()).pathname).toBe("/board");
    await expect(page.getByTestId("board-slip-actions")).toHaveCount(1);
    await expect(firstSlip.getByTestId("board-slip-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(firstSlip.getByTestId("board-slip-actions")).toHaveCount(0);

    await firstSlip.getByTestId("board-slip-toggle").click();
    await expect(page.getByTestId("board-slip-actions")).toHaveCount(1);
    await expect(firstSlip.getByTestId("board-slip-actions")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("board-slip-actions")).toHaveCount(0);
    await expect(firstSlip.getByTestId("board-slip-toggle")).toBeFocused();
  });

  test("View opens the detail modal, Edit opens it in edit mode", async ({ page, request }) => {
    await signIn(page, request, "owner");
    const created = await createTicket(page, `mobile actions ${Date.now()}`);
    await page.goto("/board");
    const slip = page.getByTestId(`board-ticket-${created.id}`);

    await slip.getByTestId("board-slip-toggle").click();
    await slip.getByTestId("board-slip-view").click();
    const modal = page.getByRole("dialog", { name: "Ticket details" });
    await expect(modal.getByTestId("ticket-detail-title")).toHaveText(created.title);
    await expect(modal.getByTestId("ticket-detail-edit-form")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`/tickets/${created.id}`);
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);

    await slip.getByTestId("board-slip-toggle").click();
    await slip.getByTestId("board-slip-edit").click();
    await expect(modal.getByTestId("ticket-detail-edit-form")).toBeVisible();
    await expect(modal.getByTestId("ticket-detail-input-title")).toHaveValue(created.title);
  });

  test("Move stage moves the Ticket and stays on the current stage", async ({ page, request }) => {
    await signIn(page, request, "owner");
    const created = await createTicket(page, `mobile move ${Date.now()}`);
    await page.goto("/board");
    const slip = page.getByTestId(`board-ticket-${created.id}`);

    await slip.getByTestId("board-slip-toggle").click();
    await slip.getByTestId("board-slip-move").click();
    await expect(slip.getByTestId("board-slip-move-Done")).toHaveCount(0);
    await slip.getByTestId("board-slip-move-Ready").click();

    await expect.poll(async () => (await readTicket(page, created.id)).status).toBe("Ready");
    await expect(page.getByTestId("board-status-Backlog").getByTestId(`board-ticket-${created.id}`)).toHaveCount(0);
    await expectOnlyStageInView(page, "Backlog");
    await expect(page.getByTestId("board-stage-step-Backlog")).toBeFocused();

    await page.getByTestId("board-stage-next").click();
    await expect(page.getByTestId("board-status-Ready").getByTestId(`board-ticket-${created.id}`)).toBeVisible();
  });

  test("keeps the stage across a Badge filter change and a modal open and close", async ({ page, request }) => {
    await signIn(page, request, "owner");
    const suffix = Date.now();
    const badge = await (await page.request.post("/api/badges", { data: { name: `Stage ${suffix}` } })).json();
    const created = await createTicket(page, `mobile stage ${suffix}`);
    for (const target of ["Ready", "InProgress"] as TicketStatus[]) {
      expect((await changeTicketStatusDirect(page, created.id, target)).ok).toBe(true);
    }
    expect((await page.request.put(`/api/tickets/${created.id}/badges/${badge.id}`)).ok()).toBe(true);
    await page.goto("/board");

    await page.getByTestId("board-stage-step-InProgress").click();
    await expectOnlyStageInView(page, "InProgress");
    await page.getByTestId("badge-filter").getByRole("checkbox", { name: badge.name }).check();
    await expect(page.getByTestId("board-stage-current")).toContainText("In Progress");
    await expectOnlyStageInView(page, "InProgress");
    const slip = page.getByTestId(`board-ticket-${created.id}`);
    await expect(slip).toBeVisible();

    await slip.getByTestId("board-slip-toggle").click();
    await slip.getByTestId("board-slip-view").click();
    const modal = page.getByRole("dialog", { name: "Ticket details" });
    await expect(modal).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId("board-stage-current")).toContainText("In Progress");
    await expectOnlyStageInView(page, "InProgress");

    await page.reload();
    await expect(page.getByTestId("board-stage-current")).toContainText("In Progress");
    await expectOnlyStageInView(page, "InProgress");
  });

  test("Edit, Cancel and reload lands in view mode", async ({ page, request }) => {
    await signIn(page, request, "owner");
    const created = await createTicket(page, `mobile edit flag ${Date.now()}`);
    await page.goto("/board");
    const slip = page.getByTestId(`board-ticket-${created.id}`);
    await slip.getByTestId("board-slip-toggle").click();
    await slip.getByTestId("board-slip-edit").click();
    const modal = page.getByRole("dialog", { name: "Ticket details" });
    await expect(modal.getByTestId("ticket-detail-edit-form")).toBeVisible();
    await modal.getByRole("button", { name: "Cancel" }).click();
    expect(new URL(page.url()).searchParams.get("edit")).toBeNull();
    expect(new URL(page.url()).searchParams.get("from")).toBe("board");
    await page.reload();
    await expect(page.getByTestId("ticket-detail-title")).toHaveText(created.title);
    await expect(page.getByTestId("ticket-detail-edit-form")).toHaveCount(0);
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("keeps every column and drag, with no switcher and no Move to… button", async ({ page, request }) => {
    await signIn(page, request, "owner");
    const created = await createTicket(page, `desktop board ${Date.now()}`);
    await page.goto("/board");
    await expect(page.getByTestId("board-stage-switcher")).toHaveCount(0);
    for (const stage of stages) await expect(page.getByTestId(`board-status-${stage}`)).toBeVisible();
    const slip = page.getByTestId(`board-ticket-${created.id}`);
    await expect(slip.getByTestId("board-slip-toggle")).toHaveCount(0);
    await expect(slip.getByTestId("move-to-trigger")).toHaveCount(0);
    await expect(page.getByTestId("move-to-trigger")).toHaveCount(0);
    await slip.dragTo(page.getByTestId("board-status-Ready").getByRole("heading"));
    await expect(page.getByTestId("board-status-Ready").getByTestId(`board-ticket-${created.id}`)).toBeVisible();
  });
});
