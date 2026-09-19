import type { AdmitDecision, AdmitReason } from "shared";
import type { AdmissionScope } from "./admission-scope.js";

/** Fields describing why a call was refused admission. */
export interface AdmissionRefusalInfo {
  readonly admissionId: string;
  /** Always "hold" or "deny" -- `admittedTool`/`admittedModel` only construct this on a non-"allow" decision. */
  readonly decision: Exclude<AdmitDecision, "allow">;
  readonly reason: AdmitReason;
  readonly scope: AdmissionScope;
}

/**
 * Typed error raised when the admission ledger holds or denies a tool
 * execution or a model invocation. Both `admittedTool` and `admittedModel`
 * construct this on a non-"allow" decision, but surface it differently to
 * the graph -- see the doc comments on each for why:
 *
 * - `admittedModel` throws it directly. LangChain JS `createAgent`'s model
 *   node has no error-catching layer of its own (confirmed by reading
 *   `node_modules/langchain/dist/agents/ReactAgent.js`, which contains no
 *   try/catch around the model call), so this is a genuine exception
 *   surfaced to whoever called `agent.invoke()`.
 * - `admittedTool` does NOT throw this directly into the tool's `func`.
 *   `@langchain/langgraph`'s `ToolNode` defaults `handleToolErrors` to
 *   `true` and catches any plain thrown error, turning it into an error
 *   `ToolMessage` ("Error: ...\n Please fix your mistakes.") and letting
 *   the graph continue immediately -- which is NOT a pause, just an
 *   immediate continuation with a synthetic tool failure. The one
 *   exception `ToolNode` makes is `isGraphInterrupt(e)`, which it
 *   re-throws unconditionally (see
 *   `node_modules/@langchain/langgraph/dist/prebuilt/tool_node.js`).
 *   `admittedTool` therefore passes this error's structured fields to
 *   `@langchain/langgraph`'s `interrupt()` instead of throwing the error
 *   object itself, so the tool step genuinely pauses (graph state
 *   checkpointed, `agent.invoke()` resolves rather than rejects) and can
 *   be resumed later at the exact same step with `Command({ resume })`.
 */
export class AdmissionRefused extends Error {
  readonly admissionId: string;
  readonly decision: Exclude<AdmitDecision, "allow">;
  readonly reason: AdmitReason;
  readonly scope: AdmissionScope;

  constructor(info: AdmissionRefusalInfo) {
    super(
      `admission ${info.decision} (${info.reason}) for action "${info.scope.action}" on resource "${info.scope.resource}" (round ${info.scope.roundId})`,
    );
    this.name = "AdmissionRefused";
    this.admissionId = info.admissionId;
    this.decision = info.decision;
    this.reason = info.reason;
    this.scope = info.scope;
  }

  /** A plain, serializable payload suitable for `interrupt()` (which checkpoints its argument). */
  toInterruptPayload(): {
    type: "admission-refused";
    admissionId: string;
    decision: Exclude<AdmitDecision, "allow">;
    reason: AdmitReason;
    scope: AdmissionScope;
    message: string;
  } {
    return {
      type: "admission-refused",
      admissionId: this.admissionId,
      decision: this.decision,
      reason: this.reason,
      scope: this.scope,
      message: this.message,
    };
  }
}
