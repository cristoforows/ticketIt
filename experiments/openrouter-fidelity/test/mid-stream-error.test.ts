import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatOpenRouter, OpenRouterError } from "@langchain/openrouter";
import { FakeOpenRouterServer } from "../src/server.js";
import {
  FIXTURES,
  MID_STREAM_ERROR_MODEL,
  MID_STREAM_ERROR_CODE,
  MID_STREAM_ERROR_MESSAGE,
  MID_STREAM_ERROR_CHUNKS_BEFORE,
} from "../src/fixtures.js";
import { makeModel, collectStream } from "./helpers.js";

// Matrix row: "mid-stream error". Fixture (f), stream mode: an in-band SSE
// `error` chunk with HTTP 200 preserved throughout (headers already sent),
// per https://openrouter.ai/docs/api-reference/streaming. Invoke mode uses
// OpenRouter's ordinary non-streaming error envelope
// (`{"error":{"code","message"}}` with a non-2xx status) as the closest
// real analog, since a truly "mid-stream" error has no meaning for a
// single JSON response.
//
// Finding (stream mode): `_streamResponseChunks` does NOT throw and does
// NOT read `data.error` at all. It builds a normal (empty-content) chunk
// from `choices[0].delta` and merges `finish_reason: "error"` into
// `response_metadata` the same way it merges any other finish_reason. The
// `error.code`/`error.message` payload itself is silently dropped -- not
// on additional_kwargs, not on response_metadata. A caller must notice
// `response_metadata.finish_reason === "error"` itself; nothing throws.

test("mid-stream error (stream mode): does NOT throw; finish_reason surfaces as 'error' but the error payload is silently dropped", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(MID_STREAM_ERROR_MODEL, server.baseURL);
    const stream = await model.stream("analyze this");
    let thrown: unknown;
    const { chunks, concatenated } = await (async () => {
      try {
        return await collectStream(stream);
      } catch (err) {
        thrown = err;
        return { chunks: [], concatenated: undefined };
      }
    })();

    assert.equal(thrown, undefined, "the adapter must not throw for an in-band error chunk");
    assert.equal(chunks.length, MID_STREAM_ERROR_CHUNKS_BEFORE + 1, "the 2 content chunks plus the (unremarkable-looking) error chunk");
    assert.ok(concatenated);
    assert.equal(concatenated.content, "Starting analysis... Partial results computed. ");
    assert.equal(concatenated.response_metadata.finish_reason, "error", "the only surfaced signal that something went wrong");

    // The actual error code/message are nowhere on the message.
    assert.equal(JSON.stringify(concatenated).includes(MID_STREAM_ERROR_CODE), false);
    assert.equal(JSON.stringify(concatenated).includes(MID_STREAM_ERROR_MESSAGE), false);
  } finally {
    await server.close();
  }
});

test("mid-stream error (invoke mode): a non-streaming HTTP error envelope throws a typed OpenRouterError", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(MID_STREAM_ERROR_MODEL, server.baseURL);
    let thrown: unknown;
    try {
      await model.invoke("analyze this");
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof OpenRouterError, "the adapter throws its own typed error for a non-2xx JSON error envelope");
    const err = thrown as OpenRouterError;
    assert.equal(err.statusCode, 502);
    assert.equal(err.code, MID_STREAM_ERROR_CODE);
    assert.match(err.message, new RegExp(MID_STREAM_ERROR_MESSAGE));

    assert.equal(server.requests.length, 1, "maxRetries: 0 -- no automatic retry against a persistently-failing fixture");
  } finally {
    await server.close();
  }
});

test("mid-stream error: maxRetries makes the caller retry N+1 times against a persistently-failing invoke", async () => {
  // Confirms the general retry mechanic (used to explain the DEFAULT
  // maxRetries=6 finding recorded in the evidence file) cheaply: a small
  // maxRetries here still demonstrates "N+1 total requests, exponential
  // backoff between them" without the ~105s / 7-request cost the actual
  // default incurs. See scripts/verify-default-retry.ts (documented in
  // README.md) to reproduce the exact default-configuration numbers.
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = new ChatOpenRouter({ model: MID_STREAM_ERROR_MODEL, apiKey: "dummy-key", baseURL: server.baseURL, maxRetries: 2 });
    let thrown: unknown;
    try {
      await model.invoke("analyze this");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof OpenRouterError);
    assert.equal(server.requests.length, 3, "1 initial attempt + 2 retries");
  } finally {
    await server.close();
  }
});
