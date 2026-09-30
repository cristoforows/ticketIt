export interface Config {
  galleyUrl: URL;
  statusIntervalMs: number;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULT_GALLEY_URL = "http://localhost:8080";
const DEFAULT_STATUS_INTERVAL_MS = 10_000;

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const problems: string[] = [];

  const galleyUrl = parseGalleyUrl(env["GALLEY_URL"] ?? DEFAULT_GALLEY_URL, problems);
  const statusIntervalMs = parseInterval(env["MICHELIN_STATUS_INTERVAL_MS"], problems);

  if (problems.length > 0 || galleyUrl === undefined || statusIntervalMs === undefined) {
    throw new ConfigError(problems);
  }
  return { galleyUrl, statusIntervalMs };
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

function parseInterval(raw: string | undefined, problems: string[]): number | undefined {
  if (raw === undefined) {
    return DEFAULT_STATUS_INTERVAL_MS;
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    problems.push(`MICHELIN_STATUS_INTERVAL_MS must be a positive integer, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  return value;
}
