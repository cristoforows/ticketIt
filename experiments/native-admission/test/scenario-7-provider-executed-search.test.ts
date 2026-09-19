import { test, before } from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import { createHarnessAgent, runTurn } from "native-harness";
import { admittedModel, ControllableChatModel, simulatedWebSearchReply } from "../src/index.js";
import { assertDbReachable, createFixture, waitFor } from "./helpers.js";

before(assertDbReachable);

test(
  "scenario 7: provider-executed search is admitted only at the model call -- there is no separate tool admission, and a mid-call disconnect does not undo the already-dispatched search",
  async () => {
    const fixture = await createFixture("s7-provider-executed-search");
    try {
      // "search" is a resource on the MODEL scope, not a tool resource --
      // there is no admittedTool wrapping anything named "search" anywhere
      // in this test, by construction, because OpenRouter's web-search
      // plugin runs inside the provider's completion call
      // (docs/integration-feasibility.md, "OpenRouter integration": "Search
      // occurs inside provider calls and may be an already-dispatched
      // remote action rather than a separately intercepted local tool").
      const scope = fixture.baseScope("invoke_model", "search");
      fixture.ledger.grant({
        agentId: scope.agentId,
        account: scope.account,
        action: scope.action,
        resource: scope.resource,
        kind: { kind: "ticket", ticketId: scope.ticketId },
      });

      const inner = ControllableChatModel.create([simulatedWebSearchReply()]);
      const model = admittedModel(inner, fixture.ledger, scope);

      // No tools at all: there is nothing for a search "tool call" to be --
      // the only registered execution surface is the model itself.
      const agent = createHarnessAgent({
        model,
        tools: [],
        checkpointer: fixture.checkpointer,
        systemPrompt: "scenario 7",
      });

      // Hold the call open so a mid-call disconnect can be observed, mirroring
      // scenario 2: the search reply is a single provider call, so
      // "already-dispatched" must apply to the WHOLE call, citations included
      // -- there is no earlier point inside it to intercept separately.
      const gate = inner.armDelay();
      const invocation = runTurn(agent, {
        roundId: fixture.roundId,
        threadId: fixture.threadId,
        input: "what is the current stable release?",
      });

      await waitFor(() => fixture.ledger.decisions().length === 1, {
        message: "the in-flight search call's admission was never recorded",
      });
      assert.equal(fixture.ledger.decisions().length, 1, "the in-flight search call's admission must already be recorded");
      assert.equal(fixture.ledger.decisions()[0]?.decision, "allow");
      assert.equal(fixture.ledger.dispatches()[0]?.completedAtMs, undefined, "not complete() yet -- still in flight");

      fixture.ledger.setConnected(false);
      gate.release();

      const result = await invocation;
      const finalMessage = result.messages.at(-1) as AIMessage;
      assert.equal(
        finalMessage.content,
        "Based on a web search, the current stable release is documented at the URL cited below.",
      );
      const annotations = (finalMessage.additional_kwargs as { annotations?: unknown[] }).annotations;
      assert.ok(Array.isArray(annotations) && annotations.length === 1, "expected the simulated citation annotation to survive the disconnect");
      assert.equal(fixture.ledger.dispatches()[0]?.completedAtMs !== undefined, true, "the already-dispatched search call must still complete");

      // Exactly one admission for the entire run, and it is the MODEL/search
      // scope -- never a "tool" resource, because none was ever registered.
      const decisions = fixture.ledger.decisions();
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.request.action, "invoke_model");
      assert.equal(decisions[0]?.request.resource, "search");
      assert.equal(
        decisions.every((d) => d.request.action !== "run_tool"),
        true,
        "no separate tool admission exists for provider-executed search",
      );

      // The next call, attempted while still disconnected, is held -- the
      // same already-dispatched/next-call split scenario 2 demonstrates,
      // now shown for the search-carrying model call specifically.
      await assert.rejects(
        () => runTurn(agent, { roundId: fixture.roundId, threadId: fixture.threadId, input: "search again" }),
        (error: unknown) => {
          assert.equal((error as Error).name, "AdmissionRefused");
          assert.equal((error as { decision?: string }).decision, "hold");
          assert.equal((error as { reason?: string }).reason, "disconnected");
          return true;
        },
      );
    } finally {
      await fixture.cleanup();
    }
  },
);
