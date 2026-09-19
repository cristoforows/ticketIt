import { test, before } from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import { ScriptedChatModel, MarkerState, createMarkerTool, createHarnessAgent, runTurn } from "native-harness";
import { admittedTool } from "../src/index.js";
import { assertDbReachable, createFixture } from "./helpers.js";

before(assertDbReachable);

test(
  "scenario 4: revoking a grant between turns denies the next tool call while the earlier turn's completed dispatch is untouched",
  async () => {
    const fixture = await createFixture("s4-revocation-between-calls");
    try {
      const scope = fixture.baseScope("run_tool", "marker");
      const grant = fixture.ledger.grant({
        agentId: scope.agentId,
        account: scope.account,
        action: scope.action,
        resource: scope.resource,
        kind: { kind: "ticket", ticketId: scope.ticketId },
      });

      const markerState = new MarkerState();
      const wrappedMarker = admittedTool(createMarkerTool(markerState), fixture.ledger, scope);

      // Plain (unwrapped) model, same convention as scenario 1: this
      // scenario isolates TOOL admission across two turns on one thread.
      const model = ScriptedChatModel.create([
        new AIMessage({ content: "", tool_calls: [{ id: "call_1", name: "marker", args: { note: "turn A" } }] }),
        new AIMessage({ content: "turn A final reply" }),
        new AIMessage({ content: "", tool_calls: [{ id: "call_2", name: "marker", args: { note: "turn B" } }] }),
      ]);

      const agent = createHarnessAgent({
        model,
        tools: [wrappedMarker],
        checkpointer: fixture.checkpointer,
        systemPrompt: "scenario 4",
      });

      // Turn A: the grant is valid, so the tool runs and the turn completes normally.
      const turnA = await runTurn(agent, {
        roundId: fixture.roundId,
        threadId: fixture.threadId,
        input: "run the marker tool",
      });
      assert.equal(markerState.callCount, 1);
      assert.equal((turnA.messages.at(-1) as AIMessage).content, "turn A final reply");

      // Manual revocation, between turns, per agent-execution.md ("Permissions
      // and connected accounts"): "Manual revocation takes effect for
      // subsequent tool actions."
      fixture.ledger.revoke(grant.id);

      // Turn B: the SAME tool action is now denied -- the graph pauses via
      // interrupt() before the tool runs (same mechanism as scenario 1),
      // rather than the model node seeing an exception.
      const turnB = await runTurn(agent, {
        roundId: fixture.roundId,
        threadId: fixture.threadId,
        input: "run the marker tool again",
      });
      // `messages` accumulates the whole thread, not just this turn: turn A
      // left 4 (Human, AI(tool_calls), ToolMessage, AI(final)); turn B adds
      // its own Human + AI(tool_calls) and then pauses before a ToolMessage
      // is produced, for 6 total.
      assert.equal(turnB.messages.length, turnA.messages.length + 2, "expected turn B to pause before the ToolMessage was produced");
      assert.equal(markerState.callCount, 1, "the tool must not have run a second time");

      const state = await agent.graph.getState({ configurable: { thread_id: fixture.threadId } });
      assert.deepEqual(state.next, ["tools"]);
      const interrupts = state.tasks[0]?.interrupts ?? [];
      assert.equal(interrupts.length, 1);
      const payload = interrupts[0]?.value as { type: string; decision: string; reason: string };
      assert.equal(payload.type, "admission-refused");
      assert.equal(payload.decision, "deny");
      assert.equal(payload.reason, "revoked");

      const decisions = fixture.ledger.decisions();
      assert.equal(decisions.length, 2);
      assert.equal(decisions[0]?.decision, "allow");
      assert.equal(decisions[1]?.decision, "deny");
      assert.equal(decisions[1]?.reason, "revoked");

      const dispatches = fixture.ledger.dispatches();
      assert.equal(dispatches.length, 1, "only turn A's tool call was ever dispatched");
      assert.equal(dispatches[0]?.completedAtMs !== undefined, true, "turn A's dispatch remains completed, untouched by the later revocation");
    } finally {
      await fixture.cleanup();
    }
  },
);
