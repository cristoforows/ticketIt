import type { components } from "../api/generated/schema.d.ts";
import type { RunnerCredential } from "../credentials.ts";
import { callGalley, INVALID_JSON, isRecord, type GalleyRequest, type Outcome, type Timed, type TransportFailure } from "./client.ts";

export type RegisterRunnerRequest = components["schemas"]["RegisterRunnerRequest"];
export type RunnerClaim = components["schemas"]["RunnerClaim"];
export type RoundEventRequest = components["schemas"]["RoundEventRequest"];
export type RoundEventResult = components["schemas"]["RoundEventResult"];

export type RunnerFailure =
  | TransportFailure
  | { reason: "credential_rejected"; httpStatus: 401 }
  | { reason: "not_registered"; httpStatus: 409 }
  | { reason: "http_status"; httpStatus: number }
  | { reason: "invalid_body"; error: string };

export type RunnerResult = Timed<Outcome<string, RunnerFailure>>;

export type ClaimFailure = Exclude<RunnerFailure, { reason: "not_registered" }>;

export type ClaimResult = Timed<Outcome<RunnerClaim | null, ClaimFailure>>;

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

export function claimWork(request: RunnerRequest): Promise<ClaimResult> {
  const headers = { accept: "application/json", authorization: request.credential.authorizationHeader() };
  return callGalley<RunnerClaim | null, ClaimFailure>(request, "api/runner/claims", { method: "POST", headers }, async (response, readJson) => {
    if (response.status === 204) {
      await response.body?.cancel();
      return { ok: true, value: null };
    }
    if (response.status === 401) {
      await response.body?.cancel();
      return { ok: false, failure: { reason: "credential_rejected", httpStatus: 401 } };
    }
    if (response.status !== 201) {
      await response.body?.cancel();
      return { ok: false, failure: { reason: "http_status", httpStatus: response.status } };
    }
    const payload = await readJson();
    if (payload === INVALID_JSON) {
      return { ok: false, failure: { reason: "invalid_body", error: "response is not valid JSON" } };
    }
    const claim = parseClaim(payload);
    return typeof claim === "string" ? { ok: false, failure: { reason: "invalid_body", error: claim } } : { ok: true, value: claim };
  });
}

function parseClaim(payload: unknown): RunnerClaim | string {
  if (!isRecord(payload)) {
    return "body is not a JSON object";
  }
  const { roundId, sequence, claimEpoch, ticket, agent } = payload;
  if (typeof roundId !== "string") {
    return "roundId is not a string";
  }
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(claimEpoch)) {
    return "sequence or claimEpoch is not an integer";
  }
  if (!isRecord(ticket) || !["id", "title", "goal", "context", "successCriteria", "constraints", "repository"].every((field) => typeof ticket[field] === "string")) {
    return "ticket is not a claimed Ticket";
  }
  if (!isRecord(agent) || typeof agent["id"] !== "string" || typeof agent["name"] !== "string" || typeof agent["kind"] !== "string") {
    return "agent is not an Agent";
  }
  return payload as RunnerClaim;
}

export type RoundEventFailure =
  | TransportFailure
  | { reason: "http_status"; httpStatus: number; errorCode?: string }
  | { reason: "invalid_body"; error: string };

export type RoundEventOutcome = { result: RoundEventResult; replayed: boolean };

export type RoundEventReport = Timed<Outcome<RoundEventOutcome, RoundEventFailure>>;

export interface RoundEventExpectation {
  type: RoundEventRequest["type"];
  observationId?: string;
}

// The body arrives serialised so every retry of one event sends the same bytes.
export function reportRoundEvent(request: RunnerRequest, roundId: string, body: string, expected: RoundEventExpectation): Promise<RoundEventReport> {
  const headers = { accept: "application/json", "content-type": "application/json", authorization: request.credential.authorizationHeader() };
  const path = `api/runner/rounds/${encodeURIComponent(roundId)}/events`;
  return callGalley<RoundEventOutcome, RoundEventFailure>(request, path, { method: "POST", headers, body }, async (response, readJson) => {
    const payload = await readJson();
    if (response.status !== 200 && response.status !== 201) {
      return { ok: false, failure: { reason: "http_status", httpStatus: response.status, errorCode: errorCodeOf(payload) } };
    }
    if (payload === INVALID_JSON) {
      return { ok: false, failure: { reason: "invalid_body", error: "response is not valid JSON" } };
    }
    const result = parseRoundEventResult(payload, roundId, expected);
    return typeof result === "string" ? { ok: false, failure: { reason: "invalid_body", error: result } } : { ok: true, value: { result, replayed: response.status === 200 } };
  });
}

const END_STATES: Partial<Record<RoundEventRequest["type"], RoundEventResult["state"]>> = { delivered: "delivered", stop_confirmed: "stopped", failed: "failed", interrupted: "interrupted" };

