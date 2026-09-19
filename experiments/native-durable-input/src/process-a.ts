/**
 * Process A: runs a scripted turn until it either pauses on a durable
 * `interrupt()` question or (for the "process-death" scenario) blocks
 * indefinitely inside a tool call so the test can SIGKILL it. Prints one
 * line of JSON to stdout describing the outcome, then exits -- except for
 * "process-death", which never exits on its own (see
 * `test/scenarios.test.ts`, which spawns and kills it).
 *
 * Usage: node --import tsx src/process-a.ts <scenario> <threadId> <tmpDir>
 * scenario: "question" | "fixed-inputs" | "restart" | "process-death"
 */
import { createHarnessAgent, runTurn, ScriptedChatModel } from "native-harness/src/index.js";
import { finalReply, toolCallResponse } from "./agent-factory.js";
import { connect } from "./connection.js";
import * as fixtures from "./fixtures.js";
import { composeSystemPrompt, LibraryStore } from "./library.js";
import { MarkerFileStore } from "./marker-store.js";
import { flagFilePath, libraryFilePath, markerFilePath } from "./paths.js";
import { graphOf, readPendingInterrupt } from "./recovery.js";
import { createAskHumanTool, createBlockingWaitTool, createRestartProbeTool } from "./tools.js";

async function main(): Promise<void> {
  const [scenario, threadId, tmpDir] = process.argv.slice(2);
  if (!scenario || !threadId || !tmpDir) {
    throw new Error("Usage: process-a.ts <scenario> <threadId> <tmpDir>");
  }

  const { checkpointer, registry, snapshotStore, close } = await connect();
  const config = { configurable: { thread_id: threadId } };

  try {
    const roundId = await registry.registerRound(threadId);

    if (scenario === "question") {
      const markerStore = new MarkerFileStore(markerFilePath(tmpDir, threadId));
      const model = ScriptedChatModel.create([
        toolCallResponse("ask_human", { question: fixtures.QUESTION_TEXT }),
        finalReply(fixtures.QUESTION_FINAL_REPLY),
      ]);
      const tool = createAskHumanTool(markerStore);
      const agent = createHarnessAgent({
        model,
        tools: [tool],
        checkpointer,
        systemPrompt: fixtures.QUESTION_SYSTEM_PROMPT,
      });

      await runTurn(agent, { roundId, threadId, input: fixtures.QUESTION_INPUT });
      const pending = await readPendingInterrupt(graphOf(agent), config);

      printResult({
        scenario,
        threadId,
        roundId,
        interrupted: Boolean(pending),
        interruptId: pending?.id,
        interruptValue: pending?.value,
        firstRequestSystemPrompt: model.requests[0]?.systemPrompt,
        modelRequestCount: model.requests.length,
        marker: markerStore.read(),
      });
      return;
    }

    if (scenario === "fixed-inputs") {
      const markerStore = new MarkerFileStore(markerFilePath(tmpDir, threadId));
      const library = new LibraryStore(libraryFilePath(tmpDir, "main"));
      const content = library.read();
      const systemPrompt = composeSystemPrompt(content);

      // Fix the snapshot for this thread at Round start -- a second call
      // for the same thread (e.g. on resume) would be a no-op; see
      // ExecutionSnapshotStore.save().
      await snapshotStore.save({ threadId, version: content.version, systemPrompt });

      const model = ScriptedChatModel.create([
        toolCallResponse("ask_human", { question: fixtures.QUESTION_TEXT }),
        finalReply(fixtures.QUESTION_FINAL_REPLY),
      ]);
      const tool = createAskHumanTool(markerStore);
      const agent = createHarnessAgent({ model, tools: [tool], checkpointer, systemPrompt });

      await runTurn(agent, { roundId, threadId, input: fixtures.QUESTION_INPUT });
      const pending = await readPendingInterrupt(graphOf(agent), config);

      printResult({
        scenario,
        threadId,
        roundId,
        version: content.version,
        interrupted: Boolean(pending),
        interruptId: pending?.id,
        firstRequestSystemPrompt: model.requests[0]?.systemPrompt,
      });
      return;
    }

    if (scenario === "restart") {
      const markerStore = new MarkerFileStore(markerFilePath(tmpDir, threadId));
      const model = ScriptedChatModel.create([
        toolCallResponse("restart_probe", { note: fixtures.RESTART_NOTE }),
        finalReply(fixtures.RESTART_FINAL_REPLY),
      ]);
      const tool = createRestartProbeTool(markerStore);
      const agent = createHarnessAgent({
        model,
        tools: [tool],
        checkpointer,
        systemPrompt: fixtures.QUESTION_SYSTEM_PROMPT,
      });

      await runTurn(agent, { roundId, threadId, input: fixtures.RESTART_INPUT });
      const pending = await readPendingInterrupt(graphOf(agent), config);

      printResult({
        scenario,
        threadId,
        roundId,
        interrupted: Boolean(pending),
        interruptId: pending?.id,
        markerAfterProcessA: markerStore.read(),
      });
      return;
    }

    if (scenario === "process-death") {
      // Deliberately never resolves on its own: the tool polls for a flag
      // file the test does not create, so `runTurn` below stays pending
      // until the test SIGKILLs this process mid-tool-call. No JSON is
      // printed and no cleanup runs -- that absence is the point (see
      // "Process death" in test/scenarios.test.ts).
      const markerStore = new MarkerFileStore(markerFilePath(tmpDir, threadId));
      const flagFile = flagFilePath(tmpDir, threadId);
      const model = ScriptedChatModel.create([
        toolCallResponse("blocking_wait", { label: fixtures.PROCESS_DEATH_LABEL }),
        finalReply(fixtures.PROCESS_DEATH_FINAL_REPLY),
      ]);
      const tool = createBlockingWaitTool(markerStore, flagFile);
      const agent = createHarnessAgent({
        model,
        tools: [tool],
        checkpointer,
        systemPrompt: fixtures.PROCESS_DEATH_SYSTEM_PROMPT,
      });

      // Print a "started" line BEFORE blocking, so the test knows it is
      // safe to send SIGKILL (the tool call is genuinely in flight, not
      // still waiting on the model or agent boot).
      process.stdout.write(`${JSON.stringify({ scenario, threadId, roundId, started: true })}\n`);
      await runTurn(agent, { roundId, threadId, input: fixtures.PROCESS_DEATH_INPUT });
      // Unreachable in the intended test flow (the process is killed
      // first), but included so a manual run without a kill still
      // completes cleanly once the flag file is created by hand.
      printResult({ scenario, threadId, roundId, completedWithoutKill: true });
      return;
    }

    throw new Error(`Unknown scenario: ${scenario}`);
  } finally {
    // For "process-death", this `finally` only runs if the tool actually
    // returned (i.e. the process was never killed); when SIGKILLed, the
    // whole process -- including this cleanup -- never runs, which is
    // expected and does not itself corrupt the checkpoint.
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
