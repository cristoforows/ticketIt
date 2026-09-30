export type Level = "info" | "warn" | "error";

export type Fields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export function createLogger(
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): Logger {
  const log = (level: Level, msg: string, fields: Fields = {}): void => {
    write(JSON.stringify({ time: now().toISOString(), level, msg, ...fields }));
  };
  return {
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}

export function stdoutLogger(): Logger {
  return createLogger((line) => process.stdout.write(`${line}\n`));
}