function parseRoundEventResult(payload: unknown, roundId: string, expected: RoundEventExpectation): RoundEventResult | string {
  if (!isRecord(payload)) {
    return "body is not a JSON object";
  }
  const { roundId: reportedRound, type, state, startedAt, endedAt, seq, observationId } = payload;
  if (reportedRound !== roundId) {
    return "roundId is not the Round the event was sent for";
  }
  if (type !== expected.type) {
    return `type is not ${expected.type}`;
  }
  const endState = END_STATES[expected.type];
  if (endState !== undefined && state !== endState) {
    return `state is not ${endState}`;
  }
  if (endState === undefined && state !== "claimed" && state !== "running") {
    return "state is not claimed or running";
  }
  if (typeof startedAt !== "string" && !(type === "stop_confirmed" && startedAt === null)) {
    return "startedAt is not a string";
  }
  if (endState !== undefined && typeof endedAt !== "string") {
    return "endedAt is not a string";
  }
  if (type === "progress" && !(Number.isSafeInteger(seq) && (seq as number) >= 1)) {
    return "seq is not a positive integer";
  }
  if (type === "usage_observed" && observationId !== expected.observationId) {
    return "observationId is not the observation the event was sent for";
  }
  const result: RoundEventResult = { roundId: reportedRound, type: expected.type, state: state as RoundEventResult["state"], startedAt };
  if (type === "progress") result.seq = seq as number;
  if (type === "usage_observed") result.observationId = observationId as string;
  if (endState !== undefined) result.endedAt = endedAt as string;
  return result;
}

export type RunnerCommandAckOutcome = components["schemas"]["RunnerCommandAckOutcome"];
export type RoundCommandAcknowledgement = components["schemas"]["RoundCommandAcknowledgement"];

// `type` stays a string: a newer Galley may send a type this Michelin does not know.
export type PulledCommand = Omit<components["schemas"]["RunnerCommand"], "type"> & { type: string };

export type RoundCommandFailure = RoundEventFailure;

export type RoundCommandsResult = Timed<Outcome<PulledCommand[], RoundCommandFailure>>;

export type RoundCommandAckResult = Timed<Outcome<RoundCommandAcknowledgement, RoundCommandFailure>>;

function errorCodeOf(payload: unknown): string | undefined {
  return isRecord(payload) && isRecord(payload["error"]) && typeof payload["error"]["code"] === "string" ? payload["error"]["code"] : undefined;
}

export function pullRoundCommands(request: RunnerRequest, roundId: string): Promise<RoundCommandsResult> {
  const headers = { accept: "application/json", authorization: request.credential.authorizationHeader() };
  const path = `api/runner/rounds/${encodeURIComponent(roundId)}/commands`;
  return callGalley<PulledCommand[], RoundCommandFailure>(request, path, { method: "GET", headers }, async (response, readJson) => {
    const payload = await readJson();
    if (response.status !== 200) {
      return { ok: false, failure: { reason: "http_status", httpStatus: response.status, errorCode: errorCodeOf(payload) } };
    }
    if (payload === INVALID_JSON) {
      return { ok: false, failure: { reason: "invalid_body", error: "response is not valid JSON" } };
    }
    const commands = parseCommands(payload);
    return typeof commands === "string" ? { ok: false, failure: { reason: "invalid_body", error: commands } } : { ok: true, value: commands };
  });
}

function parseCommands(payload: unknown): PulledCommand[] | string {
  if (!isRecord(payload) || !Array.isArray(payload["commands"])) {
    return "commands is not an array";
  }
  const commands: PulledCommand[] = [];
  for (const command of payload["commands"] as unknown[]) {
    if (!isRecord(command)) {
      return "a command is not a JSON object";
    }
    const { id, type, claimEpoch, issuedAt } = command;
    if (typeof id !== "string" || typeof type !== "string" || typeof issuedAt !== "string" || !Number.isSafeInteger(claimEpoch)) {
      return "a command lacks id, type, claimEpoch or issuedAt";
    }
    commands.push({ id, type, claimEpoch: claimEpoch as number, issuedAt });
  }
  return commands;
}

export function acknowledgeRoundCommand(request: RunnerRequest, roundId: string, commandId: string, outcome: RunnerCommandAckOutcome): Promise<RoundCommandAckResult> {
  const headers = { accept: "application/json", "content-type": "application/json", authorization: request.credential.authorizationHeader() };
  const path = `api/runner/rounds/${encodeURIComponent(roundId)}/commands/${encodeURIComponent(commandId)}/ack`;
  return callGalley<RoundCommandAcknowledgement, RoundCommandFailure>(request, path, { method: "POST", headers, body: JSON.stringify({ outcome }) }, async (response, readJson) => {
    const payload = await readJson();
    if (response.status !== 200) {
      return { ok: false, failure: { reason: "http_status", httpStatus: response.status, errorCode: errorCodeOf(payload) } };
    }
    if (payload === INVALID_JSON) {
      return { ok: false, failure: { reason: "invalid_body", error: "response is not valid JSON" } };
    }
    if (!isRecord(payload) || payload["id"] !== commandId || payload["outcome"] !== outcome || typeof payload["acknowledgedAt"] !== "string") {
      return { ok: false, failure: { reason: "invalid_body", error: "body is not the acknowledgement of this command and outcome" } };
    }
    return { ok: true, value: { id: commandId, outcome, acknowledgedAt: payload["acknowledgedAt"] } };
  });
}
