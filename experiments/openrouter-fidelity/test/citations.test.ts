import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeOpenRouterServer } from "../src/server.js";
import {
  FIXTURES,
  CITATIONS_MODEL,
  CITATION_CONTENT,
  CITATION_TEXT,
  CITATION_START_CODEPOINTS,
  CITATION_END_CODEPOINTS,
} from "../src/fixtures.js";
import { makeModel, collectStream } from "./helpers.js";

// Matrix rows: "citation url/title/content" and "citation offsets correct
// over Unicode". Fixture (b) shape per
// https://openrouter.ai/docs/guides/features/plugins/web-search
// (`annotations[].url_citation.{url,title,content,start_index,end_index}`).
//
// `@langchain/openrouter@0.4.13`'s own `AssistantMessage` request/response
// type (dist/api-types.d.ts) has no `annotations` field, and its message
// converter (delegated to `@langchain/openai`'s
// `convertCompletionsMessageToBaseMessage` / `...DeltaToBaseMessageChunk`)
// never reads `message.annotations` / `delta.annotations`. These tests
// confirm that empirically: annotations never reach the AIMessage(Chunk) in
// either mode, while the message `content` text itself (including the
// multi-byte Unicode before the cited span) is preserved exactly.

test("citations: invoke preserves Unicode content but drops annotations entirely", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(CITATIONS_MODEL, server.baseURL);
    const res = await model.invoke("tell me about coffee trends");

    assert.equal(res.content, CITATION_CONTENT);
    assert.equal(res.additional_kwargs.annotations, undefined, "annotations not copied to additional_kwargs");
    assert.equal((res.response_metadata as Record<string, unknown>).annotations, undefined);
    assert.equal(JSON.stringify(res).includes("url_citation"), false, "no trace of url_citation anywhere on the message");

    const blocks = res.contentBlocks ?? [];
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "text");
  } finally {
    await server.close();
  }
});

test("citations: stream preserves Unicode content but drops annotations entirely", async () => {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  try {
    const model = makeModel(CITATIONS_MODEL, server.baseURL);
    const stream = await model.stream("tell me about coffee trends");
    const { concatenated } = await collectStream(stream);

    assert.ok(concatenated);
    assert.equal(concatenated.content, CITATION_CONTENT);
    assert.equal(concatenated.additional_kwargs.annotations, undefined);
    assert.equal(JSON.stringify(concatenated).includes("url_citation"), false);
  } finally {
    await server.close();
  }
});

test("citations: raw-response access path (monkey-patched global fetch) recovers annotations the adapter drops", async () => {
  // ChatOpenRouter calls the global `fetch` directly (chat_models/index.ts)
  // and exposes no injectable fetch/configuration option, so the only
  // available raw-response access path for a lost field like `annotations`
  // is to monkey-patch `globalThis.fetch` and clone the response before
  // handing it back to the adapter. This test exercises that path so it is
  // recorded as observed, not just theorized.
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  const originalFetch = globalThis.fetch;
  const capturedBodies: unknown[] = [];
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    const clone = response.clone();
    void clone
      .json()
      .then((body) => capturedBodies.push(body))
      .catch(() => {});
    return response;
  }) as typeof fetch;

  try {
    const model = makeModel(CITATIONS_MODEL, server.baseURL);
    await model.invoke("tell me about coffee trends");
    // Let the cloned-body .json() microtask resolve.
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(capturedBodies.length, 1);
    const rawMessage = (capturedBodies[0] as { choices: Array<{ message: Record<string, unknown> }> }).choices[0]!.message;
    const annotations = rawMessage.annotations as Array<{ url_citation: Record<string, unknown> }>;
    assert.equal(annotations.length, 1);
    const citation = annotations[0]!.url_citation;
    assert.equal(citation.url, "https://example.com/coffee-trends-2025");
    assert.equal(citation.title, "Global Coffee Trends 2025");
    assert.equal(typeof citation.content, "string");
    assert.equal(citation.start_index, CITATION_START_CODEPOINTS);
    assert.equal(citation.end_index, CITATION_END_CODEPOINTS);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("citations: offsets are codepoint-based, not UTF-16 code-unit-based -- naive JS .slice() misreads the citation", () => {
  // This fixture constructs start_index/end_index as Unicode codepoint
  // offsets (see fixtures.ts for why), specifically to exercise the
  // multi-byte-Unicode-before-the-span case the issue asks for. The astral
  // emoji in CITATION_PREFIX is a UTF-16 surrogate pair (2 code units, 1
  // codepoint), so naive JS string slicing at the codepoint offsets lands
  // one code unit short of the true UTF-16 boundary.
  const naiveUtf16Slice = CITATION_CONTENT.slice(CITATION_START_CODEPOINTS, CITATION_END_CODEPOINTS);
  const codepointAwareSlice = Array.from(CITATION_CONTENT).slice(CITATION_START_CODEPOINTS, CITATION_END_CODEPOINTS).join("");

  assert.notEqual(naiveUtf16Slice, CITATION_TEXT, "naive UTF-16 .slice() must NOT recover the cited text (demonstrates the bug)");
  assert.equal(codepointAwareSlice, CITATION_TEXT, "codepoint-aware slicing DOES recover the exact cited text");
});
