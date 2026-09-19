/**
 * Delivery-lifecycle fixtures for issue #28 ("M1.17 — Draft PR delivery
 * lifecycle with mocked reviews and merge"). Each test below is a
 * self-contained scenario from that issue's acceptance criteria; see the
 * numbered list in this repository's evidence record
 * (docs/evidence/m1/28-pr-delivery-lifecycle.md) for the exact mapping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "shared";
import { FakeGitHubApi } from "../src/fake-github-api.js";
import { FakeGitRemote } from "../src/fake-git-remote.js";
import {
  AdmissionRefusedError,
  GitHubConnection,
  GitHubConnectionActions,
  pullsResource,
  pushResource,
} from "../src/github-connection.js";
import { DeliveryModule, type DeliverInput } from "../src/delivery-module.js";
import { GalleySubstitute } from "../src/galley-substitute.js";

const OWNER = "acme";
const REPO = "allowed-repo";
const PAT_TOKEN = "pat-fixture-michelin-token";
const AGENT_ID = "agent-coder-1";
const ACCOUNT = "github:michelin-bot";
const GIT_AUTHOR = { name: "ticketIt Runner", email: "runner@ticketit.invalid" };
const SSH_IDENTITY = "/fixtures/ssh/michelin-deploy-key";

function makeWorktreeWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), "delivery-lifecycle-work-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "config", "user.name", "Seed Author"], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "config", "user.email", "seed@example.invalid"], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "seed commit"], { stdio: ["ignore", "pipe", "pipe"] });
  return dir;
}

interface Harness {
  readonly api: FakeGitHubApi;
  readonly remote: FakeGitRemote;
  readonly worktree: string;
  readonly clock: FakeClock;
  readonly galley: GalleySubstitute;
  readonly ticketId: string;
  readonly branch: string;
  grantAllTicketActions(): void;
  makeConnection(roundId: string): GitHubConnection;
  makeDelivery(connection: GitHubConnection): DeliveryModule;
  cleanup(): Promise<void>;
}

async function setup(ticketId: string, branch: string): Promise<Harness> {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const api = new FakeGitHubApi({
    patAccounts: [
      { token: PAT_TOKEN, login: "michelin-bot", repositories: [`${OWNER}/${REPO}`], permissions: ["contents", "pull_requests"] },
    ],
    clock,
  });
  const { baseUrl } = await api.listen();
  const remote = new FakeGitRemote();
  const worktree = makeWorktreeWithCommit();
  const galley = new GalleySubstitute("cristoforows", clock);
  galley.createTicket(ticketId);

  function grantAllTicketActions(): void {
    for (const [action, resource] of [
      [GitHubConnectionActions.GIT_COMMIT, worktree],
      [GitHubConnectionActions.GIT_PUSH, pushResource(remote.remoteUrl, branch)],
      [GitHubConnectionActions.PULLS_READ, pullsResource(OWNER, REPO)],
      [GitHubConnectionActions.PULLS_WRITE, pullsResource(OWNER, REPO)],
    ] as const) {
      galley.ledger.grant({ agentId: AGENT_ID, account: ACCOUNT, action, resource, kind: { kind: "ticket", ticketId } });
    }
  }

  function makeConnection(roundId: string): GitHubConnection {
    return new GitHubConnection({
      expectedLogin: "michelin-bot",
      pat: PAT_TOKEN,
      apiBaseUrl: baseUrl,
      gitAuthor: GIT_AUTHOR,
      sshCommand: remote.sshCommandFor(SSH_IDENTITY),
      ledger: galley.ledger,
      ledgerContext: { roundId, ticketId, agentId: AGENT_ID, account: ACCOUNT },
    });
  }

  function makeDelivery(connection: GitHubConnection): DeliveryModule {
    return new DeliveryModule({ connection, owner: OWNER, repo: REPO, base: "main", branch, worktree, remote: remote.remoteUrl });
  }

  return {
    api,
    remote,
    worktree,
    clock,
    galley,
    ticketId,
    branch,
    grantAllTicketActions,
    makeConnection,
    makeDelivery,
    cleanup: () => api.close(),
  };
}

const ROUND_1_INPUT: DeliverInput = {
  title: "Fix the flaky retry logic",
  commitMessage: "Round 1: fix the flaky retry logic",
  summary: "Fixed the off-by-one in the retry backoff calculation.",
  testsAndResults: "npm test -> 12/12 passing.",
  successCriteriaAssessment: "Meets Success Criteria: retries now stop after the configured max attempts.",
};

test("1. Round 1 delivery creates exactly one draft PR whose body carries summary, tests and results, and the Success Criteria assessment; Galley records the delivered commit; Ticket In Review", async () => {
  const h = await setup("ticket-101", "ticket-101-branch");
  try {
    h.grantAllTicketActions();
    h.galley.startRound(h.ticketId);
    const connection = h.makeConnection("round-1");
    const delivery = h.makeDelivery(connection);

    const result = await delivery.deliver(ROUND_1_INPUT);
    h.galley.recordDelivery(h.ticketId, {
      commitSha: result.commitSha,
      summary: ROUND_1_INPUT.summary,
      testsAndResults: ROUND_1_INPUT.testsAndResults,
      successCriteriaAssessment: ROUND_1_INPUT.successCriteriaAssessment,
      prNumber: result.prNumber,
    });

    assert.equal(result.created, true);
    assert.equal(result.pullRequest.draft, true, "the created PR must be a draft");
    assert.match(result.pullRequest.body, /Fixed the off-by-one in the retry backoff calculation\./);
    assert.match(result.pullRequest.body, /npm test -> 12\/12 passing\./);
    assert.match(result.pullRequest.body, /Meets Success Criteria: retries now stop/);

    const allPrs = await connection.listPullRequestsByHead(OWNER, REPO, h.branch, "all");
    assert.equal(allPrs.length, 1, "exactly one draft PR must exist for this branch");

    const ticket = h.galley.getTicket(h.ticketId);
    assert.equal(ticket.status, "In Review");
    assert.equal(ticket.rounds.length, 1);
    assert.equal(ticket.rounds[0]?.deliveredCommitSha, result.commitSha);
    assert.equal(ticket.rounds[0]?.prNumber, result.prNumber);
  } finally {
    await h.cleanup();
  }
});

test("2. Replaying the same delivery finds the existing PR; PR count stays 1; the Round record is unchanged", async () => {
  const h = await setup("ticket-102", "ticket-102-branch");
  try {
    h.grantAllTicketActions();
    h.galley.startRound(h.ticketId);
    const connection = h.makeConnection("round-1");
    const delivery = h.makeDelivery(connection);

    const first = await delivery.deliver(ROUND_1_INPUT);
    h.galley.recordDelivery(h.ticketId, {
      commitSha: first.commitSha,
      summary: ROUND_1_INPUT.summary,
      testsAndResults: ROUND_1_INPUT.testsAndResults,
      successCriteriaAssessment: ROUND_1_INPUT.successCriteriaAssessment,
      prNumber: first.prNumber,
    });

    // Replay: the same delivery request repeated (e.g. a retried Michelin
    // call), without Galley being told of a new Round/Delivered event.
    const replay = await delivery.deliver(ROUND_1_INPUT);

    assert.equal(replay.created, false, "replay must find, not create");
    assert.equal(replay.prNumber, first.prNumber);

    const allPrs = await connection.listPullRequestsByHead(OWNER, REPO, h.branch, "all");
    assert.equal(allPrs.length, 1, "PR count stays 1 across the replay");

    const ticket = h.galley.getTicket(h.ticketId);
    assert.equal(ticket.rounds.length, 1, "the Round record is unchanged");
    assert.equal(ticket.rounds[0]?.deliveredCommitSha, first.commitSha);
  } finally {
    await h.cleanup();
  }
});

test("3. A CHANGES_REQUESTED review and a comment are recorded as informational; status stays In Review; Round count unchanged", async () => {
  const h = await setup("ticket-103", "ticket-103-branch");
  try {
    h.grantAllTicketActions();
    h.galley.startRound(h.ticketId);
    const connection = h.makeConnection("round-1");
    const delivery = h.makeDelivery(connection);
    const delivered = await delivery.deliver(ROUND_1_INPUT);
    h.galley.recordDelivery(h.ticketId, {
      commitSha: delivered.commitSha,
      summary: ROUND_1_INPUT.summary,
      testsAndResults: ROUND_1_INPUT.testsAndResults,
      successCriteriaAssessment: ROUND_1_INPUT.successCriteriaAssessment,
      prNumber: delivered.prNumber,
    });

    // A human reviewer acts directly on GitHub (test-control helpers,
    // never through Michelin's PAT).
    h.api.injectReview(OWNER, REPO, delivered.prNumber, { state: "CHANGES_REQUESTED", body: "Please add a regression test." });
    h.api.injectComment(OWNER, REPO, delivered.prNumber, "Also update the changelog.");

    // Michelin's GitHub connection observes and surfaces it as informational feedback.
    const reviews = await connection.listReviews(OWNER, REPO, delivered.prNumber);
    const comments = await connection.listIssueComments(OWNER, REPO, delivered.prNumber);
    for (const review of reviews) {
      h.galley.recordFeedback(h.ticketId, { kind: "review", detail: `${review.state}: ${review.body}` });
    }
    for (const comment of comments) {
      h.galley.recordFeedback(h.ticketId, { kind: "comment", detail: comment.body });
    }

    const ticket = h.galley.getTicket(h.ticketId);
    assert.equal(ticket.status, "In Review", "feedback must never change status");
    assert.equal(ticket.rounds.length, 1, "feedback must never start a Round");
    assert.equal(ticket.feedbackEvents.length, 2);
    assert.equal(ticket.feedbackEvents[0]?.kind, "review");
    assert.match(ticket.feedbackEvents[0]?.detail ?? "", /CHANGES_REQUESTED/);
    assert.equal(ticket.feedbackEvents[1]?.kind, "comment");
    assert.match(ticket.feedbackEvents[1]?.detail ?? "", /changelog/);
  } finally {
    await h.cleanup();
  }
});

test("4. Explicit requeue moves In Review to Ready; Round 2 commits on the SAME branch and updates the SAME PR (number unchanged); both Rounds' delivered commits are retained and distinct; the PR head sha equals Round 2's commit", async () => {
  const h = await setup("ticket-104", "ticket-104-branch");
  try {
    h.grantAllTicketActions();
    h.galley.startRound(h.ticketId);
    const connection1 = h.makeConnection("round-1");
    const delivery1 = h.makeDelivery(connection1);
    const round1 = await delivery1.deliver(ROUND_1_INPUT);
    h.galley.recordDelivery(h.ticketId, {
      commitSha: round1.commitSha,
      summary: ROUND_1_INPUT.summary,
      testsAndResults: ROUND_1_INPUT.testsAndResults,
      successCriteriaAssessment: ROUND_1_INPUT.successCriteriaAssessment,
      prNumber: round1.prNumber,
    });

    h.galley.explicitRequeue(h.ticketId);
    assert.equal(h.galley.getTicket(h.ticketId).status, "Ready");

    h.galley.startRound(h.ticketId);
    const connection2 = h.makeConnection("round-2");
    const delivery2 = h.makeDelivery(connection2);
    const round2Input: DeliverInput = {
      title: "Fix the flaky retry logic (round 2)",
      commitMessage: "Round 2: address review feedback",
      summary: "Added the requested regression test and updated the changelog.",
      testsAndResults: "npm test -> 13/13 passing.",
      successCriteriaAssessment: "Still meets Success Criteria; regression covered.",
    };
    const round2 = await delivery2.deliver(round2Input);
    h.galley.recordDelivery(h.ticketId, {
      commitSha: round2.commitSha,
      summary: round2Input.summary,
      testsAndResults: round2Input.testsAndResults,
      successCriteriaAssessment: round2Input.successCriteriaAssessment,
      prNumber: round2.prNumber,
    });

    assert.equal(round2.created, false, "rework must update the existing PR, not create a new one");
    assert.equal(round2.prNumber, round1.prNumber, "PR number unchanged");
    assert.notEqual(round2.commitSha, round1.commitSha, "each Round's delivered commit is distinct");

    const ticket = h.galley.getTicket(h.ticketId);
    assert.equal(ticket.status, "In Review");
    assert.equal(ticket.rounds.length, 2);
    assert.equal(ticket.rounds[0]?.deliveredCommitSha, round1.commitSha, "Round 1's delivery is retained");
    assert.equal(ticket.rounds[1]?.deliveredCommitSha, round2.commitSha, "Round 2's delivery is retained");

    const prNow = await connection2.getPullRequest(OWNER, REPO, round2.prNumber);
    assert.equal(prNow.headSha, round2.commitSha, "the PR head sha equals Round 2's commit");

    const allPrs = await connection2.listPullRequestsByHead(OWNER, REPO, h.branch, "all");
    assert.equal(allPrs.length, 1, "still exactly one PR across both Rounds");
  } finally {
    await h.cleanup();
  }
});

test("5. Approval alone leaves the Ticket In Review and the ticket-based grant still allowed", async () => {
  const h = await setup("ticket-105", "ticket-105-branch");
  try {
    h.grantAllTicketActions();
    h.galley.startRound(h.ticketId);
    const connection = h.makeConnection("round-1");
    const delivery = h.makeDelivery(connection);
    const delivered = await delivery.deliver(ROUND_1_INPUT);
    h.galley.recordDelivery(h.ticketId, {
      commitSha: delivered.commitSha,
      summary: ROUND_1_INPUT.summary,
      testsAndResults: ROUND_1_INPUT.testsAndResults,
      successCriteriaAssessment: ROUND_1_INPUT.successCriteriaAssessment,
      prNumber: delivered.prNumber,
    });

    h.api.injectReview(OWNER, REPO, delivered.prNumber, { state: "APPROVED", body: "LGTM" });
    const reviews = await connection.listReviews(OWNER, REPO, delivered.prNumber);
    for (const review of reviews) {
      h.galley.recordFeedback(h.ticketId, { kind: "review", detail: `${review.state}: ${review.body}` });
    }

    const ticket = h.galley.getTicket(h.ticketId);
    assert.equal(ticket.status, "In Review", "approval alone must not complete the Ticket");

    const admission = h.galley.ledger.admit({
      roundId: "round-1",
      ticketId: h.ticketId,
      agentId: AGENT_ID,
      account: ACCOUNT,
      action: GitHubConnectionActions.PULLS_READ,
      resource: pullsResource(OWNER, REPO),
    });
    assert.equal(admission.decision, "allow", "the ticket-based grant must still be valid");
  } finally {
    await h.cleanup();
  }
});

test("6. Merge moves the Ticket to Done, the ticket-based grant then denies with ticket-done, and a time-based grant for the same Agent still allows", async () => {
  const h = await setup("ticket-106", "ticket-106-branch");
  try {
    h.grantAllTicketActions();
    h.galley.startRound(h.ticketId);
    const connection = h.makeConnection("round-1");
    const delivery = h.makeDelivery(connection);
    const delivered = await delivery.deliver(ROUND_1_INPUT);
    h.galley.recordDelivery(h.ticketId, {
      commitSha: delivered.commitSha,
      summary: ROUND_1_INPUT.summary,
      testsAndResults: ROUND_1_INPUT.testsAndResults,
      successCriteriaAssessment: ROUND_1_INPUT.successCriteriaAssessment,
      prNumber: delivered.prNumber,
    });

    // A time-based grant for a DIFFERENT action, scoped to the same Agent
    // but not this Ticket, to isolate it from the ticket-based grants
    // above (v1-scope.md: "Never combine ticket and time restrictions
    // into a single grant").
    h.galley.ledger.grant({
      agentId: AGENT_ID,
      account: ACCOUNT,
      action: GitHubConnectionActions.VERIFY_IDENTITY,
      resource: "github-account:michelin-bot",
      kind: { kind: "time", expiresAt: h.clock.nowMs() + 3_600_000 },
    });

    h.api.injectMerge(OWNER, REPO, delivered.prNumber, { mergeCommitSha: "merge-commit-abc123" });
    const observed = await connection.getPullRequest(OWNER, REPO, delivered.prNumber);
    assert.equal(observed.mergeCommitSha, "merge-commit-abc123");
    h.galley.observeMerge(h.ticketId, {
      merged: observed.merged,
      state: observed.state,
      mergedAt: observed.mergedAt,
      mergeCommitSha: observed.mergeCommitSha,
      prNumber: observed.number,
    });

    const ticket = h.galley.getTicket(h.ticketId);
    assert.equal(ticket.status, "Done");

    const ticketBasedAdmission = h.galley.ledger.admit({
      roundId: "round-1",
      ticketId: h.ticketId,
      agentId: AGENT_ID,
      account: ACCOUNT,
      action: GitHubConnectionActions.PULLS_WRITE,
      resource: pullsResource(OWNER, REPO),
    });
    assert.equal(ticketBasedAdmission.decision, "deny");
    assert.equal(ticketBasedAdmission.reason, "ticket-done");

    const timeBasedAdmission = h.galley.ledger.admit({
      roundId: "round-1",
      ticketId: h.ticketId,
      agentId: AGENT_ID,
      account: ACCOUNT,
      action: GitHubConnectionActions.VERIFY_IDENTITY,
      resource: "github-account:michelin-bot",
    });
    assert.equal(timeBasedAdmission.decision, "allow", "a time-based grant survives ticketDone for the same Agent");
  } finally {
    await h.cleanup();
  }
});

test("7. Reopen after Done does not restore the ticket grant", async () => {
  const h = await setup("ticket-107", "ticket-107-branch");
  try {
    h.grantAllTicketActions();
    h.galley.startRound(h.ticketId);
    const connection = h.makeConnection("round-1");
    const delivery = h.makeDelivery(connection);
    const delivered = await delivery.deliver(ROUND_1_INPUT);
    h.galley.recordDelivery(h.ticketId, {
      commitSha: delivered.commitSha,
      summary: ROUND_1_INPUT.summary,
      testsAndResults: ROUND_1_INPUT.testsAndResults,
      successCriteriaAssessment: ROUND_1_INPUT.successCriteriaAssessment,
      prNumber: delivered.prNumber,
    });

    h.api.injectMerge(OWNER, REPO, delivered.prNumber);
    const observed = await connection.getPullRequest(OWNER, REPO, delivered.prNumber);
    h.galley.observeMerge(h.ticketId, {
      merged: observed.merged,
      state: observed.state,
      mergedAt: observed.mergedAt,
      mergeCommitSha: observed.mergeCommitSha,
      prNumber: observed.number,
    });
    assert.equal(h.galley.getTicket(h.ticketId).status, "Done");

    h.galley.reopen(h.ticketId);
    assert.equal(h.galley.getTicket(h.ticketId).status, "In Review");

    const admission = h.galley.ledger.admit({
      roundId: "round-1",
      ticketId: h.ticketId,
      agentId: AGENT_ID,
      account: ACCOUNT,
      action: GitHubConnectionActions.PULLS_WRITE,
      resource: pullsResource(OWNER, REPO),
    });
    assert.equal(admission.decision, "deny");
    assert.equal(admission.reason, "ticket-done", "reopening a Done Ticket must not restore its ticket-based grant");
  } finally {
    await h.cleanup();
  }
});

test("8. A closed-unmerged PR is recorded in undefinedTransitions with status unchanged", async () => {
  const h = await setup("ticket-108", "ticket-108-branch");
  try {
    h.grantAllTicketActions();
    h.galley.startRound(h.ticketId);
    const connection = h.makeConnection("round-1");
    const delivery = h.makeDelivery(connection);
    const delivered = await delivery.deliver(ROUND_1_INPUT);
    h.galley.recordDelivery(h.ticketId, {
      commitSha: delivered.commitSha,
      summary: ROUND_1_INPUT.summary,
      testsAndResults: ROUND_1_INPUT.testsAndResults,
      successCriteriaAssessment: ROUND_1_INPUT.successCriteriaAssessment,
      prNumber: delivered.prNumber,
    });

    h.api.injectClose(OWNER, REPO, delivered.prNumber);
    const observed = await connection.getPullRequest(OWNER, REPO, delivered.prNumber);
    assert.equal(observed.merged, false);
    assert.equal(observed.state, "closed");
    h.galley.observeMerge(h.ticketId, {
      merged: observed.merged,
      state: observed.state,
      mergedAt: observed.mergedAt,
      mergeCommitSha: observed.mergeCommitSha,
      prNumber: observed.number,
    });

    const ticket = h.galley.getTicket(h.ticketId);
    assert.equal(ticket.status, "In Review", "D4 is not resolved here: status must not change");
    assert.equal(ticket.undefinedTransitions.length, 1);
    assert.equal(ticket.undefinedTransitions[0]?.kind, "closed-unmerged");
    assert.equal(ticket.undefinedTransitions[0]?.observed["merged"], false);
    assert.equal(ticket.undefinedTransitions[0]?.observed["prNumber"], delivered.prNumber);
  } finally {
    await h.cleanup();
  }
});

test("9. A merge observed while a Round is open is recorded in undefinedTransitions, status unchanged, Round still open", async () => {
  const h = await setup("ticket-109", "ticket-109-branch");
  try {
    h.grantAllTicketActions();
    h.galley.startRound(h.ticketId);
    const connection = h.makeConnection("round-1");
    const delivery = h.makeDelivery(connection);
    const delivered = await delivery.deliver(ROUND_1_INPUT);
    h.galley.recordDelivery(h.ticketId, {
      commitSha: delivered.commitSha,
      summary: ROUND_1_INPUT.summary,
      testsAndResults: ROUND_1_INPUT.testsAndResults,
      successCriteriaAssessment: ROUND_1_INPUT.successCriteriaAssessment,
      prNumber: delivered.prNumber,
    });

    // Owner explicitly requeues and a new Round starts (rework) BEFORE the
    // human's merge of the still-outstanding PR is observed — the D4
    // "merge arrival during an open round" exceptional case.
    h.galley.explicitRequeue(h.ticketId);
    h.galley.startRound(h.ticketId);
    assert.equal(h.galley.getTicket(h.ticketId).roundOpen, true);

    h.api.injectMerge(OWNER, REPO, delivered.prNumber);
    const observed = await connection.getPullRequest(OWNER, REPO, delivered.prNumber);
    h.galley.observeMerge(h.ticketId, {
      merged: observed.merged,
      state: observed.state,
      mergedAt: observed.mergedAt,
      mergeCommitSha: observed.mergeCommitSha,
      prNumber: observed.number,
    });

    const ticket = h.galley.getTicket(h.ticketId);
    assert.equal(ticket.status, "In Progress", "status must not change while a Round is open");
    assert.equal(ticket.roundOpen, true, "the Round must still be open");
    assert.equal(ticket.rounds.length, 1, "Round 2 was never delivered");
    assert.equal(ticket.undefinedTransitions.length, 1);
    assert.equal(ticket.undefinedTransitions[0]?.kind, "merge-during-open-round");
  } finally {
    await h.cleanup();
  }
});

test("10. With the ledger disconnected, deliver refuses before any API call or push (request log and remote unchanged)", async () => {
  const h = await setup("ticket-110", "ticket-110-branch");
  try {
    h.grantAllTicketActions();
    h.galley.startRound(h.ticketId);
    h.galley.ledger.setConnected(false);
    const connection = h.makeConnection("round-1");
    const delivery = h.makeDelivery(connection);

    await assert.rejects(
      () => delivery.deliver(ROUND_1_INPUT),
      (err: unknown) => err instanceof AdmissionRefusedError && err.decision === "hold" && err.reason === "disconnected",
    );

    assert.equal(h.api.requestLog().length, 0, "no API call must have run");
    assert.equal(h.remote.revParse(`refs/heads/${h.branch}`), null, "the remote must be unchanged");
  } finally {
    await h.cleanup();
  }
});
