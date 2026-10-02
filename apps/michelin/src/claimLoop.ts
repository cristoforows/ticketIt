import { acknowledgeCommand, startCommandLoop } from "./commandLoop.ts";
import type { RunnerCredential } from "./credentials.ts";
import { runControlledEngine, type EngineDeps } from "./engine.ts";
import type { EngineScript } from "./engineScript.ts";
import type { FetchFn } from "./galley/client.ts";
import { claimWork, type ClaimResult, type PulledCommand, type RunnerClaim } from "./galley/runner.ts";
import type { Registration } from "./heartbeatLoop.ts";
import type { Logger } from "./logger.ts";
import { sleep } from "./statusLoop.ts";

export interface ClaimLoopOptions {
  galleyUrl: URL;
  intervalMs: number;
  commandIntervalMs: number;
  fetch: FetchFn;
  logger: Logger;
  credential: RunnerCredential;
  registration: Readonly<Registration>;
  engineScript: EngineScript;
  engineDeps?: Partial<EngineDeps>;
  requestTimeoutMs?: number;
}

export interface ClaimLoop {
  stop(): Promise<void>;
}

export function startClaimLoop(options: ClaimLoopOptions): ClaimLoop {
  const shutdown = new AbortController();
  const finished = run(options, shutdown.signal);
  return {
    stop: async () => {
      shutdown.abort();
      await finished;
    },
  };
}

// One Round at a time: polling resumes only after the claimed Round's script ends or is abandoned.
async function run(options: ClaimLoopOptions, signal: AbortSignal): Promise<void> {
  const { galleyUrl, intervalMs, logger, registration } = options;
  const request = { fetch: options.fetch, galleyUrl, signal, timeoutMs: options.requestTimeoutMs, credential: options.credential };
  while (!signal.aborted) {
    await sleep(intervalMs, signal);
    if (signal.aborted || !registration.registered) {
      continue;
    }
    const result = await claimWork(request);
    if (result.ok && result.value !== null) {
      const { roundId, sequence, claimEpoch, ticket } = result.value;
      logger.info("round claimed", {
        galleyUrl: galleyUrl.href,
        durationMs: result.durationMs,
        roundId,
        sequence,
        claimEpoch,
        ticketId: ticket.id,
        ticketTitle: ticket.title,
      });
      await runRound(options, result.value, signal);
      continue;
    }
    if (!result.ok) {
      logFailure(logger, galleyUrl, result);
    }
  }
}

async function runRound(options: ClaimLoopOptions, claim: RunnerClaim, signal: AbortSignal): Promise<void> {
  const { galleyUrl, fetch, logger, credential, requestTimeoutMs } = options;
  const stop = new AbortController();
  let stopCommand: PulledCommand | undefined;
  const commands = startCommandLoop({
    galleyUrl,
    intervalMs: options.commandIntervalMs,
    fetch,
    logger,
    credential,
    claim,
    signal,
    requestTimeoutMs,
    onStop: (command) => {
      stopCommand ??= command;
      stop.abort(stopCommand.id);
    },
  });
  try {
    const outcome = await runControlledEngine({
      galleyUrl,
      fetch,
      logger,
      credential,
      claim,
      script: options.engineScript,
      signal,
      stop: stop.signal,
      requestTimeoutMs,
      deps: options.engineDeps,
    });
    await commands.stop();
    if (outcome === "stopped" && stopCommand !== undefined) {
      await acknowledgeCommand({ fetch, galleyUrl, signal, timeoutMs: requestTimeoutMs, credential }, logger, claim.roundId, stopCommand, "applied");
    }
  } catch (error) {
    logger.error("engine failed unexpectedly", { roundId: claim.roundId, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await commands.stop();
  }
}

function logFailure(logger: Logger, galleyUrl: URL, result: ClaimResult & { ok: false }): void {
  const { failure, durationMs } = result;
  if (failure.reason === "aborted") {
    return;
  }
  if (failure.reason === "credential_rejected") {
    logger.error("runner credential rejected", {
      galleyUrl: galleyUrl.href,
      step: "claim",
      httpStatus: failure.httpStatus,
      action: "the credential is wrong or revoked; pair the runner again in Swiftlet and update MICHELIN_RUNNER_TOKEN",
    });
    return;
  }
  logger.error("runner claim failed", { galleyUrl: galleyUrl.href, durationMs, ...failure });
}
