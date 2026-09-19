import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatOpenRouter } from "@langchain/openrouter";
import type { AIMessageChunk } from "@langchain/core/messages";
import { FakeOpenRouterServer } from "openrouter-fidelity/src/server.js";
import { FIXTURES, USAGE_ONLY_CHUNK_MODEL, USAGE_ONLY_TEXT, FULL_USAGE } from "openrouter-fidelity/src/fixtures.js";
import {
  startRawCapture,
  mergeRawSseEvents,
  normalizeFromAdapterMessage,
  normalizeFromRawResponse,
  mergeObservations,
  computeRoundTotals,
  type AdapterMessageShape,
} from "../src/index.js";

/**
 * Issue #26: "Include at least one test running the usage-only-final-chunk
 * fixture through the full path." Per #25's single most consequential
 * finding, `ChatOpenRouter._streamResponseChunks` silently drops the
 * documented empty-`choices` trailing usage chunk -- the adapter-only
 * result must be honestly "unknown usage, flagged incomplete", never a
 * silent zero. This test exercises the REAL adapter's `.stream()` against
 * `FakeOpenRouterServer` (not a synthetic message object) and computes
 * BOTH totals -- the adapter-only one (to prove the gap is recorded, not
 * papered over) and the raw-capture-recovered one -- independently.
 *
 * This goes through `ChatOpenRouter.stream()` directly rather than through
 * `createHarnessAgent`/the checkpointer: whether LangChain JS `createAgent`'s
 * internal model-call step ever invokes the underlying chat model via its
 * streaming API (as opposed to `.invoke()`) for a plain conversational step
 * is undocumented/uncertain behavior outside this slice's bounded scope
 * (see docs/evidence/m1/26-usage-persistence.md, "Observed limitations").
 * The checkpoint-survival behavior for whatever the model actually returns
 * is established generically by checkpoint-persistence.test.ts, which
 * shows LangGraph's checkpoint persists whatever fields sit on the
 * message object, regardless of how that message was produced.
 */
test(
  "usage-only-final-chunk fixture, full path: the adapter-only observation is honestly unknown/incomplete, " +
    "never a silent zero; the raw capture recovers the real numbers separately",
  async () => {
    const server = new FakeOpenRouterServer(FIXTURES);
    await server.start();
    const roundId = "round-usage-only-chunk-full-path";

    try {
      const model = new ChatOpenRouter({
        model: USAGE_ONLY_CHUNK_MODEL,
        apiKey: "dummy-key",
        baseURL: server.baseURL,
        maxRetries: 0,
      });

      const capture = startRawCapture();
      const stream = await model.stream("what is the answer?");
      let concatenated: AIMessageChunk | undefined;
      for await (const chunk of stream) {
        concatenated = concatenated ? concatenated.concat(chunk) : chunk;
      }
      await capture.finished();
      capture.restore();

      assert.ok(concatenated, "the stream delivered at least one chunk");
      assert.equal(concatenated!.content, USAGE_ONLY_TEXT);

      // --- Adapter-only path: the honest result ---
      const adapterMessage = concatenated as unknown as AdapterMessageShape;
      const adapterObservation = normalizeFromAdapterMessage({ roundId, message: adapterMessage });
      assert.equal(
        adapterObservation.promptTokens,
        "unknown",
        "the adapter never surfaces usage delivered via the empty-choices trailing chunk (#25)",
      );
      assert.equal(adapterObservation.completionTokens, "unknown");
      assert.equal(adapterObservation.cost.status, "unknown");

      const adapterOnlyTotals = computeRoundTotals(roundId, [adapterObservation]);
      assert.equal(adapterOnlyTotals.incomplete, true, "the adapter-only total is flagged incomplete");
      assert.equal(
        adapterOnlyTotals.promptTokens.sum,
        0,
        "the unknown contribution is excluded from the sum -- this 0 means 'nothing reported', not 'reported zero'",
      );
      assert.equal(adapterOnlyTotals.promptTokens.incomplete, true);
      assert.equal(adapterOnlyTotals.cost.status, "unknown");
      assert.equal(adapterOnlyTotals.cost.hasUnknown, true);
      assert.equal(adapterOnlyTotals.cost.reportedSum, 0, "no reported cost, not a fabricated zero-cost report");

      // --- Out-of-band raw capture: recovers what the adapter dropped ---
      assert.equal(capture.captures.length, 1);
      const rawCapture = capture.captures[0]!;
      assert.equal(rawCapture.streamed, true);
      assert.ok(rawCapture.sseEvents);
      assert.equal(rawCapture.sseEvents!.length, 3, "content chunk + finish_reason chunk + usage-only trailing chunk");

      const merged = mergeRawSseEvents(rawCapture.sseEvents!);
      const rawObservation = normalizeFromRawResponse({ roundId, raw: merged });
      assert.equal(rawObservation.promptTokens, FULL_USAGE.prompt_tokens);
      assert.equal(rawObservation.completionTokens, FULL_USAGE.completion_tokens);
      assert.equal(rawObservation.cost.status, "reported");
      if (rawObservation.cost.status === "reported") {
        assert.equal(rawObservation.cost.amount, FULL_USAGE.cost);
      }

      const mergedObservation = mergeObservations(adapterObservation, rawObservation);
      assert.equal(mergedObservation.source, "adapter+raw-capture");
      const mergedTotals = computeRoundTotals(roundId, [mergedObservation]);
      assert.equal(mergedTotals.incomplete, false, "once the raw capture supplies what the adapter dropped, the total is complete");
      assert.equal(mergedTotals.promptTokens.sum, FULL_USAGE.prompt_tokens);
      assert.equal(mergedTotals.cost.status, "reported");
      assert.equal(mergedTotals.cost.reportedSum, FULL_USAGE.cost);

      // Explicit statement per the issue: `adapterOnlyTotals` above IS what
      // the adapter path alone would have reported -- entirely unknown,
      // correctly flagged incomplete, never a silent zero. `mergedTotals`
      // is a SEPARATE, additional result built from the out-of-band raw
      // capture; it does not overwrite or hide the adapter-only finding.
    } finally {
      await server.close();
    }
  },
);
