import { test, expect } from "@playwright/test";

// Precondition this spec depends on but does not itself arrange: by the
// time this file runs, run.sh has already stopped the real Galley process
// started for tests/status.spec.ts (see README.md, "The failure-mode
// spec"). Playwright's fixed file order plus `workers: 1`
// (playwright.config.ts) is what makes that ordering safe to rely on.
//
// This is deliberately a *real* stopped backend, not a mocked/intercepted
// route: the point is to prove the real proxy (Vite's preview-mode proxy,
// see apps/swiftlet/README.md, "Galley address configuration") and the
// real page both behave correctly when the upstream they depend on is
// genuinely gone -- something Swiftlet's own stubbed-fetch unit tests
// cannot exercise.
//
// If this spec is ever run directly against a live Galley, it is expected
// to fail -- that failure is itself the proof this suite is not one that
// always passes regardless of what it tests (see
// docs/evidence/m2/53-browser-harness.md, "Proof the suite can fail," for
// a captured red run).
test("status page shows its error state when Galley is stopped", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("status-error")).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("status-error-message")).not.toBeEmpty();

  // The success state must never render alongside or instead of the error
  // state -- a partial/guessed render would be worse than an honest error.
  await expect(page.getByTestId("status-success")).toHaveCount(0);
});
