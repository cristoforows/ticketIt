/**
 * `./generated/schema` comes from contracts/openapi.yaml — the single
 * source of truth for Galley's HTTP API. Regenerate it with `npm run
 * generate:swiftlet` from contracts/ after editing the contract; tsc
 * then checks REQUIRED_FIELDS and the object below against the new
 * shape, so a contract change this file has not caught up with is a
 * compile error rather than a silent runtime mismatch.
 */
import type { components } from "./generated/schema";

/** The GET /api/status payload. StatusView renders these fields and no others. */
export type GalleyStatus = components["schemas"]["StatusResponse"];

const STATUS_ENDPOINT = "/api/status";

const REQUIRED_FIELDS: Array<keyof GalleyStatus> = [
  "application",
  "status",
  "version",
  "environment",
  "startedAt",
];

/**
 * Fetches Galley's status from the (proxied) `/api/status`. Throws on
 * every failure — unreachable, non-2xx, or off-contract shape — so
 * callers render an explicit error rather than a partial value.
 */
export async function fetchGalleyStatus(): Promise<GalleyStatus> {
  let response: Pick<Response, "ok" | "status" | "statusText" | "json">;

  try {
    response = await fetch(STATUS_ENDPOINT);
  } catch (cause) {
    throw new Error("Galley is unreachable.", { cause });
  }

  if (!response.ok) {
    throw new Error(
      `Galley returned an error response: ${response.status} ${response.statusText}`.trim(),
    );
  }

  const payload: unknown = await response.json();
  return parseGalleyStatus(payload);
}

function parseGalleyStatus(payload: unknown): GalleyStatus {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Galley's response body was not a JSON object.");
  }

  const record = payload as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    if (typeof record[field] !== "string") {
      throw new Error(`Galley's response was missing string field "${field}".`);
    }
  }

  return {
    application: record.application as GalleyStatus["application"],
    status: record.status as GalleyStatus["status"],
    version: record.version as GalleyStatus["version"],
    environment: record.environment as GalleyStatus["environment"],
    startedAt: record.startedAt as GalleyStatus["startedAt"],
    // Added by issue #52 (contracts/openapi.yaml's additive "database"
    // field). Not in REQUIRED_FIELDS and not rendered by StatusView --
    // out of scope per issue #52 ("You do not need to change
    // StatusView.tsx; rendering the new fields is out of scope").
    // Passed through, not validated, purely so this function's return
    // type keeps matching the generated GalleyStatus shape.
    database: record.database as GalleyStatus["database"],
  };
}
