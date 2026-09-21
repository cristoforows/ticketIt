import { test, expect } from "@playwright/test";
import { signIn } from "../support/sign-in";

// run.sh's own way of carrying a signed-in browser context across two
// separate `playwright test` process invocations, with a real Galley
// restart in between (README.md, "Adding a spec": "the spec cannot
// restart a process it did not start"). This file signs in and saves
// that state; session-restart-after.spec.ts reloads it once Galley is
// back up.
const STORAGE_STATE_PATH = process.env.E2E_STORAGE_STATE_PATH;

test.beforeAll(() => {
  if (!STORAGE_STATE_PATH) {
    throw new Error(
      "E2E_STORAGE_STATE_PATH is not set -- run.sh sets this for the Galley-restart phase.",
    );
  }
});

test("the Owner signs in before Galley restarts", async ({ page, request }) => {
  await signIn(page, request, "owner");
  await expect(page.getByTestId("app-shell")).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE_PATH! });
});
