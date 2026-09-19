import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ChatOpenRouter } from "@langchain/openrouter";
import { FakeOpenRouterServer } from "openrouter-fidelity/src/server.js";
import {
  FIXTURES,
  CITATIONS_MODEL,
  CITATION_CONTENT,
  CITATION_TEXT,
  CITATION_START_CODEPOINTS,
  CITATION_END_CODEPOINTS,
  USAGE_MODEL,
  USAGE_TEXT,
  FULL_USAGE,
} from "openrouter-fidelity/src/fixtures.js";
import {
  resolveDatabaseUrl,
  assertDatabaseReachable,
  createPostgresCheckpointer,
  RoundRegistry,
  createHarnessAgent,
  runTurn,
} from "native-harness/src/index.js";
import {
  startRawCapture,
  extractRawMessage,
  normalizeFromRawResponse,
  normalizeFromAdapterMessage,
  UsageObservationStore,
  type AdapterMessageShape,
} from "../src/index.js";

/**
 * Part 1 of #26: runs the OpenRouter fixtures (#25) through the native
 * harness (#22) with the REAL, pinned `ChatOpenRouter` adapter pointed at
 * `FakeOpenRouterServer`, used as the model inside `createHarnessAgent`
 * with the PostgreSQL checkpointer. After each turn, the thread is
 * reloaded from a FRESH `PostgresSaver` instance and a fresh pool
 * (`createPostgresCheckpointer` called again, never reusing the original
 * connection object) -- the closest approximation of "a fresh process"
 * available inside one test file -- and we assert exactly what survived:
 * content, citations, and usage fields.
 *
 * No real credentials/providers: `ChatOpenRouter` is pointed at
 * `FakeOpenRouterServer` (127.0.0.1, ephemeral port) with a dummy API key,
 * per experiments/README.md.
 */

const connectionString = resolveDatabaseUrl();

function fakeModel(model: string, baseURL: string): ChatOpenRouter {
  return new ChatOpenRouter({ model, apiKey: "dummy-key", baseURL, maxRetries: 0 });
}

/**
 * `createHarnessAgent`'s declared return type (`HarnessAgent` in
 * native-harness, `ReturnType<typeof createAgent>` instantiated against the
 * wide `CreateHarnessAgentOptions` parameter types) does not carry a
 * specific-enough state-channel schema for TypeScript to resolve
 * `.getState()`'s return type usefully at a fresh call site. The runtime
 * behavior is exactly LangGraph's documented `StateSnapshot` (`.values` is
 * the current channel values, i.e. `{ messages: BaseMessage[] }` for
 * `createAgent`'s default state) -- see
 * node_modules/@langchain/langgraph/dist/pregel/types.d.ts. This helper
 * asserts to that minimal, accurate shape once, instead of scattering
 * `as any` through every reload assertion below.
 */
interface MinimalStatefulAgent {
  getState(config: { configurable: { thread_id: string } }): Promise<{ values: { messages: unknown[] } }>;
}

async function reloadMessages(agent: unknown, threadId: string): Promise<unknown[]> {
  const snapshot = await (agent as MinimalStatefulAgent).getState({ configurable: { thread_id: threadId } });
  return snapshot.values.messages;
}

