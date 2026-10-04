import type { RunnerCredential } from "./credentials.ts";
import { isRetryable, retryDelayMs } from "./engine.ts";
import type { FetchFn } from "./galley/client.ts";
import { reconcile, type CessationEvent, type HeldRound, type PulledCommand, type RunnerClaim } from "./galley/runner.ts";
import type { Registration } from "./heartbeatLoop.ts";
import type { Logger } from "./logger.ts";
import { sleep } from "./statusLoop.ts";

export type HeldExecution = "running" | "stopped";

export interface HeldRoundState {
  claim: RunnerClaim;
  execution: () => HeldExecution;
  onStop: (command: PulledCommand | undefined) => void;
  onDrop: () => void;
}

export type ReconcileOutcome =
  | { kind: "none" }
  | { kind: "continue" }
  | { kind: "stop" }
  | { kind: "cessation"; event: CessationEvent }
  | { kind: "hold" }
  | { kind: "drop" }
  | { kind: "aborted" };

export type GateResult = { kind: "proceed" } | Exclude<ReconcileOutcome, { kind: "none" } | { kind: "continue" } | { kind: "hold" }>;

export interface ReconcilerOptions {
  galleyUrl: URL;
  fetch: FetchFn;
  logger: Logger;
  credential: RunnerCredential;
  registration: Registration;
  signal: AbortSignal;
  requestTimeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class Reconciler {
  #options: ReconcilerOptions;
  #held: HeldRoundState | undefined;
  #inFlight: Promise<ReconcileOutcome> | undefined;

  constructor(options: ReconcilerOptions) {
    this.#options = options;
  }

  get required(): boolean {
    return this.#options.registration.reconcileRequired;
  }

  hold(state: HeldRoundState): void {
    this.#held = state;
  }

  release(state: HeldRoundState): void {
    if (this.#held === state) {
      this.#held = undefined;
    }
  }

  // Free unless a Reconcile is owed: then every step, report and authority check waits on Galley's answer.
  async gate(): Promise<GateResult> {
    if (!this.required) {
      return { kind: "proceed" };
    }
    const outcome = await this.reconcile();
    switch (outcome.kind) {
      case "continue":
      case "none":
        return { kind: "proceed" };
      case "hold":
        return { kind: "drop" };
      default:
        return outcome;
    }
  }

  reconcile(): Promise<ReconcileOutcome> {
    this.#inFlight ??= this.#reconcileOnce().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #reconcileOnce(): Promise<ReconcileOutcome> {
    const { logger, registration, signal } = this.#options;
    const request = { fetch: this.#options.fetch, galleyUrl: this.#options.galleyUrl, signal, timeoutMs: this.#options.requestTimeoutMs, credential: this.#options.credential };
    const pause = this.#options.sleep ?? sleep;
    const state = this.#held;
    const held: HeldRound[] = state === undefined ? [] : [{ roundId: state.claim.roundId, claimEpoch: state.claim.claimEpoch, execution: state.execution() }];
    const raised = registration.reconcileRaised;
    const clear = (): void => {
      if (registration.reconcileRaised === raised) {
        registration.reconcileRequired = false;
      }
    };
    for (let attempt = 1; ; attempt++) {
      const report = await reconcile(request, held);
      const context = { roundId: held[0]?.roundId, execution: held[0]?.execution ?? "unknown", attempt, durationMs: report.durationMs };
      if (report.ok) {
        const round = report.value;
        if (round === null) {
          clear();
          logger.info("reconciled; no open round", context);
          return { kind: "none" };
        }
        const { disposition, cessationEvent, commands } = round;
        logger.info("reconciled", { ...context, roundId: round.roundId, disposition, ...(cessationEvent === undefined ? {} : { cessationEvent }) });
        switch (disposition) {
          case "continue":
            clear();
            return { kind: "continue" };
          case "stop":
            clear();
            state?.onStop(commands.find((command) => command.type === "stop" && command.claimEpoch === round.claimEpoch));
            return { kind: "stop" };
          case "report_cessation":
            return { kind: "cessation", event: cessationEvent! };
          case "hold":
            state?.onDrop();
            return { kind: "hold" };
        }
      }
      if (report.failure.reason === "aborted" || signal.aborted) {
        return { kind: "aborted" };
      }
      if (!isRetryable(report.failure)) {
        logger.error("reconcile refused; round dropped locally", { ...context, ...report.failure });
        state?.onDrop();
        return { kind: "drop" };
      }
      const retryInMs = retryDelayMs(attempt);
      logger.warn("reconcile failed; retrying", { ...context, ...report.failure, retryInMs });
      await pause(retryInMs, signal);
      if (signal.aborted) {
        return { kind: "aborted" };
      }
    }
  }
}
