import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spawns `src/process-a.ts` / `src/process-b.ts` as genuinely separate OS
 * processes (not in-process function calls) via `child_process.spawn`, per
 * this issue's requirement that the durable-question proof cross a real
 * process boundary. Both scripts run under the same `tsx` loader this
 * package's own `npm test` uses, so behavior matches a direct
 * `node --import tsx src/process-a.ts ...` invocation exactly.
 */

const helpersDir = dirname(fileURLToPath(import.meta.url));
/** experiments/native-durable-input (two levels up from test/helpers). */
export const packageRoot = join(helpersDir, "..", "..");

export type ProcessName = "process-a" | "process-b";

function scriptPath(name: ProcessName): string {
  return join(packageRoot, "src", `${name}.ts`);
}

function spawnProcess(name: ProcessName, args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn("node", ["--import", "tsx", scriptPath(name), ...args], {
    cwd: packageRoot,
    env: process.env,
  });
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The last non-empty stdout line, parsed as JSON (the script's result line). */
  readonly json: unknown;
}

/**
 * Runs `process-a.ts` or `process-b.ts` to completion (used for every
 * scenario except the process-death kill itself) and parses its final
 * stdout JSON line.
 */
export function runToCompletion(name: ProcessName, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(name, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
      const lastLine = lines[lines.length - 1];
      let json: unknown;
      try {
        json = lastLine !== undefined ? JSON.parse(lastLine) : undefined;
      } catch {
        json = undefined;
      }
      resolve({ exitCode, signal, stdout, stderr, json });
    });
  });
}

export interface SpawnedForKill {
  readonly child: ChildProcessWithoutNullStreams;
  /** The first stdout line matching `predicate`, parsed as JSON. */
  readonly json: unknown;
}

/**
 * Spawns a process and resolves as soon as a stdout line satisfies
 * `predicate`, WITHOUT waiting for exit -- the caller owns the returned
 * `child` (used by the process-death scenario to SIGKILL Process A while it
 * is still genuinely blocked inside its tool call, never after it exits on
 * its own).
 */
export function spawnUntilLine(
  name: ProcessName,
  args: readonly string[],
  predicate: (line: string) => boolean,
): Promise<SpawnedForKill> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(name, args);
    let buffer = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!settled && predicate(line)) {
          settled = true;
          let json: unknown;
          try {
            json = JSON.parse(line);
          } catch {
            json = undefined;
          }
          resolve({ child, json });
          return;
        }
      }
    });
    child.on("error", (error) => {
      if (!settled) reject(error);
    });
    child.on("exit", (code, signal) => {
      if (!settled) {
        reject(new Error(`process-a exited (code=${code}, signal=${signal}) before printing the expected line`));
      }
    });
  });
}
