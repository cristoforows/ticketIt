/**
 * Process B: a fresh process that reconnects to an existing thread purely
 * through the PostgreSQL checkpointer (and, for "fixed-inputs", the
 * execution-snapshot table) -- it holds none of Process A's in-memory
 * state. Reads the pending interrupt via `getState()`, resumes with
 * `Command({ resume })`, and prints one line of JSON with the result.
 *
 * Usage:
 *   node --import tsx src/process-b.ts question <threadId> <tmpDir> <answer>
 *   node --import tsx src/process-b.ts fixed-inputs <threadId> <tmpDir> <answer>
 *   node --import tsx src/process-b.ts restart <threadId> <tmpDir> <answer>
 *   node --import tsx src/process-b.ts process-death <threadId> <tmpDir> [--negative-demo]
 *
 * Calling this script twice with the same threadId/answer for "question"
 * or "fixed-inputs" is scenario 2 (duplicate reply): the second call is
 * Process B "or Process C" from the issue text -- this script does not
 * care which process index it is, only that it is a fresh reconnect.
 */
import { Command, createHarnessAgent, ScriptedChatModel } from "native-harness/src/index.js";
import { finalReply } from "./agent-factory.js";
import { connect } from "./connection.js";
import * as fixtures from "./fixtures.js";
import { MarkerFileStore } from "./marker-store.js";
import { flagFilePath, markerFilePath } from "./paths.js";
import { graphOf, readPendingInterrupt, RecoveryPolicy, RecoveryRefusedError } from "./recovery.js";
import { createAskHumanTool, createBlockingWaitTool, createRestartProbeTool, type ResumeAnswer } from "./tools.js";

