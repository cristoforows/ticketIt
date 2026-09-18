/**
 * Minimal local HTTP facade over an `AdmissionLedger`, so a plugin running
 * in another OS process (e.g. the OpenCode admission bridge planned for
 * issue #20) can call admit/dispatch/complete/state over loopback instead
 * of importing this package directly. Deliberately small: no auth, no
 * framework, `node:http` and `JSON.parse`/`JSON.stringify` only. This is
 * an M1 adapter proof, not a hardened service — see the evidence record's
 * "Observed limitations".
 *
 * Every write here still goes through `AdmissionLedger`'s own validation
 * (including `assertGrantKind`), so a malformed or hostile JSON body
 * cannot smuggle a combined ticket+time grant kind past the runtime check
 * just because it skipped TypeScript entirely.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AdmissionLedger, AdmitRequest } from "./admission-ledger.js";

export interface LedgerServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

/** Start the facade for `ledger` on `port` (0 for an OS-assigned ephemeral port). Resolves once listening. */
export function startLedgerServer(ledger: AdmissionLedger, port: number): Promise<LedgerServerHandle> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      handleRequest(ledger, req, res).catch((err: unknown) => {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      });
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

async function handleRequest(ledger: AdmissionLedger, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (method === "GET" && url.pathname === "/state") {
    sendJson(res, 200, ledger.state());
    return;
  }

  if (method === "POST" && url.pathname === "/admit") {
    const body = (await readJsonBody(req)) as AdmitRequest;
    sendJson(res, 200, ledger.admit(body));
    return;
  }

  if (method === "POST" && url.pathname === "/dispatch") {
    const body = (await readJsonBody(req)) as { admissionId: string };
    ledger.dispatch(body.admissionId);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/complete") {
    const body = (await readJsonBody(req)) as { admissionId: string };
    ledger.complete(body.admissionId);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: `Not found: ${method} ${url.pathname}` });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}
