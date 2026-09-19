// Public API of the native-harness tracer package. Later M1 slices (#23
// durable-input, #24 admission, #26 OpenRouter persistence) depend on this
// package through `dependencies: { "native-harness": "file:../native-harness" }`
// and should only import from here.

export {
  ScriptedChatModel,
  type ScriptedChatModelFields,
  type ScriptedRequest,
} from "./scripted-chat-model.js";

export { MarkerState, createMarkerTool } from "./marker-tool.js";

export {
  DEFAULT_DATABASE_URL,
  DATABASE_URL_ENV_VAR,
  resolveDatabaseUrl,
  assertDatabaseReachable,
  createPostgresCheckpointer,
} from "./checkpointer.js";

export { RoundRegistry } from "./round-registry.js";

export {
  createHarnessAgent,
  runTurn,
  type CreateHarnessAgentOptions,
  type HarnessAgent,
  type RunTurnOptions,
  type RunTurnResult,
} from "./harness.js";

// Additive re-exports for M1.12 (native-durable-input, issue #23). A
// dependent package that needs to construct its own tool objects or
// scripted model *responses with tool_calls* (durable human-input
// interrupts) must build them from THIS package's own installed copies of
// `@langchain/core`/`@langchain/langgraph`/`zod`, not a separately
// `npm install`-ed copy in its own node_modules. Two different installed
// copies of the same pinned version are still two different sets of
// classes/module state; LangChain/LangGraph internals (this package's own
// `createAgent`/`ToolNode`/model-output handling) do real `instanceof`-style
// identity checks on message and tool objects, which only work if the
// objects came from the copy those internals themselves import from -- a
// classic dual-package hazard. (`interrupt()`'s pause/resume plumbing and
// `Command` detection happen to be safe across separate copies, since they
// key off `globalThis`/`Symbol.for()` global registries rather than
// `instanceof`, but re-exporting them here too avoids a separate pinned
// `@langchain/langgraph` runtime dependency in the consumer entirely.) See
// docs/evidence/m1/23-native-durable-input.md, "Documentation research",
// for the specific mechanisms checked.
export { AIMessage } from "@langchain/core/messages";
export { tool } from "@langchain/core/tools";
export { z } from "zod";
export { interrupt, Command } from "@langchain/langgraph";
