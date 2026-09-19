import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { interrupt, tool, z } from "native-harness/src/index.js";
import type { MarkerFileStore } from "./marker-store.js";

/**
 * The resume payload every interrupting tool in this package expects,
 * carried through `Command({ resume })` (see `src/process-b.ts`). Including
 * `interruptId` (read from `getState()` before resuming -- see
 * `src/recovery.ts`'s `readPendingInterrupt`) lets the marker store's
 * idempotency key be `(thread ID [implicit in the per-thread marker file],
 * interrupt ID, answer)`, matching the issue's required idempotency
 * granularity, not just `(thread ID, answer)`.
 */
export interface ResumeAnswer {
  readonly interruptId: string;
  readonly answer: string;
}

/**
 * Scenario 1/2/3 tool ("durable question"). Calls `interrupt()` with the
 * question; when resumed, applies the marker side effect exactly once per
 * distinct `(interruptId, answer)` key via `MarkerFileStore.recordSideEffectOnce`
 * -- this is the harness-level idempotency the issue asks for if the
 * framework itself would otherwise repeat the effect on a duplicate resume
 * (see docs/evidence/m1/23-native-durable-input.md for which case was
 * actually observed).
 */
export function createAskHumanTool(markerStore: MarkerFileStore) {
  return tool(
    async ({ question }: { question: string }) => {
      markerStore.recordToolInvocation(`ask_human:entered node, question="${question}"`);
      const resume = interrupt({ kind: "question", question }) as ResumeAnswer;
      const key = `${resume.interruptId}:${resume.answer}`;
      const result = markerStore.recordSideEffectOnce(
        key,
        `ask_human resumed with answer="${resume.answer}" interruptId=${resume.interruptId}`,
      );
      return result.applied
        ? `marker recorded for answer "${resume.answer}" (side-effect #${result.sideEffectCount})`
        : `duplicate resume ignored for interruptId ${resume.interruptId} and the same answer ` +
            `(side-effect count remains ${result.sideEffectCount}; harness-level idempotency)`;
    },
    {
      name: "ask_human",
      description:
        "Asks the human a durable question via interrupt() and records a side-effect marker exactly once per distinct interrupt answer.",
      schema: z.object({ question: z.string() }),
    },
  );
}

/**
 * Scenario 4 tool ("restart semantics"). Records a side effect BEFORE
 * calling `interrupt()`, inside the same node/tool. LangGraph documents
 * that an interrupted node restarts from the beginning on resume
 * (docs/integration-feasibility.md, "LangChain human input": "Interrupted
 * nodes may restart from the beginning; effects before an interrupt can
 * repeat."), so `beforeInterruptCount` is expected to be 2 after resume
 * (once during Process A's paused attempt, once again when Process B
 * restarts the node), while the after-interrupt marker only applies once
 * (the resume only truly completes once).
 */
export function createRestartProbeTool(markerStore: MarkerFileStore) {
  return tool(
    async ({ note }: { note: string }) => {
      markerStore.recordBeforeInterrupt(`restart_probe:before-interrupt note="${note}"`);
      const resume = interrupt({ kind: "restart-probe", note }) as ResumeAnswer;
      markerStore.recordToolInvocation(`restart_probe:after-interrupt answer="${resume.answer}"`);
      return `restart probe complete: ${resume.answer}`;
    },
    {
      name: "restart_probe",
      description:
        "Records a marker before interrupt() and another after resume, to observe LangGraph's node-restart-from-beginning behavior.",
      schema: z.object({ note: z.string() }),
    },
  );
}

/**
 * Scenario 5 tool ("process death"). Blocks by polling for a flag file
 * that the test does not create until the negative demonstration, so
 * Process A can be SIGKILLed while genuinely mid-tool-call (not paused via
 * `interrupt()` -- this tool never calls `interrupt()` at all). Records a
 * "started" marker before entering the poll loop, so the checkpoint/marker
 * evidence can show the tool began but never finished.
 */
export function createBlockingWaitTool(markerStore: MarkerFileStore, flagFile: string) {
  return tool(
    async ({ label }: { label: string }) => {
      markerStore.recordToolInvocation(`blocking_wait:started label="${label}"`);
      while (!existsSync(flagFile)) {
        await sleep(100);
      }
      markerStore.recordToolInvocation(`blocking_wait:flag observed label="${label}"`);
      return `blocking_wait complete: ${label}`;
    },
    {
      name: "blocking_wait",
      description: "Blocks until a flag file appears on disk. Used to simulate a tool call in flight when the process dies.",
      schema: z.object({ label: z.string() }),
    },
  );
}
