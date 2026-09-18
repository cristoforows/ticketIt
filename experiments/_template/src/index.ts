import { FakeClock } from "shared";

/**
 * Sample function to replace with the thing this experiment actually
 * proves. Shown here only to demonstrate importing `shared` through the
 * local `file:../shared` dependency and using FakeClock for deterministic
 * time.
 */
export function describeElapsed(clock: FakeClock, fromMs: number): string {
  const elapsedMs = clock.nowMs() - fromMs;
  return `${elapsedMs}ms elapsed since ${new Date(fromMs).toISOString()}`;
}
