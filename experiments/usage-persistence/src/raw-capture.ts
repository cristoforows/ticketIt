/**
 * Raw-response capture via fetch interception.
 *
 * #25's evidence established that `ChatOpenRouter` (`@langchain/openrouter@0.4.13`)
 * has no injectable `fetch`/`configuration` option -- `_generate` and
 * `_streamResponseChunks` call the global `fetch(...)` directly -- so the
 * only available access path for data the adapter drops before it reaches
 * the returned `AIMessage`/`AIMessageChunk` (citation annotations; usage
 * delivered via an empty-`choices` trailing SSE chunk) is monkey-patching
 * `globalThis.fetch` and reading a `response.clone()` independently of
 * whatever the adapter itself consumes. This module generalizes that
 * mechanism (first exercised ad hoc in
 * experiments/openrouter-fidelity/test/citations.test.ts) into a reusable
 * capture session.
 *
 * Caveats carried forward from #25's evidence ("Observed limitations"):
 * this patches `globalThis.fetch` process-wide, not scoped to one
 * `ChatOpenRouter` instance, so it must be installed/restored carefully
 * around exactly the calls under test.
 */

/** One raw response captured off an intercepted `fetch` call. */
export interface RawCapture {
  /** The `model` field found on the captured response body (JSON) or its first SSE event. */
  readonly model: string | undefined;
  /** True if the response was served as `text/event-stream` (SSE). */
  readonly streamed: boolean;
  /** For a non-streaming response: the parsed JSON body. `undefined` for a streamed response. */
  readonly json: Record<string, unknown> | undefined;
  /**
   * For a streamed response: every `data: ...` SSE event's parsed JSON
   * payload, in order, excluding the literal `[DONE]` terminator. Read from
   * an independent `response.clone()`, so this reflects every byte the
   * server actually sent -- including events the adapter itself discards
   * before ever constructing a `ChatGenerationChunk` from them (e.g. the
   * usage-only trailing chunk with empty `choices`; #25).
   */
  readonly sseEvents: Record<string, unknown>[] | undefined;
}

export interface RawCaptureSession {
  /** Every raw response captured so far, in the order the underlying requests were made. */
  readonly captures: readonly RawCapture[];
  /** Waits for every in-flight clone-read to finish. Call before inspecting `captures`. */
  finished(): Promise<void>;
  /** Restores the original `globalThis.fetch`. Safe to call more than once. */
  restore(): void;
}

/**
 * Installs the fetch interception described above and returns a session
 * object exposing every capture made while installed. Not scoped to one
 * model instance: every `fetch` call made anywhere in the process while
 * installed is captured, in order.
 */
export function startRawCapture(): RawCaptureSession {
  const originalFetch = globalThis.fetch;
  const captures: RawCapture[] = [];
  const pending: Promise<void>[] = [];
  let restored = false;

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    const clone = response.clone();
    const contentType = clone.headers.get("content-type") ?? "";
    const streamed = contentType.includes("text/event-stream");

    const readPromise = clone
      .text()
      .then((text) => {
        if (streamed) {
          const sseEvents = parseSseEvents(text);
          const model = typeof sseEvents[0]?.["model"] === "string" ? (sseEvents[0]!["model"] as string) : undefined;
          captures.push({ model, streamed: true, json: undefined, sseEvents });
        } else {
          const json = safeParseJsonObject(text);
          const model = json && typeof json["model"] === "string" ? (json["model"] as string) : undefined;
          captures.push({ model, streamed: false, json, sseEvents: undefined });
        }
      })
      .catch(() => {
        // A capture failure must never break the real response the adapter
        // consumes; it only means this out-of-band evidence path lost data
        // for this one call, which a test's assertions will surface as a
        // gap rather than a hang or a false pass.
      });
    pending.push(readPromise);

    return response;
  }) as typeof fetch;

  return {
    captures,
    async finished(): Promise<void> {
      await Promise.all(pending);
    },
    restore(): void {
      if (!restored) {
        globalThis.fetch = originalFetch;
        restored = true;
      }
    },
  };
}

function safeParseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseSseEvents(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const block of text.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0 || payload === "[DONE]") {
      continue;
    }
    const parsed = safeParseJsonObject(payload);
    if (parsed) {
      events.push(parsed);
    }
  }
  return events;
}