async function main(): Promise<void> {
  const positionals = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const negativeDemo = process.argv.includes("--negative-demo");
  const [scenario, threadId, tmpDir, answer] = positionals;
  if (!scenario || !threadId || !tmpDir) {
    throw new Error("Usage: process-b.ts <scenario> <threadId> <tmpDir> [answer] [--negative-demo]");
  }

  const { checkpointer, snapshotStore, close } = await connect();
  const config = { configurable: { thread_id: threadId } };

  try {
    if (scenario === "question") {
      if (!answer) throw new Error("question scenario requires an <answer> argument");
      const markerStore = new MarkerFileStore(markerFilePath(tmpDir, threadId));
      const model = ScriptedChatModel.create([finalReply(fixtures.QUESTION_FINAL_REPLY)]);
      const tool = createAskHumanTool(markerStore);
      const agent = createHarnessAgent({
        model,
        tools: [tool],
        checkpointer,
        systemPrompt: fixtures.QUESTION_SYSTEM_PROMPT,
      });
      const graph = graphOf(agent);

      const pendingBefore = await readPendingInterrupt(graph, config);
      const resumePayload: ResumeAnswer = { interruptId: pendingBefore?.id ?? "<none>", answer };
      const result = await graph.invoke(new Command({ resume: resumePayload }), config);

      printResult({
        scenario,
        threadId,
        hadPendingInterruptBeforeResume: Boolean(pendingBefore),
        pendingInterruptId: pendingBefore?.id,
        modelRequestCountThisProcess: model.requests.length,
        finalMessageCount: Array.isArray((result as { messages?: unknown[] }).messages)
          ? (result as { messages: unknown[] }).messages.length
          : undefined,
        marker: markerStore.read(),
      });
      return;
    }

    if (scenario === "fixed-inputs") {
      if (!answer) throw new Error("fixed-inputs scenario requires an <answer> argument");
      const markerStore = new MarkerFileStore(markerFilePath(tmpDir, threadId));
      const snapshot = await snapshotStore.load(threadId);
      if (!snapshot) throw new Error(`No execution snapshot found for thread ${threadId}`);

      const model = ScriptedChatModel.create([finalReply(fixtures.QUESTION_FINAL_REPLY)]);
      const tool = createAskHumanTool(markerStore);
      // Reconstructed from the durable per-thread snapshot -- NOT from
      // LibraryStore.read() -- even though the library file may have been
      // republished to version B by now.
      const agent = createHarnessAgent({ model, tools: [tool], checkpointer, systemPrompt: snapshot.systemPrompt });
      const graph = graphOf(agent);

      const pendingBefore = await readPendingInterrupt(graph, config);
      const resumePayload: ResumeAnswer = { interruptId: pendingBefore?.id ?? "<none>", answer };
      await graph.invoke(new Command({ resume: resumePayload }), config);

      printResult({
        scenario,
        threadId,
        snapshotVersion: snapshot.version,
        snapshotSystemPrompt: snapshot.systemPrompt,
        resumedRequestSystemPrompt: model.requests[0]?.systemPrompt,
      });
      return;
    }

    if (scenario === "restart") {
      if (!answer) throw new Error("restart scenario requires an <answer> argument");
      const markerStore = new MarkerFileStore(markerFilePath(tmpDir, threadId));
      const model = ScriptedChatModel.create([finalReply(fixtures.RESTART_FINAL_REPLY)]);
      const tool = createRestartProbeTool(markerStore);
      const agent = createHarnessAgent({
        model,
        tools: [tool],
        checkpointer,
        systemPrompt: fixtures.QUESTION_SYSTEM_PROMPT,
      });
      const graph = graphOf(agent);

      const pendingBefore = await readPendingInterrupt(graph, config);
      const resumePayload: ResumeAnswer = { interruptId: pendingBefore?.id ?? "<none>", answer };
      await graph.invoke(new Command({ resume: resumePayload }), config);

      printResult({
        scenario,
        threadId,
        markerAfterResume: markerStore.read(),
      });
      return;
    }

    if (scenario === "process-death") {
      const markerStore = new MarkerFileStore(markerFilePath(tmpDir, threadId));
      const flagFile = flagFilePath(tmpDir, threadId);
      const graph = graphOf(
        createHarnessAgent({
          model: ScriptedChatModel.create([finalReply(fixtures.PROCESS_DEATH_FINAL_REPLY)]),
          // The real blocking_wait tool, bound to this thread's flag file.
          // `classify()`/`continueIfIntact()` never invoke the graph (they
          // only call `getState()`), so this binding only matters for the
          // `--negative-demo` path below, which does invoke the graph.
          tools: [createBlockingWaitTool(markerStore, flagFile)],
          checkpointer,
          systemPrompt: fixtures.PROCESS_DEATH_SYSTEM_PROMPT,
        }),
      );

      if (negativeDemo) {
        // Clearly-labelled NEGATIVE demonstration: bypass RecoveryPolicy
        // entirely and ask the framework itself to continue. The test
        // creates the flag file before spawning this process, so the tool
        // (restarted from the beginning, per LangGraph's node-restart
        // semantics) completes this time.
        const result = await graph.invoke(null, config);
        printResult({
          scenario,
          threadId,
          negativeDemo: true,
          frameworkContinued: true,
          finalMessageCount: Array.isArray((result as { messages?: unknown[] }).messages)
            ? (result as { messages: unknown[] }).messages.length
            : undefined,
          marker: markerStore.read(),
        });
        return;
      }

      const policy = new RecoveryPolicy(graph);
      const classification = await policy.classify(config);
      try {
        await policy.continueIfIntact(config);
        printResult({ scenario, threadId, refused: false, classification });
      } catch (error) {
        if (error instanceof RecoveryRefusedError) {
          printResult({
            scenario,
            threadId,
            refused: true,
            reason: error.reason,
            classification,
            message: error.message,
          });
          return;
        }
        throw error;
      }
      return;
    }

    throw new Error(`Unknown scenario: ${scenario}`);
  } finally {
    await close();
  }
}

function printResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
