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

const TOKEN = `tir_${"c".repeat(43)}`;

let server: Server | undefined;
let authorizations: (string | undefined)[] = [];

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function fakeGalley(): Promise<string> {
  authorizations = [];
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/status") {
      res.end(JSON.stringify(statusBody));
      return;
    }
    authorizations.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: "unauthenticated", message: "sign-in required" } }));
      return;
    }
    res.end(JSON.stringify(req.url === "/api/runner/register" ? { registeredAt: "2026-10-01T12:00:00Z" } : { lastSeenAt: "2026-10-01T12:00:10Z" }));
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
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
      waiters.splice(0).forEach((wake) => wake());
    }),
  );
  const until = async (msg: string): Promise<void> => {
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    void exit.then((result) => (exited = result));
    while (!lines.some((line) => line["msg"] === msg)) {
      if (exited !== undefined) {
        throw new Error(
          `michelin exited (code ${exited.code}, signal ${exited.signal}) before logging ${JSON.stringify(msg)}\nstdout: ${JSON.stringify(lines)}\nstderr: ${stderr}`,
        );
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { child, lines, exit, until };
}

describe("michelin process", () => {
  it("checks Galley, registers, heartbeats, then exits 0 on SIGTERM without logging the token", async () => {
    const galleyUrl = await fakeGalley();
    const michelin = run({
      GALLEY_URL: galleyUrl,
      MICHELIN_STATUS_INTERVAL_MS: "60000",
      MICHELIN_HEARTBEAT_INTERVAL_MS: "50",
      MICHELIN_RUNNER_TOKEN: TOKEN,
    });

    await michelin.until("galley status ok");
    await michelin.until("runner heartbeat ok");
    michelin.child.kill("SIGTERM");

    expect(await michelin.exit).toEqual({ code: 0, signal: null });
    const messages = michelin.lines.map((line) => line["msg"]);
    expect(messages[0]).toBe("michelin starting");
    expect(messages.slice(-2)).toEqual(["michelin stopping", "michelin stopped"]);
    expect(messages).toContain("galley status ok");
    expect(messages.indexOf("runner registered")).toBeLessThan(messages.indexOf("runner heartbeat ok"));
    expect(michelin.lines[0]).toMatchObject({ heartbeatIntervalMs: 50, michelinVersion: "0.1.0" });
    expect(authorizations.every((header) => header === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(michelin.lines)).not.toContain(TOKEN.slice(4));
  }, 15_000);

  it("keeps running and logs a rejected credential without echoing it", async () => {
    const galleyUrl = await fakeGalley();
    const wrong = `tir_${"d".repeat(43)}`;
    const michelin = run({ GALLEY_URL: galleyUrl, MICHELIN_STATUS_INTERVAL_MS: "60000", MICHELIN_HEARTBEAT_INTERVAL_MS: "50", MICHELIN_RUNNER_TOKEN: wrong });

    await michelin.until("runner credential rejected");
    michelin.child.kill("SIGTERM");

    expect(await michelin.exit).toEqual({ code: 0, signal: null });
    expect(JSON.stringify(michelin.lines)).not.toContain(wrong.slice(4));
  }, 15_000);

  it("exits non-zero with a clear error on bad configuration", async () => {
    const michelin = run({ MICHELIN_STATUS_INTERVAL_MS: "0", MICHELIN_RUNNER_TOKEN: TOKEN });
    expect(await michelin.exit).toEqual({ code: 1, signal: null });
    expect(michelin.lines).toHaveLength(1);
    expect(michelin.lines[0]).toMatchObject({ level: "error", msg: "invalid configuration" });
  }, 15_000);

  it("exits 1 naming MICHELIN_RUNNER_TOKEN when it is missing", async () => {
    const michelin = run({ MICHELIN_RUNNER_TOKEN: "" });
    expect(await michelin.exit).toEqual({ code: 1, signal: null });
    expect(michelin.lines).toHaveLength(1);
    expect(michelin.lines[0]).toMatchObject({ level: "error", msg: "invalid configuration" });
    expect(String((michelin.lines[0]?.["problems"] as string[])[0])).toContain("MICHELIN_RUNNER_TOKEN is required");
  }, 15_000);
});
