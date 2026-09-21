import { test, expect } from "@playwright/test";
import { setFakeIdentity, signIn } from "../support/sign-in";

// Owner login the substitute provider's default identity reports
// (apps/galley/internal/githubfake.TestOwnerIdentity.Login) -- run.sh
// sets GALLEY_OWNER_GITHUB_LOGIN to this same value, so a fresh sign-in
// against the empty e2e database bootstraps this identity as the Owner.
const OWNER_LOGIN = "ticketit-test-owner";

test.describe("sign-in", () => {
  test("the Owner can sign in with GitHub and sees the authenticated shell", async ({ page, request }) => {
    await signIn(page, request, "owner");

    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("signed-in-owner")).toContainText(OWNER_LOGIN);
    await expect(page.getByTestId("sign-in-page")).toHaveCount(0);
  });

  test("the session survives a page reload", async ({ page, request }) => {
    await signIn(page, request, "owner");
    await expect(page.getByTestId("app-shell")).toBeVisible();

    await page.reload();

    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("signed-in-owner")).toContainText(OWNER_LOGIN);
  });

  test("sign-out revokes the session through Galley and returns to the sign-in page", async ({ page, request }) => {
    await signIn(page, request, "owner");
    await expect(page.getByTestId("app-shell")).toBeVisible();

    await page.getByTestId("sign-out-button").click();

    await expect(page.getByTestId("sign-in-page")).toBeVisible();
    await expect(page.getByTestId("app-shell")).toHaveCount(0);

    // Prove the session was actually revoked through Galley, not just
    // that the UI stopped showing it (Swiftlet renders what Galley
    // returns; it never decides this itself -- ADR 0001).
    const sessionResponse = await page.context().request.get("/api/session");
    expect(sessionResponse.status()).toBe(401);
  });

  test("a non-owner identity is rejected with Galley's own reason, and no authenticated shell renders", async ({
    page,
    request,
  }) => {
    await setFakeIdentity(request, "non-owner");
    await page.goto("/");
    await page.getByTestId("sign-in-with-github").click();
    await page.waitForLoadState("load");

    // Galley returns its owner_mismatch error body directly on this
    // navigation (contracts/openapi.yaml's /api/auth/github/callback,
    // "default" response) -- Swiftlet never intercepts or rewrites it,
    // so the exact code and message Galley produced must be the ones
    // visible on the page, not a friendlier substitute.
    const body = await page.textContent("body");
    expect(body).toContain("owner_mismatch");
    expect(body).toContain("this GitHub account is not the configured owner");

    await expect(page.getByTestId("app-shell")).toHaveCount(0);
    await expect(page.getByTestId("signed-in-owner")).toHaveCount(0);
  });
});
