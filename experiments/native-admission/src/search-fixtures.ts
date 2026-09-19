import { AIMessage } from "@langchain/core/messages";

/**
 * Builds a scripted `AIMessage` simulating a provider-executed web-search
 * reply (OpenRouter's web-search plugin), for scenario 7 (provider-executed
 * search classification).
 *
 * Shape is DOCUMENTATION RESEARCH, not observed: OpenRouter's web-search
 * plugin docs (https://openrouter.ai/docs/guides/features/plugins/web-search,
 * read for `docs/integration-feasibility.md`'s "OpenRouter integration"
 * row) describe URL citations returned alongside the completion; OpenAI-
 * compatible citation annotations conventionally appear as an
 * `annotations` array of `{ type: "url_citation", url_citation: { url,
 * title, content, start_index, end_index } }` objects on the message, and
 * LangChain's OpenAI-family chat models surface non-standard response
 * fields under `additional_kwargs` (confirmed pattern in this repo:
 * `native-harness`'s own `ScriptedChatModel` puts everything the "model"
 * returns verbatim on the `AIMessage` it hands back). This experiment
 * workspace makes no live OpenRouter call (see `experiments/README.md`,
 * "No calls to real providers"), so the exact field names/values here are
 * an unverified approximation of the real shape, clearly labeled as such
 * in the evidence record.
 */
export function simulatedWebSearchReply(): AIMessage {
  return new AIMessage({
    content:
      "Based on a web search, the current stable release is documented at the URL cited below.",
    additional_kwargs: {
      annotations: [
        {
          type: "url_citation",
          url_citation: {
            url: "https://example.invalid/docs/release-notes",
            title: "Release notes (fixture)",
            content: "Fixture citation content -- no real network call was made.",
            start_index: 0,
            end_index: 0,
          },
        },
      ],
    },
    response_metadata: {
      model: "fixture/simulated-search-model",
      // OpenRouter's usage-accounting docs (see docs/integration-feasibility.md,
      // "OpenRouter accounting" row) mention a search-cost breakdown; simulated
      // here as an explicit, clearly-fixture number rather than omitted, so a
      // test can assert this experiment does not invent a *tool* admission
      // for it (see scenario 7).
      usage: { search_context_cost: 0.0042 },
    },
  });
}
