import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";

/** A gate returned by {@link ControllableChatModel.armDelay}, controlling one future call. */
export interface DelayGate {
  /** Lets the armed call's response resolve. A no-op if the call already settled (e.g. aborted). */
  release(): void;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Rejects with an AbortError as soon as `signal` fires; never resolves on its own. */
function abortRejection(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

class ControllableModelState {
  readonly responseQueue: AIMessage[];
  readonly requests: BaseMessage[][] = [];
  pendingDelay?: { promise: Promise<void>; release: () => void };

  constructor(responses: readonly AIMessage[]) {
    this.responseQueue = [...responses];
  }
}

export interface ControllableChatModelFields extends BaseChatModelParams {
  /** Pre-scripted responses, consumed in order -- same contract as native-harness's ScriptedChatModel. */
  responses: readonly AIMessage[];
}

/**
 * Like native-harness's `ScriptedChatModel`, but a call can be held open
 * until the test explicitly releases it (`armDelay()`), so a test can
 * observe ledger/connectivity state changing while a model call is
 * genuinely in flight (M1.13 scenarios 2 and 5), and can abort a held call
 * through the standard LangChain `options.signal` (`AbortSignal`) the way
 * a real provider call would be cancelled.
 *
 * This is new code in `experiments/native-admission`, not a modification
 * of `native-harness`: `ScriptedChatModel._generate` resolves as soon as
 * it is called (see native-harness/src/scripted-chat-model.ts), which
 * cannot represent "a promise you control" (issue #24's own phrasing for
 * scenario 2). `native-harness` was not modified to add this -- see the
 * evidence record's "native-harness changes" note.
 */
export class ControllableChatModel extends BaseChatModel {
  readonly #state: ControllableModelState;
  readonly #boundToolNames: readonly string[];

  constructor(
    fields: ControllableChatModelFields,
    sharedState?: ControllableModelState,
    boundToolNames: readonly string[] = [],
  ) {
    super(fields);
    this.#state = sharedState ?? new ControllableModelState(fields.responses);
    this.#boundToolNames = boundToolNames;
  }

  static create(
    responses: readonly AIMessage[],
    params: BaseChatModelParams = {},
  ): ControllableChatModel {
    return new ControllableChatModel({ ...params, responses });
  }

  _llmType(): string {
    return "controllable-chat-model";
  }

  get requests(): readonly BaseMessage[][] {
    return this.#state.requests;
  }

  get remainingResponses(): number {
    return this.#state.responseQueue.length;
  }

  /** Tool names this (possibly bound) copy was bound with, if any. */
  get boundToolNames(): readonly string[] {
    return this.#boundToolNames;
  }

  /**
   * Arms a delay gate for the NEXT `_generate` call on this model (or any
   * bound copy sharing its state): that call will not resolve its scripted
   * response until `release()` is called, or will reject with an
   * `AbortError` if `options.signal` fires first -- whichever happens
   * first. Only one armed delay is held at a time; arm again before each
   * call that needs to be held.
   */
  armDelay(): DelayGate {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#state.pendingDelay = { promise, release };
    return { release };
  }

  override bindTools(
    tools: BindToolsInput[],
    _kwargs?: Partial<BaseChatModelCallOptions>,
  ): Runnable<any, AIMessageChunk, BaseChatModelCallOptions> {
    const names = tools.map((candidate) =>
      typeof candidate === "object" && candidate !== null && "name" in candidate
        ? String((candidate as { name?: unknown }).name ?? "unknown-tool")
        : "unknown-tool",
    );
    const bound = new ControllableChatModel({ responses: [] }, this.#state, names);
    return bound as unknown as Runnable<any, AIMessageChunk, BaseChatModelCallOptions>;
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this.#state.requests.push([...messages]);

    const delay = this.#state.pendingDelay;
    this.#state.pendingDelay = undefined;
    if (delay) {
      await Promise.race([delay.promise, abortRejection(options.signal)]);
    } else if (options.signal?.aborted) {
      throw abortError();
    }

    const next = this.#state.responseQueue.shift();
    if (!next) {
      throw new Error(
        "ControllableChatModel: no scripted response left to return. " +
          `Received ${messages.length} message(s) but the response queue is empty.`,
      );
    }

    return {
      generations: [
        {
          text: messageTextContent(next) ?? "",
          message: next,
        },
      ],
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const result = await this._generate(messages, options, runManager);
    const generation = result.generations[0];
    if (!generation) {
      throw new Error("ControllableChatModel: _generate returned no generations to stream.");
    }
    const message = generation.message as AIMessage;
    yield new ChatGenerationChunk({
      text: generation.text,
      message: new AIMessageChunk({
        content: message.content,
        tool_calls: message.tool_calls,
        additional_kwargs: message.additional_kwargs,
        response_metadata: message.response_metadata,
      }),
    });
  }
}

function messageTextContent(message: BaseMessage): string | undefined {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    const text = message.content
      .map((block) =>
        typeof block === "object" && block && "text" in block ? String((block as { text: unknown }).text) : "",
      )
      .join("");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}
