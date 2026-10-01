import { readFileSync } from "node:fs";
import { resolveRunnerCredential, type RunnerCredential } from "./credentials.ts";
import { DEFAULT_ENGINE_SCRIPT, parseEngineScript, type EngineScript } from "./engineScript.ts";

export interface Config {
  galleyUrl: URL;
  statusIntervalMs: number;
  heartbeatIntervalMs: number;
  claimIntervalMs: number;
  runnerCredential: RunnerCredential;
  engineScript: EngineScript;
}

export type ReadScriptFile = (path: string) => string;

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULT_GALLEY_URL = "http://localhost:8080";
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_CLAIM_INTERVAL_MS = 5_000;

export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  readScriptFile: ReadScriptFile = (path) => readFileSync(path, "utf8"),
): Config {
  const problems: string[] = [];

  const galleyUrl = parseGalleyUrl(env["GALLEY_URL"] ?? DEFAULT_GALLEY_URL, problems);
  const statusIntervalMs = parseInterval("MICHELIN_STATUS_INTERVAL_MS", env["MICHELIN_STATUS_INTERVAL_MS"], problems);
  const heartbeatIntervalMs = parseInterval("MICHELIN_HEARTBEAT_INTERVAL_MS", env["MICHELIN_HEARTBEAT_INTERVAL_MS"], problems);
  const claimIntervalMs = parseInterval("MICHELIN_CLAIM_INTERVAL_MS", env["MICHELIN_CLAIM_INTERVAL_MS"], problems, DEFAULT_CLAIM_INTERVAL_MS);
  const runnerCredential = resolveRunnerCredential(env, problems);
  const engineScript = loadEngineScript(env["MICHELIN_ENGINE_SCRIPT"], readScriptFile, problems);

  if (
    problems.length > 0 ||
    galleyUrl === undefined ||
    statusIntervalMs === undefined ||
    heartbeatIntervalMs === undefined ||
    claimIntervalMs === undefined ||
    runnerCredential === undefined ||
    engineScript === undefined
  ) {
    throw new ConfigError(problems);
  }
  return { galleyUrl, statusIntervalMs, heartbeatIntervalMs, claimIntervalMs, runnerCredential, engineScript };
}

function parseGalleyUrl(raw: string, problems: string[]): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`GALLEY_URL must be an absolute http(s) URL, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    problems.push(`GALLEY_URL must use http or https, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
}

function parseInterval(name: string, raw: string | undefined, problems: string[], fallback = DEFAULT_INTERVAL_MS): number | undefined {
  if (raw === undefined) {
    return fallback;
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    problems.push(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  return value;
}

function loadEngineScript(path: string | undefined, read: ReadScriptFile, problems: string[]): EngineScript | undefined {
  if (path === undefined) {
    return DEFAULT_ENGINE_SCRIPT;
  }
  if (path === "") {
    problems.push("MICHELIN_ENGINE_SCRIPT must be the path of a JSON file");
    return undefined;
  }
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
    problems.push(`MICHELIN_ENGINE_SCRIPT ${JSON.stringify(path)} could not be read (${code})`);
    return undefined;
  }
  const scriptProblems: string[] = [];
  const script = parseEngineScript(text, scriptProblems);
  for (const problem of scriptProblems) {
    problems.push(`MICHELIN_ENGINE_SCRIPT ${JSON.stringify(path)}: ${problem}`);
  }
  return script;
}
