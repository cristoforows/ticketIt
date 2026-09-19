import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";

/** One scripted "chunk" of a streamed reply: text plus its own token usage delta. */
export interface PartialOutputChunk {
  readonly text: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** A snapshot of everything accumulated by a call up to the moment it last made progress or was aborted. */
export interface PartialCapture {
  readonly content: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly chunksEmitted: number;
  readonly aborted: boolean;
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

/**
 * A scripted chat model purpose-built for M1.13 scenario 5 (pending Stop /
 * abort). It "streams" a fixed list of chunks one at a time, gated by
 * explicit `release()` calls (the same deterministic-gate convention as
 * `ControllableChatModel` -- no real timers), and records a `PartialCapture`
 * snapshot after every chunk it manages to append AND right before it
 * throws on an aborted gate. This lets a test abort a call partway through
 * and assert exactly how much content and usage had accumulated at that
 * point -- something neither `native-harness`'s `ScriptedChatModel` (single
 * request/response, no partial state) nor `ControllableChatModel` (a single
 * all-or-nothing gate around one whole scripted `AIMessage`) can express.
 *
 * This is new code in `experiments/native-admission`, not a modification of
 * `native-harness`: representing "content that arrived before an abort"
 * needs per-chunk accumulation, which is out of scope for the boot-test
 * tracer package. It has no tool-binding behavior because scenario 5 uses
 * no tools -- `bindTools()` is a no-op returning `this`, which is
 * sufficient for `createAgent`'s own `bindTools([])` call when the tools
 * array is empty (confirmed while building this fixture: `createAgent`
 * still calls `model.bindTools(tools)` once even for a zero-length `tools`
 * array).
 */
export class PartialOutputChatModel extends BaseChatModel {
  readonly #chunks: readonly PartialOutputChunk[];
  readonly #gates = new Map<number, { promise: Promise<void>; release: () => void }>();
  #lastCapture: PartialCapture | undefined;

  constructor(chunks: readonly PartialOutputChunk[], fields: BaseChatModelParams = {}) {
    super(fields);
    this.#chunks = chunks;
  }

  _llmType(): string {
    return "partial-output-chat-model";
  }

  /** Snapshot of the most recent call's accumulated content/usage, taken right before it last settled (a successful chunk append or an abort). */
  get lastCapture(): PartialCapture | undefined {
    return this.#lastCapture;
  }

  /**
   * Arms a gate that must be `release()`d before the chunk at
   * `atChunkIndex` (0-based) is appended. Used to hold a call open exactly
   * at a chosen chunk boundary so a test can fire an AbortSignal while it
   * waits there. Targeting the gate by index (rather than "the next call to
   * `_generate`") is deliberate: it lets a test arm the gate for, say,
   * chunk 1 BEFORE the call even starts, while chunk 0 still appends
   * immediately -- there is no other synchronization point between two
   * chunks of the same non-streamed `_generate` call for a test to hook
   * into once the call has started (no `await` boundary separates them
   * unless a gate is already waiting). A chunk index with no armed gate
   * appends immediately (subject only to an already-aborted signal).
   */
  armChunkGate(atChunkIndex: number): { release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#gates.set(atChunkIndex, { promise, release });
    return { release };
  }

  override bindTools(
    _tools: unknown[],
    _kwargs?: Partial<BaseChatModelCallOptions>,
  ): Runnable<any, AIMessageChunk, BaseChatModelCallOptions> {
    // Scenario 5 uses no tools; this model never needs a tool-aware bound
    // copy, so it returns itself rather than building one (see class doc).
    return this as unknown as Runnable<any, AIMessageChunk, BaseChatModelCallOptions>;
  }

  async _generate(
    _messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let emitted = 0;

    for (let index = 0; index < this.#chunks.length; index += 1) {
      const chunk = this.#chunks[index]!;
      const gate = this.#gates.get(index);
      this.#gates.delete(index);
      try {
        if (gate) {
          await Promise.race([gate.promise, abortRejection(options.signal)]);
        } else if (options.signal?.aborted) {
          throw abortError();
        }
      } catch (error) {
        this.#lastCapture = {
          content,
          usage: { inputTokens, outputTokens },
          chunksEmitted: emitted,
          aborted: true,
        };
        throw error;
      }

      content += chunk.text;
      inputTokens += chunk.inputTokens ?? 0;
      outputTokens += chunk.outputTokens ?? 0;
      emitted += 1;
      this.#lastCapture = {
        content,
        usage: { inputTokens, outputTokens },
        chunksEmitted: emitted,
        aborted: false,
      };
    }

    return {
      generations: [
        {
          text: content,
          message: new AIMessage({
            content,
            response_metadata: { usage: { inputTokens, outputTokens } },
          }),
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
      throw new Error("PartialOutputChatModel: _generate returned no generations to stream.");
    }
    yield new ChatGenerationChunk({
      text: generation.text,
      message: new AIMessageChunk({
        content: generation.message.content,
        response_metadata: generation.message.response_metadata,
      }),
    });
  }
}
