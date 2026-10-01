import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let runnerPaths: (string | undefined)[] = [];
let eventBodies: Record<string, unknown>[] = [];
let scriptDirectory: string | undefined;

const claimBody = {
  roundId: "77777777-7777-4777-8777-777777777777",
  sequence: 1,
  claimEpoch: 1,
  ticket: { id: "88888888-8888-4888-8888-888888888888", title: "Write the report", goal: "g", context: "", successCriteria: "s", constraints: "", repository: "" },
  agent: { id: "99999999-9999-4999-8999-999999999999", name: "atlas", kind: "research" },
};

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (scriptDirectory) rmSync(scriptDirectory, { recursive: true, force: true });
  scriptDirectory = undefined;
});

function scriptFile(contents: string): string {
  scriptDirectory ??= mkdtempSync(join(tmpdir(), "michelin-script-"));
  const path = join(scriptDirectory, "script.json");
  writeFileSync(path, contents);
  return path;
}

async function fakeGalley(): Promise<string> {
  authorizations = [];
  runnerPaths = [];
  eventBodies = [];
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/status") {
      res.end(JSON.stringify(statusBody));
      return;
    }
    authorizations.push(req.headers.authorization);
    runnerPaths.push(req.url);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: "unauthenticated", message: "sign-in required" } }));
      return;
    }
    if (req.url === "/api/runner/claims") {
      res.statusCode = 201;
      res.end(JSON.stringify(claimBody));
      return;
    }
    if (req.url === `/api/runner/rounds/${claimBody.roundId}/events`) {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const event = JSON.parse(body) as { type: string; data: { observationId?: string } };
        eventBodies.push(event as unknown as Record<string, unknown>);
        const notes = eventBodies.filter((recorded) => recorded["type"] === "progress").length;
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            roundId: claimBody.roundId,
            type: event.type,
            state: "running",
            startedAt: "2026-10-01T12:00:01Z",
            ...(event.type === "progress" ? { seq: notes } : {}),
            ...(event.type === "usage_observed" ? { observationId: event.data.observationId } : {}),
          }),
        );
      });
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
  it("checks Galley, registers, heartbeats, claims one Round, runs the default script to its hold, then exits 0 on SIGTERM without logging the token", async () => {
    const galleyUrl = await fakeGalley();
    const michelin = run({
      GALLEY_URL: galleyUrl,
      MICHELIN_STATUS_INTERVAL_MS: "60000",
      MICHELIN_HEARTBEAT_INTERVAL_MS: "50",
      MICHELIN_CLAIM_INTERVAL_MS: "20",
      MICHELIN_RUNNER_TOKEN: TOKEN,
    });

    await michelin.until("galley status ok");
    await michelin.until("runner heartbeat ok");
    await michelin.until("round claimed");
    await michelin.until("engine holding");
    await new Promise((resolve) => setTimeout(resolve, 200));
    michelin.child.kill("SIGTERM");

    expect(await michelin.exit).toEqual({ code: 0, signal: null });
    const messages = michelin.lines.map((line) => line["msg"]);
    expect(messages[0]).toBe("michelin starting");
    expect(messages.slice(-2)).toEqual(["michelin stopping", "michelin stopped"]);
    expect(messages).toContain("galley status ok");
    expect(messages.indexOf("runner registered")).toBeLessThan(messages.indexOf("runner heartbeat ok"));
    expect(messages.indexOf("runner registered")).toBeLessThan(messages.indexOf("round claimed"));
    expect(messages.indexOf("round claimed")).toBeLessThan(messages.indexOf("execution started reported"));
    expect(runnerPaths[0]).toBe("/api/runner/register");
    expect(runnerPaths.filter((path) => path === "/api/runner/claims")).toHaveLength(1);
    expect(eventBodies.map((body) => body["type"])).toEqual(["execution_started", "progress", "progress", "progress", "usage_observed"]);
    expect(eventBodies[0]).toMatchObject({ type: "execution_started", idempotencyKey: `${claimBody.roundId}:0`, claimEpoch: 1 });
    expect(eventBodies[1]).toMatchObject({ idempotencyKey: `${claimBody.roundId}:1`, data: { note: "Reading the Ticket" } });
    const usage = eventBodies[4] as { idempotencyKey: string; data: { observationId: string } };
    expect(usage.idempotencyKey).toBe(usage.data.observationId);
    expect(messages.filter((message) => message === "progress reported")).toHaveLength(3);
    expect(messages.indexOf("usage observation reported")).toBeLessThan(messages.indexOf("engine holding"));
    expect(michelin.lines.find((line) => line["msg"] === "round claimed")).toMatchObject({
      roundId: claimBody.roundId,
      sequence: 1,
      claimEpoch: 1,
      ticketId: claimBody.ticket.id,
      ticketTitle: claimBody.ticket.title,
    });
    expect(michelin.lines[0]).toMatchObject({ heartbeatIntervalMs: 50, claimIntervalMs: 20, michelinVersion: "0.1.0" });
    expect(authorizations.every((header) => header === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(michelin.lines)).not.toContain(TOKEN.slice(4));
  }, 15_000);

  it("runs the script MICHELIN_ENGINE_SCRIPT names: a finite script ends and claiming resumes", async () => {
    const galleyUrl = await fakeGalley();
    const michelin = run({
      GALLEY_URL: galleyUrl,
      MICHELIN_STATUS_INTERVAL_MS: "60000",
      MICHELIN_HEARTBEAT_INTERVAL_MS: "50",
      MICHELIN_CLAIM_INTERVAL_MS: "20",
      MICHELIN_RUNNER_TOKEN: TOKEN,
      MICHELIN_ENGINE_SCRIPT: scriptFile('{"steps":[{"step":"start"},{"step":"wait","ms":30}]}'),
    });

    await michelin.until("engine script finished");
    await new Promise((resolve) => setTimeout(resolve, 300));
    michelin.child.kill("SIGTERM");

    expect(await michelin.exit).toEqual({ code: 0, signal: null });
    expect(runnerPaths.filter((path) => path === "/api/runner/claims").length).toBeGreaterThanOrEqual(2);
    expect(eventBodies.length).toBeGreaterThanOrEqual(2);
    expect(new Set(eventBodies.map((body) => (body["data"] as { engineReference: string }).engineReference)).size).toBe(eventBodies.length);
    expect(michelin.lines.map((line) => line["msg"])).not.toContain("engine holding");
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

  it("exits 1 naming the step when MICHELIN_ENGINE_SCRIPT holds an invalid script", async () => {
    const michelin = run({
      MICHELIN_RUNNER_TOKEN: TOKEN,
      MICHELIN_ENGINE_SCRIPT: scriptFile('{"steps":[{"step":"start"},{"step":"wait","ms":0},{"step":"deliver"}]}'),
    });
    expect(await michelin.exit).toEqual({ code: 1, signal: null });
    expect(michelin.lines).toHaveLength(1);
    expect(michelin.lines[0]).toMatchObject({ level: "error", msg: "invalid configuration" });
    const problems = michelin.lines[0]?.["problems"] as string[];
    expect(problems.some((problem) => problem.includes("MICHELIN_ENGINE_SCRIPT") && problem.includes("steps[1]"))).toBe(true);
    expect(problems.some((problem) => problem.includes("steps[2]") && problem.includes("deliver") && problem.includes("M4.10"))).toBe(true);
    expect(JSON.stringify(michelin.lines)).not.toContain(TOKEN.slice(4));
  }, 15_000);

  it("exits 1 when MICHELIN_ENGINE_SCRIPT names a file that does not exist", async () => {
    const michelin = run({ MICHELIN_RUNNER_TOKEN: TOKEN, MICHELIN_ENGINE_SCRIPT: join(tmpdir(), "michelin-no-such-script.json") });
    expect(await michelin.exit).toEqual({ code: 1, signal: null });
    expect(michelin.lines).toHaveLength(1);
    expect(String((michelin.lines[0]?.["problems"] as string[])[0])).toMatch(/^MICHELIN_ENGINE_SCRIPT .*could not be read \(ENOENT\)/);
  }, 15_000);

  it("exits 1 naming MICHELIN_RUNNER_TOKEN when it is missing", async () => {
    const michelin = run({ MICHELIN_RUNNER_TOKEN: "" });
    expect(await michelin.exit).toEqual({ code: 1, signal: null });
    expect(michelin.lines).toHaveLength(1);
    expect(michelin.lines[0]).toMatchObject({ level: "error", msg: "invalid configuration" });
    expect(String((michelin.lines[0]?.["problems"] as string[])[0])).toContain("MICHELIN_RUNNER_TOKEN is required");
  }, 15_000);
});
