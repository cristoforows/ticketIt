import { randomUUID } from "node:crypto";
import type { RunnerCredential } from "./credentials.ts";
import type { EngineScript } from "./engineScript.ts";
import type { FetchFn } from "./galley/client.ts";
import { reportRoundEvent, type RoundEventFailure, type RoundEventRequest, type RunnerClaim } from "./galley/runner.ts";
import type { Logger } from "./logger.ts";
import { sleep } from "./statusLoop.ts";

export type EngineOutcome = "completed" | "abandoned" | "aborted";

export interface EngineDeps {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => Date;
  newReference: () => string;
}

export interface EngineOptions {
  galleyUrl: URL;
  fetch: FetchFn;
  logger: Logger;
  credential: RunnerCredential;
  claim: RunnerClaim;
  script: EngineScript;
  signal: AbortSignal;
  requestTimeoutMs?: number;
  deps?: Partial<EngineDeps>;
}

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 30_000;

export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
}

// A refusal is final, and nothing is closed or unlocked on the strength of it: recovery is M5 (#6).
function isRetryable(failure: RoundEventFailure): boolean {
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

export async function runControlledEngine(options: EngineOptions): Promise<EngineOutcome> {
  const { logger, signal, claim } = options;
  const deps: EngineDeps = { sleep, now: () => new Date(), newReference: () => `controlled:${randomUUID()}`, ...options.deps };
  const roundId = claim.roundId;
  let stepIndex = 0;
  for (const step of options.script.steps) {
    if (signal.aborted) {
      return "aborted";
    }
    switch (step.step) {
      case "start": {
        const event: RoundEventRequest = {
          type: "execution_started",
          idempotencyKey: `${roundId}:${stepIndex}`,
          claimEpoch: claim.claimEpoch,
          occurredAt: deps.now().toISOString(),
          data: { engineReference: deps.newReference() },
        };
        const outcome = await sendEvent(options, deps, "start", stepIndex, JSON.stringify(event), event.data.engineReference);
        if (outcome !== "sent") {
          return outcome;
        }
        break;
      }
      case "wait":
        await deps.sleep(step.ms, signal);
        break;
      case "hold":
        logger.info("engine holding", { roundId });
        await untilAborted(signal);
        return "aborted";
    }
    stepIndex++;
  }
  if (signal.aborted) {
    return "aborted";
  }
  logger.info("engine script finished", { roundId });
  return "completed";
}

async function sendEvent(options: EngineOptions, deps: EngineDeps, step: "start", stepIndex: number, body: string, engineReference: string): Promise<"sent" | "abandoned" | "aborted"> {
  const { logger, signal, claim } = options;
  const request = { fetch: options.fetch, galleyUrl: options.galleyUrl, signal, timeoutMs: options.requestTimeoutMs, credential: options.credential };
  for (let attempt = 1; ; attempt++) {
    const report = await reportRoundEvent(request, claim.roundId, body);
    const context = { roundId: claim.roundId, step, stepIndex, attempt };
    if (report.ok) {
      logger.info("execution started reported", {
        ...context,
        engineReference,
        httpStatus: report.value.replayed ? 200 : 201,
        replayed: report.value.replayed,
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
