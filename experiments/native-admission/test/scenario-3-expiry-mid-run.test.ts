import { test, before } from "node:test";
import assert from "node:assert/strict";
import { tool } from "@langchain/core/tools";
import { AIMessage } from "@langchain/core/messages";
import { ScriptedChatModel, MarkerState, createMarkerTool, createHarnessAgent, runTurn } from "native-harness";
import { admittedTool, admittedModel } from "../src/index.js";
import { assertDbReachable, createFixture } from "./helpers.js";

before(assertDbReachable);

test(
  "scenario 3: a time-based grant expiring mid-run denies the search-scoped model call while the tool's own ticket-based grant keeps it allowed",
  async () => {
    const fixture = await createFixture("s3-expiry-mid-run");
    try {
      const toolScope = fixture.baseScope("run_tool", "marker");
      const modelScope = fixture.baseScope("invoke_model", "search");

      // The tool's grant is ticket-based: it has no expiry field at all, so
      // advancing the clock past the model grant's expiry must not affect it
      // (v1-scope.md, "Permissions and accounts": "Expired authority does
      // not stop otherwise permitted work").
      fixture.ledger.grant({
        agentId: toolScope.agentId,
        account: toolScope.account,
        action: toolScope.action,
        resource: toolScope.resource,
        kind: { kind: "ticket", ticketId: toolScope.ticketId },
      });

      // The model/search grant is time-based and expires well before the
      // run's second model call -- see the marker tool's clock-advance below.
      const expiresAt = fixture.clock.nowMs() + 60_000;
      fixture.ledger.grant({
        agentId: modelScope.agentId,
        account: modelScope.account,
        action: modelScope.action,
        resource: modelScope.resource,
        kind: { kind: "time", expiresAt },
      });

      const markerState = new MarkerState();
      const baseMarker = createMarkerTool(markerState);

      // The marker tool's execution is the deterministic synchronization
      // point between the run's two model calls (no tool calls happen
      // except this one, and the ReAct loop always calls the tool node
      // strictly between them). Advancing the FakeClock here -- rather than
      // relying on real elapsed wall-clock time -- is what makes "expires
      // mid-run" reproducible without a flaky race.
      const advancingMarker = tool(
        async (args: { note?: string }) => {
          const output = await baseMarker.invoke(args);
          fixture.clock.advance(120_000); // now well past expiresAt
          return output;
        },
        {
          name: baseMarker.name,
          description: baseMarker.description,
          schema: (baseMarker as unknown as { schema: unknown }).schema as never,
        },
      );
      const wrappedMarker = admittedTool(advancingMarker, fixture.ledger, toolScope);

      const inner = ScriptedChatModel.create([
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "marker", args: { note: "s3" } }],
        }),
        new AIMessage({ content: "should not be reached: model admission expired" }),
      ]);
      const model = admittedModel(inner, fixture.ledger, modelScope);

      const agent = createHarnessAgent({
        model,
        tools: [wrappedMarker],
        checkpointer: fixture.checkpointer,
        systemPrompt: "scenario 3",
      });

      await assert.rejects(
        () =>
          runTurn(agent, {
            roundId: fixture.roundId,
            threadId: fixture.threadId,
            input: "look something up and record a marker",
          }),
        (error: unknown) => {
          assert.equal((error as Error).name, "AdmissionRefused");
          assert.equal((error as { decision?: string }).decision, "deny");
          assert.equal((error as { reason?: string }).reason, "expired");
          return true;
        },
      );

      // The tool actually ran: its ticket-based grant was never touched by
      // the model grant's expiry.
      assert.equal(markerState.callCount, 1);
      assert.equal(inner.remainingResponses, 1, "the second (post-expiry) scripted model reply must remain unconsumed");

      const decisions = fixture.ledger.decisions();
      const modelDecisions = decisions.filter((d) => d.request.resource === "search");
      const toolDecisions = decisions.filter((d) => d.request.resource === "marker");

      assert.equal(modelDecisions.length, 2, "expected one allowed and one denied model-call admission");
      assert.equal(modelDecisions[0]?.decision, "allow");
      assert.equal(modelDecisions[1]?.decision, "deny");
      assert.equal(modelDecisions[1]?.reason, "expired");

      assert.equal(toolDecisions.length, 1, "expected exactly one tool admission, unaffected by the model grant's expiry");
      assert.equal(toolDecisions[0]?.decision, "allow");
    } finally {
      await fixture.cleanup();
    }
  },
);
