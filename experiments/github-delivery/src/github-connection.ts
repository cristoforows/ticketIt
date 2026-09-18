/**
 * The Michelin-side GitHub connection (docs/agent-execution.md, "Initial
 * GitHub connection": "Use a fine-grained personal access token
 * configured locally on the runner for v1. The runner calls GitHub's API
 * directly rather than requiring `gh`, verifies the authenticated
 * account identity... Git commit authorship and the account identity
 * used for API actions remain separate configuration concerns.").
 *
 * Every API and Git action here first calls `AdmissionLedger.admit()`
 * (experiments/shared) with the action/resource scope, and refuses to
 * proceed when the decision is not `"allow"` (`"hold"` or `"deny"`) —
 * see `#admitOrThrow`. This is the "Ledger consulted before API and Git
 * actions" acceptance criterion for issue #27.
 *
 * `verifyIdentity()`/`checkRepositoryAccess()`/`checkPullRequestAccess()`
 * only ever send the single configured PAT (`#pat`) to the fake GitHub
 * API — there is no code path in this module that reads or sends any
 * other credential, so a broader token configured only in the fake API
 * and never given to this module's constructor can never be sent (see
 * the evidence record's fixture evidence for the test proving this from
 * the fake API's own request log).
 */
import { execFileSync } from "node:child_process";
import type { AdmissionLedger, AdmitDecision, AdmitReason } from "shared";

/** Action names used in every `ledger.admit()` call this module makes. Exported for reuse/tests. */
export const GitHubConnectionActions = {
  VERIFY_IDENTITY: "github.identity.verify",
  REPO_READ: "github.repo.read",
  PULLS_READ: "github.pulls.read",
  GIT_COMMIT: "git.commit",
  GIT_PUSH: "git.push",
} as const;

