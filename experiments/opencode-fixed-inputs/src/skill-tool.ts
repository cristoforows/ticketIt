import type { ScriptedTurn } from "opencode-harness";

let callIdCounter = 0;
function nextCallId(prefix: string): string {
  callIdCounter += 1;
  return `${prefix}_${callIdCounter}`;
}

export interface SkillToolCallOptions {
  /** The skill's `name` (its SKILL.md frontmatter `name`, matching its folder name). */
  name: string;
  /** Tool call id; auto-generated if omitted. */
  id?: string;
}

/**
 * Script an OpenAI-style tool-call turn invoking OpenCode's built-in
 * "skill" tool (registered tool id `"skill"`; confirmed against a running
 * pinned instance the same way `experiments/opencode-harness/src/scripting.ts`
 * confirmed `"bash"`/`"question"` for #17 -- via `client.tool.ids()`/
 * `client.tool.list({query:{provider,model}})`). `opencode-harness@0.1.0`
 * (#16-#17) does not export a skill-tool-call scripter (only bash/question/
 * text), so this is implemented locally in this package per this issue's
 * instructions rather than editing that shared package. It is a thin,
 * mechanical peer of `scriptBashToolCall`/`scriptQuestionToolCall` and
 * would be a reasonable candidate to fold into `opencode-harness/src/
 * scripting.ts` later if a future slice wants it there too.
 *
 * Confirmed schema (`client.tool.list()` for id "skill"):
 * `{ name: string }`, required. Confirmed tool description: "Load a
 * specialized skill when the task at hand matches one of the skills
 * listed in the system prompt. Use this tool to inject the skill's
 * instructions and resources into current conversation." The tool result
 * (`state.output`) contains the skill's Markdown body (everything after
 * the SKILL.md frontmatter), wrapped in a `<skill_content>` envelope with
 * the skill's base directory -- see docs/evidence/m1/19-opencode-fixed-inputs.md,
 * "Fixture/stub evidence" for a captured example.
 */
export function scriptSkillToolCall(options: SkillToolCallOptions): ScriptedTurn {
  return {
    content: "",
    toolCalls: [
      {
        id: options.id ?? nextCallId("call_skill"),
        name: "skill",
        arguments: JSON.stringify({ name: options.name }),
      },
    ],
  };
}
