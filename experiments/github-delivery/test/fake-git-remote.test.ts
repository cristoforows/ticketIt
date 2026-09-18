import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitRemote } from "../src/fake-git-remote.js";

function makeWorktreeWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-git-remote-work-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "config", "user.name", "Fixture Author"], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "config", "user.email", "fixture@example.invalid"], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "fixture commit"], { stdio: ["ignore", "pipe", "pipe"] });
  return dir;
}

test("push over the fake SSH transport logs the configured identity", () => {
  const remote = new FakeGitRemote();
  const worktree = makeWorktreeWithCommit();
  const identityPath = "/fixtures/ssh/michelin-deploy-key";

  execFileSync("git", ["-C", worktree, "push", remote.remoteUrl, "main"], {
    env: { ...process.env, GIT_SSH_COMMAND: remote.sshCommandFor(identityPath) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const invocations = remote.invocations();
  const pushInvocation = invocations.find((entry) => entry.argsLine.includes("git-receive-pack"));
  assert.ok(pushInvocation, "expected a logged invocation running git-receive-pack");
  assert.equal(pushInvocation?.identity, identityPath);
});

test("pushed commits land in the bare remote repository", () => {
  const remote = new FakeGitRemote();
  const worktree = makeWorktreeWithCommit();
  const localHead = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  execFileSync("git", ["-C", worktree, "push", remote.remoteUrl, "main"], {
    env: { ...process.env, GIT_SSH_COMMAND: remote.sshCommandFor("/fixtures/ssh/some-key") },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(remote.revParse("refs/heads/main"), localHead);
});

test("different pushes can log different configured identities", () => {
  const remote = new FakeGitRemote();
  const worktreeA = makeWorktreeWithCommit();
  execFileSync("git", ["-C", worktreeA, "push", remote.remoteUrl, "main"], {
    env: { ...process.env, GIT_SSH_COMMAND: remote.sshCommandFor("/fixtures/ssh/key-a") },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const worktreeB = makeWorktreeWithCommit();
  execFileSync("git", ["-C", worktreeB, "push", "--force", remote.remoteUrl, "main"], {
    env: { ...process.env, GIT_SSH_COMMAND: remote.sshCommandFor("/fixtures/ssh/key-b") },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const identities = remote
    .invocations()
    .filter((entry) => entry.argsLine.includes("git-receive-pack"))
    .map((entry) => entry.identity);
  assert.deepEqual(identities, ["/fixtures/ssh/key-a", "/fixtures/ssh/key-b"]);
});
