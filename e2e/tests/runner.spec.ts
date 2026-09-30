import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { createTicket } from "../support/tickets";

const MICHELIN_MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/michelin/src/main.ts");

async function ticketSnapshot(page: Page): Promise<unknown> {
  const response = await page.request.get("/api/tickets");
  expect(response.ok()).toBe(true);
  return response.json();
}

function startMichelin(token: string): { child: ChildProcess; output: () => string } {
  const galleyUrl = process.env.GALLEY_BASE_URL;
  if (!galleyUrl) throw new Error("GALLEY_BASE_URL is required: run.sh points Michelin at the real Galley");
  const child = spawn(process.execPath, [MICHELIN_MAIN], {
    env: {
      PATH: process.env.PATH,
      GALLEY_URL: galleyUrl,
      MICHELIN_RUNNER_TOKEN: token,
      MICHELIN_HEARTBEAT_INTERVAL_MS: "500",
      MICHELIN_STATUS_INTERVAL_MS: "5000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  return { child, output: () => output };
}

test("a paired Michelin shows Connected, and once it stops, Runner disconnected with no Ticket changed", async ({ page, request }) => {
  await signIn(page, request, "owner");
  await createTicket(page, `Runner watch ${Date.now()}`);

  await page.goto("/agents");
  const section = page.getByRole("region", { name: "Runner" });
  const headerPill = page.getByRole("banner").getByTestId("runner-health-pill");
  await expect(headerPill).toHaveAttribute("data-health", /not_paired|connected|disconnected/);

  const repair = section.getByRole("button", { name: "Pair again" });
  const [paired] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/runner-credential") && r.request().method() === "POST"),
    (async () => {
      if (await repair.isVisible()) {
        await repair.click();
        await section.getByRole("button", { name: "Pair new runner" }).click();
      } else {
        await section.getByRole("button", { name: "Pair runner" }).click();
      }
    })(),
  ]);
  expect(paired.status()).toBe(201);
  const token = await section.getByLabel("Runner credential").inputValue();
  expect(token).toMatch(/^tir_[A-Za-z0-9_-]{43}$/);
  await section.getByRole("button", { name: "Done" }).click();
  await expect(section.getByLabel("Runner credential")).toHaveCount(0);

  const michelin = startMichelin(token);
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
