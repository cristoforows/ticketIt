import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeOpenRouterServer } from "../src/server.js";
import { FIXTURES, TOOL_CALL_MODEL } from "../src/fixtures.js";
import { makeModel, collectStream } from "./helpers.js";

// Matrix row: "tool call". Fixture (a): a single tool call, delivered as a
// full message (invoke) or as index-keyed streaming deltas (stream) per
// https://docs.langchain.com/oss/javascript/integrations/chat/openrouter

test("tool call: invoke surfaces the parsed tool call, raw tool call, and usage_metadata", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(TOOL_CALL_MODEL, server.baseURL);
    const res = await model.invoke("what's the weather in lisbon?");

    assert.equal(res.content, "");
    assert.deepEqual(res.tool_calls, [
      { name: "get_weather", args: { location: "Lisbon" }, id: "call_get_weather_1", type: "tool_call" },
    ]);
    assert.equal((res.invalid_tool_calls ?? []).length, 0);
    // Raw provider tool_calls survive alongside the normalized ones.
    assert.equal(res.additional_kwargs.tool_calls?.[0]?.function?.arguments, '{"location":"Lisbon"}');
    assert.equal(res.response_metadata.finish_reason, "tool_calls");
    assert.deepEqual(res.usage_metadata, { input_tokens: 41, output_tokens: 11, total_tokens: 52 });

    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("tool call: stream assembles tool_call_chunks by index into the same final tool call", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(TOOL_CALL_MODEL, server.baseURL);
    const stream = await model.stream("what's the weather in lisbon?");
    const { chunks, concatenated } = await collectStream(stream);

    assert.equal(chunks.length, 4, "one delta per SSE chunk from the fixture");
    assert.ok(concatenated);
    assert.equal(concatenated.content, "");
    assert.deepEqual(concatenated.tool_calls, [
      { name: "get_weather", args: { location: "Lisbon" }, id: "call_get_weather_1", type: "tool_call" },
    ]);
    assert.equal(concatenated.response_metadata.finish_reason, "tool_calls");

    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});
