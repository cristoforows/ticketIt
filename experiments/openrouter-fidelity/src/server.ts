import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A single non-streaming ("invoke") fixture response for the
 * `/chat/completions` endpoint.
 */
export interface JsonFixtureResponse {
  kind: "json";
  /** HTTP status code. Defaults to 200. */
  status?: number;
  /** JSON body to serialize and return. */
  body: Record<string, unknown>;
  /**
   * If set, write only the first N characters of the serialized JSON body,
   * then destroy the socket without completing the response. Simulates a
   * connection drop mid-body for a non-streaming request (the `invoke`
   * counterpart of the SSE `truncateAfter` behavior below).
   */
  truncateToChars?: number;
}

/**
 * A single streaming ("stream") fixture response for the
 * `/chat/completions` endpoint, delivered as server-sent events.
 */
export interface SseFixtureResponse {
  kind: "sse";
  /** HTTP status code for the initial response. Defaults to 200. */
  status?: number;
  /** One JSON object per `data: ...` SSE line, sent in order. */
  chunks: Record<string, unknown>[];
  /**
   * If set, destroy the socket after writing this many chunks, without
   * ever sending `data: [DONE]`. Simulates a dropped connection mid-stream,
   * distinct from the in-band `error` chunk shape used by the
   * mid-stream-error fixture (see fixtures.ts).
   */
  truncateAfter?: number;
}

export interface FixtureBundle {
  /** Served when the request body has `stream: false` (or omitted). */
  json: JsonFixtureResponse;
  /** Served when the request body has `stream: true`. */
  sse: SseFixtureResponse;
}

/** One recorded request, for test assertions. */
export interface RecordedRequest {
  method: string;
  path: string;
  /** Request headers with `authorization` removed. */
  headers: Record<string, string | string[]>;
  /** Parsed JSON request body. */
  body: unknown;
}

/**
 * A local, in-process fake of OpenRouter's `/chat/completions` endpoint.
 *
 * Serves named fixtures (chosen by the request body's `model` field) in
 * either JSON (`stream: false`) or SSE (`stream: true`) shape, records
 * every request it receives (headers minus `authorization`, and the parsed
 * body) for assertions, and can simulate a truncated connection or an
 * in-band mid-stream error per fixture. Never talks to a real provider;
 * listens only on 127.0.0.1 with an ephemeral port.
 */
export class FakeOpenRouterServer {
  private readonly server: Server;
  private readonly fixtures: Record<string, FixtureBundle>;
  private readonly recorded: RecordedRequest[] = [];
  private port = 0;

  constructor(fixtures: Record<string, FixtureBundle>) {
    this.fixtures = fixtures;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        // A handler bug should not hang the test; surface it as a 500.
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: { message: String(err) } }));
      });
    });
  }

  /** Start listening on 127.0.0.1 with an ephemeral port. */
  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    this.port = address.port;
  }

  /** Stop listening and close any open connections. */
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.closeAllConnections();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Base URL to pass as `baseURL` to `ChatOpenRouter`. */
  get baseURL(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Every request received so far, in order. */
  get requests(): readonly RecordedRequest[] {
    return this.recorded;
  }

  /** Clear recorded requests between assertions within a test. */
  clearRequests(): void {
    this.recorded.length = 0;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    const rawBody = await readBody(req);

    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "authorization" || value === undefined) continue;
      headers[key] = value;
    }

    let parsedBody: unknown = undefined;
    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON body", code: "invalid_request" } }));
        return;
      }
    }

    this.recorded.push({ method, path, headers, body: parsedBody });

    if (method !== "POST" || path !== "/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `No fixture route for ${method} ${path}`, code: "not_found" } }));
      return;
    }

    const model = isRecord(parsedBody) && typeof parsedBody.model === "string" ? parsedBody.model : undefined;
    const bundle = model ? this.fixtures[model] : undefined;
    if (!bundle) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `No fixture registered for model "${String(model)}"`, code: "unknown_fixture" },
        }),
      );
      return;
    }

    const wantsStream = isRecord(parsedBody) && parsedBody.stream === true;
    if (wantsStream) {
      this.serveSse(res, bundle.sse);
    } else {
      this.serveJson(res, bundle.json);
    }
  }

  private serveJson(res: ServerResponse, fixture: JsonFixtureResponse): void {
    const payload = JSON.stringify(fixture.body);
    res.writeHead(fixture.status ?? 200, { "content-type": "application/json" });
    if (fixture.truncateToChars !== undefined) {
      res.write(payload.slice(0, fixture.truncateToChars), () => {
        setImmediate(() => res.socket?.destroy());
      });
      return;
    }
    res.end(payload);
  }

  private serveSse(res: ServerResponse, fixture: SseFixtureResponse): void {
    res.writeHead(fixture.status ?? 200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (let i = 0; i < fixture.chunks.length; i += 1) {
      const isLastBeforeTruncation = fixture.truncateAfter !== undefined && i + 1 === fixture.truncateAfter;
      if (isLastBeforeTruncation) {
        // Wait for the write to be accepted by the stream, then give the
        // event loop a turn so the bytes actually reach the client's
        // socket buffer before we destroy the connection -- otherwise the
        // client can observe zero bytes read instead of a genuine
        // mid-stream truncation.
        res.write(`data: ${JSON.stringify(fixture.chunks[i])}\n\n`, () => {
          setImmediate(() => res.socket?.destroy());
        });
        return;
      }
      res.write(`data: ${JSON.stringify(fixture.chunks[i])}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
