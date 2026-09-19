import type { AdmitRequest } from "shared";

/**
 * The fixed identity a wrapped tool or wrapped model checks admission
 * against on every call. Bound once at construction time (mirroring how a
 * real Round would boot a fresh wrapped agent/tools for that Round), not
 * threaded per-call: `BaseChatModel._generate`'s `ParsedCallOptions` does
 * not carry `thread_id`/`configurable` (see
 * `@langchain/core/language_models/chat_models` -- `ParsedCallOptions`
 * omits everything from `RunnableConfig` except `signal`/`timeout`/
 * `maxConcurrency`), so there is no per-call channel to pull `roundId`/
 * `ticketId` out of the LangGraph invocation itself.
 */
export interface AdmissionScope {
  readonly roundId: string;
  readonly ticketId: string;
  readonly agentId: string;
  readonly account: string;
  readonly action: string;
  readonly resource: string;
}

/** Builds the ledger's `AdmitRequest` shape from a fixed {@link AdmissionScope}. */
export function toAdmitRequest(scope: AdmissionScope): AdmitRequest {
  return {
    roundId: scope.roundId,
    ticketId: scope.ticketId,
    agentId: scope.agentId,
    account: scope.account,
    action: scope.action,
    resource: scope.resource,
  };
}
