import { test, expect, type Locator, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { changeTicketStatusDirect, createTicket, reorderTicketDirect, type Ticket } from "../support/tickets";

async function apiReadyOrder(page: Page, ids: string[]): Promise<string[]> {
  const response = await page.request.get("/api/tickets");
  expect(response.ok()).toBe(true);
  const { tickets } = await response.json() as { tickets: Ticket[] };
  return tickets.filter((ticket) => ticket.status === "Ready" && ids.includes(ticket.id)).map((ticket) => ticket.id);
}

async function renderedOrder(rows: Locator, prefix: string, ids: string[]): Promise<string[]> {
  const testIds = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid") ?? ""));
  return testIds.map((testId) => testId.slice(prefix.length)).filter((id) => ids.includes(id));
}

function boardOrder(page: Page, ids: string[]): Promise<string[]> {
  return renderedOrder(page.getByTestId("board-status-Ready").locator('[data-testid^="board-ticket-"]'), "board-ticket-", ids);
}

function listOrder(page: Page, ids: string[]): Promise<string[]> {
  return renderedOrder(page.getByTestId("ticket-list-items").locator('[data-testid^="ticket-item-"]'), "ticket-item-", ids);
}

async function dragOntoSlip(page: Page, source: Locator, target: Locator, half: "upper" | "lower") {
  await target.scrollIntoViewIfNeeded();
  await expect(source).toBeInViewport();
  await source.hover();
  await page.mouse.down();
  const start = await source.boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2 + 8);
  const box = await target.boundingBox();
  const y = half === "upper" ? box!.y + box!.height / 4 : box!.y + (box!.height * 3) / 4;
  await page.mouse.move(box!.x + box!.width / 2, y, { steps: 5 });
  await page.mouse.up();
}

function positionCommand(page: Page, id: string) {
  return page.waitForResponse((response) => response.url().endsWith(`/api/tickets/${id}/position`) && response.request().method() === "POST");
}

test("reorder a Ready stage by drag on the board and Move up/down in the list; the order persists and matches Galley", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const stamp = Date.now();
  const [a, b, c] = [
    await createTicket(page, `priority A ${stamp}`),
    await createTicket(page, `priority B ${stamp}`),
    await createTicket(page, `priority C ${stamp}`),
  ];
  const ids = [a.id, b.id, c.id];
  for (const id of ids) expect((await changeTicketStatusDirect(page, id, "Ready")).ok).toBe(true);
  expect(await apiReadyOrder(page, ids)).toEqual([a.id, b.id, c.id]);

  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/board");
  const ready = page.getByTestId("board-status-Ready");
  await expect.poll(() => boardOrder(page, ids)).toEqual([a.id, b.id, c.id]);

  const [aboveA] = await Promise.all([
    positionCommand(page, c.id),
    dragOntoSlip(page, ready.getByTestId(`board-ticket-${c.id}`), ready.getByTestId(`board-ticket-${a.id}`), "upper"),
  ]);
  expect(aboveA.status()).toBe(200);
  expect(aboveA.request().postDataJSON()).toEqual({ before: a.id });
  await expect.poll(() => boardOrder(page, ids)).toEqual([c.id, a.id, b.id]);
  expect(await apiReadyOrder(page, ids)).toEqual([c.id, a.id, b.id]);

  const [belowB] = await Promise.all([
    positionCommand(page, c.id),
    dragOntoSlip(page, ready.getByTestId(`board-ticket-${c.id}`), ready.getByTestId(`board-ticket-${b.id}`), "lower"),
  ]);
  expect(belowB.request().postDataJSON()).toEqual({ after: b.id });
  await expect.poll(() => boardOrder(page, ids)).toEqual([a.id, b.id, c.id]);
  expect(await apiReadyOrder(page, ids)).toEqual([a.id, b.id, c.id]);

  await page.goto("/");
  await expect.poll(() => listOrder(page, ids)).toEqual([a.id, b.id, c.id]);
  const rowC = page.getByTestId(`ticket-item-${c.id}`);
  const [upC] = await Promise.all([positionCommand(page, c.id), rowC.getByTestId("ticket-reorder-up").click()]);
  expect(upC.request().postDataJSON()).toEqual({ before: b.id });
  await expect.poll(() => listOrder(page, ids)).toEqual([a.id, c.id, b.id]);
  await expect(rowC.getByTestId("ticket-reorder-up")).toBeFocused();

  const rowA = page.getByTestId(`ticket-item-${a.id}`);
  const [downA] = await Promise.all([positionCommand(page, a.id), rowA.getByTestId("ticket-reorder-down").click()]);
  expect(downA.request().postDataJSON()).toEqual({ after: c.id });
  await expect.poll(() => listOrder(page, ids)).toEqual([c.id, a.id, b.id]);

  const persisted = await apiReadyOrder(page, ids);
  expect(persisted).toEqual([c.id, a.id, b.id]);
  await page.reload();
  await expect.poll(() => listOrder(page, ids)).toEqual(persisted);
  await page.goto("/board");
  await expect.poll(() => boardOrder(page, ids)).toEqual(persisted);
});

test("a stale Move up shows Galley's anchor rejection verbatim and the order stays put", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const stamp = Date.now();
  const first = await createTicket(page, `priority reject first ${stamp}`);
  const second = await createTicket(page, `priority reject second ${stamp}`);
  const ids = [first.id, second.id];
  for (const id of ids) expect((await changeTicketStatusDirect(page, id, "Ready")).ok).toBe(true);
  await page.goto("/");
  await expect.poll(() => listOrder(page, ids)).toEqual([first.id, second.id]);

  expect((await changeTicketStatusDirect(page, first.id, "Backlog")).ok).toBe(true);
  const live = await reorderTicketDirect(page, second.id, { before: first.id });
  expect(live.errorCode).toBe("reorder_anchor_invalid");

  const [rejected] = await Promise.all([
    positionCommand(page, second.id),
    page.getByTestId(`ticket-item-${second.id}`).getByTestId("ticket-reorder-up").click(),
  ]);
  expect(rejected.status()).toBe(400);
  await expect(page.getByTestId("ticket-list-reorder-error")).toContainText(live.errorMessage!);
  await expect(page.getByTestId(`ticket-item-${first.id}`).getByTestId("ticket-status")).toHaveText("Backlog");
  expect((await changeTicketStatusDirect(page, first.id, "Ready")).ok).toBe(true);
  await page.reload();
  await expect.poll(() => listOrder(page, ids)).toEqual([second.id, first.id]);
  expect(await apiReadyOrder(page, ids)).toEqual([second.id, first.id]);
});
