import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  AIMessage,
  AIMessageChunk,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";

/**
 * One request the ScriptedChatModel actually received, captured verbatim so
 * a test can assert on exactly what the agent sent (system prompt included,
 * since createAgent folds the system prompt into the first message of the
 * messages array rather than passing it out of band).
 */
export interface ScriptedRequest {
  /** Every message the model received for this call, in order. */
  readonly messages: readonly BaseMessage[];
  /** The system prompt content, if the first message was a SystemMessage. */
  readonly systemPrompt: string | undefined;
  /** Names of the tools bound at the time this request was made, if any. */
  readonly boundToolNames: readonly string[];
}

/**
 * Mutable state shared between a ScriptedChatModel and every bound copy
 * `bindTools()` produces from it. createAgent calls `model.bindTools(tools)`
 * once to obtain a tool-aware runnable and then invokes THAT object, not the
 * original instance -- so the queue of scripted responses and the request
 * log must live in a shared object, not on `this`, or a bound copy would
 * start from an empty queue.
 */
class ScriptedModelState {
  readonly responseQueue: AIMessage[];
  readonly requests: ScriptedRequest[] = [];

  constructor(responses: readonly AIMessage[]) {
    this.responseQueue = [...responses];
  }
}

export interface ScriptedChatModelFields extends BaseChatModelParams {
  /**
   * Pre-scripted responses returned in order, one per call to the model
   * (i.e. one per agent "step"). Include AIMessages with `tool_calls` to
   * script a tool-calling turn, followed by a plain-text AIMessage for the
   * agent's final reply.
   */
  responses: readonly AIMessage[];
}

/**
 * A `BaseChatModel` that never makes a network call: it returns pre-scripted
 * `AIMessage`s from a queue, in order, and records every request it
 * receives. Used to boot the native harness (LangChain JS `createAgent`)
 * deterministically, without a real model provider.
 */
export class ScriptedChatModel extends BaseChatModel {
  private readonly state: ScriptedModelState;
  private readonly boundToolNames: readonly string[];

  constructor(
    fields: ScriptedChatModelFields,
    sharedState?: ScriptedModelState,
    boundToolNames: readonly string[] = [],
  ) {
    super(fields);
    this.state = sharedState ?? new ScriptedModelState(fields.responses);
    this.boundToolNames = boundToolNames;
  }

  static create(
    responses: readonly AIMessage[],
    params: BaseChatModelParams = {},
  ): ScriptedChatModel {
    return new ScriptedChatModel({ ...params, responses });
  }

  _llmType(): string {
    return "scripted-chat-model";
  }

  /** Every request this model (or any of its bound copies) has received. */
  get requests(): readonly ScriptedRequest[] {
    return this.state.requests;
  }

  /** How many scripted responses remain unconsumed. */
  get remainingResponses(): number {
    return this.state.responseQueue.length;
  }

  /**
   * Returns a bound copy that shares this model's response queue and
   * request log, but records the tool names it was bound with. Mirrors
   * `BaseChatModel.bindTools`, required for `createAgent` to attach tools.
   */
  override bindTools(
    tools: BindToolsInput[],
    _kwargs?: Partial<BaseChatModelCallOptions>,
  ): Runnable<any, AIMessageChunk, BaseChatModelCallOptions> {
    const names = tools.map((candidate) => extractToolName(candidate));
    const bound = new ScriptedChatModel({ responses: [] }, this.state, names);
    return bound as unknown as Runnable<any, AIMessageChunk, BaseChatModelCallOptions>;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const next = this.state.responseQueue.shift();
    if (!next) {
      throw new Error(
        "ScriptedChatModel: no scripted response left to return. " +
          `Received ${messages.length} message(s) but the response queue is empty; ` +
          "pass enough AIMessages to ScriptedChatModel.create() for every model call " +
          "the scripted turn makes.",
      );
    }

    const firstMessage = messages[0];
    const systemPrompt =
      firstMessage instanceof SystemMessage ? messageTextContent(firstMessage) : undefined;

    this.state.requests.push({
      messages: [...messages],
      systemPrompt,
      boundToolNames: this.boundToolNames,
    });

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
    // Simple, single-chunk streaming: resolve the whole scripted response
    // through _generate and yield it as one chunk. createAgent does not
    // require real token-level streaming to function.
    const result = await this._generate(messages, options, runManager);
    const generation = result.generations[0];
    if (!generation) {
      throw new Error("ScriptedChatModel: _generate returned no generations to stream.");
    }
    const message = generation.message as AIMessage;
    yield new ChatGenerationChunk({
      text: generation.text,
      message: new AIMessageChunk({
        content: message.content,
        tool_calls: message.tool_calls,
        additional_kwargs: message.additional_kwargs,
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
      .map((block) => (typeof block === "object" && block && "text" in block ? String((block as { text: unknown }).text) : ""))
      .join("");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function extractToolName(candidate: BindToolsInput): string {
  if (typeof candidate === "object" && candidate !== null && "name" in candidate) {
    const { name } = candidate as { name?: unknown };
    if (typeof name === "string") {
      return name;
    }
  }
  return "unknown-tool";
}
