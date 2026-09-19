import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CITATION_CONTENT,
  CITATION_START_CODEPOINTS,
  CITATION_END_CODEPOINTS,
  CITATION_TEXT,
  FULL_USAGE,
  toolCallFixture,
  usageOnlyChunkFixture,
} from "openrouter-fidelity/src/fixtures.js";
import { extractCitations } from "../src/citations.js";
import {
  computeRoundTotals,
  estimateCostFromTokens,
  extractRawMessage,
  mergeObservations,
  mergeRawSseEvents,
  normalizeFromAdapterMessage,
  normalizeFromRawResponse,
  type UsageObservation,
} from "../src/usage-ingest.js";

// ---------------------------------------------------------------------------
// extractCitations: codepoint-aware offsets over multi-byte Unicode content
// ---------------------------------------------------------------------------

test("extractCitations recovers the exact cited text with codepoint-aware offsets over Unicode content", () => {
  const annotations = [
    {
      type: "url_citation",
      url_citation: {
        url: "https://example.com/coffee-trends-2025",
        title: "Global Coffee Trends 2025",
        content: "Coffee consumption statistics for 2025.",
        start_index: CITATION_START_CODEPOINTS,
        end_index: CITATION_END_CODEPOINTS,
      },
    },
  ];

  const citations = extractCitations(CITATION_CONTENT, annotations);

  assert.equal(citations.length, 1);
  assert.equal(citations[0]!.url, "https://example.com/coffee-trends-2025");
  assert.equal(citations[0]!.startCodepoint, CITATION_START_CODEPOINTS);
  assert.equal(citations[0]!.endCodepoint, CITATION_END_CODEPOINTS);
  assert.equal(citations[0]!.citedText, CITATION_TEXT, "codepoint-aware slicing must recover the exact cited text");

  // The naive UTF-16 .slice() bug #25 demonstrated must NOT be silently
  // present in extractCitations's own recovered text.
  const naiveUtf16Slice = CITATION_CONTENT.slice(CITATION_START_CODEPOINTS, CITATION_END_CODEPOINTS);
  assert.notEqual(naiveUtf16Slice, CITATION_TEXT, "sanity: the naive slice is indeed wrong for this fixture (astral emoji precedes the span)");
});

test("extractCitations returns an empty array for undefined/non-array annotations (the adapter-surfaced case, per #25)", () => {
  assert.deepEqual(extractCitations("some content", undefined), []);
  assert.deepEqual(extractCitations("some content", null), []);
  assert.deepEqual(extractCitations("some content", "not-an-array"), []);
});

// ---------------------------------------------------------------------------
// normalizeFromAdapterMessage: the "honest, adapter-only" path
// ---------------------------------------------------------------------------

test("normalizeFromAdapterMessage normalizes reasoning/cached tokens and recovers cost/cache-write only via response_metadata.usage", () => {
  const observation = normalizeFromAdapterMessage({
    roundId: "round-1",
    message: {
      id: "gen-usage-1",
      content: "Paris is the capital of France.",
      usage_metadata: {
        input_tokens: FULL_USAGE.prompt_tokens,
        output_tokens: FULL_USAGE.completion_tokens,
        input_token_details: { cache_read: FULL_USAGE.prompt_tokens_details.cached_tokens },
        output_token_details: { reasoning: FULL_USAGE.completion_tokens_details.reasoning_tokens },
      },
      response_metadata: { usage: FULL_USAGE },
    },
  });

  assert.equal(observation.generationId, "gen-usage-1");
  assert.equal(observation.source, "adapter");
  assert.equal(observation.promptTokens, 512);
  assert.equal(observation.completionTokens, 18);
  assert.equal(observation.reasoningTokens, 6);
  assert.equal(observation.cachedTokens, 256);
  assert.equal(observation.cacheWriteTokens, 64, "cache-write is recoverable only via response_metadata.usage, not usage_metadata (#25)");
  assert.equal(observation.cost.status, "reported");
  if (observation.cost.status === "reported") {
    assert.equal(observation.cost.amount, 0.002145);
    assert.ok(observation.cost.provenance.length > 0);
  }
  assert.equal(observation.citations.length, 0, "the adapter never surfaces annotations (#25)");
});

test("normalizeFromAdapterMessage: usage never surfaced by the adapter yields unknown tokens and unknown cost, not zero", () => {
  const observation = normalizeFromAdapterMessage({
    roundId: "round-1",
    message: {
      id: "gen-usage-only-1",
      content: "The answer is 42.",
      // No usage_metadata, no response_metadata.usage at all -- this is
      // exactly what ChatOpenRouter's stream() surfaces for the
      // usage-only-trailing-chunk fixture (#25: "Entirely lost").
    },
  });

  assert.equal(observation.promptTokens, "unknown");
  assert.equal(observation.completionTokens, "unknown");
  assert.equal(observation.reasoningTokens, "unknown");
  assert.equal(observation.cachedTokens, "unknown");
  assert.equal(observation.cacheWriteTokens, "unknown");
  assert.equal(observation.cost.status, "unknown");
});

