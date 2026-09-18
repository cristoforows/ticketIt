import http from "node:http";
import type { AddressInfo } from "node:net";

/** One pre-scripted assistant turn the stub will return for a chat completion. */
export interface ScriptedTurn {
  content: string;
}

/** A request the stub received, logged so tests can assert what the engine sent. */
export interface StubRequestLogEntry {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body, or the raw string if it did not parse as JSON. */
  body: unknown;
  /** Raw request body text, useful for substring assertions. */
  bodyRaw: string;
  receivedAtMs: number;
}

export interface StubModelServerOptions {
  /** Model id advertised in /v1/models and echoed in completion responses. Default "stub-model". */
  modelId?: string;
  /**
   * Queue of scripted assistant turns, consumed in order by chat
   * completion requests. When exhausted, the last turn (or a default
   * "Hello from stub" turn if none were given) is repeated.
   */
  turns?: ScriptedTurn[];
}

/**
 * A local OpenAI-compatible HTTP server (node:http) implementing chat
 * completions (streaming SSE and non-streaming) and a models list
 * endpoint, returning pre-scripted turns and logging every request body
 * it receives. Binds to 127.0.0.1 on an ephemeral port.
 */
export class StubModelServer {
  readonly modelId: string;
  readonly requests: StubRequestLogEntry[] = [];

  private readonly turnQueue: ScriptedTurn[];
  private readonly server: http.Server;
  private listening = false;

  constructor(options: StubModelServerOptions = {}) {
    this.modelId = options.modelId ?? "stub-model";
    this.turnQueue = options.turns && options.turns.length > 0 ? [...options.turns] : [{ content: "Hello from stub" }];
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  /** Add another scripted turn to the end of the queue. */
  enqueueTurn(turn: ScriptedTurn): void {
    this.turnQueue.push(turn);
  }

  get url(): string {
    if (!this.listening) throw new Error("StubModelServer is not listening yet; call start() first");
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  get port(): number {
    if (!this.listening) throw new Error("StubModelServer is not listening yet; call start() first");
    return (this.server.address() as AddressInfo).port;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        this.listening = true;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
    this.listening = false;
  }

  private nextTurn(): ScriptedTurn {
    if (this.turnQueue.length > 1) return this.turnQueue.shift()!;
    return this.turnQueue[0] ?? { content: "" };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const bodyRaw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      if (bodyRaw) {
        try {
          body = JSON.parse(bodyRaw);
        } catch {
          body = bodyRaw;
        }
      }
      this.requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...req.headers },
        body,
        bodyRaw,
        receivedAtMs: Date.now(),
      });

      const url = req.url ?? "";
      if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
        this.respondChatCompletion(res, body as { stream?: boolean } | undefined);
        return;
      }
      if (url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: this.modelId, object: "model", created: 0, owned_by: "stub" }],
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `stub: no handler for ${req.method ?? ""} ${url}` } }));
    });
  }

  private respondChatCompletion(res: http.ServerResponse, body: { stream?: boolean } | undefined): void {
    const turn = this.nextTurn();
    const id = `chatcmpl-stub-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    if (body?.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const deltaChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model: this.modelId,
        choices: [{ index: 0, delta: { role: "assistant", content: turn.content }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(deltaChunk)}\n\n`);
      const doneChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model: this.modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model: this.modelId,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: turn.content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  }
}
