/**
 * A fake GitHub REST API server modeling the documented identity and
 * resource-scope behavior this experiment needs (see
 * docs/evidence/m1/27-github-identity.md, "Documentation research", for
 * the cited GitHub docs this models). It is a model of documented
 * behavior, not a capture of real GitHub responses — see that record's
 * "Observed limitations".
 *
 * Endpoints:
 * - `GET /user` — identity lookup. A configured OAuth-kind token (sign-in
 *   identity) or PAT-kind token (Connected Account identity) resolves to
 *   its configured `login`. Per
 *   https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
 *   ("If you are using a GitHub App or fine-grained personal access
 *   token and you receive a 'Resource not accessible by integration' or
 *   'Resource not accessible by personal access token' error, then your
 *   token has insufficient permissions") and
 *   https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 *   ("Authorization: Bearer OAUTH-TOKEN"), both schemes authenticate via
 *   `Authorization: Bearer <token>`.
 * - `GET /repos/{owner}/{repo}` — 200 only for a repository inside the
 *   presenting PAT's configured resource set; 404 otherwise. Per
 *   https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api :
 *   "GitHub uses a 404 Not Found response instead of a 403 Forbidden
 *   response to avoid confirming the existence of private repositories."
 * - `GET /repos/{owner}/{repo}/pulls` — repository-scope gate first (404
 *   if outside the resource set, matching the "don't confirm existence"
 *   behavior above), then 403 ("Resource not accessible by personal
 *   access token", same citation) if the token's resource-set entry does
 *   not include the `pull_requests` permission.
 *
 * This server never accepts a bearer token it was not configured with:
 * an unrecognized token always resolves to `tokenKind: "unknown"` and a
 * 401, regardless of endpoint.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** A configured OAuth-style sign-in identity (mocks GitHub OAuth user identity). */
export interface OAuthAccountConfig {
  readonly token: string;
  readonly login: string;
}

/**
 * A configured fine-grained PAT identity: a login plus the resource set
 * (`"owner/repo"` strings) and permissions (e.g. `"pull_requests"`,
 * `"contents"`) this token is scoped to.
 */
export interface PatAccountConfig {
  readonly token: string;
  readonly login: string;
  readonly repositories: readonly string[];
  readonly permissions: readonly string[];
}

export interface FakeGitHubApiConfig {
  readonly oauthAccounts?: readonly OAuthAccountConfig[];
  readonly patAccounts?: readonly PatAccountConfig[];
}

export type TokenKind = "oauth" | "pat" | "unknown";

/** One recorded request, for test assertions (e.g. "only the PAT was ever sent"). */
export interface RequestLogEntry {
  readonly method: string;
  readonly path: string;
  readonly tokenKind: TokenKind;
  readonly token: string | null;
  readonly login: string | null;
  readonly status: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header) ?? /^token\s+(.+)$/i.exec(header);
  return match ? (match[1] ?? null) : null;
}

/**
 * Fake GitHub REST API. Constructed with fixed account fixtures; start it
 * with `listen()` and stop it with `close()`. Every request is recorded
 * in `requestLog()`, regardless of outcome.
 */
export class FakeGitHubApi {
  #server: Server | null = null;
  #port = 0;
  readonly #oauthByToken = new Map<string, OAuthAccountConfig>();
  readonly #patByToken = new Map<string, PatAccountConfig>();
  readonly #requests: RequestLogEntry[] = [];

  constructor(config: FakeGitHubApiConfig = {}) {
    for (const account of config.oauthAccounts ?? []) {
      this.#oauthByToken.set(account.token, account);
    }
    for (const account of config.patAccounts ?? []) {
      this.#patByToken.set(account.token, account);
    }
  }

  /** Start listening on 127.0.0.1, OS-assigned ephemeral port. Resolves once listening. */
  listen(): Promise<{ baseUrl: string }> {
    return new Promise((resolve, reject) => {
      const server: Server = createServer((req, res) => {
        this.#handle(req, res).catch((err: unknown) => {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        this.#port = typeof address === "object" && address !== null ? address.port : 0;
        this.#server = server;
        resolve({ baseUrl: `http://127.0.0.1:${this.#port}` });
      });
    });
  }

  close(): Promise<void> {
    const server = this.#server;
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** Every request handled so far, oldest first. Copies, not live references. */
  requestLog(): RequestLogEntry[] {
    return this.#requests.map((entry) => ({ ...entry }));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = extractBearerToken(req.headers["authorization"]);
    const oauthAccount = token ? this.#oauthByToken.get(token) : undefined;
    const patAccount = token ? this.#patByToken.get(token) : undefined;
    const tokenKind: TokenKind = oauthAccount ? "oauth" : patAccount ? "pat" : "unknown";
    const login = oauthAccount?.login ?? patAccount?.login ?? null;

    const record = (status: number): void => {
      this.#requests.push({ method, path: url.pathname, tokenKind, token, login, status });
    };

    if (method === "GET" && url.pathname === "/user") {
      if (tokenKind === "unknown") {
        record(401);
        sendJson(res, 401, { message: "Bad credentials" });
        return;
      }
      record(200);
      sendJson(res, 200, { login });
      return;
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/pulls)?$/.exec(url.pathname);
    if (method === "GET" && repoMatch) {
      if (tokenKind === "unknown") {
        record(401);
        sendJson(res, 401, { message: "Bad credentials" });
        return;
      }
      const owner = repoMatch[1] ?? "";
      const repo = repoMatch[2] ?? "";
      const pullsSuffix = repoMatch[3];
      const fullName = `${owner}/${repo}`;
      const repositories = patAccount?.repositories ?? [];

      if (!repositories.includes(fullName)) {
        // GitHub hides the existence of resources a fine-grained token
        // cannot see: 404, not 403. See the module doc comment citation.
        record(404);
        sendJson(res, 404, { message: "Not Found" });
        return;
      }

      if (pullsSuffix) {
        const permissions = patAccount?.permissions ?? [];
        if (!permissions.includes("pull_requests")) {
          record(403);
          sendJson(res, 403, { message: "Resource not accessible by personal access token" });
          return;
        }
        record(200);
        sendJson(res, 200, []);
        return;
      }

      record(200);
      sendJson(res, 200, { full_name: fullName, owner: { login: owner }, name: repo, private: true });
      return;
    }

    record(404);
    sendJson(res, 404, { message: `Not found: ${method} ${url.pathname}` });
  }
}