// ---------------------------------------------------------------------------
// extractRawMessage / mergeRawSseEvents: the out-of-band raw-capture path
// ---------------------------------------------------------------------------

test("extractRawMessage recovers citations and full usage from a raw JSON invoke body", () => {
  const annotatedJson = {
    id: "gen-citations-1",
    model: "test/citations",
    choices: [
      {
        message: {
          content: CITATION_CONTENT,
          annotations: [
            {
              type: "url_citation",
              url_citation: {
                url: "https://example.com/coffee-trends-2025",
                title: "Global Coffee Trends 2025",
                content: "Coffee consumption statistics for 2025.",
                start_index: CITATION_START_CODEPOINTS,
                end_index: CITATION_END_CODEPOINTS,
              },
            },
          ],
        },
      },
    ],
    usage: FULL_USAGE,
  };

  const raw = extractRawMessage(annotatedJson);
  const observation = normalizeFromRawResponse({ roundId: "round-1", raw });

  assert.equal(observation.generationId, "gen-citations-1");
  assert.equal(observation.source, "raw-capture");
  assert.equal(observation.citations.length, 1);
  assert.equal(observation.citations[0]!.citedText, CITATION_TEXT);
  assert.equal(observation.cost.status, "reported");
});

test("mergeRawSseEvents recovers usage from an empty-choices trailing chunk the adapter itself drops (#25's single most consequential finding)", () => {
  const merged = mergeRawSseEvents(usageOnlyChunkFixture.sse.chunks as Record<string, unknown>[]);

  assert.equal(merged.id, "gen-usage-only-1");
  assert.equal(merged.content, "The answer is 42.");
  // The raw capture reads every byte the server sent, including the final
  // empty-choices `usage` chunk ChatOpenRouter's _streamResponseChunks
  // `continue`s past -- so usage IS recoverable here, unlike on the
  // adapter-surfaced AIMessageChunk (see checkpoint-persistence.test.ts and
  // usage-only-chunk.test.ts for the adapter-alone contrast).
  assert.ok(merged.usage, "raw capture recovers usage the adapter drops");
  assert.equal(merged.usage!.prompt_tokens, FULL_USAGE.prompt_tokens);
  assert.equal((merged.usage as Record<string, unknown>)["cost"], FULL_USAGE.cost);

  const observation = normalizeFromRawResponse({ roundId: "round-1", raw: merged, source: "raw-capture" });
  assert.equal(observation.promptTokens, FULL_USAGE.prompt_tokens);
  assert.equal(observation.cost.status, "reported");
  assert.equal(observation.partial, false);
});

// ---------------------------------------------------------------------------
// mergeObservations
// ---------------------------------------------------------------------------

