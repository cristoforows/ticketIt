import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import type { AdmissionLedger } from "shared";
import { toAdmitRequest, type AdmissionScope } from "./admission-scope.js";
import { AdmissionRefused } from "./admission-refused.js";

/**
 * Wraps a `BaseChatModel` (a `ScriptedChatModel`, a `ControllableChatModel`,
 * or a real provider model) so every model call -- every `_generate`, and
 * every `_streamResponseChunks` -- first checks admission for the fixed
 * `scope`, because provider-executed web search happens *inside* the model
 * call: there is no separate, later, interceptable step for it (see
 * `docs/integration-feasibility.md`, "OpenRouter integration": "Search
 * occurs inside provider calls and may be an already-dispatched remote
 * action rather than a separately intercepted local tool"). This is why
 * this wrapper's admission point is the *whole model call*, not a step
 * inside it: once dispatched, "already dispatched" (v1-scope.md,
 * "Permissions and accounts": "Already-dispatched actions may complete on
 * expiry") applies to everything the provider did during that call,
 * including any search it ran, because nothing inside the call is visible
 * to admit() separately.
 *
 * Unlike `admittedTool`, a held/denied model call throws `AdmissionRefused`
 * directly rather than pausing via `interrupt()`. Two reasons, both
 * confirmed while building this package rather than assumed:
 *
 * 1. `createAgent`'s model node (`node_modules/langchain/dist/agents/ReactAgent.js`)
 *    has no error-catching layer analogous to `ToolNode`'s
 *    `handleToolErrors`, so a thrown error here is not silently swallowed
 *    into a synthetic message the way an uncaught tool error would be --
 *    it genuinely rejects `agent.invoke()`.
 * 2. `interrupt()` requires `@langchain/langgraph`'s checkpointer-backed
 *    scratchpad plumbing that is wired up per-node by the compiled graph;
 *    using it from inside a chat model (which `createAgent` treats as an
 *    opaque `Runnable`, not a graph node it authored an interrupt path
 *    for) is not a pattern this package's documentation research or
 *    fixture testing established as supported, so this wrapper does not
 *    attempt it for model calls. See "Observed limitations" in the
 *    evidence record.
 *
 * A held/denied model call is therefore coarser-grained than a held/denied
 * tool call: the whole `agent.invoke()` rejects, and resuming means a
 * fresh call on the same `threadId` (thread-level continuity), not a
 * step-level resume of the exact refused model call.
 */
export class AdmittedChatModel extends BaseChatModel {
  // `BaseChatModel`'s own constructor calls `this._llmType()` synchronously
  // during `super(fields)`, before control returns to this subclass's
  // constructor body -- i.e. before ES private fields declared here are
  // installed on `this` (private fields are only installed once `super()`
  // returns in the derived constructor). Touching `#inner` from
  // `_llmType()` therefore throws "Cannot read private member #inner from
  // an object whose class did not declare it" the first time it is called.
  // Observed directly while building this wrapper (scenario 2's test
  // failed with exactly that error before this was changed to a static
  // string). `_llmType()` is kept static/inner-independent for this
  // reason, not for lack of a more descriptive option.
  readonly #inner: BaseChatModel;
  readonly #ledger: AdmissionLedger;
  readonly #scope: AdmissionScope;

  constructor(
    inner: BaseChatModel,
    ledger: AdmissionLedger,
    scope: AdmissionScope,
    fields: BaseChatModelParams = {},
  ) {
    super(fields);
    this.#inner = inner;
    this.#ledger = ledger;
    this.#scope = scope;
  }

  _llmType(): string {
    return "admitted-chat-model";
  }

  /** The wrapped inner model, for tests that need to inspect its own request/response log. */
  get inner(): BaseChatModel {
    return this.#inner;
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<BaseChatModelCallOptions>,
  ): Runnable<any, AIMessageChunk, BaseChatModelCallOptions> {
    if (typeof this.#inner.bindTools !== "function") {
      throw new Error("AdmittedChatModel: wrapped model does not implement bindTools()");
    }
    const boundInner = this.#inner.bindTools(tools, kwargs) as unknown as BaseChatModel;
    const bound = new AdmittedChatModel(boundInner, this.#ledger, this.#scope);
    return bound as unknown as Runnable<any, AIMessageChunk, BaseChatModelCallOptions>;
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const admission = this.#ledger.admit(toAdmitRequest(this.#scope));

    if (admission.decision !== "allow") {
      throw new AdmissionRefused({
        admissionId: admission.admissionId,
        decision: admission.decision,
        reason: admission.reason,
        scope: this.#scope,
      });
    }

    this.#ledger.dispatch(admission.admissionId);
    // Deliberately does NOT wrap this call in try/catch to call complete()
    // only on success: an aborted or failing call must NOT be marked
    // complete() (that would misrepresent it as finished work). The
    // dispatch record with no completedAtMs is itself the retained
    // evidence that a call was in flight when it stopped -- see
    // `ledger.dispatches()` and the evidence record's fixture notes for
    // the pending-Stop/abort scenario.
    const result = await (
      this.#inner as unknown as {
        _generate(
          messages: BaseMessage[],
          options: Record<string, unknown>,
          runManager?: CallbackManagerForLLMRun,
        ): Promise<ChatResult>;
      }
    )._generate(messages, options, runManager);
    this.#ledger.complete(admission.admissionId);
    return result;
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    // Same admission gate as _generate, then defer to it for the actual
    // response (mirrors ScriptedChatModel's own single-chunk streaming
    // shim -- see native-harness/src/scripted-chat-model.ts).
    const result = await this._generate(messages, options, runManager);
    const generation = result.generations[0];
    if (!generation) {
      throw new Error("AdmittedChatModel: wrapped model returned no generations to stream.");
    }
    const message = generation.message;
    yield new ChatGenerationChunk({
      text: generation.text,
      message: new AIMessageChunk({
        content: message.content,
        tool_calls: (message as unknown as { tool_calls?: AIMessageChunk["tool_calls"] }).tool_calls,
        additional_kwargs: message.additional_kwargs,
        response_metadata: message.response_metadata,
      }),
    });
  }
}

/**
 * Wraps `model` so every call is checked against `ledger` for `scope`
 * before it runs. See {@link AdmittedChatModel} for the full behavior and
 * why model-call refusal surfaces as a thrown `AdmissionRefused` rather
 * than an `interrupt()`.
 */
export function admittedModel(
  model: BaseChatModel,
  ledger: AdmissionLedger,
  scope: AdmissionScope,
): AdmittedChatModel {
  return new AdmittedChatModel(model, ledger, scope);
}
