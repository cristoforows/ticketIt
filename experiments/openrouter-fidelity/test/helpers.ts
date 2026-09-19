import { ChatOpenRouter } from "@langchain/openrouter";
import type { AIMessageChunk } from "@langchain/core/messages";

/**
 * Builds a `ChatOpenRouter` pointed at the fake server with a dummy key.
 *
 * `maxRetries: 0` is load-bearing for the error-fixture tests: the base
 * LangChain caller retries a failed (non-2xx) request up to 6 times with
 * exponential backoff by default (observed: ~105s and 7 total requests
 * against a persistently-failing fixture). We disable that here so tests
 * stay fast and so `server.requests.length` reflects exactly one call per
 * `invoke`/`stream`; the default-retry behavior itself is recorded in the
 * evidence file as an observed limitation, not exercised by these tests.
 *
 * `modelKwargs` passes the two documented usage-accounting mechanisms
 * through to the request body (see fixtures.ts and the evidence file for
 * why both are set): OpenRouter's own (now-automatic/deprecated per its
 * current docs) `usage.include`, and the OpenAI-standard
 * `stream_options.include_usage` that `@langchain/openrouter`'s own
 * request types (`OpenRouter.ChatStreamOptions`) model.
 */
export function makeModel(model: string, baseURL: string, overrides: Record<string, unknown> = {}): ChatOpenRouter {
  return new ChatOpenRouter({
    model,
    apiKey: "dummy-key",
    baseURL,
    maxRetries: 0,
    modelKwargs: { usage: { include: true }, stream_options: { include_usage: true } },
    ...overrides,
  });
}

export interface CollectedStream {
  chunks: AIMessageChunk[];
  /** All chunks concatenated with `.concat()`, or `undefined` if none arrived. */
  concatenated: AIMessageChunk | undefined;
}

/** Drains an async iterable of message chunks, concatenating as it goes. */
export async function collectStream(stream: AsyncIterable<AIMessageChunk>): Promise<CollectedStream> {
  const chunks: AIMessageChunk[] = [];
  let concatenated: AIMessageChunk | undefined;
  for await (const chunk of stream) {
    chunks.push(chunk);
    concatenated = concatenated ? concatenated.concat(chunk) : chunk;
  }
  return { chunks, concatenated };
}
