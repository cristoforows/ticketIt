/**
 * A fake GitHub REST API server. The identity/resource-scope behavior
 * below (`GET /user`, `GET /repos/{owner}/{repo}`, the 404-vs-403 gating)
 * is unchanged from #27 (M1.16); see
 * docs/evidence/m1/27-github-identity.md, "Documentation research", for
 * the cited GitHub docs it models. It is a model of documented behavior,
 * not a capture of real GitHub responses — see that record's "Observed
 * limitations".
 *
 * #28 (M1.17) adds the delivery-lifecycle surface: draft pull-request
 * creation, listing by head branch, update, a single PR's state
 * (draft/merged/merged_at/merge_commit_sha/head sha), reviews, and issue
 * (PR) comments. See docs/evidence/m1/28-pr-delivery-lifecycle.md,
 * "Documentation research", for the cited fields this models
 * (`docs/rest/pulls/pulls`, `docs/rest/pulls/reviews`,
 * `docs/rest/issues/comments`).
 *
 * Endpoints (identity):
 * - `GET /user` — identity lookup. A configured OAuth-kind token (sign-in
 *   identity) or PAT-kind token (Connected Account identity) resolves to
 *   its configured `login`. Both schemes authenticate via
 *   `Authorization: Bearer <token>` (also accepts `Authorization: token
 *   <token>`, forgivingly).
 * - `GET /repos/{owner}/{repo}` — 200 only for a repository inside the
 *   presenting PAT's configured resource set; 404 otherwise (GitHub uses
 *   404 instead of 403 to avoid confirming the existence of private
 *   repositories not in a fine-grained token's resource set).
 *
 * Endpoints (delivery lifecycle, #28): every one of these applies the
 * SAME two identity/permission gates as #27's `/pulls` endpoint, in the
 * same order — repository-resource-set 404, then missing-`pull_requests`
 * -permission 403 — before doing anything else:
 * - `GET /repos/{owner}/{repo}/pulls` — list. Supports `?head=owner:branch`
 *   (real GitHub's documented filter format) and `?state=open|closed|all`
 *   (default `open`).
 * - `POST /repos/{owner}/{repo}/pulls` — create. Body:
 *   `{ title, head, base, body, draft, headSha }`. `headSha` is a
 *   fixture-only bridging field, not a real GitHub request field — see
 *   "Observed limitations" in the evidence record: this fake API and
 *   `FakeGitRemote` are decoupled fixtures (no git-observation channel
 *   between them), so the caller (this package's `DeliveryModule`, which
 *   just pushed that exact commit) reports the head sha it observed,
 *   modeling what real GitHub derives automatically from the pushed
 *   branch. Rejects a duplicate open PR for the same `head`+`base` with
 *   422, mirroring GitHub's real "A pull request already exists for
 *   ..." validation error.
 * - `GET /repos/{owner}/{repo}/pulls/{number}` — get one: state, draft,
 *   merged, merged_at, merge_commit_sha, closed_at, head.sha, head.ref,
 *   base.ref.
 * - `PATCH /repos/{owner}/{repo}/pulls/{number}` — update
 *   `{ title?, body?, headSha? }` (`headSha` — same bridging rationale as
 *   create, modeling the "synchronize" effect of a new push landing on
 *   the PR's head branch).
 * - `GET /repos/{owner}/{repo}/pulls/{number}/reviews` — list reviews.
 * - `GET /repos/{owner}/{repo}/issues/{number}/comments` — list issue
 *   (PR) comments; real GitHub serves PR comments through the issues API
 *   ("Every pull request is an issue, but not every issue is a pull
 *   request.").
 *
 * Test-control helpers (`injectReview`, `injectComment`, `injectMerge`,
 * `injectClose`) are plain TypeScript methods, not HTTP endpoints. They
 * model a human acting directly on GitHub (approving, requesting
 * changes, commenting, merging, closing) — actions Michelin's PAT never
 * performs itself (open decision D2: agent merge authority is
 * unresolved) — so they bypass identity entirely and are never added to
 * `requestLog()`.
 *
 * This server never accepts a bearer token it was not configured with:
 * an unrecognized token always resolves to `tokenKind: "unknown"` and a
 * 401, regardless of endpoint.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FakeClock } from "shared";

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
  /** Deterministic timestamp source for created/updated/merged timestamps. Defaults to a fresh `FakeClock(0)`. */
  readonly clock?: FakeClock;
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

/**
 * Pull-request review states this fixture models: a subset of GitHub's
 * real enum (which also includes `PENDING` and `DISMISSED`) — see the
 * evidence record's "Observed limitations". Only the two states this
 * package's acceptance criteria require are modeled.
 */
