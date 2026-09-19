import { existsSync, readFileSync } from "node:fs";

/**
 * POSIX single-quote a string for safe use as one shell word. Copied from
 * `experiments/opencode-harness/src/marker.ts`'s private `shellQuote`
 * (not exported by the harness) rather than modifying that file -- see
 * the PR notes for why this and the rest of this module are local to
 * this package.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface SlowBashScriptOptions {
  /** Marker file appended to before and after sleeping (see `markerAppendCommand` in opencode-harness for the plain single-append version this extends). */
  markerFile: string;
  /** File the script writes the literal pid of the backgrounded `sleep` into, before waiting on it. */
  pidFile: string;
  /** How long to sleep, in whole seconds. */
  sleepSeconds: number;
  beforeLine?: string;
  afterLine?: string;
}

/**
 * Build a shell command for `scriptBashToolCall` (from opencode-harness)
 * that: appends a "before" line to `markerFile`, backgrounds a `sleep
 * <sleepSeconds>`, writes that backgrounded process's own pid to
 * `pidFile`, waits on it, then appends an "after" line to `markerFile`.
 *
 * This is deliberately more than `markerAppendCommand` supports: the
 * harness's helper appends exactly one line and returns, with no way to
 * observe an in-progress child process from outside the OpenCode process.
 * Backgrounding `sleep` and capturing its own pid with `$!` gives an
 * external, OS-level handle (checked with `process.kill(pid, 0)`) on the
 * actual process the "bash" tool spawns, independent of anything OpenCode
 * itself reports -- which is exactly the "observed cessation" evidence
 * `confirmStop` requires, and exactly what lets scenario 4 (process death)
 * check whether the tool's child process survives its parent.
 */
export function slowBashScript(options: SlowBashScriptOptions): string {
  const before = options.beforeLine ?? "before-sleep";
  const after = options.afterLine ?? "after-sleep";
  return [
    `echo ${shellQuote(before)} >> ${shellQuote(options.markerFile)}`,
    `sleep ${Math.trunc(options.sleepSeconds)} &`,
    "SLEEP_PID=$!",
    `echo $SLEEP_PID > ${shellQuote(options.pidFile)}`,
    "wait $SLEEP_PID",
    `echo ${shellQuote(after)} >> ${shellQuote(options.markerFile)}`,
  ].join("\n");
}

/** Read the pid written by a `slowBashScript` command, or null if the file does not exist yet. */
export function readPidFile(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const text = readFileSync(pidFile, "utf8").trim();
  if (!text) return null;
  const pid = Number.parseInt(text, 10);
  return Number.isFinite(pid) ? pid : null;
}

/**
 * Check whether `pid` currently exists, using the same `process.kill(pid,
 * 0)` / ESRCH technique `opencode-harness`'s `ManagedOpenCode.close()`
 * uses for its own orphan check (see `src/managed-opencode.ts` there).
 * Sending signal `0` delivers nothing; it only performs the existence/
 * permission check.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but we lack permission to signal it --
    // still "alive" for this purpose. Anything else is unexpected.
    if (code === "EPERM") return true;
    throw err;
  }
}
