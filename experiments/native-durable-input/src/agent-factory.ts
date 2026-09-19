import { AIMessage } from "native-harness/src/index.js";

/** Builds a scripted AIMessage that requests a single tool call. */
export function toolCallResponse(toolName: string, args: Record<string, unknown>, callId = "call_1"): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ id: callId, name: toolName, args }] });
}

/** Builds a scripted plain-text AIMessage (a final reply). */
export function finalReply(text: string): AIMessage {
  return new AIMessage({ content: text });
}
