export { StubModelServer } from "./stub-model-server.js";
export type { ScriptedToolCall, ScriptedTurn, StubModelServerOptions, StubRequestLogEntry } from "./stub-model-server.js";

export { startManagedOpenCode } from "./managed-opencode.js";
export type {
  ManagedOpenCode,
  ManagedOpenCodeCloseResult,
  ManagedOpenCodeSessionHelpers,
  StartManagedOpenCodeOptions,
  StubProviderOptions,
} from "./managed-opencode.js";
export type { OpencodeClient as OpencodeV2Client } from "@opencode-ai/sdk/v2";

export {
  listPending,
  replyPermission,
  replyQuestion,
  rejectQuestion,
  subscribeEvents,
} from "./pending.js";
export type {
  EngineReplyResult,
  EventSubscription,
  PendingPermissionRequest,
  PendingQuestionRequest,
  PendingState,
  PermissionReplyKind,
  QuestionAnswer,
  SubscribedEvent,
} from "./pending.js";

export { scriptBashToolCall, scriptQuestionToolCall, scriptTextTurn } from "./scripting.js";
export type { BashToolCallOptions, QuestionOption, QuestionSpec, QuestionToolCallOptions } from "./scripting.js";

export { markerAppendCommand, readMarkerLines } from "./marker.js";

export { createRoundMapping } from "./round-mapping.js";
export type { RoundMapping } from "./round-mapping.js";

export { isolatedEnvOverrides, makeIsolatedPaths } from "./env.js";
export type { IsolatedPaths } from "./env.js";

export {
  readOpencodePaths,
  readResolvedOpencodeConfig,
  resolveOpencodeBinary,
  resolveOpencodeBinDir,
  resolveOpencodeSdkVersion,
  resolveOpencodeVersion,
} from "./locate.js";
