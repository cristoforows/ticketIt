import type { components } from "./generated/schema";

export type RoundLimitBreach = components["schemas"]["RoundLimitBreach"];

const KINDS: readonly RoundLimitBreach["kind"][] = ["wall_clock", "denial_loop"];

export function parseLimitBreach(value: unknown): RoundLimitBreach | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const breach = value as Record<string, unknown>;
  const { kind, limit, measured, breachedAt } = breach;
  if (
    !KINDS.includes(kind as RoundLimitBreach["kind"]) ||
    !Number.isSafeInteger(limit) ||
    !Number.isSafeInteger(measured) ||
    (limit as number) < 1 ||
    (measured as number) < (limit as number) ||
    typeof breachedAt !== "string"
  ) {
    return undefined;
  }
  return { kind: kind as RoundLimitBreach["kind"], limit: limit as number, measured: measured as number, breachedAt };
}

// Galley's explanation prints whole seconds as Go's time.Duration does, so the two read alike.
export function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

export const LIMIT_STOPPING_LABEL = "Technical limit reached. Stopping the Round.";

export function limitBreachLabel(breach: RoundLimitBreach): string {
  return breach.kind === "wall_clock"
    ? `Active time limit reached: ${formatSeconds(breach.measured)} of ${formatSeconds(breach.limit)}`
    : `Denied-check limit reached: ${breach.measured} of ${breach.limit}`;
}
