/**
 * `confirmStop` implements the rule from
 * docs/contracts/execution-interface.md ("Stop with evidence-bearing
 * confirmation"): "Michelin ... reports 'Stop confirmed' only once it has
 * evidence that execution actually ceased ... No other signal (disconnect,
 * timeout, or an unacknowledged Stop command) is treated as confirmation."
 *
 * This helper is deliberately generic (it does not know anything about
 * OpenCode, child processes, or marker files): it polls a caller-supplied
 * `hasCeased()` check on a bounded schedule and only ever returns
 * `status: "Stopped"` when that check itself returned `true` at least once.
 * If the budget is exhausted without that happening, it returns
 * `status: "not-confirmed"` -- it never guesses, and it never treats
 * "the poll loop ended" as evidence of anything. Callers (see
 * `test/abort-while-running.test.ts`) are expected to build `hasCeased`
 * from real, out-of-band observations (an OS-level check that a specific
 * child process no longer exists, a marker file that stopped growing past
 * when it should have, the engine's own reported session status, etc.),
 * combined with `allOf`/`raceEvidence` below when more than one signal is
 * required or any one of several signals is acceptable.
 */

export interface CessationCheckResult {
  /** True only when this check found direct evidence that execution ceased. */
  observed: boolean;
  /** Human-readable detail about what was (or was not) observed, for the evidence record. */
  detail: string;
}

export type CessationCheck = () => Promise<CessationCheckResult>;

export interface ConfirmStopOptions {
  /** The single check `confirmStop` polls. Compose multiple checks with `allOf`/`anyOf` first. */
  hasCeased: CessationCheck;
  /** Maximum number of polls before giving up. Default 20. */
  maxAttempts?: number;
  /** Delay between polls in milliseconds. Default 250. */
  intervalMs?: number;
}

export interface ConfirmStopResult {
  status: "Stopped" | "not-confirmed";
  /** How many polls were made (including the one that produced evidence, if any). */
  attempts: number;
  /** Explanation: either what evidence was observed, or why confirmation is being refused. */
  reason: string;
  /** `Date.now()` at the moment cessation evidence was observed, or null if never confirmed. */
  observedAtMs: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `options.hasCeased` up to `maxAttempts` times, `intervalMs` apart,
 * and only report `"Stopped"` the first time it returns `observed: true`.
 * Exhausting the budget without observed evidence returns
 * `"not-confirmed"` -- this is the refusal path: it is not an error, it is
 * the correct, honest answer when there is no evidence to report Stopped
 * on, and callers must not upgrade it to "Stopped" themselves.
 */
export async function confirmStop(options: ConfirmStopOptions): Promise<ConfirmStopResult> {
  const maxAttempts = options.maxAttempts ?? 20;
  const intervalMs = options.intervalMs ?? 250;
  if (maxAttempts < 1) throw new Error("confirmStop requires maxAttempts >= 1");

  let lastDetail = "no attempt made";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await options.hasCeased();
    lastDetail = result.detail;
    if (result.observed) {
      return {
        status: "Stopped",
        attempts: attempt,
        reason: `observed cessation evidence: ${result.detail}`,
        observedAtMs: Date.now(),
      };
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }

  return {
    status: "not-confirmed",
    attempts: maxAttempts,
    reason:
      `no cessation evidence observed after ${maxAttempts} attempts at ${intervalMs}ms apart ` +
      `(last check: ${lastDetail}); refusing to report Stopped without evidence`,
    observedAtMs: null,
  };
}

/** Combine checks so `hasCeased` only reports observed once every one of them has, in a single poll. */
export function allOf(checks: CessationCheck[]): CessationCheck {
  return async () => {
    const results = await Promise.all(checks.map((check) => check()));
    const observed = results.every((r) => r.observed);
    const detail = results.map((r) => r.detail).join("; ");
    return { observed, detail };
  };
}
