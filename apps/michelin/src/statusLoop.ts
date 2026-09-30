import { fetchStatus, type FetchFn } from "./galley/client.ts";
import type { Logger } from "./logger.ts";

export interface StatusLoopOptions {
  galleyUrl: URL;
  intervalMs: number;
  fetch: FetchFn;
  logger: Logger;
  requestTimeoutMs?: number;
}

export interface StatusLoop {
  stop(): Promise<void>;
}

export function startStatusLoop(options: StatusLoopOptions): StatusLoop {
  const shutdown = new AbortController();
  const finished = run(options, shutdown.signal);
  return {
    stop: async () => {
      shutdown.abort();
      await finished;
    },
  };
}

async function run(options: StatusLoopOptions, signal: AbortSignal): Promise<void> {
  const { galleyUrl, intervalMs, logger } = options;
  while (!signal.aborted) {
    const result = await fetchStatus({
      fetch: options.fetch,
      galleyUrl,
      signal,
      timeoutMs: options.requestTimeoutMs,
    });
    if (result.ok) {
      const { status } = result;
      const context = {
        galleyUrl: galleyUrl.href,
        durationMs: result.durationMs,
        version: status.version,
        environment: status.environment,
        startedAt: status.startedAt,
        databaseStatus: status.database.status,
        migrationVersion: status.database.migrationVersion,
      };
      if (status.database.status === "ok") {
        logger.info("galley status ok", context);
      } else {
        logger.warn("galley status ok but database unhealthy", { ...context, databaseError: status.database.error });
      }
    } else if (result.failure.reason !== "aborted") {
      logger.error("galley status check failed", {
        galleyUrl: galleyUrl.href,
        durationMs: result.durationMs,
        ...result.failure,
      });
    }
    await sleep(intervalMs, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
