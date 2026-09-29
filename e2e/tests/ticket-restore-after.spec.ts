import { test, expect } from "@playwright/test";
import type { Ticket } from "../support/tickets";

const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;
test.use({ storageState: STORAGE_STATE_PATH });
test.beforeAll(() => { if (!STORAGE_STATE_PATH) throw new Error("run.sh must set E2E_STORAGE_STATE_PATH"); });

test("restored Ready and Done retain status, Badge and fields after Galley restart", async ({ page }) => {
  const response = await page.request.get("/api/tickets");
  expect(response.ok()).toBe(true);
  const tickets = (await response.json() as { tickets: Ticket[] }).tickets;
  const ready = tickets.find((ticket) => ticket.title === "restore: Ready before restart");
  const done = tickets.find((ticket) => ticket.title === "restore: Done before restart");
  expect(ready?.status).toBe("Backlog");
  expect(done?.status).toBe("Done");
  expect(ready?.archivedAt).toBeNull();
  expect(done?.archivedAt).toBeNull();
  expect(ready?.goal).toBe("Preserved after restore");
  expect(ready?.badges.map((badge) => badge.name)).toEqual(["restore: Badge before restart"]);
  expect(done?.badges.map((badge) => badge.name)).toEqual(["restore: Badge before restart"]);
  await page.goto("/board");
  await expect(page.getByTestId("board-status-Backlog").getByTestId(`board-ticket-${ready!.id}`)).toBeVisible();
  await expect(page.getByTestId("board-status-Done").getByTestId(`board-ticket-${done!.id}`)).toBeVisible();
});
