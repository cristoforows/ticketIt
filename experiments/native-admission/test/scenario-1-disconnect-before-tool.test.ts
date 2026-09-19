import { test, before } from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import { ScriptedChatModel, MarkerState, createMarkerTool, createHarnessAgent, runTurn } from "native-harness";
import { admittedTool } from "../src/index.js";
import { assertDbReachable, createFixture } from "./helpers.js";

before(assertDbReachable);

test(
  "scenario 1: disconnect before the next tool holds admission, pauses the graph via interrupt(), and records zero allow decisions while disconnected",
  async () => {
    const fixture = await createFixture("s1-disconnect-before-tool");
    try {
      const scope = fixture.baseScope("run_tool", "marker");
      // A valid grant exists -- the ONLY reason the tool is not admitted is
      // that the ledger is disconnected, not a missing/expired/revoked grant.
      fixture.ledger.grant({
        agentId: scope.agentId,
        account: scope.account,
        action: scope.action,
        resource: scope.resource,
        kind: { kind: "ticket", ticketId: scope.ticketId },
      });

      const markerState = new MarkerState();
      const wrappedMarker = admittedTool(createMarkerTool(markerState), fixture.ledger, scope);

      // Plain (unwrapped) model: this scenario isolates TOOL admission.
      // Wrapping the model too would also hold the very first model call
      // once disconnected, and the model would never produce the tool
      // call this scenario needs the graph to pause on.
      const model = ScriptedChatModel.create([
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "marker", args: { note: "s1" } }],
        }),
        new AIMessage({ content: "should not be reached while disconnected" }),
      ]);

      const agent = createHarnessAgent({
        model,
        tools: [wrappedMarker],
        checkpointer: fixture.checkpointer,
        systemPrompt: "scenario 1",
      });

      // Disconnect BEFORE the tool step -- the model call itself is not
      // admission-checked in this scenario (see comment above), so this
      // disconnect specifically targets "the next tool", per the scenario.
      fixture.ledger.setConnected(false);

      const result = await runTurn(agent, {
        roundId: fixture.roundId,
        threadId: fixture.threadId,
        input: "run the marker tool",
      });

      // "the graph pauses or ends the step gracefully": agent.invoke()
      // RESOLVED (no exception reached the caller) with only the human +
      // AI(tool_calls) messages -- the tool step itself never completed.
      assert.equal(result.messages.length, 2, "expected the run to pause before the ToolMessage was produced");

      // The marker tool's own side effect never ran.
      assert.equal(markerState.callCount, 0);

      // Mechanism: an interrupt() raised by admittedTool, observable via getState().
      // `agent.getState` itself is typed `never` in this pinned langchain
      // version -- its own .d.ts says so explicitly ("internal methods to
      // enable support for LangGraph Platform... intentionally return as
      // `never` to avoid type errors due to type inference",
      // node_modules/langchain/dist/agents/ReactAgent.d.ts). At runtime it
      // just delegates to `this.#graph.getState(...)` (confirmed by reading
      // ReactAgent.js), so `agent.graph.getState(...)` is used here instead:
      // identical runtime behavior, properly typed as `Promise<StateSnapshot>`.
      const state = await agent.graph.getState({ configurable: { thread_id: fixture.threadId } });
      assert.deepEqual(state.next, ["tools"], "expected the graph to be paused before the tools node");
      assert.equal(state.tasks.length, 1);
      const interrupts = state.tasks[0]?.interrupts ?? [];
      assert.equal(interrupts.length, 1);
      const payload = interrupts[0]?.value as { type: string; decision: string; reason: string };
      assert.equal(payload.type, "admission-refused");
      assert.equal(payload.decision, "hold");
      assert.equal(payload.reason, "disconnected");

      // Ledger evidence: exactly one admission recorded, and it is "hold" --
      // zero "allow" decisions were recorded while disconnected.
      const decisions = fixture.ledger.decisions();
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.decision, "hold");
      assert.equal(decisions[0]?.reason, "disconnected");
      assert.equal(decisions.filter((d) => d.decision === "allow").length, 0);
      assert.equal(fixture.ledger.dispatches().length, 0, "a held admission must never be dispatched");
    } finally {
      await fixture.cleanup();
    }
  },
);
