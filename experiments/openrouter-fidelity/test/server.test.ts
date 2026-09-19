import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeOpenRouterServer } from "../src/server.js";
import { FIXTURES, TOOL_CALL_MODEL, TRUNCATED_MODEL, MID_STREAM_ERROR_MODEL } from "../src/fixtures.js";

test("server: serves the JSON fixture for a non-streaming request and records the request minus auth", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const res = await fetch(`${server.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer super-secret-dummy-key" },
      body: JSON.stringify({ model: TOOL_CALL_MODEL, stream: false, messages: [] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.model, TOOL_CALL_MODEL);
    assert.equal(body.object, "chat.completion");

    assert.equal(server.requests.length, 1);
    const recorded = server.requests[0]!;
    assert.equal(recorded.method, "POST");
    assert.equal(recorded.path, "/chat/completions");
    assert.equal("authorization" in recorded.headers, false, "authorization header must not be recorded");
    assert.equal((recorded.body as { model: string }).model, TOOL_CALL_MODEL);
  } finally {
    await server.close();
  }
});

test("server: serves SSE fixture chunks terminated with [DONE] for a streaming request", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const res = await fetch(`${server.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: JSON.stringify({ model: TOOL_CALL_MODEL, stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    const dataLines = text.split("\n\n").filter((line) => line.startsWith("data: "));
    assert.equal(dataLines.at(-1), "data: [DONE]");
    assert.equal(dataLines.length, 5); // 4 fixture chunks + [DONE]
  } finally {
    await server.close();
  }
});

test("server: truncates an SSE stream after N chunks with no [DONE]", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    let threw = false;
    let partialText = "";
    try {
      const res = await fetch(`${server.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer dummy" },
        body: JSON.stringify({ model: TRUNCATED_MODEL, stream: true, messages: [] }),
      });
      partialText = await res.text();
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "reading a truncated body should fail somewhere before completion");
    assert.equal(partialText.includes("[DONE]"), false);
  } finally {
    await server.close();
  }
});

test("server: unknown model returns 404 with an error body", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const res = await fetch(`${server.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test/does-not-exist", stream: false, messages: [] }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "unknown_fixture");
  } finally {
    await server.close();
  }
});

test("server: mid-stream-error fixture returns a 502 JSON error envelope for non-streaming requests", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const res = await fetch(`${server.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MID_STREAM_ERROR_MODEL, stream: false, messages: [] }),
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "server_error");
  } finally {
    await server.close();
  }
});
