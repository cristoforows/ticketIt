import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdmissionLedger, FakeClock } from "shared";
import { FakeGitHubApi, type PatAccountConfig } from "../src/fake-github-api.js";
import { FakeGitRemote } from "../src/fake-git-remote.js";
import {
  AdmissionRefusedError,
  GitHubConnection,
  GitHubConnectionActions,
  IdentityMismatchError,
  PullRequestPermissionError,
  RepositoryAccessError,
  pullsResource,
  pushResource,
  repoResource,
  type GitHubConnectionConfig,
} from "../src/github-connection.js";

const PAT_TOKEN = "pat-fixture-michelin-token";
const ADMIN_TOKEN = "pat-fixture-admin-broader-token-never-sent";
const AGENT_ID = "agent-coder-1";
const ROUND_ID = "round-1";
const TICKET_ID = "ticket-27";
const ACCOUNT = "github:michelin-bot";
const GIT_AUTHOR = { name: "ticketIt Runner", email: "runner@ticketit.invalid" };

function makeWorktreeWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), "github-connection-work-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "config", "user.name", "Seed Author"], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "config", "user.email", "seed@example.invalid"], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "seed commit"], { stdio: ["ignore", "pipe", "pipe"] });
  return dir;
}

/** A fake API with a normal PAT plus a broader "admin" PAT that must never be sent. */
function makeApiWithAdminDecoy(normalOverrides: Partial<PatAccountConfig> = {}): FakeGitHubApi {
  return new FakeGitHubApi({
    patAccounts: [
      {
        token: PAT_TOKEN,
        login: "michelin-bot",
        repositories: ["acme/allowed-repo"],
        permissions: ["pull_requests"],
        ...normalOverrides,
      },
      {
        token: ADMIN_TOKEN,
        login: "michelin-admin",
        repositories: ["acme/allowed-repo", "acme/other-repo"],
        permissions: ["pull_requests", "contents", "admin"],
      },
    ],
  });
}

function makeConnection(overrides: Partial<GitHubConnectionConfig> & { apiBaseUrl: string; ledger: AdmissionLedger }): GitHubConnection {
  return new GitHubConnection({
    expectedLogin: "michelin-bot",
    pat: PAT_TOKEN,
    gitAuthor: GIT_AUTHOR,
    sshCommand: "true",
    ledgerContext: { roundId: ROUND_ID, ticketId: TICKET_ID, agentId: AGENT_ID, account: ACCOUNT },
    ...overrides,
  });
}

function grantTicket(ledger: AdmissionLedger, action: string, resource: string): void {
  ledger.grant({ agentId: AGENT_ID, account: ACCOUNT, action, resource, kind: { kind: "ticket", ticketId: TICKET_ID } });
}

test("PAT identity mismatch is rejected", async () => {
  const api = makeApiWithAdminDecoy();
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock);
    grantTicket(ledger, GitHubConnectionActions.VERIFY_IDENTITY, "github-account:not-michelin-bot");
    const connection = makeConnection({ apiBaseUrl: baseUrl, ledger, expectedLogin: "not-michelin-bot" });

    await assert.rejects(() => connection.verifyIdentity(), IdentityMismatchError);
  } finally {
    await api.close();
  }
});

test("PAT identity match is accepted and recorded", async () => {
  const api = makeApiWithAdminDecoy();
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock);
    grantTicket(ledger, GitHubConnectionActions.VERIFY_IDENTITY, "github-account:michelin-bot");
    const connection = makeConnection({ apiBaseUrl: baseUrl, ledger });

    const result = await connection.verifyIdentity();

    assert.equal(result.login, "michelin-bot");
    const log = api.requestLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.token, PAT_TOKEN);
    assert.equal(log[0]?.status, 200);
  } finally {
    await api.close();
  }
});

test("repository outside the token's resource set fails explicitly; only the PAT was ever sent, never the broader admin token", async () => {
  const api = makeApiWithAdminDecoy();
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock);
    grantTicket(ledger, GitHubConnectionActions.REPO_READ, repoResource("acme", "other-repo"));
    const connection = makeConnection({ apiBaseUrl: baseUrl, ledger });

    await assert.rejects(
      () => connection.checkRepositoryAccess("acme", "other-repo"),
      (err: unknown) => err instanceof RepositoryAccessError && err.status === 404,
    );

    const log = api.requestLog();
    assert.ok(log.length > 0);
    assert.ok(
      log.every((entry) => entry.token === PAT_TOKEN),
      `expected every fake API request to use only the PAT, got tokens: ${JSON.stringify(log.map((e) => e.token))}`,
    );
    assert.ok(
      log.every((entry) => entry.token !== ADMIN_TOKEN),
      "the broader admin token must never be sent to the fake API",
    );
  } finally {
    await api.close();
  }
});

test("pull-request permission missing surfaces 403, no credential substitution", async () => {
  const api = makeApiWithAdminDecoy({ permissions: [] }); // normal PAT lacks pull_requests
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock);
    grantTicket(ledger, GitHubConnectionActions.PULLS_READ, pullsResource("acme", "allowed-repo"));
    const connection = makeConnection({ apiBaseUrl: baseUrl, ledger });

    await assert.rejects(() => connection.checkPullRequestAccess("acme", "allowed-repo"), PullRequestPermissionError);

    const log = api.requestLog();
    assert.ok(log.every((entry) => entry.token === PAT_TOKEN));
    assert.ok(log.every((entry) => entry.token !== ADMIN_TOKEN));
  } finally {
    await api.close();
  }
});

