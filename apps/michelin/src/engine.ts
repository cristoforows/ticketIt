import { createHash, randomUUID } from "node:crypto";
import type { AwaitAnswer } from "./answerInbox.ts";
import type { RunnerCredential } from "./credentials.ts";
import { NOTE_MAX_LENGTH, type EngineScript } from "./engineScript.ts";
import type { FetchFn } from "./galley/client.ts";
import { reportRoundEvent, type RoundEventFailure, type RoundEventRequest, type RunnerClaim } from "./galley/runner.ts";
import type { Logger } from "./logger.ts";
import { sleep } from "./statusLoop.ts";

interface PendingEvent {
  step: "start" | "progress" | "usage" | "deliver" | "fail" | "interrupt" | "stop" | "ask" | "resume";
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
  requestTimeoutMs?: number;
  deps?: Partial<EngineDeps>;
}

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

// RFC 9562 version 5 with the Round as namespace: a restarted engine raises the same question under the same id, so Galley's replay
// check, keyed on it, never records a second question.
export function questionIdFor(roundId: string, stepIndex: number): string {
  const namespace = Buffer.from(roundId.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(namespace).update(`ask:${stepIndex}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ANSWER_NOTE_PREFIX = "Owner's answer: ";

export function answerNote(answer: string): string {
  return [...`${ANSWER_NOTE_PREFIX}${answer}`].slice(0, NOTE_MAX_LENGTH).join("");
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
  const halt = AbortSignal.any([signal, stop]);
  const steps = options.script.steps;
  const awaitAnswer: AwaitAnswer = options.awaitAnswer ?? ((_questionId, until) => untilAborted(until).then(() => undefined));
  let waitingForAnswer = false;
  // Sent only once the engine has ceased: Galley ends the Round on this event alone.
  const stopped = async (): Promise<EngineOutcome> => {
    const commandId = typeof stop.reason === "string" ? stop.reason : undefined;
    logger.info("engine stopped", { roundId, stepIndex, ...(commandId === undefined ? {} : { commandId }) });
    const position = waitingForAnswer
      ? `while waiting for the answer to step ${stepIndex + 1}`
      : stepIndex < steps.length
        ? `before step ${stepIndex + 1}`
        : `after step ${steps.length}`;
    const evidence = `Stopped ${position} of ${steps.length}${commandId === undefined ? "" : ` on Stop command ${commandId}`}`;
    const outcome = await sendEvent(options, deps, {
      step: "stop",
      stepIndex,
      event: envelope("stop_confirmed", `${roundId}:stop`, { evidence }),
      reported: "stop confirmation reported",
      context: {},
    });
    return outcome === "sent" ? "stopped" : outcome;
  };
  let stepIndex = 0;
  for (const step of steps) {
    if (signal.aborted) {
      return "aborted";
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
        const raised = await sendEvent(options, deps, {
          step: "ask",
          stepIndex,
          event: envelope("question_raised", questionId, { questionId, text: step.question }),
          reported: "question raised",
          context: { questionId },
        });
        if (raised !== "sent") {
          return raised;
        }
        waitingForAnswer = true;
        logger.info("engine waiting for an answer", { roundId, stepIndex, questionId });
        const answer = await awaitAnswer(questionId, halt);
        if (signal.aborted) {
          return "aborted";
        }
        if (stop.aborted || answer === undefined) {
          return stopped();
        }
        waitingForAnswer = false;
        const resumed = await sendEvent(options, deps, {
          step: "resume",
          stepIndex,
          event: envelope("resumed", `${roundId}:${stepIndex}`, { questionId }),
          reported: "resume reported",
          context: { questionId },
        });
        if (resumed !== "sent") {
          return resumed;
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
      case "hold":
        logger.info("engine holding", { roundId });
        await untilAborted(halt);
        return signal.aborted ? "aborted" : stopped();
    }
    if (pending !== undefined) {
      const outcome = await sendEvent(options, deps, pending);
      if (outcome !== "sent") {
        return outcome;
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
    }
    stepIndex++;
  }
  if (signal.aborted) {
    return "aborted";
  }
  if (stop.aborted) {
    return stopped();
  }
  logger.info("engine script finished", { roundId });
  return "completed";
}

async function sendEvent(options: EngineOptions, deps: EngineDeps, pending: PendingEvent): Promise<"sent" | "abandoned" | "aborted"> {
  const { logger, signal, claim } = options;
  const request = { fetch: options.fetch, galleyUrl: options.galleyUrl, signal, timeoutMs: options.requestTimeoutMs, credential: options.credential };
  const body = JSON.stringify(pending.event);
  const expected = {
    type: pending.event.type,
    observationId: pending.step === "usage" ? pending.event.idempotencyKey : undefined,
    questionId: pending.step === "ask" || pending.step === "resume" ? (pending.context["questionId"] as string) : undefined,
  };
  for (let attempt = 1; ; attempt++) {
    const report = await reportRoundEvent(request, claim.roundId, body, expected);
    const context = { roundId: claim.roundId, step: pending.step, stepIndex: pending.stepIndex, attempt };
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
    const retryInMs = retryDelayMs(attempt);
    logger.warn("round event failed; retrying", { ...context, durationMs: report.durationMs, ...report.failure, retryInMs });
    await deps.sleep(retryInMs, signal);
    if (signal.aborted) {
      return "aborted";
    }
  }
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
