import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeOpenRouterServer } from "../src/server.js";
import { FIXTURES, USAGE_ONLY_CHUNK_MODEL, USAGE_ONLY_TEXT } from "../src/fixtures.js";
import { makeModel, collectStream } from "./helpers.js";

// Matrix row: "usage-only final chunk". Fixture (d): a trailing SSE chunk
// with empty `choices` and `usage` present, per
// https://openrouter.ai/docs/api-reference/streaming ("usage is always
// included in the final chunk when streaming").
//
// Finding: `ChatOpenRouter._streamResponseChunks` (chat_models/index.ts)
// does `const choice = data.choices?.[0]; if (!choice?.delta) continue;`.
// When `choices` is `[]`, `choice` is `undefined`, so this chunk is
// skipped entirely -- the adapter's `.stream()` never even calls the
// delta converter for it. Usage/cost delivered this way is silently and
// completely lost in streaming mode, even though the fake server sent it
// correctly and `usage_metadata`/`response_metadata.usage` work fine when
// usage instead rides on the finish_reason chunk (see usage.test.ts).

test("usage-only-chunk: server actually sends the documented empty-choices trailing chunk", async () => {
  // Sanity-check the fixture/server themselves (independent of the
  // adapter) before showing the adapter drops it.
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const res = await fetch(`${server.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: USAGE_ONLY_CHUNK_MODEL, stream: true, messages: [] }),
    });
    const text = await res.text();
    const dataLines = text.split("\n\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]");
    assert.equal(dataLines.length, 3, "content chunk + finish_reason chunk + usage-only chunk");
    const lastChunk = JSON.parse(dataLines.at(-1)!.slice("data: ".length));
    assert.deepEqual(lastChunk.choices, []);
    assert.ok(lastChunk.usage);
  } finally {
    await server.close();
  }
});

test("usage-only-chunk: invoke surfaces usage normally (no trailing-chunk concept in a single JSON response)", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(USAGE_ONLY_CHUNK_MODEL, server.baseURL);
    const res = await model.invoke("what is the answer?");
    assert.equal(res.content, USAGE_ONLY_TEXT);
    assert.ok(res.usage_metadata, "invoke has no partial-delivery point; usage surfaces as usual");
    assert.equal(res.usage_metadata!.total_tokens, 530);
  } finally {
    await server.close();
  }
});

test("usage-only-chunk: stream DROPS the usage-only trailing chunk entirely -- no usage_metadata, no response_metadata.usage", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(USAGE_ONLY_CHUNK_MODEL, server.baseURL);
    const stream = await model.stream("what is the answer?");
    const { chunks, concatenated } = await collectStream(stream);

    // The fixture sends 3 chunks; the adapter only yields 2 -- the
    // empty-choices usage chunk never becomes a ChatGenerationChunk.
    assert.equal(chunks.length, 2);
    assert.ok(concatenated);
    assert.equal(concatenated.content, USAGE_ONLY_TEXT);
    assert.equal(concatenated.usage_metadata, undefined, "usage_metadata is entirely absent");
    assert.deepEqual(concatenated.response_metadata.usage, {}, "response_metadata.usage never receives the trailing chunk's data");
  } finally {
    await server.close();
  }
});