test("commit author differs from the API identity (read via git log --format)", async () => {
  const api = makeApiWithAdminDecoy();
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock);
    const worktree = makeWorktreeWithCommit();
    grantTicket(ledger, GitHubConnectionActions.GIT_COMMIT, worktree);
    const connection = makeConnection({ apiBaseUrl: baseUrl, ledger });

    const sha = connection.commit(worktree, "ticketIt: apply change");

    const authorLine = execFileSync("git", ["-C", worktree, "log", "-1", "--format=%an <%ae>", sha], { encoding: "utf8" }).trim();
    assert.equal(authorLine, `${GIT_AUTHOR.name} <${GIT_AUTHOR.email}>`);
    // The commit author is a configuration concern distinct from the API identity's login.
    assert.notEqual(authorLine, "michelin-bot");
  } finally {
    await api.close();
  }
});

test("SSH identity used for push is logged separately from the API token", async () => {
  const api = makeApiWithAdminDecoy();
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock);
    const worktree = makeWorktreeWithCommit();
    const remote = new FakeGitRemote();
    const identityPath = "/fixtures/ssh/michelin-deploy-key";
    grantTicket(ledger, GitHubConnectionActions.GIT_PUSH, pushResource(remote.remoteUrl, "main"));
    const connection = makeConnection({
      apiBaseUrl: baseUrl,
      ledger,
      sshCommand: remote.sshCommandFor(identityPath),
    });

    connection.push(worktree, remote.remoteUrl, "main");

    const pushInvocation = remote.invocations().find((entry) => entry.argsLine.includes("git-receive-pack"));
    assert.ok(pushInvocation);
    assert.equal(pushInvocation?.identity, identityPath);
    assert.notEqual(pushInvocation?.identity, PAT_TOKEN);
    // Push never touches the fake GitHub API at all.
    assert.equal(api.requestLog().length, 0);
  } finally {
    await api.close();
  }
});

test("ledger consulted before API actions: offline downgrades an otherwise-valid admission to hold, and the action does not run", async () => {
  const api = makeApiWithAdminDecoy();
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock);
    grantTicket(ledger, GitHubConnectionActions.VERIFY_IDENTITY, "github-account:michelin-bot");
    ledger.setConnected(false);
    const connection = makeConnection({ apiBaseUrl: baseUrl, ledger });

    await assert.rejects(
      () => connection.verifyIdentity(),
      (err: unknown) => err instanceof AdmissionRefusedError && err.decision === "hold" && err.reason === "disconnected",
    );

    assert.equal(api.requestLog().length, 0, "the API action must not run while held");
  } finally {
    await api.close();
  }
});

test("ledger consulted before API actions: an expired time-based grant denies, and the action does not run", async () => {
  const api = makeApiWithAdminDecoy();
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock);
    ledger.grant({
      agentId: AGENT_ID,
      account: ACCOUNT,
      action: GitHubConnectionActions.VERIFY_IDENTITY,
      resource: "github-account:michelin-bot",
      kind: { kind: "time", expiresAt: clock.nowMs() + 1_000 },
    });
    clock.advance(2_000);
    const connection = makeConnection({ apiBaseUrl: baseUrl, ledger });

    await assert.rejects(
      () => connection.verifyIdentity(),
      (err: unknown) => err instanceof AdmissionRefusedError && err.decision === "deny" && err.reason === "expired",
    );

    assert.equal(api.requestLog().length, 0);
  } finally {
    await api.close();
  }
});

test("ledger consulted before API actions: a revoked grant denies, and the action does not run", async () => {
  const api = makeApiWithAdminDecoy();
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock);
    const grant = ledger.grant({
      agentId: AGENT_ID,
      account: ACCOUNT,
      action: GitHubConnectionActions.VERIFY_IDENTITY,
      resource: "github-account:michelin-bot",
      kind: { kind: "ticket", ticketId: TICKET_ID },
    });
    ledger.revoke(grant.id);
    const connection = makeConnection({ apiBaseUrl: baseUrl, ledger });

    await assert.rejects(
      () => connection.verifyIdentity(),
      (err: unknown) => err instanceof AdmissionRefusedError && err.decision === "deny" && err.reason === "revoked",
    );

    assert.equal(api.requestLog().length, 0);
  } finally {
    await api.close();
  }
});

test("ledger consulted before API actions: a valid ticket grant allows, and the action runs", async () => {
  const api = makeApiWithAdminDecoy();
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock);
    grantTicket(ledger, GitHubConnectionActions.VERIFY_IDENTITY, "github-account:michelin-bot");
    const connection = makeConnection({ apiBaseUrl: baseUrl, ledger });

    const result = await connection.verifyIdentity();

    assert.equal(result.login, "michelin-bot");
    assert.equal(api.requestLog().length, 1);
  } finally {
    await api.close();
  }
});

test("ledger consulted before Git actions too: without a grant, commit and push are refused and never run", async () => {
  const api = makeApiWithAdminDecoy();
  const { baseUrl } = await api.listen();
  try {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const ledger = new AdmissionLedger(clock); // no grants at all
    const worktree = makeWorktreeWithCommit();
    const headBefore = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const remote = new FakeGitRemote();
    const connection = makeConnection({
      apiBaseUrl: baseUrl,
      ledger,
      sshCommand: remote.sshCommandFor("/fixtures/ssh/unused-key"),
    });

    await assert.rejects(
      async () => connection.commit(worktree, "should not run"),
      (err: unknown) => err instanceof AdmissionRefusedError && err.decision === "deny" && err.reason === "no-grant",
    );
    const headAfter = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(headAfter, headBefore, "commit must not have run");

    await assert.rejects(
      async () => connection.push(worktree, remote.remoteUrl, "main"),
      (err: unknown) => err instanceof AdmissionRefusedError && err.decision === "deny" && err.reason === "no-grant",
    );
    assert.equal(remote.revParse("refs/heads/main"), null, "push must not have run");
  } finally {
    await api.close();
  }
});
