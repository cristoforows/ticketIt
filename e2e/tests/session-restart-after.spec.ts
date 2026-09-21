import { test, expect } from "@playwright/test";

// Loads the browser storage state session-restart-before.spec.ts saved,
// into a fresh browser context -- proving the session token itself
// (persisted in PostgreSQL, not anything held in Galley's process
// memory) is what survives run.sh's real Galley restart in between,
// exactly as apps/galley/README.md's own restart-durability test proves
// at the API level, but through a real browser this time.
const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;

test.use({ storageState: STORAGE_STATE_PATH });

test.beforeAll(() => {
  if (!STORAGE_STATE_PATH) {
    throw new Error(
      "E2E_STORAGE_STATE_PATH is not set -- run.sh sets this for the Galley-restart phase.",
    );
  }
});

test("the session survives a Galley restart", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("signed-in-owner")).toContainText("ticketit-test-owner");
});
