import { FakeClock } from "shared";
import type { FixtureBundle } from "./server.js";

/**
 * All fixtures below are CONSTRUCTED from documentation, not captured from
 * a real OpenRouter response (this workspace never calls a real provider;
 * see experiments/README.md). Sources:
 *
 * - Chat completions / streaming shape, usage-only final chunk, SSE
 *   keep-alive comments:
 *   https://openrouter.ai/docs/api-reference/streaming
 * - Usage accounting fields (`usage.cost`, `usage.cost_details`,
 *   `usage.prompt_tokens_details.cached_tokens`,
 *   `usage.prompt_tokens_details.cache_write_tokens`,
 *   `usage.completion_tokens_details.reasoning_tokens`):
 *   https://openrouter.ai/docs/guides/guides/usage-accounting
 * - Web search URL citation annotations
 *   (`annotations[].url_citation.{url,title,content,start_index,end_index}`):
 *   https://openrouter.ai/docs/guides/features/plugins/web-search
 * - Mid-stream in-band error shape (`error: {code,message}` alongside
 *   `choices[0].finish_reason: "error"`, HTTP 200 preserved because
 *   headers were already sent): https://openrouter.ai/docs/api-reference/streaming
 * - Tool call and general chat-completions wire shape (OpenAI-compatible):
 *   https://docs.langchain.com/oss/javascript/integrations/chat/openrouter
 *
 * A fixed FakeClock (not wall time) supplies every fixture's `created`
 * timestamp so results are reproducible.
 */
const clock = new FakeClock("2026-09-19T00:00:00.000Z");
const CREATED = Math.floor(clock.nowMs() / 1000);

/** OpenRouter's own type declarations list "FakeProvider" as a valid provider name. */
const PROVIDER = "FakeProvider";

// ---------------------------------------------------------------------------
// (a) Tool call
// ---------------------------------------------------------------------------

export const TOOL_CALL_MODEL = "test/tool-call";
const TOOL_CALL_ID = "call_get_weather_1";

