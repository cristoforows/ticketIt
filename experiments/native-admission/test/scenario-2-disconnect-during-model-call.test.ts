import { test, before } from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import { createHarnessAgent, runTurn } from "native-harness";
import { admittedModel, ControllableChatModel } from "../src/index.js";
import { assertDbReachable, createFixture, waitFor } from "./helpers.js";

before(assertDbReachable);

test(
  "scenario 2: an in-flight model call completes despite a mid-call disconnect, but the next model call is held",
  async () => {
    const fixture = await createFixture("s2-disconnect-during-model-call");
    try {
      const scope = fixture.baseScope("invoke_model", "chat");
      fixture.ledger.grant({
        agentId: scope.agentId,
        account: scope.account,
        action: scope.action,
        resource: scope.resource,
        kind: { kind: "ticket", ticketId: scope.ticketId },
      });

      const inner = ControllableChatModel.create([
        new AIMessage({ content: "first reply, dispatched before disconnect" }),
        new AIMessage({ content: "second reply -- must never be produced" }),
      ]);
      const model = admittedModel(inner, fixture.ledger, scope);

      const agent = createHarnessAgent({
        model,
        tools: [],
        checkpointer: fixture.checkpointer,
        systemPrompt: "scenario 2",
      });

      // Hold the first call open until we explicitly release it, so we can
      // flip connectivity to "disconnected" while it is genuinely in flight
      // (admitted + dispatched, but not yet complete()).
      const gate = inner.armDelay();
      const firstInvoke = runTurn(agent, {
        roundId: fixture.roundId,
        threadId: fixture.threadId,
        input: "go",
      });

      // Wait for the in-flight call's admit()/dispatch() to actually run
      // before we disconnect and release the gate. A fixed number of
      // microtask ticks was tried first and observed to be fragile (it
      // depends on internal await hops inside createAgent's ReAct loop and
      // the checkpointer's initial read, not a stable constant) -- see
      // waitFor()'s doc comment in test/helpers.ts.
      await waitFor(() => fixture.ledger.decisions().length === 1, {
        message: "the in-flight call's admission was never recorded",
      });

      assert.equal(fixture.ledger.decisions().length, 1, "the in-flight call's admission must already be recorded");
      assert.equal(fixture.ledger.decisions()[0]?.decision, "allow");
      assert.equal(fixture.ledger.dispatches().length, 1, "dispatch() must already be recorded for the in-flight call");
      assert.equal(fixture.ledger.dispatches()[0]?.completedAtMs, undefined, "not complete() yet -- still in flight");

      fixture.ledger.setConnected(false);
      gate.release();

      const firstResult = await firstInvoke;
      assert.equal(
        (firstResult.messages.at(-1) as AIMessage).content,
        "first reply, dispatched before disconnect",
        "the already-dispatched call must complete and deliver its real result",
      );
      assert.equal(fixture.ledger.dispatches()[0]?.completedAtMs !== undefined, true, "complete() must be recorded once the in-flight call finished");
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The NEXT model call, attempted while still disconnected, must be held --
      // not run, and not silently allowed just because the previous call finished.
      await assert.rejects(
        () =>
          runTurn(agent, {
            roundId: fixture.roundId,
            threadId: fixture.threadId,
            input: "go again",
          }),
        (error: unknown) => {
          assert.equal((error as Error).name, "AdmissionRefused");
          assert.equal((error as { decision?: string }).decision, "hold");
          assert.equal((error as { reason?: string }).reason, "disconnected");
          return true;
        },
      );

      const decisions = fixture.ledger.decisions();
      assert.equal(decisions.length, 2);
      assert.equal(decisions[0]?.decision, "allow");
      assert.equal(decisions[1]?.decision, "hold");
      assert.equal(
        decisions.filter((d) => d.decidedAtMs >= fixture.clock.nowMs() && d.decision === "allow" && d !== decisions[0]).length,
        0,
        "no allow decisions recorded once disconnected",
      );
      // The second (never-produced) scripted reply must remain unconsumed.
      assert.equal(inner.remainingResponses, 1);
    } finally {
      await fixture.cleanup();
    }
  },
);
