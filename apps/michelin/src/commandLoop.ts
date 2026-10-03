import type { RunnerCredential } from "./credentials.ts";
import { isRetryable, retryDelayMs } from "./engine.ts";
import type { FetchFn } from "./galley/client.ts";
import {
  acknowledgeRoundCommand,
  pullRoundCommands,
  type PulledCommand,
  type RunnerClaim,
  type RunnerCommandAckOutcome,
  type RunnerRequest,
} from "./galley/runner.ts";
import type { Logger } from "./logger.ts";
import { sleep } from "./statusLoop.ts";

export interface CommandLoopOptions {
  galleyUrl: URL;
  intervalMs: number;
  fetch: FetchFn;
  logger: Logger;
  credential: RunnerCredential;
  claim: RunnerClaim;
  signal: AbortSignal;
  onStop: (command: PulledCommand) => void;
  onAnswer: (command: AnswerCommand) => void;
  requestTimeoutMs?: number;
}

export type AnswerCommand = PulledCommand & { answer: NonNullable<PulledCommand["answer"]> };

export interface CommandLoop {
  stop(): Promise<void>;
}

export function startCommandLoop(options: CommandLoopOptions): CommandLoop {
  const ended = new AbortController();
  const finished = run(options, AbortSignal.any([options.signal, ended.signal]));
  return {
    stop: async () => {
      ended.abort();
      await finished;
    },
  };
}

async function run(options: CommandLoopOptions, signal: AbortSignal): Promise<void> {
  const { logger, claim } = options;
  const request: RunnerRequest = { fetch: options.fetch, galleyUrl: options.galleyUrl, signal, timeoutMs: options.requestTimeoutMs, credential: options.credential };
  const seen = new Set<string>();
  while (!signal.aborted) {
    await sleep(options.intervalMs, signal);
    if (signal.aborted) {
      return;
    }
    const result = await pullRoundCommands(request, claim.roundId);
    if (!result.ok) {
      if (result.failure.reason !== "aborted" && !signal.aborted) {
        logger.error("round commands poll failed", { roundId: claim.roundId, durationMs: result.durationMs, ...result.failure });
      }
      continue;
    }
    for (const command of result.value) {
      if (seen.has(command.id)) {
        continue;
      }
      seen.add(command.id);
      const context = { roundId: claim.roundId, commandId: command.id, type: command.type, commandEpoch: command.claimEpoch, claimEpoch: claim.claimEpoch };
      if (command.type !== "stop" && command.type !== "answer") {
        logger.warn("unknown command left unacknowledged", context);
        continue;
      }
      if (command.claimEpoch !== claim.claimEpoch) {
        logger.warn("command for another claim epoch ignored", context);
        await acknowledgeCommand(request, logger, claim.roundId, command, "ignored");
        continue;
      }
      if (command.type === "answer") {
        const answer = command as AnswerCommand;
        logger.info("answer received", { ...context, questionId: answer.answer.questionId });
        options.onAnswer(answer);
        continue;
      }
      logger.info("stop requested", context);
      options.onStop(command);
    }
  }
}

export async function acknowledgeCommand(
  request: RunnerRequest,
  logger: Logger,
  roundId: string,
  command: PulledCommand,
  outcome: RunnerCommandAckOutcome,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    const result = await acknowledgeRoundCommand(request, roundId, command.id, outcome);
    const context = { roundId, commandId: command.id, type: command.type, outcome, attempt, durationMs: result.durationMs };
    if (result.ok) {
      logger.info("command acknowledged", { ...context, acknowledgedAt: result.value.acknowledgedAt });
      return true;
    }
    if (result.failure.reason === "aborted" || request.signal.aborted) {
      return false;
    }
    if (!isRetryable(result.failure)) {
      logger.error("command acknowledgement refused", { ...context, ...result.failure });
      return false;
    }
    const retryInMs = retryDelayMs(attempt);
    logger.warn("command acknowledgement failed; retrying", { ...context, ...result.failure, retryInMs });
    await sleep(retryInMs, request.signal);
    if (request.signal.aborted) {
      return false;
    }
  }
}
