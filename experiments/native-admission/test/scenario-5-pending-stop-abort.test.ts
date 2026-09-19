import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHarnessAgent, runTurn } from "native-harness";
import { admittedModel, PartialOutputChatModel } from "../src/index.js";
import { assertDbReachable, createFixture, waitFor } from "./helpers.js";

before(assertDbReachable);

test(
  "scenario 5: a pending Stop cancels an in-flight model call through AbortSignal, retaining partial output/usage; the next admission is denied with stop-pending; the checkpoint remains readable",
  async () => {
    const fixture = await createFixture("s5-pending-stop-abort");
    try {
      const scope = fixture.baseScope("invoke_model", "chat");
      fixture.ledger.grant({
        agentId: scope.agentId,
        account: scope.account,
        action: scope.action,
        resource: scope.resource,
        kind: { kind: "ticket", ticketId: scope.ticketId },
      });

      const inner = new PartialOutputChatModel([
        { text: "Partial answer: as of the source consulted, ", inputTokens: 12, outputTokens: 8 },
        { text: "the current stable version is 4.2.", inputTokens: 0, outputTokens: 10 },
      ]);
      const model = admittedModel(inner, fixture.ledger, scope);

      const agent = createHarnessAgent({
        model,
        tools: [],
        checkpointer: fixture.checkpointer,
        systemPrompt: "scenario 5",
      });

      const controller = new AbortController();
      // Hold the call open right before its second (never-to-arrive) chunk
      // (index 1); the first chunk (index 0) has no gate armed for it and
      // appends immediately.
      inner.armChunkGate(1);
      const firstInvoke = runTurn(agent, {
        roundId: fixture.roundId,
        threadId: fixture.threadId,
        input: "look this up",
        signal: controller.signal,
      });

      // Wait for the first chunk to have genuinely landed before stopping,
      // so there is real partial content/usage to assert on.
      await waitFor(() => inner.lastCapture?.chunksEmitted === 1, {
        message: "the first scripted chunk never landed",
      });

      // The owner's Stop request records a pending "Stop requested" command
      // for the Round (execution-interface.md, "Stop with evidence-bearing
      // confirmation"); Michelin's mechanism for actually stopping the
      // engine, in this native-path fixture, is aborting the in-flight
      // call's AbortSignal.
      fixture.ledger.requestStop(fixture.roundId);
      controller.abort();

      await assert.rejects(firstInvoke, (error: unknown) => {
        assert.equal((error as Error).name, "AbortError");
        return true;
      });

      // Cancellation + retained partial output/usage: the model's own
      // capture reflects exactly the one chunk that landed before the
      // abort fired, and no more.
      const partial = inner.lastCapture;
      assert.ok(partial);
      assert.equal(partial?.aborted, true);
      assert.equal(partial?.chunksEmitted, 1);
      assert.equal(partial?.content, "Partial answer: as of the source consulted, ");
      assert.equal(partial?.usage.inputTokens, 12);
      assert.equal(partial?.usage.outputTokens, 8);

      // Ledger evidence: admitted and dispatched, but never complete()d --
      // that dispatch record (no completedAtMs) is the retained evidence of
      // the cancelled in-flight call (see admitted-model.ts's doc comment:
      // an aborted/failing call must never be marked complete()).
      const decisions = fixture.ledger.decisions();
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.decision, "allow");
      const dispatches = fixture.ledger.dispatches();
      assert.equal(dispatches.length, 1);
      assert.equal(dispatches[0]?.completedAtMs, undefined, "an aborted call must never be marked complete()");

      // The next admission attempt on the same thread is denied with
      // stop-pending -- taking precedence even though the underlying grant
      // is still otherwise valid (AdmissionLedger.admit()'s precedence
      // rule: a pending Stop always denies first).
      await assert.rejects(
        () =>
          runTurn(agent, {
            roundId: fixture.roundId,
            threadId: fixture.threadId,
            input: "try again",
          }),
        (error: unknown) => {
          assert.equal((error as Error).name, "AdmissionRefused");
          assert.equal((error as { decision?: string }).decision, "deny");
          assert.equal((error as { reason?: string }).reason, "stop-pending");
          return true;
        },
      );

      // The checkpoint (from before the aborted call) remains readable.
      const tuple = await fixture.checkpointer.getTuple({ configurable: { thread_id: fixture.threadId } });
      assert.ok(tuple, "expected the checkpoint to still be readable after the aborted call");
    } finally {
      await fixture.cleanup();
    }
  },
);
