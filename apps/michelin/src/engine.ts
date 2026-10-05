import { createHash, randomUUID } from "node:crypto";
import type { AwaitAnswer, AwaitApproval } from "./answerInbox.ts";
import type { RunnerCredential } from "./credentials.ts";
import { NOTE_MAX_LENGTH, type ActStep, type EngineScript } from "./engineScript.ts";
import type { FetchFn } from "./galley/client.ts";
import {
  checkAuthority,
  reportRoundEvent,
  type AuthorityCheckResult,
  type ClaimedFeedback,
  type RoundEventFailure,
  type RoundEventRequest,
  type RunnerClaim,
} from "./galley/runner.ts";
import type { Logger } from "./logger.ts";
import type { GateResult, ReconcileOutcome } from "./reconciler.ts";
import { sleep } from "./statusLoop.ts";

interface PendingEvent {
  step: "start" | "progress" | "usage" | "deliver" | "fail" | "interrupt" | "stop" | "ask" | "resume" | "request" | "act" | "cease";
  stepIndex: number;
  event: RoundEventRequest;
  reported: string;
  context: Record<string, unknown>;
}

export type EngineOutcome = "completed" | "delivered" | "failed" | "interrupted" | "abandoned" | "aborted" | "stopped";

export interface EngineDeps {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => Date;
  newReference: () => string;
  newObservationId: () => string;
}

export interface EngineOptions {
  galleyUrl: URL;
  fetch: FetchFn;
  logger: Logger;
  credential: RunnerCredential;
  claim: RunnerClaim;
  script: EngineScript;
  signal: AbortSignal;
  stop: AbortSignal;
  awaitAnswer?: AwaitAnswer;
  awaitApproval?: AwaitApproval;
  requestTimeoutMs?: number;
  deps?: Partial<EngineDeps>;
  reconcile?: EngineReconcile;
  // Aborted when Galley's Reconcile answers hold or refuses the Round: the engine leaves it without reporting.
  dropped?: AbortSignal;
  onHalted?: () => void;
  reportRetryMaxMs?: number;
}

export interface EngineReconcile {
  gate(): Promise<GateResult>;
  require(): void;
  settle(): Promise<ReconcileOutcome>;
  intervalMs: number;
}

type SendOutcome = "sent" | "abandoned" | "aborted" | "stop" | "halted";

export const DEFAULT_REPORT_RETRY_MAX_MS = 300_000;

const TERMINAL_ENDINGS: Partial<Record<RoundEventRequest["type"], EngineOutcome>> = { delivered: "delivered", stop_confirmed: "stopped", failed: "failed", interrupted: "interrupted" };

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 30_000;

export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
}

// A refusal is final, and nothing is closed or unlocked on the strength of it: recovery is M5 (#6).
export function isRetryable(failure: RoundEventFailure): boolean {
  switch (failure.reason) {
    case "unreachable":
    case "timeout":
    case "invalid_body":
      return true;
    case "http_status":
      return failure.httpStatus >= 500;
    case "aborted":
      return false;
  }
}

export function questionIdFor(roundId: string, stepIndex: number): string {
  return stepIdFor(roundId, `ask:${stepIndex}`);
}

export function requestIdFor(roundId: string, stepIndex: number): string {
  return stepIdFor(roundId, `act:${stepIndex}`);
}

