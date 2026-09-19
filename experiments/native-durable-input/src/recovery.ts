import type { RunnableConfig } from "@langchain/core/runnables";
import type { StateSnapshot } from "@langchain/langgraph";
import type { HarnessAgent } from "native-harness/src/index.js";

/**
 * `ReactAgent.getState()`/`.updateState()` (the object `createHarnessAgent`
 * returns) are typed `never` in `langchain@1.5.11` -- reserved for internal
 * LangGraph Platform use (see
 * `node_modules/langchain/dist/agents/ReactAgent.d.ts`, "The following are
 * internal methods... Note: we intentionally return as `never`"). The
 * supported way to reach the real compiled graph (with a working
 * `getState`/`invoke`/`updateState`) is the `.graph` getter, which returns
 * the underlying `CompiledStateGraph` (`AgentGraph<Types>` in that same
 * file). Every state read/resume in this package goes through
 * `agent.graph`, never `agent.getState`/`agent.invoke` directly, for this
 * reason -- see docs/evidence/m1/23-native-durable-input.md, "Documentation
 * research".
 */
export function graphOf(agent: HarnessAgent) {
  return (agent as unknown as { graph: CompiledGraphLike }).graph;
}

/** The minimal shape of `agent.graph` this package relies on. */
export interface CompiledGraphLike {
  invoke(input: unknown, config: RunnableConfig): Promise<Record<string, unknown>>;
  getState(config: RunnableConfig, options?: { subgraphs?: boolean }): Promise<StateSnapshot>;
}

export interface PendingInterrupt {
  readonly id: string | undefined;
  readonly value: unknown;
}

/**
 * Reads the pending interrupt (if any) from durable graph state via
 * `getState()` -- not from any in-memory record of "what Process A saw" --
 * so a genuinely fresh process (Process B, reconnecting only through the
 * checkpointer) can recover it (see the "Durable question" scenario).
 */
export async function readPendingInterrupt(
  graph: CompiledGraphLike,
  config: RunnableConfig,
): Promise<PendingInterrupt | undefined> {
  const state = await graph.getState(config);
  for (const task of state.tasks) {
    const first = task.interrupts[0];
    if (first) {
      return { id: first.id, value: first.value };
    }
  }
  return undefined;
}

export type RecoveryStatus = "completed" | "waiting-for-input" | "interrupted-not-resumable";

export interface RecoveryClassification {
  readonly status: RecoveryStatus;
  readonly next: readonly string[];
  readonly hasPendingInterrupt: boolean;
}

export type RecoveryRefusalReason = "interrupted-not-resumable";

/**
 * Thrown by `RecoveryPolicy.continueIfIntact()` when the last durable
 * checkpoint reflects an incomplete step. `reason` is always exactly
 * `"interrupted-not-resumable"`, per this issue's acceptance criteria.
 */
export class RecoveryRefusedError extends Error {
  readonly reason: RecoveryRefusalReason;

  constructor(reason: RecoveryRefusalReason, message: string) {
    super(message);
    this.name = "RecoveryRefusedError";
    this.reason = reason;
  }
}

/**
 * The harness's own process-death recovery rule (M1.12, scenario 5). This
 * is deliberately NOT a LangGraph feature: LangGraph itself has no concept
 * of "the process that was running this graph died" -- a checkpoint that
 * stopped mid-step is, to `graph.invoke(null, config)`, indistinguishable
 * from one that is merely between supersteps, and LangGraph will happily
 * continue it (see the "negative demonstration" in
 * `test/scenarios.test.ts`, which calls `graph.invoke(null, config)`
 * directly, bypassing this class, to prove exactly that).
 *
 * The application-level rule this class encodes comes from
 * docs/v1-scope.md ("Lifecycle": "Execution actually stops unexpectedly" ->
 * Ticket Blocked, Round Interrupted, "explicit recovery required") and
 * docs/contracts/execution-interface.md ("Reconciliation on reconnect":
 * "Continuation of the same Round happens only when execution is reported
 * intact... Otherwise, Galley records the Round as Interrupted"). Michelin
 * (the real runner) is the thing that would "report" intactness; this
 * class is this experiment's local stand-in for that refusal, keyed off
 * the same signal Michelin would have to derive: whether the last durable
 * checkpoint shows a pending interrupt (a genuine, resumable pause) or an
 * incomplete step with no interrupt (consistent with the process dying
 * mid-tool-call, among other causes this class does not try to
 * distinguish -- see "Observed limitations" in the evidence record).
 */
export class RecoveryPolicy {
  constructor(private readonly graph: CompiledGraphLike) {}

  async classify(config: RunnableConfig): Promise<RecoveryClassification> {
    const state = await this.graph.getState(config);
    const hasPendingInterrupt = state.tasks.some((task) => task.interrupts.length > 0);
    const status: RecoveryStatus =
      state.next.length === 0 ? "completed" : hasPendingInterrupt ? "waiting-for-input" : "interrupted-not-resumable";
    return { status, next: state.next, hasPendingInterrupt };
  }

  /**
   * Refuses to resume a thread whose last durable checkpoint reflects an
   * incomplete step (non-empty `next`, no pending interrupt). Throws
   * `RecoveryRefusedError("interrupted-not-resumable")`. A
   * `"waiting-for-input"` classification (a genuine, answerable pause) or
   * `"completed"` classification is returned normally -- this method's
   * narrow job is the mid-node-death refusal this issue's scenario 5 asks
   * for, not a general-purpose "may I resume?" gate for every state.
   */
  async continueIfIntact(config: RunnableConfig): Promise<RecoveryClassification> {
    const classification = await this.classify(config);
    if (classification.status === "interrupted-not-resumable") {
      const threadId = (config.configurable as { thread_id?: string } | undefined)?.thread_id ?? "<unknown>";
      throw new RecoveryRefusedError(
        "interrupted-not-resumable",
        `Refusing to resume thread ${threadId}: the last durable checkpoint left next=[${classification.next.join(", ")}] ` +
          "with no pending interrupt, meaning a step began but never recorded completion -- consistent with the " +
          "executing process dying mid-tool-call. Per docs/v1-scope.md (\"Lifecycle\") and " +
          "docs/contracts/execution-interface.md (\"Reconciliation on reconnect\"), this Round is classified " +
          "Interrupted and its Ticket Blocked; automatic resume is refused even though the underlying framework " +
          "state could technically continue (graph.invoke(null, config) would not raise this objection). A person " +
          "must return the Ticket to Ready to start a new Round.",
      );
    }
    return classification;
  }
}
