import type { components } from "../api/generated/schema.d.ts";
import type { RunnerCredential } from "../credentials.ts";
import { callGalley, INVALID_JSON, isRecord, type GalleyRequest, type Outcome, type Timed, type TransportFailure } from "./client.ts";

export type RegisterRunnerRequest = components["schemas"]["RegisterRunnerRequest"];

export type RunnerFailure =
  | TransportFailure
  | { reason: "credential_rejected"; httpStatus: 401 }
  | { reason: "not_registered"; httpStatus: 409 }
  | { reason: "http_status"; httpStatus: number }
  | { reason: "invalid_body"; error: string };

export type RunnerResult = Timed<Outcome<string, RunnerFailure>>;

export interface RunnerRequest extends GalleyRequest {
  credential: RunnerCredential;
}

export function registerRunner(request: RunnerRequest, body: RegisterRunnerRequest): Promise<RunnerResult> {
  return runnerCall(request, "api/runner/register", JSON.stringify(body), "registeredAt");
}

export function sendHeartbeat(request: RunnerRequest): Promise<RunnerResult> {
  return runnerCall(request, "api/runner/heartbeat", undefined, "lastSeenAt");
}

async function runnerCall(request: RunnerRequest, path: string, body: string | undefined, field: "registeredAt" | "lastSeenAt"): Promise<RunnerResult> {
  const headers: Record<string, string> = { accept: "application/json", authorization: request.credential.authorizationHeader() };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return callGalley<string, RunnerFailure>(request, path, { method: "POST", headers, body }, async (response, readJson) => {
    if (response.status === 401) {
      await response.body?.cancel();
      return { ok: false, failure: { reason: "credential_rejected", httpStatus: 401 } };
    }
    if (!response.ok) {
      const payload = await readJson();
      if (response.status === 409 && isRecord(payload) && isRecord(payload["error"]) && payload["error"]["code"] === "runner_not_registered") {
        return { ok: false, failure: { reason: "not_registered", httpStatus: 409 } };
      }
      return { ok: false, failure: { reason: "http_status", httpStatus: response.status } };
    }
    const payload = await readJson();
    if (payload === INVALID_JSON) {
      return { ok: false, failure: { reason: "invalid_body", error: "response is not valid JSON" } };
    }
    const value = isRecord(payload) ? payload[field] : undefined;
    if (typeof value !== "string") {
      return { ok: false, failure: { reason: "invalid_body", error: `${field} is not a string` } };
    }
    return { ok: true, value };
  });
}
