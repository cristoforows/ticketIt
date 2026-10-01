import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

const MICHELIN_MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/michelin/src/main.ts");

export interface RunningMichelin {
  child: ChildProcess;
  output: () => string;
}

export function startMichelin(token: string, claimIntervalMs: number): RunningMichelin {
  const galleyUrl = process.env.GALLEY_BASE_URL;
  if (!galleyUrl) throw new Error("GALLEY_BASE_URL is required: run.sh points Michelin at the real Galley");
  const child = spawn(process.execPath, [MICHELIN_MAIN], {
    env: {
      PATH: process.env.PATH,
      GALLEY_URL: galleyUrl,
      MICHELIN_RUNNER_TOKEN: token,
      MICHELIN_HEARTBEAT_INTERVAL_MS: "500",
      MICHELIN_STATUS_INTERVAL_MS: "5000",
      MICHELIN_CLAIM_INTERVAL_MS: String(claimIntervalMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  return { child, output: () => output };
}

/** Pairs through the Agents page and returns the one-time credential it shows. */
export async function pairRunnerViaUI(page: Page): Promise<string> {
  await page.goto("/agents");
  const section = page.getByRole("region", { name: "Runner" });
  await expect(page.getByRole("banner").getByTestId("runner-health-pill")).toHaveAttribute("data-health", /not_paired|connected|disconnected/);

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
  return token;
}
