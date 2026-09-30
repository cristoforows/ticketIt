import { ConfigError, loadConfig } from "./config.ts";
import { stdoutLogger } from "./logger.ts";
import { startStatusLoop } from "./statusLoop.ts";

const logger = stdoutLogger();

try {
  const config = loadConfig(process.env);
  logger.info("michelin starting", {
    galleyUrl: config.galleyUrl.href,
    statusIntervalMs: config.statusIntervalMs,
    node: process.version,
  });

  const loop = startStatusLoop({
    galleyUrl: config.galleyUrl,
    intervalMs: config.statusIntervalMs,
    fetch,
    logger,
  });

  const shutDown = (signal: NodeJS.Signals): void => {
    logger.info("michelin stopping", { signal });
    void loop.stop().then(() => logger.info("michelin stopped"));
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
