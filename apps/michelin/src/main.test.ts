import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

const statusBody = {
  application: "galley",
  status: "ok",
  version: "dev",
  environment: "development",
  startedAt: "2026-09-30T10:00:00Z",
  database: { status: "ok", migrationVersion: 12 },
};

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function fakeGalley(): Promise<string> {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(statusBody));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function run(env: Record<string, string>) {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
    waiters.splice(0).forEach((wake) => wake());
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const until = async (msg: string): Promise<void> => {
    while (!lines.some((line) => line["msg"] === msg)) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { child, lines, exit, until };
}

describe("michelin process", () => {
  it("checks Galley, then exits 0 on SIGTERM", async () => {
    const galleyUrl = await fakeGalley();
    const michelin = run({ GALLEY_URL: galleyUrl, MICHELIN_STATUS_INTERVAL_MS: "60000" });

    await michelin.until("galley status ok");
    michelin.child.kill("SIGTERM");

    expect(await michelin.exit).toEqual({ code: 0, signal: null });
    expect(michelin.lines.map((line) => line["msg"])).toEqual([
      "michelin starting",
      "galley status ok",
      "michelin stopping",
      "michelin stopped",
    ]);
  }, 15_000);

  it("exits non-zero with a clear error on bad configuration", async () => {
    const michelin = run({ MICHELIN_STATUS_INTERVAL_MS: "0" });
    expect(await michelin.exit).toEqual({ code: 1, signal: null });
    expect(michelin.lines).toHaveLength(1);
    expect(michelin.lines[0]).toMatchObject({ level: "error", msg: "invalid configuration" });
  }, 15_000);
});
