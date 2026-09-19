import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { AIMessage } from "@langchain/core/messages";
import {
  ScriptedChatModel,
  MarkerState,
  createMarkerTool,
  resolveDatabaseUrl,
  assertDatabaseReachable,
  createPostgresCheckpointer,
  RoundRegistry,
  createHarnessAgent,
  runTurn,
} from "../src/index.js";

const connectionString = resolveDatabaseUrl();
let rawPool: pg.Pool | undefined;

before(async () => {
  // Fail loudly and clearly if PostgreSQL is unreachable. This must never
  // be swallowed into a silent fallback -- see experiments/README.md and
  // this package's README ("Database setup").
  await assertDatabaseReachable(connectionString);
  rawPool = new pg.Pool({ connectionString });
});

after(async () => {
  await rawPool?.end();
});

test(
  "native harness: scripted turn runs the marker tool once, persists a " +
    "checkpoint, and keeps the Round ID and thread ID distinct with a " +
    "resolvable mapping",
  async () => {
    // Unique thread ID per run: avoids needing to clean up another run's
    // checkpoints, and lets this test run concurrently with itself safely.
    const threadId = `boot-${randomUUID()}`;
    const systemPrompt = "You are a scripted research agent used for a boot test.";

    const markerState = new MarkerState();
    const markerTool = createMarkerTool(markerState);

    // Script exactly two model turns: a tool call, then a final reply once
    // the tool result comes back. No network call is made.
    const model = ScriptedChatModel.create([
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call_1",
            name: "marker",
            args: { note: "boot test" },
          },
        ],
      }),
      new AIMessage({ content: "Marker recorded. Boot turn complete." }),
    ]);

    const checkpointer = createPostgresCheckpointer(connectionString);
    await checkpointer.setup(); // idempotent; also run by `npm run db:setup`

    const registry = RoundRegistry.fromConnectionString(connectionString);
    await registry.setup(); // idempotent

    try {
      // --- Round created, distinct from the thread ID (ADR 0002) ---
      const roundId = await registry.registerRound(threadId);
      assert.notEqual(
        roundId,
        threadId,
        "Round ID must never be the LangGraph thread ID (ADR 0002; " +
          "docs/contracts/execution-interface.md 'Identity model')",
      );
      assert.equal(await registry.threadIdForRound(roundId), threadId);
      assert.equal(await registry.roundIdForThread(threadId), roundId);

      // --- Boot the agent and run one turn ---
      const agent = createHarnessAgent({
        model,
        tools: [markerTool],
        checkpointer,
        systemPrompt,
      });

      const result = await runTurn(agent, {
        roundId,
        threadId,
        input: "Run the marker tool once, then tell me you're done.",
      });

      assert.equal(result.roundId, roundId);
      assert.equal(result.threadId, threadId);

      // --- The marker tool actually ran, exactly once ---
      assert.equal(markerState.callCount, 1);
      assert.deepEqual(markerState.calls, ["boot test"]);

      // --- The scripted model saw both requests it should have ---
      assert.equal(
        model.requests.length,
        2,
        "expected one model call producing the tool call, and one follow-up " +
          "after the tool result",
      );
      assert.equal(model.requests[0]?.systemPrompt, systemPrompt);
      assert.ok(model.requests[0]?.boundToolNames.includes("marker"));

      // --- The checkpoint is durable: read it back through the checkpointer ---
      const tuple = await checkpointer.getTuple({
        configurable: { thread_id: threadId },
      });
      assert.ok(tuple, "expected a persisted checkpoint tuple for this thread");
      assert.equal(tuple?.config.configurable?.thread_id, threadId);

      // --- ...and independently, via a direct SQL count ---
      assert.ok(rawPool, "expected the raw pg.Pool from the before() hook to be set");
      const { rows } = await rawPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM checkpoints WHERE thread_id = $1",
        [threadId],
      );
      const checkpointRowCount = Number(rows[0]?.count ?? "0");
      assert.ok(
        checkpointRowCount > 0,
        `expected at least one checkpoint row for thread ${threadId}, got ${checkpointRowCount}`,
      );
    } finally {
      // Clean up this run's checkpoint rows even though the thread ID was
      // unique, so repeated local runs don't accumulate rows.
      await checkpointer.deleteThread(threadId);
      await checkpointer.end();
      await registry.end();
    }
  },
);