test(
  "checkpoint persistence: citations are dropped by the adapter and do NOT survive the checkpoint reload; " +
    "they survive only because the harness captured them out of band and attached them to the Round's own record, " +
    "with correct codepoint-aware offsets over multi-byte Unicode",
  async () => {
    await assertDatabaseReachable(connectionString);

    const server = new FakeOpenRouterServer(FIXTURES);
    await server.start();

    const threadId = `usage-persistence-citations-${randomUUID()}`;
    const registry = RoundRegistry.fromConnectionString(connectionString);
    await registry.setup();
    const roundId = await registry.registerRound(threadId);
    assert.notEqual(roundId, threadId, "Round ID stays distinct from the LangGraph thread ID (ADR 0002)");

    const checkpointer = createPostgresCheckpointer(connectionString);
    await checkpointer.setup();
    const store = UsageObservationStore.fromConnectionString(connectionString);
    await store.setup();

    try {
      const model = fakeModel(CITATIONS_MODEL, server.baseURL);
      const agent = createHarnessAgent({ model, tools: [], checkpointer });

      // Fetch interception installed for exactly this turn, per #25's
      // identified raw-response access path (ChatOpenRouter has no
      // injectable fetch/configuration option).
      const capture = startRawCapture();
      const result = await runTurn(agent, {
        roundId,
        threadId,
        input: "tell me about coffee trends",
      });
      await capture.finished();
      capture.restore();

      // --- What the adapter itself surfaced, right after the turn ---
      const finalMessage = result.messages.at(-1) as unknown as AdapterMessageShape;
      assert.equal(finalMessage.content, CITATION_CONTENT, "message content is preserved by the adapter");
      assert.equal(
        JSON.stringify(finalMessage).includes("url_citation"),
        false,
        "the adapter drops annotations before they ever reach the message (#25)",
      );

      // --- Recover the citation out-of-band from the raw response, and
      // attach it to the Round's own record (usage_observations, keyed by
      // roundId) -- the mechanism the issue asks for. ---
      assert.equal(capture.captures.length, 1, "exactly one HTTP call for this turn");
      const rawCapture = capture.captures[0]!;
      assert.equal(rawCapture.streamed, false, "invoke mode: a single JSON response, no SSE");
      assert.ok(rawCapture.json, "raw JSON body was captured independently of the adapter");
      const raw = extractRawMessage(rawCapture.json!);
      const citationObservation = normalizeFromRawResponse({ roundId, raw });
      assert.equal(citationObservation.citations.length, 1);
      assert.equal(citationObservation.citations[0]!.startCodepoint, CITATION_START_CODEPOINTS);
      assert.equal(citationObservation.citations[0]!.endCodepoint, CITATION_END_CODEPOINTS);
      assert.equal(
        citationObservation.citations[0]!.citedText,
        CITATION_TEXT,
        "codepoint-aware slicing recovers the exact cited text across the preceding astral emoji",
      );

      const { inserted } = await store.record(citationObservation);
      assert.equal(inserted, true);

      // --- Reload the THREAD from a FRESH PostgresSaver instance and a
      // fresh pool (new createPostgresCheckpointer call): proves the
      // checkpoint itself is durable, not just in-process state. ---
      const reloadCheckpointer = createPostgresCheckpointer(connectionString);
      const reloadAgent = createHarnessAgent({
        model: fakeModel(CITATIONS_MODEL, server.baseURL),
        tools: [],
        checkpointer: reloadCheckpointer,
      });
      const reloadedMessages = await reloadMessages(reloadAgent, threadId);
      const reloadedFinal = reloadedMessages.at(-1) as unknown as AdapterMessageShape;

      assert.equal(reloadedFinal.content, CITATION_CONTENT, "content SURVIVES the checkpoint reload (adapter-carried)");
      assert.equal(
        JSON.stringify(reloadedFinal).includes("url_citation"),
        false,
        "citations do NOT survive the checkpoint reload -- the adapter never captured them in the first place, " +
          "so there was nothing for the checkpoint to persist",
      );
      await reloadCheckpointer.end();

      // --- Reload the citation from a FRESH UsageObservationStore
      // instance and pool: this is what DID survive, and it survived
      // because it was captured out of band and stored against the
      // Round ID, independent of the checkpoint entirely. ---
      const reloadStore = UsageObservationStore.fromConnectionString(connectionString);
      const reloaded = await reloadStore.getByGenerationId(citationObservation.generationId);
      assert.ok(reloaded, "the out-of-band citation observation survives reload, keyed to the Round ID");
      assert.equal(reloaded!.roundId, roundId);
      assert.equal(reloaded!.citations.length, 1);
      assert.equal(reloaded!.citations[0]!.startCodepoint, CITATION_START_CODEPOINTS);
      assert.equal(reloaded!.citations[0]!.endCodepoint, CITATION_END_CODEPOINTS);
      assert.equal(
        reloaded!.citations[0]!.citedText,
        CITATION_TEXT,
        "codepoint-aware offsets still recover the exact cited text after a fresh-pool reload",
      );
      await reloadStore.end();
    } finally {
      await checkpointer.deleteThread(threadId);
      await checkpointer.end();
      await store.deleteForRound(roundId);
      await store.end();
      await registry.end();
      await server.close();
    }
  },
);

