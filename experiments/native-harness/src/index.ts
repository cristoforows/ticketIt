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
