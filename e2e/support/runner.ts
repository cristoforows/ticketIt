import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

const MICHELIN_MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/michelin/src/main.ts");

export interface RunningMichelin {
  child: ChildProcess;
  output: () => string;
}

export interface UsageScriptStep {
  step: "usage";
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  activeMs: number | null;
  basis: "reported" | "estimated";
  providerGenerationId: string | null;
}

export interface DeliverScriptStep {
  step: "deliver";
  bodyMarkdown: string;
  summary: string;
  criteriaAssessment: string;
}

export type EngineScriptStep = { step: "start" } | { step: "wait"; ms: number } | { step: "progress"; note: string } | UsageScriptStep | DeliverScriptStep | { step: "hold" };

function writeEngineScript(steps: EngineScriptStep[]): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "michelin-e2e-")), "script.json");
  writeFileSync(file, JSON.stringify({ steps }));
  return file;
}

export function startMichelin(token: string, claimIntervalMs: number, engineScript?: EngineScriptStep[]): RunningMichelin {
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
      ...(engineScript ? { MICHELIN_ENGINE_SCRIPT: writeEngineScript(engineScript) } : {}),
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

/** Pairs through Galley's API with a signed-in context and returns the one-time credential. */
export async function pairRunnerViaApi(api: APIRequestContext): Promise<string> {
  const response = await api.post("/api/runner-credential");
  expect(response.status()).toBe(201);
  const { token } = await response.json() as { token: string };
  expect(token).toMatch(/^tir_[A-Za-z0-9_-]{43}$/);
  return token;
}

export interface RunnerClaim {
  roundId: string;
  sequence: number;
  claimEpoch: number;
  ticket: { id: string; title: string };
  agent: { id: string; name: string; kind: string };
}

export interface RunnerCommand {
  id: string;
  type: string;
  claimEpoch: number;
  issuedAt: string;
}

/**
 * The runner's own calls, made directly with the credential. `runner` must be a
 * context with no Owner session cookie: Galley refuses a cookie beside a bearer.
 */
export function runnerCalls(runner: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  return {
    async register(): Promise<void> {
      const response = await runner.post("/api/runner/register", { headers, data: { michelinVersion: "e2e-direct", hostname: "e2e-direct" } });
      expect(response.status()).toBe(200);
    },
    async claim(): Promise<RunnerClaim> {
      const response = await runner.post("/api/runner/claims", { headers });
      expect(response.status()).toBe(201);
      return response.json();
    },
    async claimStatus(): Promise<number> {
      return (await runner.post("/api/runner/claims", { headers })).status();
    },
    async commands(roundId: string): Promise<RunnerCommand[]> {
      const response = await runner.get(`/api/runner/rounds/${roundId}/commands`, { headers });
      expect(response.status()).toBe(200);
      return (await response.json() as { commands: RunnerCommand[] }).commands;
    },
    async ack(roundId: string, commandId: string, outcome: "applied" | "ignored"): Promise<{ status: number; body: unknown }> {
      const response = await runner.post(`/api/runner/rounds/${roundId}/commands/${commandId}/ack`, { headers, data: { outcome } });
      return { status: response.status(), body: await response.json() };
    },
  };
}
