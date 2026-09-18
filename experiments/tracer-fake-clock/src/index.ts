import { FakeClock } from "shared";

/**
 * Trivial scheduling check used only to exercise FakeClock end to end:
 * true once `clock` has advanced at least `waitMs` past `startMs`.
 */
export function hasElapsed(clock: FakeClock, startMs: number, waitMs: number): boolean {
  return clock.nowMs() - startMs >= waitMs;
}
