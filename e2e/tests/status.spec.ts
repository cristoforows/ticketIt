import { test, expect } from "@playwright/test";

// Set by run.sh to the real, running Galley's own address -- never
// Swiftlet's origin (which only proxies /api/*) -- so this spec can ask
// Galley directly for the values it will then find in the rendered page.
const GALLEY_BASE_URL = process.env.GALLEY_BASE_URL;

test.beforeAll(() => {
  if (!GALLEY_BASE_URL) {
    throw new Error(
      "GALLEY_BASE_URL is not set. This spec compares the rendered page " +
        "against Galley's own live response and cannot do that without " +
        "reaching Galley directly -- see e2e/README.md, " +
        '"Environment variables the specs read." run.sh sets this for you.',
    );
  }
});

test("status page displays the values Galley actually returns", async ({ page, request }) => {
  // The oracle for every assertion below is Galley's real, live response --
  // fetched independently of the browser -- never a hardcoded string (see
  // issue #53: "assert browser-visible values against the backend's actual
  // response, never hardcoded strings").
  const apiResponse = await request.get(`${GALLEY_BASE_URL}/api/status`);
  expect(apiResponse.ok(), "Galley's GET /api/status must respond 200 before this spec can assert anything against it").toBeTruthy();
  const body = await apiResponse.json();

  await page.goto("/");

  await expect(page.getByTestId("status-success")).toBeVisible();

  // Swiftlet renders exactly these five fields (apps/swiftlet/README.md,
  // "What this app renders, and where from"); `database` is fetched by
  // Galley but not rendered, so it is not asserted against the DOM here.
  await expect(page.getByTestId("status-application")).toHaveText(body.application);
  await expect(page.getByTestId("status-status")).toHaveText(body.status);
  await expect(page.getByTestId("status-version")).toHaveText(body.version);
  await expect(page.getByTestId("status-environment")).toHaveText(body.environment);
  await expect(page.getByTestId("status-started-at")).toHaveText(body.startedAt);

  // Prove this ran against real, reachable PostgreSQL, not just that
  // Galley itself answered -- `database.status` is computed live on every
  // request (apps/galley/README.md, "GET /api/status").
  expect(body.database.status).toBe("ok");
});
