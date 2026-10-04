import type { components } from "../api/generated/schema.d.ts";
import type { RunnerCredential } from "../credentials.ts";
import { callGalley, INVALID_JSON, isRecord, type GalleyRequest, type Outcome, type Timed, type TransportFailure } from "./client.ts";

export type RegisterRunnerRequest = components["schemas"]["RegisterRunnerRequest"];
export type RunnerClaim = components["schemas"]["RunnerClaim"];
export type ClaimedFeedback = components["schemas"]["ClaimedFeedback"];
export type RoundEventRequest = components["schemas"]["RoundEventRequest"];
export type RoundEventResult = components["schemas"]["RoundEventResult"];
export type AuthorityCheckRequest = components["schemas"]["AuthorityCheckRequest"];
export type AuthorityCheckResult = components["schemas"]["AuthorityCheckResult"];

export type RunnerFailure =
  | TransportFailure
  | { reason: "credential_rejected"; httpStatus: 401 }
  | { reason: "not_registered"; httpStatus: 409 }
  | { reason: "http_status"; httpStatus: number }
  | { reason: "invalid_body"; error: string };

export interface RunnerAck {
  at: string;
  reconcileRequired: boolean;
}

export type RunnerResult = Timed<Outcome<RunnerAck, RunnerFailure>>;

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
  return callGalley<RunnerAck, RunnerFailure>(request, path, { method: "POST", headers, body }, async (response, readJson) => {
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
    const reconcileRequired = isRecord(payload) ? payload["reconcileRequired"] : undefined;
    if (typeof reconcileRequired !== "boolean") {
      return { ok: false, failure: { reason: "invalid_body", error: "reconcileRequired is not a boolean" } };
    }
    return { ok: true, value: { at: value, reconcileRequired } };
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
  if (!Array.isArray(ticket["feedback"]) || !ticket["feedback"].every(isClaimedFeedback)) {
    return "ticket.feedback is not a list of feedback";
  }
  if (!isRecord(agent) || typeof agent["id"] !== "string" || typeof agent["name"] !== "string" || typeof agent["kind"] !== "string") {
    return "agent is not an Agent";
  }
  return payload as RunnerClaim;
}

function isClaimedFeedback(item: unknown): boolean {
  return (
    isRecord(item) &&
    typeof item["roundId"] === "string" &&
    Number.isSafeInteger(item["roundSequence"]) &&
    (item["roundSequence"] as number) >= 1 &&
    typeof item["body"] === "string" &&
    item["body"] !== "" &&
    typeof item["createdAt"] === "string"
  );
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
  questionId?: string;
  requestId?: string;
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

const QUESTION_STATES: Partial<Record<RoundEventRequest["type"], RoundEventResult["state"]>> = {
  question_raised: "waiting_for_input",
  permission_requested: "waiting_for_input",
  resumed: "running",
};

function parseRoundEventResult(payload: unknown, roundId: string, expected: RoundEventExpectation): RoundEventResult | string {
  if (!isRecord(payload)) {
    return "body is not a JSON object";
  }
  const { roundId: reportedRound, type, state, startedAt, endedAt, seq, observationId, questionId, requestId } = payload;
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
  const questionState = QUESTION_STATES[expected.type];
  if (questionState !== undefined && state !== questionState) {
    return `state is not ${questionState}`;
  }
  if (endState === undefined && questionState === undefined && state !== "claimed" && state !== "running") {
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
  if (questionState !== undefined && expected.requestId !== undefined && requestId !== expected.requestId) {
    return "requestId is not the Permission request the event was sent for";
  }
  if (questionState !== undefined && expected.requestId === undefined && questionId !== expected.questionId) {
    return "questionId is not the question the event was sent for";
  }
  const result: RoundEventResult = { roundId: reportedRound, type: expected.type, state: state as RoundEventResult["state"], startedAt };
  if (type === "progress") result.seq = seq as number;
  if (type === "usage_observed") result.observationId = observationId as string;
  if (questionState !== undefined && expected.requestId !== undefined) result.requestId = requestId as string;
  if (questionState !== undefined && expected.requestId === undefined) result.questionId = questionId as string;
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
    const { id, type, claimEpoch, issuedAt, answer, approval } = command;
    if (typeof id !== "string" || typeof type !== "string" || typeof issuedAt !== "string" || !Number.isSafeInteger(claimEpoch)) {
      return "a command lacks id, type, claimEpoch or issuedAt";
    }
    if (type === "approval") {
      if (!isRecord(approval) || typeof approval["requestId"] !== "string" || typeof approval["grantId"] !== "string") {
        return "an approval command lacks approval.requestId or approval.grantId";
      }
      commands.push({ id, type, claimEpoch: claimEpoch as number, issuedAt, approval: { requestId: approval["requestId"], grantId: approval["grantId"] } });
      continue;
    }
    if (type !== "answer") {
      commands.push({ id, type, claimEpoch: claimEpoch as number, issuedAt });
      continue;
    }
    if (!isRecord(answer) || typeof answer["questionId"] !== "string" || typeof answer["text"] !== "string") {
      return "an answer command lacks answer.questionId or answer.text";
    }
    commands.push({ id, type, claimEpoch: claimEpoch as number, issuedAt, answer: { questionId: answer["questionId"], text: answer["text"] } });
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

export type AuthorityCheckFailure = RoundEventFailure;

export type AuthorityCheckReport = Timed<Outcome<AuthorityCheckResult, AuthorityCheckFailure>>;

export function checkAuthority(request: RunnerRequest, roundId: string, body: AuthorityCheckRequest): Promise<AuthorityCheckReport> {
  const headers = { accept: "application/json", "content-type": "application/json", authorization: request.credential.authorizationHeader() };
  const path = `api/runner/rounds/${encodeURIComponent(roundId)}/authority-checks`;
  return callGalley<AuthorityCheckResult, AuthorityCheckFailure>(request, path, { method: "POST", headers, body: JSON.stringify(body) }, async (response, readJson) => {
    const payload = await readJson();
    if (response.status !== 200) {
      return { ok: false, failure: { reason: "http_status", httpStatus: response.status, errorCode: errorCodeOf(payload) } };
    }
    if (payload === INVALID_JSON) {
      return { ok: false, failure: { reason: "invalid_body", error: "response is not valid JSON" } };
    }
    if (isRecord(payload) && payload["decision"] === "allow" && typeof payload["grantId"] === "string" && payload["expiredGrantId"] === undefined) {
      return { ok: true, value: { decision: "allow", grantId: payload["grantId"] } };
    }
    if (isRecord(payload) && payload["decision"] === "deny" && payload["grantId"] === undefined) {
      const expired = payload["expiredGrantId"];
      if (expired === undefined) {
        return { ok: true, value: { decision: "deny" } };
      }
      if (typeof expired === "string") {
        return { ok: true, value: { decision: "deny", expiredGrantId: expired } };
      }
    }
    return { ok: false, failure: { reason: "invalid_body", error: "body is not an allow naming its grant or a deny naming at most an expired grant" } };
  });
}

export type HeldRound = components["schemas"]["HeldRound"];
export type ReconcileDisposition = components["schemas"]["ReconcileDisposition"];
export type CessationEvent = components["schemas"]["CessationEvent"];

export interface ReconciledRound {
  roundId: string;
  claimEpoch: number;
  disposition: ReconcileDisposition;
  cessationEvent?: CessationEvent;
  commands: PulledCommand[];
}

export type ReconcileFailure = RoundEventFailure;

export type ReconcileReport = Timed<Outcome<ReconciledRound | null, ReconcileFailure>>;

const DISPOSITIONS: readonly string[] = ["continue", "stop", "report_cessation", "hold"] satisfies ReconcileDisposition[];
const CESSATION_EVENTS: readonly string[] = ["stop_confirmed", "interrupted"] satisfies CessationEvent[];

export function reconcile(request: RunnerRequest, held: HeldRound[]): Promise<ReconcileReport> {
  const headers = { accept: "application/json", "content-type": "application/json", authorization: request.credential.authorizationHeader() };
  return callGalley<ReconciledRound | null, ReconcileFailure>(request, "api/runner/reconcile", { method: "POST", headers, body: JSON.stringify({ held }) }, async (response, readJson) => {
    const payload = await readJson();
    if (response.status !== 200) {
      return { ok: false, failure: { reason: "http_status", httpStatus: response.status, errorCode: errorCodeOf(payload) } };
    }
    if (payload === INVALID_JSON) {
      return { ok: false, failure: { reason: "invalid_body", error: "response is not valid JSON" } };
    }
    const round = parseReconciledRound(payload, held[0]);
    return typeof round === "string" ? { ok: false, failure: { reason: "invalid_body", error: round } } : { ok: true, value: round };
  });
}

function parseReconciledRound(payload: unknown, held: HeldRound | undefined): ReconciledRound | null | string {
  if (!isRecord(payload) || !("round" in payload)) {
    return "body lacks round";
  }
  const round = payload["round"];
  if (round === null) {
    return held === undefined ? null : "round is null for a held Round";
  }
  if (!isRecord(round)) {
    return "round is not a JSON object";
  }
  const { roundId, claimEpoch, disposition, cessationEvent } = round;
  if (typeof roundId !== "string" || !Number.isSafeInteger(claimEpoch)) {
    return "round lacks roundId or claimEpoch";
  }
  if (held !== undefined && (roundId !== held.roundId || claimEpoch !== held.claimEpoch)) {
    return "round is not the held Round";
  }
  if (typeof disposition !== "string" || !DISPOSITIONS.includes(disposition)) {
    return "disposition is not a known disposition";
  }
  if (held === undefined && disposition !== "hold") {
    return "a Round reconciled while holding nothing is not held";
  }
  if ((disposition === "report_cessation") !== (typeof cessationEvent === "string" && CESSATION_EVENTS.includes(cessationEvent))) {
    return "cessationEvent does not match the disposition";
  }
  const commands = parseCommands(round);
  if (typeof commands === "string") {
    return commands;
  }
  const parsed: ReconciledRound = { roundId, claimEpoch: claimEpoch as number, disposition: disposition as ReconcileDisposition, commands };
  if (disposition === "report_cessation") parsed.cessationEvent = cessationEvent as CessationEvent;
  return parsed;
}
