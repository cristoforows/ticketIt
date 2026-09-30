import { expect, it } from "vitest";
import { createLogger } from "./logger.ts";

it("writes one JSON object per call with time, level, msg and context", () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line), () => new Date("2026-09-30T10:00:00.000Z"));
  logger.warn("hello", { a: 1 });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? "")).toEqual({ time: "2026-09-30T10:00:00.000Z", level: "warn", msg: "hello", a: 1 });
});
