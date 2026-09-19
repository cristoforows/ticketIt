import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import type { AdmissionLedger } from "shared";
import { toAdmitRequest, type AdmissionScope } from "./admission-scope.js";
import { AdmissionRefused } from "./admission-refused.js";

/**
 * Wraps a LangChain tool so every execution first calls
 * `ledger.admit(...)` for the fixed `scope`:
 *
 * - On "allow": records `dispatch()`, runs the original tool via
 *   `.invoke()`, then records `complete()` and returns the real output.
 *   The model sees the tool's genuine result -- no admission machinery is
 *   visible to it on the happy path.
 * - On "hold" or "deny": the original tool's `func` never runs. The
 *   refusal is raised through `@langchain/langgraph`'s `interrupt()`
 *   (see `AdmissionRefused`'s doc comment for exactly why this, and not a
 *   thrown error or a returned refusal string, is what makes the graph
 *   genuinely pause here rather than silently continuing with a synthetic
 *   tool failure). This means: **the model is never shown a refusal
 *   message for a held/denied tool call.** The step pauses before the
 *   model's next turn is ever requested. If the same thread is later
 *   resumed with `agent.invoke(new Command({ resume: <anything> }),
 *   { configurable: { thread_id } })` after admission is fixed (a new
 *   grant, reconnect, etc.), LangGraph replays this whole wrapped
 *   function from the top: `ledger.admit()` is re-evaluated fresh, and if
 *   it now allows, the tool runs and the model receives the real tool
 *   result it would have gotten on the very first attempt -- it never
 *   sees the fact that an earlier attempt was held or denied. This is the
 *   behavior chosen for the model-facing result; the alternative (return
 *   a structured refusal `ToolMessage` and let the model react) was
 *   rejected because it can't be resumed at the same step and would
 *   consume one of the scripted model's fixed turns to react to an
 *   admission concern rather than the actual tool result.
 *
 * IMPORTANT (per `@langchain/langgraph`'s `interrupt()` doc comment):
 * because the whole node replays from the top on resume, any code in the
 * original tool's `func` that ran before a hold/deny would repeat on
 * resume too. This wrapper avoids that by checking admission BEFORE ever
 * calling the original tool's `.invoke()`, so nothing of the tool's own
 * effect can have run yet when a hold/deny is hit.
 */
export function admittedTool<T extends StructuredToolInterface>(
  originalTool: T,
  ledger: AdmissionLedger,
  scope: AdmissionScope,
): T {
  const wrapped = tool(
    async (args: unknown) => {
      const admission = ledger.admit(toAdmitRequest(scope));

      if (admission.decision === "allow") {
        ledger.dispatch(admission.admissionId);
        const output = await originalTool.invoke(args as Parameters<T["invoke"]>[0]);
        ledger.complete(admission.admissionId);
        return output;
      }

      const refused = new AdmissionRefused({
        admissionId: admission.admissionId,
        decision: admission.decision,
        reason: admission.reason,
        scope,
      });

      // Throws GraphInterrupt on first attempt (pausing this tool step).
      // On a later replay triggered by Command({ resume }), the admission
      // check above runs again first; this line is only reached again if
      // that fresh check is STILL not "allow". In that (untested by this
      // slice's scenarios) case, `interrupt()` returning instead of
      // throwing here would mean LangGraph is replaying a resume this
      // call site was not the one waiting on -- treat it as an internal
      // consistency failure rather than silently fabricating a result.
      interrupt(refused.toInterruptPayload());
      throw new Error(
        "admittedTool: interrupt() returned instead of throwing/pausing; " +
          "this means admission was still not \"allow\" on a resumed replay, " +
          "which none of this slice's scenarios exercise -- see the doc comment.",
      );
    },
    {
      name: originalTool.name,
      description: originalTool.description,
      schema: (originalTool as unknown as { schema: unknown }).schema as never,
    },
  );
  return wrapped as unknown as T;
}