/** Build the ledger `resource` scope for a repository (`"owner/repo"`). */
export function repoResource(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

/** Build the ledger `resource` scope for a repository's pull requests. */
export function pullsResource(owner: string, repo: string): string {
  return `${owner}/${repo}/pulls`;
}

/** Build the ledger `resource` scope for a git push target (`"remoteUrl#branch"`). */
export function pushResource(remote: string, branch: string): string {
  return `${remote}#${branch}`;
}

export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

/** Static ledger-request fields fixed for this connection's Round. */
export interface LedgerContext {
  readonly roundId: string;
  readonly ticketId: string;
  readonly agentId: string;
  readonly account: string;
}

export interface GitHubConnectionConfig {
  /** The expected Connected Account login; `verifyIdentity()` rejects any other. */
  readonly expectedLogin: string;
  /** The single fine-grained PAT this module is permitted to send. Never any other credential. */
  readonly pat: string;
  /** Base URL of the (fake) GitHub REST API, e.g. `http://127.0.0.1:PORT`. */
  readonly apiBaseUrl: string;
  /** Git commit author — a configuration concern distinct from the API identity. */
  readonly gitAuthor: GitAuthor;
  /** `GIT_SSH_COMMAND` value used for `push()` (see `FakeGitRemote.sshCommandFor`). */
  readonly sshCommand: string;
  readonly ledger: AdmissionLedger;
  readonly ledgerContext: LedgerContext;
}

/** Thrown when `ledger.admit()` does not return `"allow"`; the gated action never runs. */
export class AdmissionRefusedError extends Error {
  constructor(
    readonly decision: AdmitDecision,
    readonly reason: AdmitReason,
    readonly action: string,
    readonly resource: string,
  ) {
    super(`GitHub connection admission ${decision} (${reason}) for action "${action}" on resource "${resource}"`);
    this.name = "AdmissionRefusedError";
  }
}

/** Thrown when the token identity does not equal the configured Connected Account. */
export class IdentityMismatchError extends Error {
  constructor(
    readonly expectedLogin: string,
    readonly actualLogin: string,
  ) {
    super(`Token identity "${actualLogin}" does not match the configured Connected Account "${expectedLogin}"`);
    this.name = "IdentityMismatchError";
  }
}

/**
 * Thrown when the fake API returns 404 (repository outside the token's
 * resource set — GitHub hides existence, see fake-github-api.ts) or 403
 * (present but the token lacks a needed permission). Never triggers any
 * credential substitution.
 */
export class RepositoryAccessError extends Error {
  constructor(
    readonly status: 404 | 403,
    readonly owner: string,
    readonly repo: string,
    detail: string,
  ) {
    super(`Repository access to "${owner}/${repo}" failed with ${status}: ${detail}`);
    this.name = "RepositoryAccessError";
  }
}

/** Thrown when the pulls endpoint returns 403 (token lacks the pull-request permission). */
export class PullRequestPermissionError extends Error {
  constructor(
    readonly owner: string,
    readonly repo: string,
  ) {
    super(`Token lacks pull-request permission for "${owner}/${repo}" (403, no credential substitution)`);
    this.name = "PullRequestPermissionError";
  }
}

function authHeader(pat: string): Record<string, string> {
  return { Authorization: `Bearer ${pat}` };
}

export class GitHubConnection {
  readonly #expectedLogin: string;
  readonly #pat: string;
  readonly #apiBaseUrl: string;
  readonly #gitAuthor: GitAuthor;
  readonly #sshCommand: string;
  readonly #ledger: AdmissionLedger;
  readonly #ctx: LedgerContext;

  constructor(config: GitHubConnectionConfig) {
    this.#expectedLogin = config.expectedLogin;
    this.#pat = config.pat;
    this.#apiBaseUrl = config.apiBaseUrl;
    this.#gitAuthor = config.gitAuthor;
    this.#sshCommand = config.sshCommand;
    this.#ledger = config.ledger;
    this.#ctx = config.ledgerContext;
  }

  #admitOrThrow(action: string, resource: string): void {
    const result = this.#ledger.admit({
      roundId: this.#ctx.roundId,
      ticketId: this.#ctx.ticketId,
      agentId: this.#ctx.agentId,
      account: this.#ctx.account,
      action,
      resource,
    });
    if (result.decision !== "allow") {
      throw new AdmissionRefusedError(result.decision, result.reason, action, resource);
    }
  }

  /**
   * Verify that the configured PAT's identity equals the expected
   * Connected Account. Gated by the ledger; on success, returns the
   * verified login. Throws `IdentityMismatchError` on mismatch.
   */
  async verifyIdentity(): Promise<{ login: string }> {
    this.#admitOrThrow(GitHubConnectionActions.VERIFY_IDENTITY, `github-account:${this.#expectedLogin}`);
    const res = await fetch(new URL("/user", this.#apiBaseUrl), { headers: authHeader(this.#pat) });
    if (res.status !== 200) {
      throw new Error(`GitHub identity check failed with unexpected status ${res.status}`);
    }
    const body = (await res.json()) as { login: string };
    if (body.login !== this.#expectedLogin) {
      throw new IdentityMismatchError(this.#expectedLogin, body.login);
    }
    return { login: body.login };
  }

  /**
   * Check repository access. Fails explicitly on 404 (outside the
   * token's resource set) or 403; never retries with any other
   * credential.
   */
  async checkRepositoryAccess(owner: string, repo: string): Promise<{ fullName: string }> {
    this.#admitOrThrow(GitHubConnectionActions.REPO_READ, repoResource(owner, repo));
    const res = await fetch(new URL(`/repos/${owner}/${repo}`, this.#apiBaseUrl), {
      headers: authHeader(this.#pat),
    });
    if (res.status === 404) {
      throw new RepositoryAccessError(404, owner, repo, "not found or outside the token's resource set");
    }
    if (res.status === 403) {
      throw new RepositoryAccessError(403, owner, repo, "forbidden");
    }
    if (res.status !== 200) {
      throw new Error(`Unexpected status ${res.status} checking repository access to "${owner}/${repo}"`);
    }
    const body = (await res.json()) as { full_name: string };
    return { fullName: body.full_name };
  }

  /**
   * Check pull-request permission. 404 surfaces as `RepositoryAccessError`
   * (repo outside resource set); 403 surfaces as
   * `PullRequestPermissionError` (repo visible, permission missing).
   * Never substitutes a broader credential.
   */
  async checkPullRequestAccess(owner: string, repo: string): Promise<unknown[]> {
    this.#admitOrThrow(GitHubConnectionActions.PULLS_READ, pullsResource(owner, repo));
    const res = await fetch(new URL(`/repos/${owner}/${repo}/pulls`, this.#apiBaseUrl), {
      headers: authHeader(this.#pat),
    });
    if (res.status === 404) {
      throw new RepositoryAccessError(404, owner, repo, "not found or outside the token's resource set");
    }
    if (res.status === 403) {
      throw new PullRequestPermissionError(owner, repo);
    }
    if (res.status !== 200) {
      throw new Error(`Unexpected status ${res.status} checking pull-request access to "${owner}/${repo}"`);
    }
    return (await res.json()) as unknown[];
  }

  /**
   * Commit staged changes in `worktree` with the configured author
   * (`gitAuthor`, distinct from the API identity's login). Returns the
   * new commit's SHA.
   */
  commit(worktree: string, message: string): string {
    this.#admitOrThrow(GitHubConnectionActions.GIT_COMMIT, worktree);
    execFileSync("git", ["-C", worktree, "commit", "--allow-empty", "-m", message], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: this.#gitAuthor.name,
        GIT_AUTHOR_EMAIL: this.#gitAuthor.email,
        GIT_COMMITTER_NAME: this.#gitAuthor.name,
        GIT_COMMITTER_EMAIL: this.#gitAuthor.email,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  }

  /** Push `branch` from `worktree` to `remote`, using the configured fake SSH identity. */
  push(worktree: string, remote: string, branch: string): void {
    this.#admitOrThrow(GitHubConnectionActions.GIT_PUSH, pushResource(remote, branch));
    execFileSync("git", ["-C", worktree, "push", remote, branch], {
      env: { ...process.env, GIT_SSH_COMMAND: this.#sshCommand },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}
