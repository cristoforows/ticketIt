import { AnswerInbox, ApprovalInbox } from "./answerInbox.ts";
import { acknowledgeCommand, startCommandLoop } from "./commandLoop.ts";
import type { RunnerCredential } from "./credentials.ts";
import { runControlledEngine, type EngineDeps } from "./engine.ts";
import type { EngineScript } from "./engineScript.ts";
import type { FetchFn } from "./galley/client.ts";
import { randomUUID } from "node:crypto";
import { claimKeyOutlives, claimWork, type ClaimResult, type PulledCommand, type RunnerClaim } from "./galley/runner.ts";
import { requireReconcile, type Registration } from "./heartbeatLoop.ts";
import type { Logger } from "./logger.ts";
import { Reconciler, type HeldRoundState } from "./reconciler.ts";
import { sleep } from "./statusLoop.ts";

export interface ClaimLoopOptions {
  galleyUrl: URL;
  intervalMs: number;
  commandIntervalMs: number;
  reportRetryMaxMs?: number;
  fetch: FetchFn;
  logger: Logger;
  credential: RunnerCredential;
  registration: Registration;
  engineScript: EngineScript;
  engineDeps?: Partial<EngineDeps>;
  requestTimeoutMs?: number;
}

export interface ClaimLoop {
  stop(): Promise<void>;
}

export function startClaimLoop(options: ClaimLoopOptions): ClaimLoop {
  const shutdown = new AbortController();
  const finished = run(options, shutdown.signal);
  return {
    stop: async () => {
      shutdown.abort();
      await finished;
    },
  };
}

// One Round at a time: polling resumes only after the claimed Round's script ends or is abandoned.
async function run(options: ClaimLoopOptions, signal: AbortSignal): Promise<void> {
  const { galleyUrl, intervalMs, logger, registration } = options;
  const request = { fetch: options.fetch, galleyUrl, signal, timeoutMs: options.requestTimeoutMs, credential: options.credential };
  const reconciler = new Reconciler({ ...request, logger, registration, requestTimeoutMs: options.requestTimeoutMs, sleep: options.engineDeps?.sleep });
  // Held in memory only: a restarted Michelin cannot ask again, and Galley holds the Round it may have created.
  let pendingKey: string | undefined;
  while (!signal.aborted) {
    await sleep(intervalMs, signal);
    if (signal.aborted || !registration.registered) {
      continue;
    }
    // Holding nothing, Michelin claims only once Galley confirms the Owner has no open Round it might still be running;
    // a claim still awaiting its answer is asked first, since that Round may be the one.
    if (pendingKey === undefined && registration.reconcileRequired) {
      await reconciler.reconcile();
      if (registration.reconcileRequired) {
        continue;
      }
    }
    const key = pendingKey ?? randomUUID();
    const result = await claimWork(request, key);
    pendingKey = claimKeyOutlives(result) ? key : undefined;
    if (result.ok && result.value !== null) {
      const { roundId, sequence, claimEpoch, ticket } = result.value;
      logger.info("round claimed", {
        galleyUrl: galleyUrl.href,
        durationMs: result.durationMs,
        roundId,
        sequence,
        claimEpoch,
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        feedback: ticket.feedback.length,
      });
      await runRound(options, result.value, signal, reconciler);
      continue;
    }
    if (!result.ok) {
      logFailure(logger, galleyUrl, result);
    }
  }
}

async function runRound(options: ClaimLoopOptions, claim: RunnerClaim, signal: AbortSignal, reconciler: Reconciler): Promise<void> {
  const { galleyUrl, fetch, logger, credential, requestTimeoutMs, registration } = options;
  const stop = new AbortController();
  const dropped = new AbortController();
  let stopCommand: PulledCommand | undefined;
  let halted = false;
  const onStop = (command: PulledCommand | undefined): void => {
    stopCommand ??= command;
    stop.abort(stopCommand?.id);
  };
  const held: HeldRoundState = {
    claim,
    execution: () => (halted ? "stopped" : "running"),
    onStop,
    onDrop: () => dropped.abort(),
  };
  reconciler.hold(held);
  const watch = startReconcileWatch(reconciler, options.intervalMs, AbortSignal.any([signal, dropped.signal]));
  const answers = new AnswerInbox();
  const approvals = new ApprovalInbox();
  const request = { fetch, galleyUrl, signal, timeoutMs: requestTimeoutMs, credential };
  const commands = startCommandLoop({
    galleyUrl,
    intervalMs: options.commandIntervalMs,
    fetch,
    logger,
    credential,
    claim,
    signal,
    requestTimeoutMs,
    onStop,
    onAnswer: (command) => {
      answers.deliver(command.answer.questionId, {
        text: command.answer.text,
        acknowledge: async () => {
          await acknowledgeCommand(request, logger, claim.roundId, command, "applied");
        },
      });
    },
    onApproval: (command) => {
      approvals.deliver(command.approval.requestId, {
        grantId: command.approval.grantId,
        acknowledge: async () => {
          await acknowledgeCommand(request, logger, claim.roundId, command, "applied");
        },
      });
    },
  });
  try {
    const outcome = await runControlledEngine({
      galleyUrl,
      fetch,
      logger,
      credential,
      claim,
      script: options.engineScript,
      signal,
      stop: stop.signal,
      awaitAnswer: answers.wait,
      awaitApproval: approvals.wait,
      requestTimeoutMs,
      deps: options.engineDeps,
      reconcile: { gate: () => reconciler.gate(), require: () => requireReconcile(registration), settle: () => reconciler.reconcile(), intervalMs: options.intervalMs },
      reportRetryMaxMs: options.reportRetryMaxMs,
      dropped: dropped.signal,
      onHalted: () => {
        halted = true;
      },
    });
    await commands.stop();
    if (outcome === "stopped" && stopCommand !== undefined) {
      await acknowledgeCommand(request, logger, claim.roundId, stopCommand, "applied");
    }
  } catch (error) {
    logger.error("engine failed unexpectedly", { roundId: claim.roundId, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await commands.stop();
    await watch.stop();
    reconciler.release(held);
  }
}

// An engine waiting on the Owner sends nothing to gate, so an owed Reconcile is also sought on the claim interval.
function startReconcileWatch(reconciler: Reconciler, intervalMs: number, signal: AbortSignal): { stop(): Promise<void> } {
  const ended = new AbortController();
  const until = AbortSignal.any([signal, ended.signal]);
  const finished = (async () => {
    while (!until.aborted) {
      await sleep(intervalMs, until);
      if (!until.aborted && reconciler.required) {
        await reconciler.reconcile();
      }
    }
  })();
  return {
    stop: async () => {
      ended.abort();
      await finished;
    },
  };
}

function logFailure(logger: Logger, galleyUrl: URL, result: ClaimResult & { ok: false }): void {
  const { failure, durationMs } = result;
  if (failure.reason === "aborted") {
    return;
  }
  if (failure.reason === "credential_rejected") {
    logger.error("runner credential rejected", {
      galleyUrl: galleyUrl.href,
      step: "claim",
      httpStatus: failure.httpStatus,
      action: "the credential is wrong or revoked; pair the runner again in Swiftlet and update MICHELIN_RUNNER_TOKEN",
    });
    return;
  }
  logger.error("runner claim failed", { galleyUrl: galleyUrl.href, durationMs, ...failure });
}
