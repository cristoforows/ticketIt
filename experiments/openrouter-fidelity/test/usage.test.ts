import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeOpenRouterServer } from "../src/server.js";
import { FIXTURES, USAGE_MODEL, USAGE_TEXT, FULL_USAGE } from "../src/fixtures.js";
import { makeModel, collectStream } from "./helpers.js";

// Matrix rows: "reasoning tokens", "cached tokens", "cache-write", "cost".
// Fixture (c): usage attached directly to the SAME chunk that carries
// finish_reason (contrast with the separate usage-only trailing chunk in
// usage-only-chunk.test.ts). Field names/shape per
// https://openrouter.ai/docs/guides/guides/usage-accounting
//
// Finding: `convertUsageMetadata` (dist/converters/messages.js) only maps
// prompt_tokens/completion_tokens/total_tokens, prompt_tokens_details.
// {cached_tokens -> cache_read, audio_tokens -> audio}, and
// completion_tokens_details.reasoning_tokens -> reasoning. It does NOT map
// `cost`, `cost_details`, or `prompt_tokens_details.cache_write_tokens`
// into `usage_metadata`. Those fields are not lost outright, though: the
// OpenAI-delegated converter copies the ENTIRE raw `usage` object onto
// `response_metadata.usage` (and, for invoke, the legacy
// `response_metadata.tokenUsage`), so cost and cache-write survive there.

function assertUsageMetadataNormalized(usageMetadata: Record<string, unknown> | undefined) {
  assert.ok(usageMetadata, "usage_metadata must be present");
  assert.deepEqual(usageMetadata, {
    input_tokens: 512,
    output_tokens: 18,
    total_tokens: 530,
    input_token_details: { cache_read: 256, audio: 0 },
    output_token_details: { reasoning: 6 },
  });
}

function assertRawUsagePreserved(rawUsage: Record<string, unknown> | undefined) {
  assert.ok(rawUsage, "response_metadata.usage must be present");
  assert.equal(rawUsage.cost, FULL_USAGE.cost);
  assert.deepEqual(rawUsage.cost_details, FULL_USAGE.cost_details);
  assert.equal(
    (rawUsage.prompt_tokens_details as Record<string, unknown>).cache_write_tokens,
    FULL_USAGE.prompt_tokens_details.cache_write_tokens,
  );
}

test("usage: invoke normalizes reasoning/cached tokens into usage_metadata; cost and cache-write only survive on response_metadata.usage", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(USAGE_MODEL, server.baseURL);
    const res = await model.invoke("what is the capital of france?");

    assert.equal(res.content, USAGE_TEXT);
    assertUsageMetadataNormalized(res.usage_metadata as unknown as Record<string, unknown>);
    // Confirm cost/cache-write are genuinely absent from the normalized surface.
    assert.equal((res.usage_metadata as unknown as Record<string, unknown>).cost, undefined);
    assertRawUsagePreserved(res.response_metadata.usage as Record<string, unknown>);

    // The adapter passed both documented usage-accounting mechanisms through.
    assert.equal(server.requests.length, 1);
    const body = server.requests[0]!.body as Record<string, unknown>;
    assert.deepEqual(body.usage, { include: true });
    assert.deepEqual(body.stream_options, { include_usage: true });
  } finally {
    await server.close();
  }
});

test("usage: stream normalizes the same fields when usage rides on the finish_reason chunk", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(USAGE_MODEL, server.baseURL);
    const stream = await model.stream("what is the capital of france?");
    const { chunks, concatenated } = await collectStream(stream);

    assert.equal(chunks.length, 2, "content chunk + finish_reason chunk carrying usage");
    assert.ok(concatenated);
    assert.equal(concatenated.content, USAGE_TEXT);
    assertUsageMetadataNormalized(concatenated.usage_metadata as unknown as Record<string, unknown>);
    assertRawUsagePreserved(concatenated.response_metadata.usage as Record<string, unknown>);
  } finally {
    await server.close();
  }
});
