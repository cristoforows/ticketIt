import type { RunnerCredential } from "./credentials.ts";
import type { FetchFn } from "./galley/client.ts";
import { registerRunner, sendHeartbeat, type RegisterRunnerRequest, type RunnerResult } from "./galley/runner.ts";
import type { Logger } from "./logger.ts";
import { sleep } from "./statusLoop.ts";

export interface HeartbeatLoopOptions {
  galleyUrl: URL;
  intervalMs: number;
  fetch: FetchFn;
  logger: Logger;
  credential: RunnerCredential;
  identity: RegisterRunnerRequest;
  registration: Registration;
  requestTimeoutMs?: number;
}

export interface Registration {
  registered: boolean;
}

export interface HeartbeatLoop {
  stop(): Promise<void>;
}

export function startHeartbeatLoop(options: HeartbeatLoopOptions): HeartbeatLoop {
  const shutdown = new AbortController();
  const finished = run(options, shutdown.signal);
  return {
    stop: async () => {
      shutdown.abort();
      await finished;
    },
  };
}

async function run(options: HeartbeatLoopOptions, signal: AbortSignal): Promise<void> {
  const { galleyUrl, intervalMs, logger, identity, registration } = options;
  const request = { fetch: options.fetch, galleyUrl, signal, timeoutMs: options.requestTimeoutMs, credential: options.credential };
  registration.registered = false;
  while (!signal.aborted) {
    const step = registration.registered ? "heartbeat" : "register";
    const result = registration.registered ? await sendHeartbeat(request) : await registerRunner(request, identity);
    if (result.ok) {
      if (registration.registered) {
        logger.info("runner heartbeat ok", { galleyUrl: galleyUrl.href, durationMs: result.durationMs, lastSeenAt: result.value });
      } else {
        registration.registered = true;
        logger.info("runner registered", { galleyUrl: galleyUrl.href, durationMs: result.durationMs, registeredAt: result.value, ...identity });
      }
    } else {
      // Registering again rewrites registered_at in Galley, so only a lost registration or credential leads back to it.
      if (result.failure.reason === "not_registered" || result.failure.reason === "credential_rejected") {
        registration.registered = false;
      }
      if (result.failure.reason === "not_registered") {
        logger.warn("runner not registered with galley; registering again", { galleyUrl: galleyUrl.href });
        continue;
      }
      logFailure(logger, galleyUrl, step, result);
    }
    await sleep(intervalMs, signal);
  }
}

function logFailure(logger: Logger, galleyUrl: URL, step: "register" | "heartbeat", result: RunnerResult & { ok: false }): void {
  const { failure, durationMs } = result;
  if (failure.reason === "aborted") {
    return;
  }
  if (failure.reason === "credential_rejected") {
    logger.error("runner credential rejected", {
      galleyUrl: galleyUrl.href,
      step,
      httpStatus: failure.httpStatus,
      action: "the credential is wrong or revoked; pair the runner again in Swiftlet and update MICHELIN_RUNNER_TOKEN",
    });
    return;
  }
  logger.error(`runner ${step} failed`, { galleyUrl: galleyUrl.href, durationMs, ...failure });
}
