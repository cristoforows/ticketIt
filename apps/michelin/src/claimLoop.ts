import type { RunnerCredential } from "./credentials.ts";
import type { FetchFn } from "./galley/client.ts";
import { claimWork, type ClaimResult } from "./galley/runner.ts";
import type { Registration } from "./heartbeatLoop.ts";
import type { Logger } from "./logger.ts";
import { sleep } from "./statusLoop.ts";

export interface ClaimLoopOptions {
  galleyUrl: URL;
  intervalMs: number;
  fetch: FetchFn;
  logger: Logger;
  credential: RunnerCredential;
  registration: Readonly<Registration>;
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

// Execution of the claimed Round is M4.8 (#134); until then the first claim ends polling for this process.
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
      logger.info("round claimed; claim polling stopped", {
        galleyUrl: galleyUrl.href,
        durationMs: result.durationMs,
        roundId,
        sequence,
        claimEpoch,
        ticketId: ticket.id,
        ticketTitle: ticket.title,
      });
      return;
    }
    if (!result.ok) {
      logFailure(logger, galleyUrl, result);
    }
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
