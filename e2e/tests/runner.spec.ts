import { once } from "node:events";
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { pairRunnerViaUI, startMichelin } from "../support/runner";
import { createTicket } from "../support/tickets";

async function ticketSnapshot(page: Page): Promise<unknown> {
  const response = await page.request.get("/api/tickets");
  expect(response.ok()).toBe(true);
  return response.json();
}

test("a paired Michelin shows Connected, and once it stops, Runner disconnected with no Ticket changed", async ({ page, request }) => {
  await signIn(page, request, "owner");
  await createTicket(page, `Runner watch ${Date.now()}`);

  const token = await pairRunnerViaUI(page);
  const section = page.getByRole("region", { name: "Runner" });
  const headerPill = page.getByRole("banner").getByTestId("runner-health-pill");

  // Claims are tests/runner-claims.spec.ts's; this spec's Ticket snapshot must not see one.
  const michelin = startMichelin(token, 3_600_000);
  let stopped = false;
  try {
    await expect(headerPill).toHaveAttribute("data-health", "connected", { timeout: 15_000 });
    await expect(headerPill.getByRole("status")).toHaveText("Runner connected");
    await expect(section.getByTestId("runner-hostname")).not.toHaveText("");
    const before = await ticketSnapshot(page);

    michelin.child.kill("SIGTERM");
    const [code] = await once(michelin.child, "exit");
    stopped = true;
    expect(code).toBe(0);
    expect(michelin.output()).toContain("runner registered");
    expect(michelin.output()).toContain("runner heartbeat ok");
    expect(michelin.output()).not.toContain(token);

    const health = await page.request.get("/api/runner-health");
    expect((await health.json()).state).toBe("connected");

    const advanced = await page.request.post("/api/dev/clock/advance", { data: { seconds: 30 } });
    expect(advanced.status()).toBe(200);

    await expect(headerPill).toHaveAttribute("data-health", "disconnected", { timeout: 15_000 });
    await expect(headerPill.getByRole("status")).toHaveText("Runner disconnected");
    await expect(headerPill.getByTestId("runner-health-last-seen")).toHaveText(/last seen \d+ s ago$/);
    expect(await ticketSnapshot(page)).toEqual(before);

    await section.getByRole("button", { name: "Revoke" }).click();
    await section.getByRole("button", { name: "Revoke credential" }).click();
    await expect(section.getByTestId("runner-not-paired")).toContainText("The runner credential is revoked.");
    await expect(headerPill).toHaveAttribute("data-health", "not_paired");
    expect(await ticketSnapshot(page)).toEqual(before);
  } finally {
    if (!stopped) michelin.child.kill("SIGKILL");
  }
});
