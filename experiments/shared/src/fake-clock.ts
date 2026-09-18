/**
 * A deterministic clock for experiments that must not depend on wall-clock
 * time (retry/backoff timing, expiry windows, event ordering, etc.).
 *
 * M1 experiments use this instead of `Date.now()` / real timers so that
 * fixture-based evidence is reproducible. It is intentionally minimal:
 * no timers, no scheduling, just a controllable "now".
 */
export class FakeClock {
  #nowMs: number;

  /**
   * @param start Initial time, as an ISO-8601 string or epoch milliseconds.
   *   Defaults to the Unix epoch so tests are stable without an argument.
   */
  constructor(start: string | number = 0) {
    this.#nowMs = typeof start === "string" ? Date.parse(start) : start;
    if (Number.isNaN(this.#nowMs)) {
      throw new Error(`FakeClock: could not parse start value: ${String(start)}`);
    }
  }

  /** Current time as a `Date`. */
  now(): Date {
    return new Date(this.#nowMs);
  }

  /** Current time as epoch milliseconds. */
  nowMs(): number {
    return this.#nowMs;
  }

  /** Current time as an ISO-8601 string. */
  toISOString(): string {
    return this.now().toISOString();
  }

  /**
   * Move the clock forward (or backward, with a negative value) by the
   * given number of milliseconds.
   */
  advance(ms: number): void {
    this.#nowMs += ms;
  }

  /** Set the clock to an absolute point in time. */
  set(value: string | number): void {
    const next = typeof value === "string" ? Date.parse(value) : value;
    if (Number.isNaN(next)) {
      throw new Error(`FakeClock: could not parse set() value: ${String(value)}`);
    }
    this.#nowMs = next;
  }
}
