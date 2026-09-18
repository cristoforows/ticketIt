import { createAgent } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

export interface CreateHarnessAgentOptions {
  /** The chat model driving the agent. A ScriptedChatModel in this tracer. */
  model: BaseChatModel;
  /** Tools the agent may call. */
  tools: (ClientTool | ServerTool)[];
  /** Durable checkpointer (PostgresSaver in this tracer). */
  checkpointer: BaseCheckpointSaver;
  /** Optional system prompt. */
  systemPrompt?: string;
}

/**
 * Builds the native-harness agent using LangChain JS `createAgent`
 * (see docs/agent-execution.md, "Initial execution engines": "Use the
 * provided agent structure rather than designing a custom graph upfront").
 */
export function createHarnessAgent(options: CreateHarnessAgentOptions) {
  return createAgent({
    model: options.model,
    tools: options.tools,
    checkpointer: options.checkpointer,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
  });
}

export type HarnessAgent = ReturnType<typeof createHarnessAgent>;

export interface RunTurnOptions {
  /** ticketIt Round ID (never the thread ID -- see ADR 0002). */
  roundId: string;
  /** LangGraph thread ID: the engine execution reference attached to the Round. */
  threadId: string;
  /** The human input for this turn. */
  input: string;
}

export interface RunTurnResult {
  roundId: string;
  threadId: string;
  messages: unknown[];
}

/**
 * Runs one turn of the harness agent on the given thread, keyed by
 * `threadId` for LangGraph/checkpoint purposes. The Round ID is carried
 * through the result but is never passed to LangGraph as the thread
 * identifier: engine execution references and Round IDs are separate
 * identity spaces (ADR 0002; docs/contracts/execution-interface.md,
 * "Identity model").
 */
export async function runTurn(
  agent: HarnessAgent,
  options: RunTurnOptions,
): Promise<RunTurnResult> {
  const result = await agent.invoke(
    { messages: [new HumanMessage(options.input)] },
    { configurable: { thread_id: options.threadId } },
  );
  return {
    roundId: options.roundId,
    threadId: options.threadId,
    messages: (result as { messages: unknown[] }).messages,
  };
}
