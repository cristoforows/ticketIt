import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatOpenRouter } from "@langchain/openrouter";
import type { AIMessageChunk } from "@langchain/core/messages";
import { FakeOpenRouterServer } from "openrouter-fidelity/src/server.js";
import { FIXTURES, TRUNCATED_MODEL, TRUNCATED_CHUNKS_DELIVERED } from "openrouter-fidelity/src/fixtures.js";
import { normalizeFromAdapterMessage, computeRoundTotals, type AdapterMessageShape } from "../src/index.js";

/**
 * Issue #26: "A truncated stream yields unknown tokens with partial
 * content retained." The connection drops (socket destroyed, per #25)
 * before the SSE terminator; the real adapter throws `TypeError:
 * terminated` partway through. This test runs the REAL `ChatOpenRouter`
 * against `FakeOpenRouterServer`'s truncated fixture, catches the partial
 * chunks, and proves UsageIngest's honest handling: unknown tokens/cost
 * (never zero), the partial content actually retained, and the round
 * total flagged incomplete.
 */
test(
  "truncated stream: partial content is retained, tokens/cost are unknown (never zero), and the total is flagged incomplete",
  async () => {
    const server = new FakeOpenRouterServer(FIXTURES);
    await server.start();
    const roundId = "round-truncated-stream";

    try {
      const model = new ChatOpenRouter({ model: TRUNCATED_MODEL, apiKey: "dummy-key", baseURL: server.baseURL, maxRetries: 0 });
      const stream = await model.stream("go");

      const chunks: AIMessageChunk[] = [];
      let concatenated: AIMessageChunk | undefined;
      let thrown: unknown;
      try {
        for await (const chunk of stream) {
          chunks.push(chunk);
          concatenated = concatenated ? concatenated.concat(chunk) : chunk;
        }
      } catch (err) {
        thrown = err;
      }

      assert.ok(thrown, "the connection drops before the stream completes");
      assert.equal(chunks.length, TRUNCATED_CHUNKS_DELIVERED, "exactly the chunks sent before the drop were delivered");
      assert.ok(concatenated, "some chunks were delivered before the drop");
      const expectedPartialText =
        "This response will be cut off before completion because the connection drops unexpectedly ";
      assert.equal(concatenated!.content, expectedPartialText);

      const observation = normalizeFromAdapterMessage({
        roundId,
        message: concatenated as unknown as AdapterMessageShape,
        partial: true,
      });

      assert.equal(observation.partial, true);
      assert.equal(observation.content, expectedPartialText, "partial content is retained, not discarded");
      assert.equal(observation.promptTokens, "unknown", "usage never arrived before the connection dropped");
      assert.equal(observation.completionTokens, "unknown");
      assert.equal(observation.reasoningTokens, "unknown");
      assert.equal(observation.cachedTokens, "unknown");
      assert.equal(observation.cacheWriteTokens, "unknown");
      assert.equal(observation.cost.status, "unknown");

      const totals = computeRoundTotals(roundId, [observation]);
      assert.equal(totals.incomplete, true);
      assert.equal(totals.promptTokens.sum, 0, "unknown is excluded from the sum, never summed as zero");
      assert.equal(totals.promptTokens.incomplete, true);
      assert.equal(totals.cost.status, "unknown");
      assert.equal(totals.cost.reportedSum, 0);
    } finally {
      await server.close();
    }
  },
);
