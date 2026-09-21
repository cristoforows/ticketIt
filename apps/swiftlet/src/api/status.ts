/**
 * Types generated from contracts/openapi.yaml — the single source of
 * truth for Galley's HTTP API (see contracts/README.md). Regenerate
 * `./generated/schema.d.ts` from contracts/ (`npm run
 * generate:swiftlet`, see that README) after editing the contract;
 * this file's REQUIRED_FIELDS/destructuring below is checked by the
 * TypeScript compiler against the regenerated shape, which is how a
 * contract change that this file hasn't caught up with surfaces as a
 * compile error rather than a silent runtime mismatch.
 */
import type { components } from "./generated/schema";

/**
 * The exact GET /api/status payload shape, generated from
 * contracts/openapi.yaml. Every field here, and only these fields, is
 * rendered by StatusView; nothing additional is invented on the
 * frontend.
 */
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
 * Fetches Galley's status payload from the (proxied) `/api/status`
 * endpoint. Throws an Error in every failure case — network failure
 * (Galley unreachable), a non-2xx HTTP response, or a response that
 * does not match the documented shape — so callers can render an
 * explicit error state instead of a fabricated or partial value.
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
  };
}
