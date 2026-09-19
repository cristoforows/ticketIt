import { test, before } from "node:test";
import assert from "node:assert/strict";
import { Command } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { ScriptedChatModel, MarkerState, createMarkerTool, createHarnessAgent, runTurn } from "native-harness";
import { admittedTool } from "../src/index.js";
import { assertDbReachable, connectionString, createFixture, RoundRegistry } from "./helpers.js";

before(assertDbReachable);

test(
  "scenario 6: a new grant after revocation lets the same thread and the same Round continue, via a Command resume rather than a new thread",
  async () => {
    const fixture = await createFixture("s6-new-grant-continues-thread");
    // Reuse the same database as the checkpointer.
    const roundRegistry = RoundRegistry.fromConnectionString(connectionString);
    try {
      await roundRegistry.setup();
      // An authoritative Round record for this thread, per ADR 0002: the
      // Round ID is generated independently and is never the thread ID.
      const roundId = await roundRegistry.registerRound(fixture.threadId);
      assert.notEqual(roundId, fixture.threadId);

      const scope = { ...fixture.baseScope("run_tool", "marker"), roundId };
      const grant1 = fixture.ledger.grant({
        agentId: scope.agentId,
        account: scope.account,
        action: scope.action,
        resource: scope.resource,
        kind: { kind: "ticket", ticketId: scope.ticketId },
      });

      const markerState = new MarkerState();
      const wrappedMarker = admittedTool(createMarkerTool(markerState), fixture.ledger, scope);

      const model = ScriptedChatModel.create([
        new AIMessage({ content: "", tool_calls: [{ id: "call_1", name: "marker", args: { note: "s6" } }] }),
        new AIMessage({ content: "final reply after resume" }),
      ]);

      const agent = createHarnessAgent({
        model,
        tools: [wrappedMarker],
        checkpointer: fixture.checkpointer,
        systemPrompt: "scenario 6",
      });

      // Revoke BEFORE the first turn even starts, so the very first tool
      // attempt is denied and the graph pauses.
      fixture.ledger.revoke(grant1.id);

      const paused = await runTurn(agent, { roundId, threadId: fixture.threadId, input: "run the marker tool" });
      // [Human, AI(tool_calls)] -- paused before a ToolMessage was produced,
      // same accounting as scenario 1.
      assert.equal(paused.messages.length, 2, "expected the run to pause before the ToolMessage was produced");
      assert.equal(markerState.callCount, 0);

      const pausedState = await agent.graph.getState({ configurable: { thread_id: fixture.threadId } });
      assert.deepEqual(pausedState.next, ["tools"]);

      // A NEW grant for the same scope -- not a reconnect, not restoring the
      // revoked grant -- is what "a new valid grant permits the same intact
      // round to continue" (integration-feasibility.md, S2) means here.
      fixture.ledger.grant({
        agentId: scope.agentId,
        account: scope.account,
        action: scope.action,
        resource: scope.resource,
        kind: { kind: "ticket", ticketId: scope.ticketId },
      });

      // Resume the SAME thread (no new thread_id, no new RoundRegistry
      // entry): admittedTool's interrupt() lets LangGraph replay the tools
      // node from the top, re-evaluating ledger.admit() fresh.
      const resumed = await agent.invoke(new Command({ resume: true }), {
        configurable: { thread_id: fixture.threadId },
      });
      const resumedMessages = (resumed as { messages: unknown[] }).messages;
      assert.equal(markerState.callCount, 1, "the tool actually ran once admission was fresh and valid");
      assert.equal((resumedMessages.at(-1) as AIMessage).content, "final reply after resume");

      // No new thread, no new Round: the registry still maps threadId -> the
      // SAME roundId registered before either turn ran.
      assert.equal(await roundRegistry.roundIdForThread(fixture.threadId), roundId);
      assert.equal(await roundRegistry.threadIdForRound(roundId), fixture.threadId);

      const decisions = fixture.ledger.decisions();
      assert.equal(decisions.length, 2);
      assert.equal(decisions[0]?.decision, "deny");
      assert.equal(decisions[0]?.reason, "revoked");
      assert.equal(decisions[1]?.decision, "allow");
    } finally {
      await roundRegistry.end();
      await fixture.cleanup();
    }
  },
);
