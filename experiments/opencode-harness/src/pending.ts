import type { OpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient as OpencodeV2Client } from "@opencode-ai/sdk/v2";

/**
 * One event received from `client.event.subscribe()`'s SSE stream, buffered
 * in arrival order. The event's own shape (`{id, type, properties}`) is
 * whatever the pinned server emits — see
 * docs/evidence/m1/17-opencode-questions.md for the concrete shapes
 * observed for `permission.asked`/`permission.replied` and
 * `question.asked`/`question.replied`/`question.rejected`, which differ
 * from the bare `@opencode-ai/sdk` package's declared `Event` union.
 */
export interface SubscribedEvent {
  receivedAtMs: number;
  event: unknown;
}

export interface EventSubscription {
  /** Every event received since subscribing, in arrival order. Mutated in place. */
  events: SubscribedEvent[];
  /** Stop consuming the event stream. Idempotent; safe to call more than once. */
  stop(): void;
  /** Resolves once the background consumption loop has actually exited after stop(). */
  closed: Promise<void>;
  /**
   * Set if the consumption loop exited because of an error other than the
   * expected abort from `stop()`. Null while subscribed or after a clean
   * stop.
   */
  error: unknown;
}

/**
 * Subscribe to the OpenCode server's event stream (`GET /event`, an SSE
 * stream) and buffer every event received into `.events`, so a test can
 * assert on it later without racing the stream. Works with either the "v1"
 * or the "/v2" SDK client (`ManagedOpenCode.client` or `.v2Client`): both
 * expose an identical `.event.subscribe()` against the same running
 * server, only the generated request/response *types* differ (see the
 * comment in `src/managed-opencode.ts`).
 *
 * `stop()` aborts the underlying fetch via `AbortSignal`; per
 * docs/evidence/m1/17-opencode-questions.md this is the only way to drop
 * the subscription observed in this pinned SDK (`ServerSentEventsResult`
 * exposes no separate `close()`).
 */
export async function subscribeEvents(
  client: OpencodeClient | OpencodeV2Client,
): Promise<EventSubscription> {
  const controller = new AbortController();
  const events: SubscribedEvent[] = [];
  const subscription: EventSubscription = {
    events,
    error: null,
    stop() {
      controller.abort();
    },
    closed: Promise.resolve(),
  };

  const result = await client.event.subscribe({ signal: controller.signal } as Parameters<
    OpencodeClient["event"]["subscribe"]
  >[0]);

  subscription.closed = (async () => {
    try {
      for await (const event of result.stream) {
        events.push({ receivedAtMs: Date.now(), event });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        subscription.error = err;
      }
      // An aborted fetch rejecting/ending the stream is the expected way
      // stop() takes effect; nothing further to do.
    }
  })();

  return subscription;
}

/** A pending permission request, as returned by `client.permission.list()` (a query, not an event). */
export interface PendingPermissionRequest {
  id: string;
  sessionID: string;
  /** The permission kind being asked about, e.g. "bash". */
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  /** Command-pattern globs that a reply of "always" would additionally cover. */
  always: string[];
  tool?: { messageID: string; callID: string };
}

/** A pending question request, as returned by `client.question.list()` (a query, not an event). */
export interface PendingQuestionRequest {
  id: string;
  sessionID: string;
  questions: unknown[];
  tool?: { messageID: string; callID: string };
}

export interface PendingState {
  permissions: PendingPermissionRequest[];
  questions: PendingQuestionRequest[];
}

/**
 * Query pending permission requests and questions for `sessionId`, entirely
 * through request/response endpoints (`GET /permission`, `GET /question`
 * via the `/v2` client's `.permission.list()`/`.question.list()`) — never
 * through the event stream. This is what a reconnecting caller (dropped
 * subscription, new process, etc.) uses to recover pending state.
 *
 * Both endpoints list pending requests *across all sessions* (no
 * server-side session filter is exposed on this pinned build's top-level
 * routes — see "Observed limitations" in
 * docs/evidence/m1/17-opencode-questions.md for why the seemingly more
 * targeted `client.v2Client.v2.session.permission.list({sessionID})` route
 * is not used here: it was observed to return an empty list even while a
 * permission for that session was genuinely pending), so this function
 * filters the results by `sessionID` itself.
 */
export async function listPending(client: OpencodeV2Client, sessionId: string): Promise<PendingState> {
  const [permissionResult, questionResult] = await Promise.all([
    client.permission.list({}),
    client.question.list({}),
  ]);
  if (permissionResult.error) {
    throw new Error(`permission.list failed: ${JSON.stringify(permissionResult.error)}`);
  }
  if (questionResult.error) {
    throw new Error(`question.list failed: ${JSON.stringify(questionResult.error)}`);
  }
  const permissions = (permissionResult.data ?? []) as PendingPermissionRequest[];
  const questions = (questionResult.data ?? []) as PendingQuestionRequest[];
  return {
    permissions: permissions.filter((p) => p.sessionID === sessionId),
    questions: questions.filter((q) => q.sessionID === sessionId),
  };
}

/** The three reply kinds the pinned version's permission endpoint names (see `PermissionReplyData.body.reply`). */
export type PermissionReplyKind = "once" | "always" | "reject";

export interface EngineReplyResult {
  /** True only if the endpoint returned the literal `true` success response. */
  ok: boolean;
  /** The raw error the SDK surfaced (e.g. a 404 `PermissionNotFoundError`/`QuestionNotFoundError`), or null. */
  error: unknown;
}

/**
 * Reply to a pending permission request via `POST /permission/{requestID}/reply`
 * (through the `/v2` client's `client.permission.reply()`). Does not throw
 * on a rejected/duplicate reply — callers that need the exact engine
 * behavior (see the "duplicate reply" test) should inspect `.error`.
 */
export async function replyPermission(
  client: OpencodeV2Client,
  requestId: string,
  response: PermissionReplyKind,
): Promise<EngineReplyResult> {
  const result = await client.permission.reply({ requestID: requestId, reply: response });
  return { ok: result.data === true, error: result.error ?? null };
}

/** One question's answer: an array of the selected option labels (see `QuestionAnswer` in the pinned SDK's v2 types). */
export type QuestionAnswer = string[];

/**
 * Reply to a pending question request via `POST /question/{requestID}/reply`
 * (through the `/v2` client's `client.question.reply()`). `answers` is one
 * entry per question in the original request, each an array of selected
 * option labels (supports `multiple: true` questions).
 */
export async function replyQuestion(
  client: OpencodeV2Client,
  requestId: string,
  answers: QuestionAnswer[],
): Promise<EngineReplyResult> {
  const result = await client.question.reply({ requestID: requestId, answers });
  return { ok: result.data === true, error: result.error ?? null };
}

/**
 * Reject a pending question request via `POST /question/{requestID}/reject`.
 * Exported alongside `replyQuestion` since the pinned version's question
 * mechanism supports both outcomes; not required by every test.
 */
export async function rejectQuestion(client: OpencodeV2Client, requestId: string): Promise<EngineReplyResult> {
  const result = await client.question.reject({ requestID: requestId });
  return { ok: result.data === true, error: result.error ?? null };
}
