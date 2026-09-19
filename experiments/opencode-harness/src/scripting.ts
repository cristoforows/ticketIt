import type { ScriptedTurn } from "./stub-model-server.js";

let callIdCounter = 0;
function nextCallId(prefix: string): string {
  callIdCounter += 1;
  return `${prefix}_${callIdCounter}`;
}

export interface BashToolCallOptions {
  /** Shell command, matching the "bash" tool's `command` parameter (see `client.tool.list()`). */
  command: string;
  /** Tool call id; auto-generated if omitted. */
  id?: string;
  timeout?: number;
  workdir?: string;
}

/**
 * Script an OpenAI-style tool-call turn invoking OpenCode's built-in
 * "bash" tool (registered tool id `"bash"`, confirmed via
 * `client.tool.ids()`/`client.tool.list()` against the pinned version —
 * see docs/evidence/m1/17-opencode-questions.md). The stub returns this as
 * `finish_reason: "tool_calls"` with no assistant text, matching the real
 * OpenAI tool-calling shape.
 */
export function scriptBashToolCall(options: BashToolCallOptions): ScriptedTurn {
  const { command, id, timeout, workdir } = options;
  const args: Record<string, unknown> = { command };
  if (timeout !== undefined) args.timeout = timeout;
  if (workdir !== undefined) args.workdir = workdir;
  return {
    content: "",
    toolCalls: [{ id: id ?? nextCallId("call_bash"), name: "bash", arguments: JSON.stringify(args) }],
  };
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionSpec {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

export interface QuestionToolCallOptions {
  questions: QuestionSpec[];
  /** Tool call id; auto-generated if omitted. */
  id?: string;
}

/**
 * Script an OpenAI-style tool-call turn invoking OpenCode's built-in
 * "question" tool (registered tool id `"question"`, confirmed the same
 * way as the bash tool above). This is the pinned version's question
 * mechanism: there is no separate native "ask a question" primitive
 * outside the tool-calling loop.
 */
export function scriptQuestionToolCall(options: QuestionToolCallOptions): ScriptedTurn {
  return {
    content: "",
    toolCalls: [
      {
        id: options.id ?? nextCallId("call_question"),
        name: "question",
        arguments: JSON.stringify({ questions: options.questions }),
      },
    ],
  };
}

/** Script a plain-text turn, e.g. the assistant's follow-up reply after a tool result is delivered back to it. */
export function scriptTextTurn(content: string): ScriptedTurn {
  return { content };
}