export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";

/** Camel-case view of a pull request, as returned by `GitHubConnection`'s PR methods and the `inject*` test-control helpers. */
export interface PullRequestView {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly closedAt: string | null;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Camel-case view of a pull-request review. */
export interface ReviewView {
  readonly id: number;
  readonly state: ReviewState;
  readonly body: string;
  readonly submittedAt: string;
}

/** Camel-case view of an issue/PR comment. */
export interface IssueCommentView {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

interface PullRequestRecord {
  readonly number: number;
  title: string;
  body: string;
  readonly headRef: string;
  headSha: string;
  readonly baseRef: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  closedAt: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

interface ReviewRecord {
  readonly id: number;
  readonly state: ReviewState;
  readonly body: string;
  readonly submittedAt: string;
}

interface CommentRecord {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
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

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

function toPullRequestJson(record: PullRequestRecord): unknown {
  return {
    number: record.number,
    title: record.title,
    body: record.body,
    draft: record.draft,
    state: record.state,
    merged: record.merged,
    merged_at: record.mergedAt,
    merge_commit_sha: record.mergeCommitSha,
    closed_at: record.closedAt,
    head: { ref: record.headRef, sha: record.headSha },
    base: { ref: record.baseRef },
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function toPullRequestView(record: PullRequestRecord): PullRequestView {
  return {
    number: record.number,
    title: record.title,
    body: record.body,
    draft: record.draft,
    state: record.state,
    merged: record.merged,
    mergedAt: record.mergedAt,
    mergeCommitSha: record.mergeCommitSha,
    closedAt: record.closedAt,
    headRef: record.headRef,
    headSha: record.headSha,
    baseRef: record.baseRef,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toReviewJson(record: ReviewRecord): unknown {
  return { id: record.id, state: record.state, body: record.body, submitted_at: record.submittedAt };
}

function toCommentJson(record: CommentRecord): unknown {
  return { id: record.id, body: record.body, created_at: record.createdAt };
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Fake GitHub REST API. Constructed with fixed account fixtures; start it
 * with `listen()` and stop it with `close()`. Every HTTP request is
 * recorded in `requestLog()`, regardless of outcome; the `inject*`
 * test-control helpers are not HTTP requests and are never recorded
 * there.
 */
export class FakeGitHubApi {
  #server: Server | null = null;
  #port = 0;
  readonly #oauthByToken = new Map<string, OAuthAccountConfig>();
  readonly #patByToken = new Map<string, PatAccountConfig>();
  readonly #requests: RequestLogEntry[] = [];
  readonly #clock: FakeClock;
  readonly #pullsByRepo = new Map<string, PullRequestRecord[]>();
  readonly #reviewsByPr = new Map<string, ReviewRecord[]>();
  readonly #commentsByPr = new Map<string, CommentRecord[]>();
  #nextPrNumber = 1;
  #nextReviewId = 1;
  #nextCommentId = 1;

  constructor(config: FakeGitHubApiConfig = {}) {
    for (const account of config.oauthAccounts ?? []) {
      this.#oauthByToken.set(account.token, account);
    }
    for (const account of config.patAccounts ?? []) {
      this.#patByToken.set(account.token, account);
    }
    this.#clock = config.clock ?? new FakeClock(0);
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

    if (tokenKind === "unknown" && url.pathname.startsWith("/repos/")) {
      record(401);
      sendJson(res, 401, { message: "Bad credentials" });
      return;
    }

    const repoOnlyMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && repoOnlyMatch) {
      const owner = repoOnlyMatch[1] ?? "";
      const repo = repoOnlyMatch[2] ?? "";
      const fullName = repoKey(owner, repo);
      const repositories = patAccount?.repositories ?? [];
      if (!repositories.includes(fullName)) {
        // GitHub hides the existence of resources a fine-grained token
        // cannot see: 404, not 403. See the module doc comment citation.
        record(404);
        sendJson(res, 404, { message: "Not Found" });
        return;
      }
      record(200);
      sendJson(res, 200, { full_name: fullName, owner: { login: owner }, name: repo, private: true });
      return;
    }

    const pullsCollectionMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (pullsCollectionMatch && (method === "GET" || method === "POST")) {
      const owner = pullsCollectionMatch[1] ?? "";
      const repo = pullsCollectionMatch[2] ?? "";
      const fullName = repoKey(owner, repo);
      const repositories = patAccount?.repositories ?? [];
      if (!repositories.includes(fullName)) {
        record(404);
        sendJson(res, 404, { message: "Not Found" });
        return;
      }
      const permissions = patAccount?.permissions ?? [];
      if (!permissions.includes("pull_requests")) {
        record(403);
        sendJson(res, 403, { message: "Resource not accessible by personal access token" });
        return;
      }

      if (method === "GET") {
        const all = this.#pullsByRepo.get(fullName) ?? [];
        const headFilter = url.searchParams.get("head"); // documented format: "owner:branch"
        const stateFilter = url.searchParams.get("state") ?? "open";
        const filtered = all.filter((pr) => {
          if (headFilter) {
            const branch = headFilter.includes(":") ? headFilter.split(":").slice(1).join(":") : headFilter;
            if (pr.headRef !== branch) return false;
          }
          if (stateFilter !== "all" && pr.state !== stateFilter) return false;
          return true;
        });
        record(200);
        sendJson(res, 200, filtered.map(toPullRequestJson));
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        record(400);
        sendJson(res, 400, { message: "Malformed JSON body" });
        return;
      }
      const title = typeof body["title"] === "string" ? (body["title"] as string) : "";
      const head = typeof body["head"] === "string" ? (body["head"] as string) : "";
      const base = typeof body["base"] === "string" ? (body["base"] as string) : "";
      const prBody = typeof body["body"] === "string" ? (body["body"] as string) : "";
      const draft = body["draft"] === true;
      const headSha = typeof body["headSha"] === "string" ? (body["headSha"] as string) : "";
      if (!head || !base || !headSha) {
        record(422);
        sendJson(res, 422, { message: "Validation Failed", errors: [{ message: "head, base, and headSha are required" }] });
        return;
      }
      const existingOpen = (this.#pullsByRepo.get(fullName) ?? []).find(
        (pr) => pr.state === "open" && pr.headRef === head && pr.baseRef === base,
      );
      if (existingOpen) {
        // Mirrors GitHub's real validation error for a duplicate open PR
        // on the same head+base (see the evidence record's documentation
        // research).
        record(422);
        sendJson(res, 422, {
          message: "Validation Failed",
          errors: [{ message: `A pull request already exists for ${owner}:${head}.` }],
        });
        return;
      }
      const now = this.#clock.toISOString();
      const created: PullRequestRecord = {
        number: this.#nextPrNumber++,
        title,
        body: prBody,
        headRef: head,
        headSha,
        baseRef: base,
        draft,
        state: "open",
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const list = this.#pullsByRepo.get(fullName) ?? [];
      list.push(created);
      this.#pullsByRepo.set(fullName, list);
      record(201);
      sendJson(res, 201, toPullRequestJson(created));
      return;
    }

    const pullsItemMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
    if (pullsItemMatch && (method === "GET" || method === "PATCH")) {
      const owner = pullsItemMatch[1] ?? "";
      const repo = pullsItemMatch[2] ?? "";
      const number = Number(pullsItemMatch[3]);
      const fullName = repoKey(owner, repo);
      const repositories = patAccount?.repositories ?? [];
      if (!repositories.includes(fullName)) {
        record(404);
        sendJson(res, 404, { message: "Not Found" });
        return;
      }
      const permissions = patAccount?.permissions ?? [];
      if (!permissions.includes("pull_requests")) {
        record(403);
        sendJson(res, 403, { message: "Resource not accessible by personal access token" });
        return;
      }
      const list = this.#pullsByRepo.get(fullName) ?? [];
      const pr = list.find((entry) => entry.number === number);
      if (!pr) {
        record(404);
        sendJson(res, 404, { message: "Not Found" });
        return;
      }

      if (method === "GET") {
        record(200);
        sendJson(res, 200, toPullRequestJson(pr));
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        record(400);
        sendJson(res, 400, { message: "Malformed JSON body" });
        return;
      }
      if (typeof body["title"] === "string") pr.title = body["title"] as string;
      if (typeof body["body"] === "string") pr.body = body["body"] as string;
      if (typeof body["headSha"] === "string") pr.headSha = body["headSha"] as string;
      pr.updatedAt = this.#clock.toISOString();
      record(200);
      sendJson(res, 200, toPullRequestJson(pr));
      return;
    }

    const reviewsMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/.exec(url.pathname);
    if (method === "GET" && reviewsMatch) {
      const owner = reviewsMatch[1] ?? "";
      const repo = reviewsMatch[2] ?? "";
      const number = Number(reviewsMatch[3]);
      const fullName = repoKey(owner, repo);
      const repositories = patAccount?.repositories ?? [];
      if (!repositories.includes(fullName)) {
        record(404);
        sendJson(res, 404, { message: "Not Found" });
        return;
      }
      const permissions = patAccount?.permissions ?? [];
      if (!permissions.includes("pull_requests")) {
        record(403);
        sendJson(res, 403, { message: "Resource not accessible by personal access token" });
        return;
      }
      const pr = (this.#pullsByRepo.get(fullName) ?? []).find((entry) => entry.number === number);
      if (!pr) {
        record(404);
        sendJson(res, 404, { message: "Not Found" });
        return;
      }
      const reviews = this.#reviewsByPr.get(prKey(owner, repo, number)) ?? [];
      record(200);
      sendJson(res, 200, reviews.map(toReviewJson));
      return;
    }

    const commentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (method === "GET" && commentsMatch) {
      const owner = commentsMatch[1] ?? "";
      const repo = commentsMatch[2] ?? "";
      const number = Number(commentsMatch[3]);
      const fullName = repoKey(owner, repo);
      const repositories = patAccount?.repositories ?? [];
      if (!repositories.includes(fullName)) {
        record(404);
        sendJson(res, 404, { message: "Not Found" });
        return;
      }
      const permissions = patAccount?.permissions ?? [];
      if (!permissions.includes("pull_requests")) {
        record(403);
        sendJson(res, 403, { message: "Resource not accessible by personal access token" });
        return;
      }
      const pr = (this.#pullsByRepo.get(fullName) ?? []).find((entry) => entry.number === number);
      if (!pr) {
        record(404);
        sendJson(res, 404, { message: "Not Found" });
        return;
      }
      const comments = this.#commentsByPr.get(prKey(owner, repo, number)) ?? [];
      record(200);
      sendJson(res, 200, comments.map(toCommentJson));
      return;
    }

    record(404);
    sendJson(res, 404, { message: `Not found: ${method} ${url.pathname}` });
  }

  #requirePr(owner: string, repo: string, number: number): PullRequestRecord {
    const pr = (this.#pullsByRepo.get(repoKey(owner, repo)) ?? []).find((entry) => entry.number === number);
    if (!pr) throw new RangeError(`Unknown pull request #${number} in ${owner}/${repo}`);
    return pr;
  }

  /**
   * Test control: simulate a reviewer submitting a review. Not a real
   * GitHub endpoint call from Michelin's PAT — models a human acting
   * directly on GitHub. Never appears in `requestLog()`.
   */
  injectReview(owner: string, repo: string, number: number, input: { readonly state: ReviewState; readonly body?: string }): ReviewView {
    this.#requirePr(owner, repo, number);
    const record: ReviewRecord = {
      id: this.#nextReviewId++,
      state: input.state,
      body: input.body ?? "",
      submittedAt: this.#clock.toISOString(),
    };
    const key = prKey(owner, repo, number);
    const list = this.#reviewsByPr.get(key) ?? [];
    list.push(record);
    this.#reviewsByPr.set(key, list);
    return { ...record };
  }

  /** Test control: simulate a GitHub comment on the PR (issue-comments API). Never appears in `requestLog()`. */
  injectComment(owner: string, repo: string, number: number, body: string): IssueCommentView {
    this.#requirePr(owner, repo, number);
    const record: CommentRecord = { id: this.#nextCommentId++, body, createdAt: this.#clock.toISOString() };
    const key = prKey(owner, repo, number);
    const list = this.#commentsByPr.get(key) ?? [];
    list.push(record);
    this.#commentsByPr.set(key, list);
    return { ...record };
  }

  /**
   * Test control: simulate the PR being merged (by a human, through
   * GitHub directly — Michelin's PAT never merges; see open decision D2).
   * Never appears in `requestLog()`.
   */
  injectMerge(owner: string, repo: string, number: number, input: { readonly mergeCommitSha?: string } = {}): PullRequestView {
    const pr = this.#requirePr(owner, repo, number);
    const now = this.#clock.toISOString();
    pr.merged = true;
    pr.mergedAt = now;
    pr.mergeCommitSha = input.mergeCommitSha ?? `merged-${pr.headSha}`;
    pr.state = "closed";
    pr.closedAt = now;
    pr.updatedAt = now;
    return toPullRequestView(pr);
  }

  /** Test control: simulate the PR being closed WITHOUT merging. Never appears in `requestLog()`. */
  injectClose(owner: string, repo: string, number: number): PullRequestView {
    const pr = this.#requirePr(owner, repo, number);
    const now = this.#clock.toISOString();
    pr.state = "closed";
    pr.merged = false;
    pr.closedAt = now;
    pr.updatedAt = now;
    return toPullRequestView(pr);
  }
}