export const toolCallFixture: FixtureBundle = {
  json: {
    kind: "json",
    body: {
      id: "gen-tool-call-1",
      object: "chat.completion",
      created: CREATED,
      model: TOOL_CALL_MODEL,
      provider: PROVIDER,
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: TOOL_CALL_ID,
                type: "function",
                function: { name: "get_weather", arguments: JSON.stringify({ location: "Lisbon" }) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 41, completion_tokens: 11, total_tokens: 52 },
    },
  },
  sse: {
    kind: "sse",
    chunks: [
      {
        id: "gen-tool-call-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: TOOL_CALL_MODEL,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: [{ index: 0, id: TOOL_CALL_ID, type: "function", function: { name: "get_weather", arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "gen-tool-call-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: TOOL_CALL_MODEL,
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"location":' } }] }, finish_reason: null },
        ],
      },
      {
        id: "gen-tool-call-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: TOOL_CALL_MODEL,
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Lisbon"}' } }] }, finish_reason: null },
        ],
      },
      {
        id: "gen-tool-call-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: TOOL_CALL_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// (b) URL citation annotations over Unicode content
// ---------------------------------------------------------------------------

export const CITATIONS_MODEL = "test/citations";

/**
 * `CITATION_PREFIX` contains a precomposed accented letter (café, one UTF-16
 * code unit) and an astral emoji (😀, U+1F600 — a UTF-16 SURROGATE PAIR, so
 * two code units but one Unicode codepoint) before the cited span. OpenRouter's
 * docs do not state whether `start_index`/`end_index` are UTF-16 code-unit
 * offsets (native JS string indexing) or Unicode codepoint offsets (native
 * Python string indexing). This fixture constructs them as CODEPOINT offsets
 * -- the more likely convention for a non-JS backend -- specifically so a
 * test can check whether naive JS `content.slice(start_index, end_index)`
 * still recovers the correct cited substring once an astral character
 * precedes the span. This offset choice is a constructed assumption, not
 * observed from a real response.
 */
export const CITATION_PREFIX = "Overview: café trends 😀 examined by researchers. ";
export const CITATION_TEXT = "Global coffee consumption rose 4% in 2025.";
export const CITATION_SUFFIX = " Additional analysis follows.";
export const CITATION_CONTENT = CITATION_PREFIX + CITATION_TEXT + CITATION_SUFFIX;

export const CITATION_START_CODEPOINTS = Array.from(CITATION_PREFIX).length;
export const CITATION_END_CODEPOINTS = CITATION_START_CODEPOINTS + Array.from(CITATION_TEXT).length;

const CITATION_ANNOTATION = {
  type: "url_citation",
  url_citation: {
    url: "https://example.com/coffee-trends-2025",
    title: "Global Coffee Trends 2025",
    content: "Coffee consumption statistics for 2025, including regional breakdowns.",
    start_index: CITATION_START_CODEPOINTS,
    end_index: CITATION_END_CODEPOINTS,
  },
};

export const citationsFixture: FixtureBundle = {
  json: {
    kind: "json",
    body: {
      id: "gen-citations-1",
      object: "chat.completion",
      created: CREATED,
      model: CITATIONS_MODEL,
      provider: PROVIDER,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: CITATION_CONTENT,
            annotations: [CITATION_ANNOTATION],
          },
        },
      ],
      usage: { prompt_tokens: 88, completion_tokens: 34, total_tokens: 122 },
    },
  },
  sse: {
    kind: "sse",
    chunks: [
      {
        id: "gen-citations-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: CITATIONS_MODEL,
        choices: [{ index: 0, delta: { role: "assistant", content: CITATION_PREFIX }, finish_reason: null }],
      },
      {
        id: "gen-citations-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: CITATIONS_MODEL,
        choices: [{ index: 0, delta: { content: CITATION_TEXT }, finish_reason: null }],
      },
      {
        id: "gen-citations-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: CITATIONS_MODEL,
        choices: [
          { index: 0, delta: { content: CITATION_SUFFIX, annotations: [CITATION_ANNOTATION] }, finish_reason: null },
        ],
      },
      {
        id: "gen-citations-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: CITATIONS_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// (c) Usage accounting fields, attached to the finish_reason chunk
// ---------------------------------------------------------------------------

export const USAGE_MODEL = "test/usage";
export const USAGE_TEXT = "Paris is the capital of France.";

/** Field names and shape per https://openrouter.ai/docs/guides/guides/usage-accounting */
export const FULL_USAGE = {
  prompt_tokens: 512,
  completion_tokens: 18,
  total_tokens: 530,
  completion_tokens_details: { reasoning_tokens: 6 },
  prompt_tokens_details: { cached_tokens: 256, cache_write_tokens: 64, audio_tokens: 0 },
  cost: 0.002145,
  cost_details: { upstream_inference_cost: 0.0019 },
};

export const usageFixture: FixtureBundle = {
  json: {
    kind: "json",
    body: {
      id: "gen-usage-1",
      object: "chat.completion",
      created: CREATED,
      model: USAGE_MODEL,
      provider: PROVIDER,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: USAGE_TEXT } }],
      usage: FULL_USAGE,
    },
  },
  sse: {
    kind: "sse",
    chunks: [
      {
        id: "gen-usage-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: USAGE_MODEL,
        choices: [{ index: 0, delta: { role: "assistant", content: USAGE_TEXT }, finish_reason: null }],
      },
      {
        // Usage riding on the SAME chunk that carries finish_reason
        // (contrast with the usage-only trailing chunk in fixture (d)).
        id: "gen-usage-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: USAGE_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: FULL_USAGE,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// (d) Usage-only final SSE chunk (empty choices) before [DONE]
// ---------------------------------------------------------------------------

export const USAGE_ONLY_CHUNK_MODEL = "test/usage-only-chunk";
export const USAGE_ONLY_TEXT = "The answer is 42.";

export const usageOnlyChunkFixture: FixtureBundle = {
  json: {
    kind: "json",
    body: {
      id: "gen-usage-only-1",
      object: "chat.completion",
      created: CREATED,
      model: USAGE_ONLY_CHUNK_MODEL,
      provider: PROVIDER,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: USAGE_ONLY_TEXT } }],
      usage: FULL_USAGE,
    },
  },
  sse: {
    kind: "sse",
    chunks: [
      {
        id: "gen-usage-only-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: USAGE_ONLY_CHUNK_MODEL,
        choices: [{ index: 0, delta: { role: "assistant", content: USAGE_ONLY_TEXT }, finish_reason: null }],
      },
      {
        // finish_reason chunk carries NO usage.
        id: "gen-usage-only-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: USAGE_ONLY_CHUNK_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        // The documented usage-only final chunk: empty `choices`, `usage` present.
        id: "gen-usage-only-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: USAGE_ONLY_CHUNK_MODEL,
        choices: [],
        usage: FULL_USAGE,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// (e) Truncated stream (connection dropped before the terminator)
// ---------------------------------------------------------------------------

export const TRUNCATED_MODEL = "test/truncated";
const TRUNCATED_PARTS = [
  "This response will be cut off ",
  "before completion because the ",
  "connection drops unexpectedly ",
  "during generation for the ",
  "truncated-stream fixture.",
];
export const TRUNCATED_FULL_TEXT = TRUNCATED_PARTS.join("");
/** Number of SSE chunks actually delivered before the socket is destroyed. */
export const TRUNCATED_CHUNKS_DELIVERED = 3;

export const truncatedFixture: FixtureBundle = {
  json: {
    kind: "json",
    body: {
      id: "gen-truncated-1",
      object: "chat.completion",
      created: CREATED,
      model: TRUNCATED_MODEL,
      provider: PROVIDER,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: TRUNCATED_FULL_TEXT } }],
      usage: { prompt_tokens: 20, completion_tokens: 25, total_tokens: 45 },
    },
    // Cut the body well before it is valid JSON, then drop the connection --
    // the invoke-mode counterpart of the SSE truncateAfter behavior.
    truncateToChars: 60,
  },
  sse: {
    kind: "sse",
    chunks: [
      ...TRUNCATED_PARTS.map((text, i) => ({
        id: "gen-truncated-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: TRUNCATED_MODEL,
        choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: text } : { content: text }, finish_reason: null }],
      })),
      {
        id: "gen-truncated-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: TRUNCATED_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ],
    truncateAfter: TRUNCATED_CHUNKS_DELIVERED,
  },
};

// ---------------------------------------------------------------------------
// (f) Mid-stream error (in-band `error` chunk; HTTP 200 stays, per docs)
// ---------------------------------------------------------------------------

export const MID_STREAM_ERROR_MODEL = "test/mid-stream-error";
export const MID_STREAM_ERROR_CODE = "server_error";
export const MID_STREAM_ERROR_MESSAGE = "Provider disconnected unexpectedly";
/** Number of ordinary content chunks sent before the in-band error chunk. */
export const MID_STREAM_ERROR_CHUNKS_BEFORE = 2;

export const midStreamErrorFixture: FixtureBundle = {
  json: {
    kind: "json",
    // Non-streaming counterpart: OpenRouter's standard error envelope
    // (`{ error: { code, message } }`) returned with a non-2xx status,
    // handled by ChatOpenRouter's OpenRouterError.fromResponse().
    status: 502,
    body: { error: { code: MID_STREAM_ERROR_CODE, message: MID_STREAM_ERROR_MESSAGE } },
  },
  sse: {
    kind: "sse",
    chunks: [
      {
        id: "gen-mid-stream-error-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: MID_STREAM_ERROR_MODEL,
        choices: [{ index: 0, delta: { role: "assistant", content: "Starting analysis... " }, finish_reason: null }],
      },
      {
        id: "gen-mid-stream-error-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: MID_STREAM_ERROR_MODEL,
        choices: [{ index: 0, delta: { content: "Partial results computed. " }, finish_reason: null }],
      },
      {
        // Documented in-band error shape: https://openrouter.ai/docs/api-reference/streaming
        id: "gen-mid-stream-error-1",
        object: "chat.completion.chunk",
        created: CREATED,
        model: MID_STREAM_ERROR_MODEL,
        error: { code: MID_STREAM_ERROR_CODE, message: MID_STREAM_ERROR_MESSAGE },
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
      },
    ],
    // No truncateAfter: the connection terminates cleanly (data: [DONE])
    // after the in-band error, isolating "error payload" from "dropped
    // connection" (fixture (e)) as two distinct, separately testable
    // failure modes, per the issue's request for both.
  },
};

export const FIXTURES: Record<string, FixtureBundle> = {
  [TOOL_CALL_MODEL]: toolCallFixture,
  [CITATIONS_MODEL]: citationsFixture,
  [USAGE_MODEL]: usageFixture,
  [USAGE_ONLY_CHUNK_MODEL]: usageOnlyChunkFixture,
  [TRUNCATED_MODEL]: truncatedFixture,
  [MID_STREAM_ERROR_MODEL]: midStreamErrorFixture,
};
