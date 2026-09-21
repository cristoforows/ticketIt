import type { APIRequestContext, Page } from "@playwright/test";

// Set by run.sh to the real, running substitute GitHub provider's own
// address (apps/galley/cmd/githubfake) -- never Swiftlet's or Galley's
// origin. Signing in against this fixture, never github.com, is the one
// hard rule every spec using this helper relies on (see README.md,
// "Signing in").
const GITHUBFAKE_BASE_URL = process.env.E2E_GITHUBFAKE_BASE_URL;

function requireGithubFakeBaseURL(): string {
  if (!GITHUBFAKE_BASE_URL) {
    throw new Error(
      "E2E_GITHUBFAKE_BASE_URL is not set. Signing in needs the substitute " +
        'GitHub provider\'s own address -- see e2e/README.md, "Signing in." ' +
        "run.sh sets this for you.",
    );
  }
  return GITHUBFAKE_BASE_URL;
}

export type FakeIdentityPreset = "owner" | "non-owner";

/**
 * Selects which fixture identity the substitute provider's `/user`
 * endpoint reports for the next completed OAuth exchange.
 * e2e/run.sh runs one fake-provider process for the whole suite, so a
 * spec needing a different identity from whatever the previous spec
 * left behind (e.g. non-owner rejection, run after an owner sign-in)
 * selects it explicitly rather than assuming a default.
 */
export async function setFakeIdentity(
  request: APIRequestContext,
  preset: FakeIdentityPreset,
): Promise<void> {
  const response = await request.post(`${requireGithubFakeBaseURL()}/_fake/identity`, {
    data: { preset },
  });
  if (!response.ok()) {
    throw new Error(
      `failed to set the fake provider's identity to preset ${JSON.stringify(preset)}: ${response.status()}`,
    );
  }
}

/**
 * Drives the real "Sign in with GitHub" UI action through the
 * substitute provider to completion, exactly as a browser would --
 * navigates to the sign-in page, clicks its one action, and follows
 * every redirect (Swiftlet -> Galley -> the fake provider -> Galley ->
 * back to Swiftlet). Does not itself assert an outcome: a rejected
 * (non-owner) identity ends this same navigation on Galley's own error
 * response rather than the signed-in shell, and callers assert whichever
 * they expect. Later specs that need to start already signed in should
 * call this once per test rather than repeating the OAuth dance.
 */
export async function signIn(
  page: Page,
  request: APIRequestContext,
  preset: FakeIdentityPreset = "owner",
): Promise<void> {
  await setFakeIdentity(request, preset);
  await page.goto("/");
  await page.getByTestId("sign-in-with-github").click();
  await page.waitForLoadState("load");
}
