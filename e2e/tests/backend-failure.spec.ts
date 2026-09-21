import { test, expect } from "@playwright/test";

// Precondition this spec depends on but does not itself arrange: by the
// time this file runs, run.sh has already stopped Galley for good (see
// README.md, "The failure-mode spec") -- run.sh invokes each spec file
// as its own `playwright test` process in the exact order it needs,
// which is what makes that ordering safe to rely on.
//
// This is deliberately a *real* stopped backend, not a mocked/intercepted
// route: the point is to prove the real proxy (Vite's preview-mode proxy,
// see apps/swiftlet/README.md, "Galley address configuration") and the
// real page both behave correctly when the upstream they depend on is
// genuinely gone -- something Swiftlet's own stubbed-fetch unit tests
// cannot exercise.
//
// Since issue #55, the page's very first call is GET /api/session, not
// GET /api/status -- with Galley entirely down, that call itself fails
// (an unreachable-backend error, not a 401), so the app never gets far
// enough to attempt sign-in or render StatusView at all. The explicit
// error state this spec now asserts is App.tsx's own "session-error"
// state, not StatusView's "status-error".
//
// If this spec is ever run directly against a live Galley, it is expected
// to fail -- that failure is itself the proof this suite is not one that
// always passes regardless of what it tests (see
// docs/evidence/m2/53-browser-harness.md, "Proof the suite can fail," for
// a captured red run).
test("the app shows its error state when Galley is stopped, instead of a blank or fabricated page", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("session-error")).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("session-error-message")).not.toBeEmpty();

  // Neither the sign-in page nor the authenticated shell -- a partial or
  // guessed render would be worse than an honest error, and this app has
  // no basis to decide either way while it cannot reach Galley at all.
  await expect(page.getByTestId("sign-in-page")).toHaveCount(0);
  await expect(page.getByTestId("app-shell")).toHaveCount(0);
});
