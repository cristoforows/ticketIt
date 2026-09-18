import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeOpenRouterServer } from "../src/server.js";
import { FIXTURES, TRUNCATED_MODEL, TRUNCATED_CHUNKS_DELIVERED } from "../src/fixtures.js";
import { makeModel, collectStream } from "./helpers.js";

// Matrix row: "truncated stream". Fixture (e): the connection is dropped
// (socket destroyed) before the SSE terminator (stream mode) or before the
// JSON body is complete (invoke mode). Both are network-level failures,
// distinct from the in-band `error` chunk in mid-stream-error.test.ts.
//
// Observed (Node v26.9.0 / undici bundled with it): both modes throw
// `TypeError: terminated` with `err.cause` a `SocketError: other side
// closed` (`code: "UND_ERR_SOCKET"`). This is undici's own error shape,
// not an OpenRouter-adapter-specific error class -- worth noting since a
// caller catching only `OpenRouterError` (see mid-stream-error.test.ts)
// would NOT catch this.

test("truncated stream: yields exactly the chunks sent before the drop, then throws TypeError('terminated')", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(TRUNCATED_MODEL, server.baseURL);
    const stream = await model.stream("go");
    const chunks: Awaited<ReturnType<typeof collectStream>>["chunks"] = [];
    let thrown: unknown;
    try {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    } catch (err) {
      thrown = err;
    }

    assert.equal(chunks.length, TRUNCATED_CHUNKS_DELIVERED, "partial chunks delivered before the connection dropped");
    const partialContent = chunks.map((c) => c.content).join("");
    assert.equal(partialContent, "This response will be cut off before completion because the connection drops unexpectedly ");

    assert.ok(thrown, "the stream iterator must throw once the connection drops");
    assert.equal((thrown as Error).name, "TypeError");
    assert.equal((thrown as Error).message, "terminated");
  } finally {
    await server.close();
  }
});

test("truncated stream (invoke mode): a JSON body cut off mid-response also throws TypeError('terminated'), never resolves", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(TRUNCATED_MODEL, server.baseURL);
    let resolved: unknown;
    let thrown: unknown;
    try {
      resolved = await model.invoke("go");
    } catch (err) {
      thrown = err;
    }

    assert.equal(resolved, undefined, "invoke must not resolve with a partial message");
    assert.ok(thrown, "invoke must reject when the JSON body is truncated");
    assert.equal((thrown as Error).name, "TypeError");
    assert.equal((thrown as Error).message, "terminated");
  } finally {
    await server.close();
  }
});
