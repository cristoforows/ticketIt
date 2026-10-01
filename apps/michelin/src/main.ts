import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { startClaimLoop } from "./claimLoop.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { startHeartbeatLoop } from "./heartbeatLoop.ts";
import { stdoutLogger } from "./logger.ts";
import { startStatusLoop } from "./statusLoop.ts";

const logger = stdoutLogger();
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

try {
  const config = loadConfig(process.env);
  const identity = { michelinVersion: version, hostname: hostname() };
  logger.info("michelin starting", {
    galleyUrl: config.galleyUrl.href,
    statusIntervalMs: config.statusIntervalMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    claimIntervalMs: config.claimIntervalMs,
    engineSteps: config.engineScript.steps.map(({ step }) => step),
    node: process.version,
    ...identity,
  });

  const registration = { registered: false };
  const loops = [
    startStatusLoop({ galleyUrl: config.galleyUrl, intervalMs: config.statusIntervalMs, fetch, logger }),
    startHeartbeatLoop({
      galleyUrl: config.galleyUrl,
      intervalMs: config.heartbeatIntervalMs,
      fetch,
      logger,
      credential: config.runnerCredential,
      identity,
      registration,
    }),
    startClaimLoop({
      galleyUrl: config.galleyUrl,
      intervalMs: config.claimIntervalMs,
      fetch,
      logger,
      credential: config.runnerCredential,
      registration,
      engineScript: config.engineScript,
    }),
  ];

  const shutDown = (signal: NodeJS.Signals): void => {
    logger.info("michelin stopping", { signal });
    void Promise.all(loops.map((loop) => loop.stop())).then(() => logger.info("michelin stopped"));
  };
  process.once("SIGINT", shutDown);
  process.once("SIGTERM", shutDown);
} catch (error) {
  if (error instanceof ConfigError) {
    logger.error("invalid configuration", { problems: error.problems });
    process.exitCode = 1;
  } else {
    throw error;
  }
}