test("mergeObservations prefers adapter-carried fields and falls back to raw-capture only for what the adapter dropped", () => {
  const adapterObs = normalizeFromAdapterMessage({
    roundId: "round-1",
    message: {
      id: "gen-citations-1",
      content: CITATION_CONTENT,
      usage_metadata: { input_tokens: 88, output_tokens: 34 },
      // No annotations reach the adapter surface at all.
    },
  });
  const rawObs = normalizeFromRawResponse({
    roundId: "round-1",
    raw: extractRawMessage({
      id: "gen-citations-1",
      choices: [
        {
          message: {
            content: CITATION_CONTENT,
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  url: "https://example.com/coffee-trends-2025",
                  title: "t",
                  content: "c",
                  start_index: CITATION_START_CODEPOINTS,
                  end_index: CITATION_END_CODEPOINTS,
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 88, completion_tokens: 34 },
    }),
  });

  const merged = mergeObservations(adapterObs, rawObs);

  assert.equal(merged.source, "adapter+raw-capture");
  assert.equal(merged.promptTokens, 88, "adapter-carried token count preferred");
  assert.equal(merged.citations.length, 1, "citations recovered from raw capture, the only place they exist");
  assert.equal(merged.citations[0]!.citedText, CITATION_TEXT);
});

// ---------------------------------------------------------------------------
// estimateCostFromTokens
// ---------------------------------------------------------------------------

test("estimateCostFromTokens carries an explicit estimation basis and provenance", () => {
  const toolCallUsage = toolCallFixture.json.body["usage"] as { prompt_tokens: number; completion_tokens: number };
  const cost = estimateCostFromTokens(toolCallUsage.prompt_tokens, toolCallUsage.completion_tokens);

  assert.equal(cost.status, "estimated");
  if (cost.status === "estimated") {
    assert.ok(cost.basis.length > 0, "an estimated cost must carry a non-empty basis");
    assert.ok(cost.basis.includes("synthetic"), "the basis must be honest that this is a synthetic, test-only pricing table");
    assert.ok(cost.provenance.length > 0);
    assert.ok(cost.amount > 0);
  }
});

test("estimateCostFromTokens returns unknown (not a silent zero) when a token count is itself unknown", () => {
  const cost = estimateCostFromTokens("unknown", 34);
  assert.equal(cost.status, "unknown");
});

// ---------------------------------------------------------------------------
// computeRoundTotals: the ingestion rules from issue #26
// ---------------------------------------------------------------------------

function observation(overrides: Partial<UsageObservation>): UsageObservation {
  return {
    roundId: "round-1",
    generationId: "gen-x",
    source: "adapter",
    promptTokens: 10,
    completionTokens: 5,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    cost: { status: "reported", amount: 0.01, provenance: "test" },
    searchCost: { status: "unavailable", reason: "test" },
    citations: [],
    content: "hello",
    partial: false,
    ...overrides,
  };
}

test("computeRoundTotals: unknown usage is never summed as zero, and the incomplete flag is visible on the TOTAL", () => {
  const totals = computeRoundTotals("round-1", [
    observation({ generationId: "gen-1", promptTokens: 100, completionTokens: 20 }),
    observation({ generationId: "gen-2", promptTokens: "unknown", completionTokens: "unknown" }),
  ]);

  // 100, not 100 + 0: the unknown contribution is excluded from the sum,
  // never treated as zero.
  assert.equal(totals.promptTokens.sum, 100);
  assert.equal(totals.promptTokens.incomplete, true);
  assert.equal(totals.completionTokens.sum, 20);
  assert.equal(totals.completionTokens.incomplete, true);

  // The flag is visible on the TOTAL object itself, not only derivable by
  // re-scanning individual rows.
  assert.equal(totals.incomplete, true);
});

test("computeRoundTotals: a fully-known round has incomplete === false", () => {
  const totals = computeRoundTotals("round-1", [
    observation({ generationId: "gen-1", promptTokens: 100, completionTokens: 20 }),
    observation({ generationId: "gen-2", promptTokens: 50, completionTokens: 10 }),
  ]);
  assert.equal(totals.promptTokens.incomplete, false);
  assert.equal(totals.incomplete, false);
  assert.equal(totals.promptTokens.sum, 150);
});

test("computeRoundTotals: aggregate reported cost is distinguished from an unavailable search-cost breakdown, never inferred from it", () => {
  const totals = computeRoundTotals("round-1", [
    observation({ generationId: "gen-1", cost: { status: "reported", amount: 0.002145, provenance: "test" } }),
  ]);

  assert.equal(totals.cost.reportedSum, 0.002145);
  assert.equal(totals.searchCostBreakdown.status, "unavailable");
  // The breakdown must never be derived as some fraction/portion of the
  // aggregate reported cost.
  assert.ok(!("amount" in totals.searchCostBreakdown));
});

test("computeRoundTotals: mixing estimated and reported cost in one total keeps both visible", () => {
  const totals = computeRoundTotals("round-1", [
    observation({ generationId: "gen-reported", cost: { status: "reported", amount: 0.002145, provenance: "test" } }),
    observation({
      generationId: "gen-estimated",
      cost: { status: "estimated", amount: 0.00041, basis: "fixture pricing v1", provenance: "test" },
    }),
  ]);

  assert.equal(totals.cost.status, "mixed");
  assert.equal(totals.cost.reportedSum, 0.002145);
  assert.equal(totals.cost.estimatedSum, 0.00041);
  assert.equal(totals.cost.hasReported, true);
  assert.equal(totals.cost.hasEstimated, true);
});

test("computeRoundTotals: an unknown-cost contribution mixed with a reported one is flagged distinctly (mixed-with-unknown)", () => {
  const totals = computeRoundTotals("round-1", [
    observation({ generationId: "gen-reported", cost: { status: "reported", amount: 0.002145, provenance: "test" } }),
    observation({ generationId: "gen-unknown", cost: { status: "unknown", reason: "no cost field" } }),
  ]);

  assert.equal(totals.cost.status, "mixed-with-unknown");
  assert.equal(totals.cost.hasUnknown, true);
  assert.equal(totals.cost.unknownCount, 1);
  assert.equal(totals.incomplete, true, "an unknown cost contribution flags the whole total incomplete");
});

test("computeRoundTotals: a truncated stream's retained partial content and unknown tokens propagate into the total", () => {
  const totals = computeRoundTotals("round-1", [
    observation({
      generationId: "gen-truncated",
      promptTokens: "unknown",
      completionTokens: "unknown",
      cost: { status: "unknown", reason: "connection dropped before usage arrived" },
      content: "This response will be cut off ",
      partial: true,
    }),
  ]);

  assert.equal(totals.incomplete, true);
  assert.equal(totals.promptTokens.sum, 0);
  assert.equal(totals.promptTokens.incomplete, true);
  assert.equal(totals.observationCount, 1);
});