test(
  "checkpoint persistence: the raw usage passthrough (response_metadata.usage -- cost, cache-write, reasoning, " +
    "cached, all unnormalized) survives the checkpoint reload, but LangChain's NORMALIZED usage_metadata convenience " +
    "field does NOT -- a checkpoint-serialization finding distinct from #25's adapter-level findings",
  async () => {
    await assertDatabaseReachable(connectionString);

    const server = new FakeOpenRouterServer(FIXTURES);
    await server.start();

    const threadId = `usage-persistence-usage-${randomUUID()}`;
    const registry = RoundRegistry.fromConnectionString(connectionString);
    await registry.setup();
    const roundId = await registry.registerRound(threadId);

    const checkpointer = createPostgresCheckpointer(connectionString);
    await checkpointer.setup();

    try {
      const model = fakeModel(USAGE_MODEL, server.baseURL);
      const agent = createHarnessAgent({ model, tools: [], checkpointer });
      const result = await runTurn(agent, { roundId, threadId, input: "what is the capital of France?" });

      // --- Immediately after the turn (in-process, nothing reloaded yet):
      // both the normalized usage_metadata AND the raw response_metadata.usage
      // passthrough are present, exactly per #25's fidelity matrix. ---
      const finalMessage = result.messages.at(-1) as unknown as AdapterMessageShape;
      assert.equal(finalMessage.content, USAGE_TEXT);
      assert.equal(finalMessage.usage_metadata?.output_token_details?.reasoning, FULL_USAGE.completion_tokens_details.reasoning_tokens);
      assert.equal(finalMessage.usage_metadata?.input_token_details?.cache_read, FULL_USAGE.prompt_tokens_details.cached_tokens);
      assert.equal(finalMessage.response_metadata?.usage?.cost, FULL_USAGE.cost);
      assert.equal(
        finalMessage.response_metadata?.usage?.prompt_tokens_details?.cache_write_tokens,
        FULL_USAGE.prompt_tokens_details.cache_write_tokens,
      );

      // Build the UsageObservation from THIS fresh, in-process message --
      // the recommended pattern (see below for why re-deriving it from a
      // later checkpoint reload instead would lose fields).
      const freshObservation = normalizeFromAdapterMessage({ roundId, message: finalMessage });
      assert.equal(freshObservation.promptTokens, FULL_USAGE.prompt_tokens);
      assert.equal(freshObservation.reasoningTokens, FULL_USAGE.completion_tokens_details.reasoning_tokens);
      assert.equal(freshObservation.cachedTokens, FULL_USAGE.prompt_tokens_details.cached_tokens);
      assert.equal(freshObservation.cacheWriteTokens, FULL_USAGE.prompt_tokens_details.cache_write_tokens);
      assert.equal(freshObservation.cost.status, "reported");

      // --- Reload from a FRESH checkpointer instance + fresh pool ---
      const reloadCheckpointer = createPostgresCheckpointer(connectionString);
      const reloadAgent = createHarnessAgent({
        model: fakeModel(USAGE_MODEL, server.baseURL),
        tools: [],
        checkpointer: reloadCheckpointer,
      });
      const reloadedMessages = await reloadMessages(reloadAgent, threadId);
      const reloadedFinal = reloadedMessages.at(-1) as unknown as AdapterMessageShape;

      assert.equal(reloadedFinal.content, USAGE_TEXT, "content survives the checkpoint reload (a real constructor kwarg)");

      // Genuine finding (not from #25, specific to this slice): LangChain's
      // `Serializable.toJSON()` only round-trips a message's CONSTRUCTOR
      // kwargs (`lc_kwargs`). The OpenAI/OpenRouter converter sets
      // `usage_metadata` by assigning it to the message AFTER construction,
      // not by passing it as a constructor kwarg -- so it is silently
      // absent from `lc_kwargs` and does NOT survive the checkpoint's
      // serialize/deserialize round-trip, even though `response_metadata`
      // (which IS a constructor kwarg, and carries the exact same numbers
      // in raw/unnormalized form) survives completely. Observed directly:
      // `Object.keys(finalMessage.lc_kwargs)` excludes `usage_metadata` but
      // includes `response_metadata`.
      assert.equal(
        reloadedFinal.usage_metadata,
        undefined,
        "the NORMALIZED usage_metadata convenience field does NOT survive the checkpoint reload -- " +
          "it is not part of the message's serializable constructor kwargs",
      );
      assert.equal(
        reloadedFinal.response_metadata?.usage?.completion_tokens_details?.reasoning_tokens,
        FULL_USAGE.completion_tokens_details.reasoning_tokens,
        "the RAW reasoning-token count survives via response_metadata.usage (a real constructor kwarg)",
      );
      assert.equal(
        reloadedFinal.response_metadata?.usage?.prompt_tokens_details?.cached_tokens,
        FULL_USAGE.prompt_tokens_details.cached_tokens,
        "the raw cached-token count survives the checkpoint reload too",
      );
      assert.equal(
        reloadedFinal.response_metadata?.usage?.cost,
        FULL_USAGE.cost,
        "raw cost survives the checkpoint reload even though it was never normalized into usage_metadata (#25) -- " +
          "adapter-carried via response_metadata, no out-of-band capture needed for this fixture",
      );
      assert.equal(
        reloadedFinal.response_metadata?.usage?.prompt_tokens_details?.cache_write_tokens,
        FULL_USAGE.prompt_tokens_details.cache_write_tokens,
        "raw cache-write tokens survive the checkpoint reload too (adapter-carried)",
      );
      await reloadCheckpointer.end();

      // Because usage_metadata is gone post-reload, re-deriving a
      // UsageObservation from the RELOADED message via
      // normalizeFromAdapterMessage (which reads prompt/completion/
      // reasoning/cached from usage_metadata) loses exactly those fields --
      // while cost and cache-write (read from response_metadata.usage)
      // are still recovered. This is why UsageIngest observations must be
      // built from the FRESH in-process adapter output at turn time (as
      // `freshObservation` above) and persisted durably then, not
      // re-derived from a later checkpoint reload.
      const reloadedObservation = normalizeFromAdapterMessage({ roundId, message: reloadedFinal });
      assert.equal(reloadedObservation.promptTokens, "unknown", "lost on reload: usage_metadata is gone");
      assert.equal(reloadedObservation.reasoningTokens, "unknown", "lost on reload: usage_metadata is gone");
      assert.equal(reloadedObservation.cachedTokens, "unknown", "lost on reload: usage_metadata is gone");
      assert.equal(reloadedObservation.cost.status, "reported", "still recovered: cost is read from response_metadata.usage");
      assert.equal(
        reloadedObservation.cacheWriteTokens,
        FULL_USAGE.prompt_tokens_details.cache_write_tokens,
        "still recovered: cache-write is read from response_metadata.usage",
      );
      assert.equal(reloadedObservation.citations.length, 0, "this fixture carries no citations");
    } finally {
      await checkpointer.deleteThread(threadId);
      await checkpointer.end();
      await registry.end();
      await server.close();
    }
  },
);
