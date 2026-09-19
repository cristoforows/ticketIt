/**
 * The delivery-lifecycle module for issue #28 ("M1.17 — Draft PR delivery
 * lifecycle with mocked reviews and merge"), built on top of #27's
 * `GitHubConnection`. Models the "Coding" deliverable shape from
 * docs/v1-scope.md, "Deliverables and review": "a separate ticket
 * worktree/branch, draft GitHub PR, summary, tests/results, and
 * success-criteria assessment. Rework reuses branch/worktree/PR until
 * merge." and docs/agent-execution.md, "Coding deliverables": "Coding
 * rounds deliver draft GitHub pull requests... The ticket's corresponding
 * round section links to the draft PR and includes a change summary,
 * tests performed and their results, and an assessment against success
 * criteria."
 *
 * `deliver()` performs, in order, every step of one Round's delivery:
 *
 * 1. Ensure the ticket's branch is checked out in its worktree (creating
 *    it from the current HEAD on the first call; reusing it on rework,
 *    per "Rework reuses branch/worktree/PR until merge").
 * 2. Commit (`GitHubConnection.commit`, ledger-gated `git.commit`) and
 *    push (`GitHubConnection.push`, ledger-gated `git.push`) to the
 *    configured remote over the fake SSH transport.
 * 3. Find-or-create the draft PR for that head branch: list first
 *    (ledger-gated `PULLS_READ`), and only create (ledger-gated
 *    `PULLS_WRITE`) when none exists; otherwise update title/body (and
 *    the fixture-only `headSha` bridge field) on the existing PR — see
 *    `github-connection.ts`'s `updatePullRequest` doc comment.
 *
 * Every one of those steps is individually ledger-gated inside
 * `GitHubConnection`'s own methods (`#admitOrThrow`, called first thing
 * in each method, before any git/`fetch` call). So if the ledger is
 * disconnected (or any grant needed along the way is missing, revoked,
 * or expired), the very FIRST gated action — `commit` — throws before it
 * runs, and nothing after it (`push`, list, create/update) ever executes:
 * no API call, no push, matching acceptance criterion 10 ("refuses before
 * any API call or push").
 *
 * Branch checkout itself is a local git operation with no network/API
 * effect, so it is not separately ledger-gated here (consistent with
 * `GitHubConnection`'s existing design, which only gates actions that
 * reach the fake API or the fake Git remote).
 */
import { execFileSync } from "node:child_process";
import type { GitHubConnection, PullRequestView } from "./github-connection.js";

export interface DeliveryModuleConfig {
  readonly connection: GitHubConnection;
  readonly owner: string;
  readonly repo: string;
  /** The PR's base branch (e.g. "main"). */
  readonly base: string;
  /** The ticket's dedicated branch, reused across every Round until merge. */
  readonly branch: string;
  /** Local worktree path `GitHubConnection.commit`/`.push` operate in. */
  readonly worktree: string;
  /** Remote URL to push to (e.g. `FakeGitRemote.remoteUrl`). */
  readonly remote: string;
}

export interface DeliverInput {
  readonly title: string;
  readonly commitMessage: string;
  readonly summary: string;
  readonly testsAndResults: string;
  readonly successCriteriaAssessment: string;
}

export interface DeliverResult {
  readonly commitSha: string;
  readonly prNumber: number;
  /** Whether this call created a new PR (`true`) or found-and-updated an existing one (`false`). */
  readonly created: boolean;
  readonly pullRequest: PullRequestView;
}

function branchExistsLocally(worktree: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", worktree, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function ensureBranch(worktree: string, branch: string): void {
  const args = branchExistsLocally(worktree, branch) ? ["checkout", branch] : ["checkout", "-b", branch];
  execFileSync("git", ["-C", worktree, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

/** Render the PR body carrying the change summary, tests/results, and Success Criteria assessment (v1-scope.md, "Deliverables and review"). */
export function renderPullRequestBody(
  input: Pick<DeliverInput, "summary" | "testsAndResults" | "successCriteriaAssessment">,
): string {
  return [
    "## Summary",
    "",
    input.summary,
    "",
    "## Tests and results",
    "",
    input.testsAndResults,
    "",
    "## Success Criteria assessment",
    "",
    input.successCriteriaAssessment,
    "",
  ].join("\n");
}

export class DeliveryModule {
  readonly #connection: GitHubConnection;
  readonly #owner: string;
  readonly #repo: string;
  readonly #base: string;
  readonly #branch: string;
  readonly #worktree: string;
  readonly #remote: string;

  constructor(config: DeliveryModuleConfig) {
    this.#connection = config.connection;
    this.#owner = config.owner;
    this.#repo = config.repo;
    this.#base = config.base;
    this.#branch = config.branch;
    this.#worktree = config.worktree;
    this.#remote = config.remote;
  }

  /** Deliver one Round: ensure branch, commit, push, then find-or-create/update the draft PR. */
  async deliver(input: DeliverInput): Promise<DeliverResult> {
    ensureBranch(this.#worktree, this.#branch);
    const commitSha = this.#connection.commit(this.#worktree, input.commitMessage);
    this.#connection.push(this.#worktree, this.#remote, this.#branch);

    const body = renderPullRequestBody(input);
    const existing = await this.#connection.listPullRequestsByHead(this.#owner, this.#repo, this.#branch, "open");
    const [current] = existing;
    if (current) {
      const updated = await this.#connection.updatePullRequest(this.#owner, this.#repo, current.number, {
        title: input.title,
        body,
        headSha: commitSha,
      });
      return { commitSha, prNumber: current.number, created: false, pullRequest: updated };
    }

    const created = await this.#connection.createPullRequest(this.#owner, this.#repo, {
      title: input.title,
      head: this.#branch,
      base: this.#base,
      body,
      draft: true,
      headSha: commitSha,
    });
    return { commitSha, prNumber: created.number, created: true, pullRequest: created };
  }
}