// RFC 9562 version 5 with the Round as namespace: a restarted engine asks again under the same id, so Galley's replay
// check, keyed on it, never records a second question or Permission request.
function stepIdFor(roundId: string, name: string): string {
  const namespace = Buffer.from(roundId.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(namespace).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ANSWER_NOTE_PREFIX = "Owner's answer: ";

export function answerNote(answer: string): string {
  return [...`${ANSWER_NOTE_PREFIX}${answer}`].slice(0, NOTE_MAX_LENGTH).join("");
}

export function performedNote(step: ActStep): string {
  return [...`Performed ${step.action} on ${step.resource}`].slice(0, NOTE_MAX_LENGTH).join("");
}

function deniedExplanation(step: ActStep, why: string): string {
  return [...`Could not ${step.action} on ${step.resource} with the ${step.account} account: ${why}`].slice(0, NOTE_MAX_LENGTH).join("");
}

export function feedbackNote(feedback: readonly ClaimedFeedback[]): string {
  const lines = feedback.map((item) => `Round ${item.roundSequence}: ${item.body}`);
  const heading = `Owner's feedback received (${feedback.length} ${feedback.length === 1 ? "comment" : "comments"}):`;
  return [...[heading, ...lines].join("\n")].slice(0, NOTE_MAX_LENGTH).join("");
}

export async function runControlledEngine(options: EngineOptions): Promise<EngineOutcome> {
  const { logger, signal, stop, claim } = options;
  const deps: EngineDeps = {
    sleep,
    now: () => new Date(),
    newReference: () => `controlled:${randomUUID()}`,
    newObservationId: () => randomUUID(),
    ...options.deps,
  };
  const roundId = claim.roundId;
  const envelope = (type: RoundEventRequest["type"], idempotencyKey: string, data: RoundEventRequest["data"]): RoundEventRequest => ({
    type,
    idempotencyKey,
    claimEpoch: claim.claimEpoch,
    occurredAt: deps.now().toISOString(),
    data,
  });
  const dropped = options.dropped ?? new AbortController().signal;
  const halt = AbortSignal.any([signal, stop, dropped]);
  const left = (): "aborted" | "abandoned" | undefined => (signal.aborted ? "aborted" : dropped.aborted ? "abandoned" : undefined);
  const steps = options.script.steps;
  const awaitAnswer: AwaitAnswer = options.awaitAnswer ?? ((_questionId, until) => untilAborted(until).then(() => undefined));
  const awaitApproval: AwaitApproval = options.awaitApproval ?? ((_requestId, until) => untilAborted(until).then(() => undefined));
  let waitingFor: "answer" | "approval" | undefined;
  let haltedOutcome: EngineOutcome = "abandoned";
  const retryMaxMs = options.reportRetryMaxMs ?? DEFAULT_REPORT_RETRY_MAX_MS;
  // Only Galley's Reconcile answer, given the stopped belief, says how the Round may end: the unsent ending if there was one,
  // otherwise the cessation Galley names.
  const recoverHalted = async (unsent: PendingEvent): Promise<EngineOutcome> => {
    options.onHalted?.();
    const haltedAt = deps.now();
    logger.error("report retry exhausted; round halted locally", { roundId, step: unsent.step, stepIndex: unsent.stepIndex, type: unsent.event.type, retryMaxMs });
    const reconcile = options.reconcile;
    if (reconcile === undefined) {
      return "abandoned";
    }
    for (;;) {
      await deps.sleep(reconcile.intervalMs, AbortSignal.any([signal, dropped]));
      const gone = left();
      if (gone !== undefined) {
        return gone;
      }
      const answer = await reconcile.settle();
      if (answer.kind === "aborted") {
        return "aborted";
      }
      if (answer.kind === "drop" || answer.kind === "hold") {
        return "abandoned";
      }
      if (answer.kind !== "cessation") {
        continue;
      }
      const ending = TERMINAL_ENDINGS[unsent.event.type] !== undefined
        ? unsent
        : {
            step: "cease" as const,
            stepIndex: unsent.stepIndex,
            event: envelope(answer.event, `${roundId}:halted`, {
              evidence: [...`Halted locally at step ${unsent.stepIndex + 1} of ${steps.length} (${unsent.event.type}) at ${haltedAt.toISOString()}: report retry bound of ${retryMaxMs} ms reached`].slice(0, NOTE_MAX_LENGTH).join(""),
            }),
            reported: "cessation reported",
            context: { unsent: unsent.event.type },
          };
      const sent = await sendEvent(options, deps, ending, { gated: false, retryMaxMs });
      if (sent === "sent") {
        return TERMINAL_ENDINGS[ending.event.type] ?? "abandoned";
      }
      if (sent !== "halted") {
        return sent === "aborted" ? "aborted" : "abandoned";
      }
    }
  };
  const send = async (pending: PendingEvent): Promise<SendOutcome> => {
    const outcome = await sendEvent(options, deps, pending, { gated: true, retryMaxMs });
    if (outcome === "halted") {
      haltedOutcome = await recoverHalted(pending);
    }
    return outcome;
  };
  // Sent only once the engine has ceased: Galley ends the Round on this event alone.
  const stopped = async (): Promise<EngineOutcome> => {
    options.onHalted?.();
    const commandId = typeof stop.reason === "string" ? stop.reason : undefined;
    logger.info("engine stopped", { roundId, stepIndex, ...(commandId === undefined ? {} : { commandId }) });
    const position = waitingFor !== undefined
      ? `while waiting for the ${waitingFor} to step ${stepIndex + 1}`
      : stepIndex < steps.length
        ? `before step ${stepIndex + 1}`
        : `after step ${steps.length}`;
    const evidence = `Stopped ${position} of ${steps.length}${commandId === undefined ? "" : ` on Stop command ${commandId}`}`;
    const outcome = await send({
      step: "stop",
      stepIndex,
      event: envelope("stop_confirmed", `${roundId}:stop`, { evidence }),
      reported: "stop confirmation reported",
      context: {},
    });
    return outcome === "sent" ? "stopped" : outcome === "halted" ? haltedOutcome : outcome === "stop" ? "abandoned" : outcome;
  };
  const settle = (outcome: Exclude<SendOutcome, "sent">): Promise<EngineOutcome> | EngineOutcome => (outcome === "stop" ? stopped() : outcome === "halted" ? haltedOutcome : outcome);
  let stepIndex = 0;
  for (const step of steps) {
    const gone = left();
    if (gone !== undefined) {
      return gone;
    }
    if (stop.aborted) {
      return stopped();
    }
    let pending: PendingEvent | undefined;
    switch (step.step) {
      case "start": {
        const engineReference = deps.newReference();
        pending = {
          step: "start",
          stepIndex,
          event: envelope("execution_started", `${roundId}:${stepIndex}`, { engineReference }),
          reported: "execution started reported",
          context: { engineReference },
        };
        break;
      }
      case "progress":
        pending = { step: "progress", stepIndex, event: envelope("progress", `${roundId}:${stepIndex}`, { note: step.note }), reported: "progress reported", context: {} };
        break;
      case "usage": {
        // The observation's identity is its key, so a retry can never record a second observation.
        const observationId = deps.newObservationId();
        const { step: _step, ...figures } = step;
        pending = { step: "usage", stepIndex, event: envelope("usage_observed", observationId, { observationId, ...figures }), reported: "usage observation reported", context: { observationId } };
        break;
      }
      case "deliver": {
        const { step: _step, ...deliverable } = step;
        pending = { step: "deliver", stepIndex, event: envelope("delivered", `${roundId}:${stepIndex}`, deliverable), reported: "delivery reported", context: {} };
        break;
      }
      case "fail":
        pending = { step: "fail", stepIndex, event: envelope("failed", `${roundId}:${stepIndex}`, { explanation: step.explanation }), reported: "failure reported", context: {} };
        break;
      case "interrupt":
        pending = { step: "interrupt", stepIndex, event: envelope("interrupted", `${roundId}:${stepIndex}`, { evidence: step.evidence }), reported: "interruption reported", context: {} };
        break;
      case "wait":
        await deps.sleep(step.ms, halt);
        break;
      case "ask": {
        const questionId = questionIdFor(roundId, stepIndex);
        const raised = await send({
          step: "ask",
          stepIndex,
          event: envelope("question_raised", questionId, { questionId, text: step.question }),
          reported: "question raised",
          context: { questionId },
        });
        if (raised !== "sent") {
          return settle(raised);
        }
        waitingFor = "answer";
        logger.info("engine waiting for an answer", { roundId, stepIndex, questionId });
        const answer = await awaitAnswer(questionId, halt);
        const goneWaiting = left();
        if (goneWaiting !== undefined) {
          return goneWaiting;
        }
        if (stop.aborted || answer === undefined) {
          return stopped();
        }
        waitingFor = undefined;
        const resumed = await send({
          step: "resume",
          stepIndex,
          event: envelope("resumed", `${roundId}:${stepIndex}`, { questionId }),
          reported: "resume reported",
          context: { questionId },
        });
        if (resumed !== "sent") {
          return settle(resumed);
        }
        await answer.acknowledge();
        pending = {
          step: "progress",
          stepIndex,
          event: envelope("progress", `${roundId}:${stepIndex}:answer`, { note: answerNote(answer.text) }),
          reported: "progress reported",
          context: { questionId },
        };
        break;
      }
      case "act": {
        const scope = { account: step.account, action: step.action, resource: step.resource };
        const failed = (why: string): PendingEvent => ({
          step: "fail",
          stepIndex,
          event: envelope("failed", `${roundId}:${stepIndex}:failed`, { explanation: deniedExplanation(step, why) }),
          reported: "failure reported",
          context: scope,
        });
        const performed: PendingEvent = { step: "act", stepIndex, event: envelope("progress", `${roundId}:${stepIndex}`, { note: performedNote(step) }), reported: "action performed", context: scope };
        const first = await checkScope(options, deps, step, stepIndex);
        if (typeof first === "string") {
          return settle(first);
        }
        if (first.decision === "unsupported") {
          pending = failed("the Connected Account does not declare this capability");
          break;
        }
        if (first.decision === "allow") {
          pending = performed;
          break;
        }
        const requestId = requestIdFor(roundId, stepIndex);
        const renewal = first.expiredGrantId === undefined ? {} : { renewsGrantId: first.expiredGrantId };
        const requested = await send({
          step: "request",
          stepIndex,
          event: envelope("permission_requested", requestId, { requestId, ...scope, ...renewal }),
          reported: "permission requested",
          context: { requestId, ...scope, ...renewal },
        });
        if (requested !== "sent") {
          return settle(requested);
        }
        waitingFor = "approval";
        logger.info("engine waiting for an approval", { roundId, stepIndex, requestId });
        const approval = await awaitApproval(requestId, halt);
        const goneWaiting = left();
        if (goneWaiting !== undefined) {
          return goneWaiting;
        }
        if (stop.aborted || approval === undefined) {
          return stopped();
        }
        waitingFor = undefined;
        const resumed = await send({
          step: "resume",
          stepIndex,
          event: envelope("resumed", `${roundId}:${stepIndex}:resumed`, { requestId }),
          reported: "resume reported",
          context: { requestId, grantId: approval.grantId },
        });
        if (resumed !== "sent") {
          return settle(resumed);
        }
        await approval.acknowledge();
        const second = await checkScope(options, deps, step, stepIndex);
        if (typeof second === "string") {
          return settle(second);
        }
        pending = second.decision === "allow" ? performed : failed("Galley still denies it after the Owner's approval");
        break;
      }
      case "hold":
        logger.info("engine holding", { roundId });
        await untilAborted(halt);
        return left() ?? stopped();
    }
    if (pending !== undefined) {
      const outcome = await send(pending);
      if (outcome !== "sent") {
        return settle(outcome);
      }
      if (pending.step === "deliver") {
        logger.info("engine delivered", { roundId });
        return "delivered";
      }
      if (pending.step === "fail") {
        logger.info("engine failed", { roundId });
        return "failed";
      }
      if (pending.step === "interrupt") {
        logger.info("engine interrupted", { roundId });
        return "interrupted";
      }
      if (pending.step === "start" && claim.ticket.feedback.length > 0) {
        const noted = await send({
          step: "progress",
          stepIndex,
          event: envelope("progress", `${roundId}:${stepIndex}:feedback`, { note: feedbackNote(claim.ticket.feedback) }),
          reported: "feedback reported",
          context: { feedback: claim.ticket.feedback.length },
        });
        if (noted !== "sent") {
          return settle(noted);
        }
      }
    }
    stepIndex++;
  }
  const gone = left();
  if (gone !== undefined) {
    return gone;
  }
  if (stop.aborted) {
    return stopped();
  }
  logger.info("engine script finished", { roundId });
  return "completed";
}

async function sendEvent(options: EngineOptions, deps: EngineDeps, pending: PendingEvent, bound: { gated: boolean; retryMaxMs: number }): Promise<SendOutcome> {
  const { logger, signal, claim } = options;
  let firstFailedAt: number | undefined;
  const request = { fetch: options.fetch, galleyUrl: options.galleyUrl, signal, timeoutMs: options.requestTimeoutMs, credential: options.credential };
  let event = pending.event;
  let cessationLetThrough = false;
  for (let attempt = 1; ; attempt++) {
    if (options.dropped?.aborted) {
      return "abandoned";
    }
    if (options.reconcile !== undefined && bound.gated && !cessationLetThrough) {
      const gate = await options.reconcile.gate();
      if (gate.kind === "aborted" || gate.kind === "drop") {
        return gate.kind === "aborted" ? "aborted" : "abandoned";
      }
      if (gate.kind === "stop" && pending.step !== "stop") {
        logger.info("reconcile asks the engine to stop", { roundId: claim.roundId, step: pending.step, stepIndex: pending.stepIndex });
        return "stop";
      }
      if (gate.kind === "cessation") {
        // Galley names a cessation only for an engine that reported itself stopped; for any other report it is not ours to send.
        if (pending.step !== "stop") {
          logger.error("reconcile named a cessation for a running engine; round dropped locally", { roundId: claim.roundId, step: pending.step, cessationEvent: gate.event });
          return "abandoned";
        }
        cessationLetThrough = true;
        event = { ...event, type: gate.event };
      }
    }
    const body = JSON.stringify(event);
    const expected = {
      type: event.type,
      observationId: pending.step === "usage" ? event.idempotencyKey : undefined,
      questionId: pending.step === "ask" || pending.step === "resume" ? (pending.context["questionId"] as string | undefined) : undefined,
      requestId: pending.step === "request" || pending.step === "resume" ? (pending.context["requestId"] as string | undefined) : undefined,
    };
    const report = await reportRoundEvent(request, claim.roundId, body, expected);
    const context = { roundId: claim.roundId, step: pending.step, stepIndex: pending.stepIndex, attempt, ...(event.type === pending.event.type ? {} : { type: event.type }) };
    if (report.ok) {
      const { result, replayed } = report.value;
      logger.info(pending.reported, {
        ...context,
        ...pending.context,
        ...(result.seq === undefined ? {} : { seq: result.seq }),
        ...(result.endedAt === undefined ? {} : { endedAt: result.endedAt }),
        httpStatus: replayed ? 200 : 201,
        replayed,
        durationMs: report.durationMs,
      });
      return "sent";
    }
    if (report.failure.reason === "aborted" || signal.aborted) {
      return "aborted";
    }
    if (!isRetryable(report.failure)) {
      logger.error("round event refused; round abandoned locally", { ...context, durationMs: report.durationMs, ...report.failure });
      return "abandoned";
    }
    const failedAt = deps.now().getTime();
    firstFailedAt ??= failedAt;
    if (failedAt - firstFailedAt >= bound.retryMaxMs) {
      logger.warn("round event failed; retry bound reached", { ...context, durationMs: report.durationMs, ...report.failure, retryMaxMs: bound.retryMaxMs });
      return "halted";
    }
    const retryInMs = retryDelayMs(attempt);
    logger.warn("round event failed; retrying", { ...context, durationMs: report.durationMs, ...report.failure, retryInMs });
    await deps.sleep(retryInMs, signal);
    if (signal.aborted) {
      return "aborted";
    }
  }
}

type ScopeDecision = AuthorityCheckResult | { decision: "unsupported" };

// Asked of Galley each time the step runs, never remembered: a grant can end between two actions.
async function checkScope(options: EngineOptions, deps: EngineDeps, step: ActStep, stepIndex: number): Promise<ScopeDecision | Exclude<SendOutcome, "sent">> {
  const { logger, signal, claim } = options;
  const request = { fetch: options.fetch, galleyUrl: options.galleyUrl, signal, timeoutMs: options.requestTimeoutMs, credential: options.credential };
  const body = { account: step.account, action: step.action, resource: step.resource, epoch: claim.claimEpoch };
  for (let attempt = 1; ; attempt++) {
    if (options.dropped?.aborted) {
      return "abandoned";
    }
    if (options.reconcile !== undefined) {
      const gate = await options.reconcile.gate();
      switch (gate.kind) {
        case "aborted":
          return "aborted";
        case "drop":
        case "cessation":
          return "abandoned";
        case "stop":
          logger.info("reconcile asks the engine to stop", { roundId: claim.roundId, step: "act", stepIndex });
          return "stop";
      }
    }
    const report = await checkAuthority(request, claim.roundId, body);
    const context = { roundId: claim.roundId, step: "act", stepIndex, attempt, account: step.account, action: step.action, resource: step.resource };
    if (report.ok) {
      const { decision, grantId, expiredGrantId } = report.value;
      logger.info("authority checked", { ...context, decision, ...(grantId === undefined ? {} : { grantId }), ...(expiredGrantId === undefined ? {} : { expiredGrantId }), durationMs: report.durationMs });
      return report.value;
    }
    if (report.failure.reason === "aborted" || signal.aborted) {
      return "aborted";
    }
    if (report.failure.reason === "http_status" && report.failure.httpStatus === 400 && report.failure.errorCode === "capability_not_supported") {
      logger.error("authority check refused an undeclared capability", { ...context, durationMs: report.durationMs, ...report.failure });
      return { decision: "unsupported" };
    }
    // Galley answers neither allow nor deny until it can see the runner and has reconciled the Round: ask again after both.
    const unanswered = report.failure.reason === "http_status" && report.failure.httpStatus === 409 && UNANSWERED_CHECKS.includes(report.failure.errorCode ?? "");
    if (report.failure.reason === "http_status" && report.failure.errorCode === "reconcile_required") {
      options.reconcile?.require();
    }
    if (!unanswered && !isRetryable(report.failure)) {
      logger.error("authority check refused; round abandoned locally", { ...context, durationMs: report.durationMs, ...report.failure });
      return "abandoned";
    }
    const retryInMs = retryDelayMs(attempt);
    logger.warn("authority check failed; retrying", { ...context, durationMs: report.durationMs, ...report.failure, retryInMs });
    await deps.sleep(retryInMs, signal);
    if (signal.aborted) {
      return "aborted";
    }
  }
}

const UNANSWERED_CHECKS: readonly string[] = ["reconcile_required", "runner_disconnected"];

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
