import { defineConfig, devices } from "@playwright/test";

// Single documented place for the browser suite's target -- run.sh sets
// this to the address of the Swiftlet production build it just started
// (via `vite preview`), never a server the developer happens to already
// have running. See README.md, "Environment variables."
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests",

  // Deterministic, repeatable runs (README.md, "Determinism"): one
  // worker, strict file order, so `tests/backend-failure.spec.ts` always
  // runs after `tests/status.spec.ts` -- run.sh relies on this to know
  // exactly when it is safe to stop Galley between the two specs.
  fullyParallel: false,
  workers: 1,
  retries: 0,

  reporter: [["list"]],

  use: {
    baseURL,
    trace: "retain-on-failure",
  },

  // Chromium only -- disk space is constrained on this machine (see
  // README.md, "Tool choice and disk footprint"). Do not add the
  // firefox/webkit projects without re-reading that section.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
