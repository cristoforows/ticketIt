import { test, expect, type Page, type Route } from "@playwright/test";
import { signIn } from "../support/sign-in";

// Intercepted rather than failed inside Galley:
// docs/evidence/m2/80-statusview-browser-error.md.
const isStatusRequest = (url: URL) => url.pathname === "/api/status";
const isSessionResponse = (url: string) => new URL(url).pathname === "/api/session";

async function reloadSignedInWithFailingStatus(page: Page, fail: (route: Route) => Promise<void>) {
  await page.route(isStatusRequest, fail);
  const sessionResponse = page.waitForResponse((response) => isSessionResponse(response.url()));
  await page.reload();
  expect((await sessionResponse).status()).toBe(200);
}

async function expectStatusErrorInsideShell(page: Page, messageFragment: string) {
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("status-error")).toBeVisible();
  await expect(page.getByTestId("status-error-message")).toContainText(messageFragment);
  await expect(page.getByTestId("session-error")).toHaveCount(0);
  await expect(page.getByTestId("status-success")).toHaveCount(0);
}

test.describe("StatusView inside the signed-in shell", () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, request, "owner");
    await expect(page.getByTestId("status-success")).toBeVisible();
  });

  test("shows its error state when GET /api/status returns non-2xx", async ({ page }) => {
    await reloadSignedInWithFailingStatus(page, (route) => route.fulfill({ status: 503 }));

    await expectStatusErrorInsideShell(page, "503");
  });

  test("shows its error state when GET /api/status fails at the network level", async ({ page }) => {
    await reloadSignedInWithFailingStatus(page, (route) => route.abort("connectionrefused"));

    await expectStatusErrorInsideShell(page, "unreachable");
  });
});
