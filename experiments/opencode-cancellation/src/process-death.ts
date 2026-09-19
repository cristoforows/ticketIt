/**
 * The lifecycle rule from CONTEXT.md ("Interrupted") and
 * docs/v1-scope.md ("Lifecycle" table, "Execution actually stops
 * unexpectedly" -> Ticket Blocked / Round Interrupted) and
 * docs/contracts/execution-interface.md ("Reconciliation on reconnect":
 * "Otherwise, Galley records the Round as Interrupted and the Ticket
 * becomes Blocked, requiring an explicit return to Ready for a new
 * Round"): losing the execution process is never treated as a resumable
 * pause and never automatically starts a new Round, no matter what turns
 * out to be recoverable from disk.
 *
 * `classifyProcessDeath` is a pure function with no branch that can
 * produce automatic continuation: it always returns the same fixed
 * outcome shape regardless of what is passed in. This is deliberate --
 * the point is that *nothing* about the observation (whether the tool's
 * child process happened to survive, how much history is recoverable,
 * how quickly the death was detected) should be able to change the
 * classification. Only an explicit owner action (a later, separate
 * "return Ticket to Ready" command, entirely outside this function) may
 * start a new Round.
 */

export interface ProcessDeathObservation {
  /** The pid of the OpenCode server process that was killed. */
  pid: number;
  /** `Date.now()` when the SIGKILL was sent. */
  killedAtMs: number;
  /** `Date.now()` when the pid was first observed to no longer exist. */
  detectedDeadAtMs: number | null;
  /** Whether the tool's own child process (e.g. a scripted "sleep") was still alive after the parent died. */
  toolChildSurvivedParent: boolean | null;
  /** Whether session/message history was recoverable from the same storage after restart. */
  historyRecovered: boolean;
  /** Whether any pending permission/question request was recoverable from the same storage after restart. */
  pendingStateRecovered: boolean;
}

export interface ProcessDeathOutcome {
  round: "Interrupted";
  ticket: "Blocked";
  /** Always true: only an explicit owner action outside this function may start a new Round. */
  newRoundRequiresExplicitOwnerAction: true;
  /** Always false: this function never itself continues or resumes the prior Round's work. */
  autoContinued: false;
  summary: string;
}

export function classifyProcessDeath(observation: ProcessDeathObservation): ProcessDeathOutcome {
  return {
    round: "Interrupted",
    ticket: "Blocked",
    newRoundRequiresExplicitOwnerAction: true,
    autoContinued: false,
    summary:
      `process ${observation.pid} died unexpectedly` +
      (observation.toolChildSurvivedParent === null
        ? "; tool child survival unknown"
        : observation.toolChildSurvivedParent
          ? "; its tool's child process survived it"
          : "; its tool's child process did not survive it") +
      `; history recovered: ${observation.historyRecovered}` +
      `; pending state recovered: ${observation.pendingStateRecovered}` +
      "; Round Interrupted, Ticket Blocked, no automatic new Round",
  };
}
