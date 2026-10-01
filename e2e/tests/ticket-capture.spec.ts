import { test, expect } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { openCapture, statusLabel, type Ticket } from "../support/tickets";

test.describe("New order capture modal", () => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 800 }]) {
    test(`an over-limit error is visible in the viewport at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openCapture(page, `capture-modal: viewport ${Date.now()}`);
      await page.getByTestId("ticket-capture-goal").fill("x".repeat(2001));
      await page.getByTestId("ticket-capture-submit").click();
      await expect(page.getByTestId("ticket-capture-error")).toBeInViewport();
      await expect(page.getByTestId("ticket-capture-submit")).toBeInViewport();
    });
  }

  test.beforeEach(async ({ page, request }) => {
    await signIn(page, request, "owner");
    await page.goto("/list");
  });

  test("the action footer ends flush with the modal at 390x844 after scrolling the form to its end", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCapture(page, `capture-modal: footer ${Date.now()}`);
    await page.getByTestId("ticket-capture-body").evaluate((body) => { body.scrollTop = body.scrollHeight; });
    const dialog = await page.getByRole("dialog").boundingBox();
    const footer = await page.getByTestId("ticket-capture-footer").boundingBox();
    expect(dialog && footer).toBeTruthy();
    expect(Math.abs(footer!.y + footer!.height - (dialog!.y + dialog!.height))).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("ticket-capture-repository")).toBeInViewport();
    await expect(page.getByTestId("ticket-capture-submit")).toBeInViewport();
  });

  test("creates a Ticket with details in one request and shows Galley's stored values", async ({ page }) => {
    const title = `capture-modal: with details ${Date.now()}`;
    await openCapture(page, title);

    await expect(page.getByTestId("ticket-title-input")).toHaveValue(title);
    await expect(page.getByTestId("ticket-title-input")).toBeFocused();
    await page.getByTestId("ticket-template-select").selectOption("Coding");
    await page.getByTestId("ticket-capture-goal").fill("  Restore sign-in on Safari  ");
    await page.getByTestId("ticket-capture-context").fill("Login page, Safari 17");
    await page.getByTestId("ticket-capture-success-criteria").fill("Existing users can sign in");
    await page.getByTestId("ticket-capture-constraints").fill("Keep the login flow");
    await page.getByTestId("ticket-capture-repository").fill("owner/repo");

    const posts: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/tickets")) posts.push(request.url()); });
    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/tickets"));
    await page.getByTestId("ticket-capture-submit").click();
    const ticket = await (await created).json() as Ticket;

    expect(posts).toHaveLength(1);
    expect(ticket.title).toBe(title);
    expect(ticket.template).toBe("Coding");
    expect(ticket.goal).toBe("Restore sign-in on Safari");
    expect(ticket.repository).toBe("owner/repo");

    await expect(page.getByTestId("ticket-capture-form")).toHaveCount(0);
    await expect(page.getByTestId("new-order-input")).toHaveValue("");
    await expect(page.getByTestId("new-order-button")).toBeFocused();
    const row = page.getByTestId(`ticket-item-${ticket.id}`);
    await expect(row.getByTestId("ticket-title")).toHaveText(ticket.title);
    await expect(row.getByTestId("ticket-status")).toHaveText(statusLabel(ticket.status));

    const stored = await (await page.request.get(`/api/tickets/${ticket.id}`)).json() as Ticket;
    await row.getByTestId("ticket-title").click();
    const detail = page.getByRole("dialog", { name: "Ticket details" });
    await expect(detail.getByTestId("ticket-detail-field-goal")).toHaveText(stored.goal);
    await expect(detail.getByTestId("ticket-detail-field-context")).toHaveText(stored.context);
    await expect(detail.getByTestId("ticket-detail-field-success-criteria")).toHaveText(stored.successCriteria);
    await expect(detail.getByTestId("ticket-detail-field-constraints")).toHaveText(stored.constraints);
    await expect(detail.getByTestId("ticket-detail-field-repository")).toHaveText(stored.repository);
  });

  test("Enter in the bar opens the modal with the typed title, and a title alone creates a Ticket", async ({ page }) => {
    const title = `capture-modal: title only ${Date.now()}`;
    await page.getByTestId("new-order-input").fill(title);
    await page.getByTestId("new-order-input").press("Enter");
    await expect(page.getByTestId("ticket-title-input")).toHaveValue(title);
    await page.getByTestId("ticket-capture-submit").click();

    const listed = await (await page.request.get("/api/tickets")).json() as { tickets: Ticket[] };
    const ticket = listed.tickets.find((item) => item.title === title);
    expect(ticket).toBeDefined();
    expect(ticket?.goal).toBe("");
    await expect(page.getByTestId(`ticket-item-${ticket!.id}`)).toBeVisible();
  });

  test("Cancel, Escape and the overlay create nothing and return focus to the bar", async ({ page }) => {
    const title = `capture-modal: cancelled ${Date.now()}`;
    const before = await (await page.request.get("/api/tickets")).json() as { tickets: Ticket[] };

    await openCapture(page, title);
    await page.getByTestId("ticket-capture-cancel").click();
    await expect(page.getByTestId("ticket-capture-form")).toHaveCount(0);
    await expect(page.getByTestId("new-order-button")).toBeFocused();

    await openCapture(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ticket-capture-form")).toHaveCount(0);
    await expect(page.getByTestId("new-order-button")).toBeFocused();

    await openCapture(page);
    await expect(page.getByTestId("ticket-title-input")).toBeFocused();
    await expect(async () => {
      await page.mouse.click(4, 4);
      await expect(page.getByTestId("ticket-capture-form")).toHaveCount(0, { timeout: 500 });
    }).toPass();
    await expect(page.getByTestId("new-order-button")).toBeFocused();

    const after = await (await page.request.get("/api/tickets")).json() as { tickets: Ticket[] };
    expect(after.tickets).toHaveLength(before.tickets.length);
    expect(after.tickets.some((item) => item.title === title)).toBe(false);
  });

  test("shows Galley's rejection verbatim and keeps the modal open with the input intact", async ({ page }) => {
    const title = `capture-modal: rejected ${Date.now()}`;
    const tooLong = "x".repeat(2001);
    const rejection = await page.request.post("/api/tickets", { data: { title, goal: tooLong } });
    expect(rejection.status()).toBe(400);
    const { error } = await rejection.json() as { error: { message: string } };

    await openCapture(page, title);
    await page.getByTestId("ticket-capture-goal").fill(tooLong);
    await page.getByTestId("ticket-capture-submit").click();

    await expect(page.getByTestId("ticket-capture-error")).toHaveText(error.message);
    await expect(page.getByTestId("ticket-capture-error")).toBeInViewport();
    await expect(page.getByTestId("ticket-title-input")).toHaveValue(title);
    await expect(page.getByTestId("ticket-capture-goal")).toHaveValue(tooLong);
    const listed = await (await page.request.get("/api/tickets")).json() as { tickets: Ticket[] };
    expect(listed.tickets.some((item) => item.title === title)).toBe(false);
  });

  test("the New order bar is absent from the Archived view", async ({ page }) => {
    await expect(page.getByTestId("new-order-bar")).toBeVisible();
    await page.getByTestId("archived-filter").check();
    await expect(page.getByTestId("new-order-bar")).toHaveCount(0);
  });
});
