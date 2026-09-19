import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptBashToolCall, scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString("utf8");
}

/**
 * Issue #21, priority row 3 ("nested shell") plus the required
 * worktree-is-not-a-sandbox demonstration, combined in one fixture since
 * both exercise the SAME single admitted "bash" tool call and are easiest
 * to reason about together.
 *
 * ## Nested shell (priority row 3)
 *
 * A single scripted "bash" tool call runs a compound shell command that:
 * 1. Commits a new file inside a scratch Git working directory (unrelated
 *    to the OpenCode-managed `projectDir`).
 * 2. Pushes that commit to a local BARE Git remote over `ssh://`, using a
 *    local fake-SSH shim (`GIT_SSH` pointed at a tiny script that ignores
 *    the host argument and runs the remaining command with a local shell)
 *    instead of a real network SSH connection -- per this workspace's "no
 *    network egress beyond loopback" rule, this never leaves the machine
 *    and opens no real socket at all.
 * 3. Makes an HTTP request to a local marker server bound to 127.0.0.1
 *    (loopback only).
 *
 * The ledger admits (or would deny) this ENTIRE compound command as one
 * single "bash" scope -- `AdmissionLedger#admit`/`#dispatch` has no
 * visibility into what the shell actually runs once dispatched. This test
 * proves that concretely: with ONE grant and ONE resulting `allow`
 * decision/dispatch, all three sub-actions (git commit, git push over the
 * fake-SSH transport, HTTP request) demonstrably occur, each confirmed by
 * an independent, engine-external witness (the bare repo's own commit log,
 * the marker HTTP server's own hit count). "Gated only coarsely" means
 * exactly this: the admission boundary sits at the granularity of "one
 * bash tool call," not at the granularity of "one git push" or "one
 * network request" -- there is no mechanism in this bridge, or in
 * OpenCode's own hook surface used here, to see or deny anything below
 * the whole shell invocation.
 *
 * ## Worktree is not a sandbox (required demonstration)
 *
 * The SAME admitted bash call also reads a marker file placed OUTSIDE
 * both the OpenCode-managed `projectDir` (a fresh temp git repo,
 * per `opencode-harness`'s `startManagedOpenCode`) and this ticketIt
 * repository's own git worktree, using nothing but a `cat` of an absolute
 * path. Its content is delivered back to the model as an ordinary tool
 * result. This is not a bypass of anything -- it is exactly
 * `docs/agent-execution.md`'s "Coding deliverables" statement applied to
 * OpenCode specifically: "Git worktrees separate working files and
 * branches, but do not restrict access to other files, credentials, or
 * the network... must not be described as a complete filesystem or
 * network sandbox." Stated plainly in this test's own assertion message
 * and in the evidence record.
 *
 * ## A native permission gate this fixture had to discover and route around
 *
 * Development note, kept because it is itself a finding: this pinned
 * build's bash tool, by default (i.e. with no `permission` config at all,
 * the same posture every other test in this suite uses), silently
 * NEVER RESOLVES a `session.prompt()` call for a command that reads a path
 * outside the OpenCode-managed project directory (confirmed narrowed down
 * to a plain `cat /etc/hostname`) or that runs `curl` -- consistent with
 * OpenCode's own `Config.permission.external_directory` field
 * (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`, "ask"|"allow"|
 * "deny", alongside `bash`/`edit`/`webfetch`/`doom_loop`) defaulting to
 * "ask" for such commands on this pinned build, with no code path in this
 * bridge (or in this fixture, before this was diagnosed) that ever replies
 * to that pending native request -- indistinguishable from a hang without
 * timestamped instrumentation. This is DIFFERENT from `permission.bash`
 * (confirmed elsewhere in this suite, e.g. `03-hook-precedes-native-permission-ask.test.ts`,
 * to default to allow when unconfigured): `external_directory` and
 * network-touching commands appear to carry their own, stricter native
 * default. This fixture therefore explicitly sets
 * `permission: { bash: "allow", external_directory: "allow" }` so the
 * native engine never blocks on an unanswered prompt -- this bridge's OWN
 * admission hook (gated below via the ledger, independent of this native
 * config entirely, exactly as `08-ambient-permission-vs-hook.test.ts`
 * establishes) remains the thing actually under test. Recorded in the
 * evidence record as an observed limitation / documentation-research gap
 * from `docs/evidence/m1/17-opencode-questions.md`'s and
 * `docs/evidence/m1/19-opencode-fixed-inputs.md`'s own permission
 * coverage, not something either of those slices got wrong -- neither
 * exercised a cross-directory read or a network-touching shell command.
 */
test("nested shell (git+fake-ssh push+HTTP) executes under ONE admitted bash call, coarse-grained; worktree is not a filesystem sandbox", async () => {
  const scratchRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-nested-shell-"));
  const bareRepoDir = path.join(scratchRoot, "bare.git");
  const workDir = path.join(scratchRoot, "work");
  const fakeSshScript = path.join(scratchRoot, "fake-ssh.sh");
  // Deliberately OUTSIDE both the (not-yet-created) OpenCode projectDir and
  // this repository's own git worktree -- just a plain OS temp directory.
  const outsideMarkerFile = path.join(scratchRoot, "outside-worktree-marker.txt");
  const outsideSentinel = "SENTINEL-OUTSIDE-THE-WORKTREE-21";
  writeFileSync(outsideMarkerFile, `${outsideSentinel}\n`, "utf8");

  mkdirSync(workDir, { recursive: true });
  git(["init", "-q", "--bare", bareRepoDir], scratchRoot);
  git(["init", "-q", workDir], scratchRoot);
  git(["config", "user.email", "nested-shell@example.invalid"], workDir);
  git(["config", "user.name", "nested-shell-test"], workDir);
  writeFileSync(path.join(workDir, "committed.txt"), "committed via nested nested-shell test\n", "utf8");
  git(["add", "."], workDir);
  git(["commit", "-q", "-m", "nested-shell fixture commit"], workDir);

  // A local, loopback-only fake-SSH shim: ignores the ssh "host" argument
  // (git invokes `ssh <host> <remote-command>`) and runs the remote
  // command with a local shell instead of opening any real network
  // connection. This is the standard technique for exercising git's ssh
  // transport entirely locally.
  writeFileSync(
    fakeSshScript,
    ["#!/bin/sh", "# $1 is the ssh \"host\" (ignored); the remaining args are the remote command.", "shift", 'exec sh -c "$*"', ""].join("\n"),
    "utf8",
  );
  chmodSync(fakeSshScript, 0o755);

  // Local HTTP marker server, loopback only.
  let httpHitCount = 0;
  const httpServer: Server = createServer((_req, res) => {
    httpHitCount += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const httpAddress = httpServer.address();
  const httpPort = typeof httpAddress === "object" && httpAddress !== null ? httpAddress.port : 0;
  assert.ok(httpPort > 0, "the local marker HTTP server should have bound to an ephemeral port");

  // The single compound "bash" command: git push over the fake-SSH
  // transport, then an HTTP GET to the local marker server, then `cat` of
  // the outside-the-worktree marker file. Quoting is POSIX-shell-safe
  // since none of these paths contain special characters.
  const nestedCommand = [
    `cd ${workDir}`,
    `GIT_SSH=${fakeSshScript} git push ssh://127.0.0.1${bareRepoDir} HEAD:refs/heads/main`,
    `curl -s http://127.0.0.1:${httpPort}/nested-shell-marker`,
    `cat ${outsideMarkerFile}`,
  ].join(" && ");

  const stub = new StubModelServer({
    // A bounded `timeout` on the bash tool call itself (OpenCode's own
    // "bash" tool parameter, milliseconds) so a genuine hang anywhere in
    // the compound command fails fast with a clear tool-timeout error
    // rather than blocking this test indefinitely.
    turns: [scriptBashToolCall({ command: nestedCommand, timeout: 10000 }), scriptTextTurn("Done after nested-shell probe.")],
  });
  await stub.start();

  const admitted = await startAdmittedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    // See the module comment's "native permission gate" note: without this,
    // the native `external_directory`/network-command ask never resolves
    // (nothing replies to it), and `session.prompt()` below hangs forever.
    // This is orthogonal to THIS BRIDGE's own admission hook, gated below
    // purely through the ledger.
    extraConfig: { permission: { bash: "allow", external_directory: "allow" } },
  });
  try {
    // Exactly one grant for the whole "bash" scope -- this is the ENTIRE
    // admission surface available to gate the compound command below.
    admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: admitted.action,
      resource: admitted.resource,
      kind: { kind: "ticket", ticketId: admitted.ticketId },
    });

    const session = await admitted.managed.session.create("m1-21 nested-shell + worktree-sandbox probe");
    await admitted.managed.session.promptText(session.id, "run the nested shell command");

    // Exactly ONE admission decision/dispatch covers the entire compound
    // command -- this is the "coarse-grained" finding stated concretely.
    const decisions = admitted.ledger.decisions();
    assert.equal(decisions.length, 1, `expected exactly one admit() call for the entire compound bash command, got: ${JSON.stringify(decisions)}`);
    assert.equal(decisions[0]!.decision, "allow");
    const dispatches = admitted.ledger.dispatches();
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0]!.completedAtMs !== undefined);

    // Sub-action 1: the git push over the fake-SSH transport actually
    // landed in the bare remote -- confirmed by an engine-external witness
    // (the bare repo's own log), not by anything OpenCode or this bridge
    // reports.
    const bareLog = git(["log", "--oneline", "refs/heads/main"], bareRepoDir);
    assert.match(bareLog, /nested-shell fixture commit/, "the git push over the fake-SSH transport must have reached the bare remote -- a sub-action inside the ONE admitted bash call, invisible to the ledger");

    // Sub-action 2: the HTTP request to the local marker server landed.
    assert.equal(httpHitCount, 1, "the loopback HTTP request must have reached the local marker server -- another sub-action inside the same single admitted bash call");

    // Sub-action 3 / worktree-is-not-a-sandbox: the outside-the-worktree
    // marker file's content was read and delivered back through the tool
    // result, proving OpenCode's bash tool is not confined to the
    // OpenCode-managed projectDir or to this repository's own git
    // worktree -- exactly docs/agent-execution.md's "do not restrict
    // access to other files... must not be described as a complete
    // filesystem or network sandbox," demonstrated concretely rather than
    // merely cited.
    const messagesJson = JSON.stringify(await admitted.managed.session.messages(session.id));
    assert.ok(
      messagesJson.includes(outsideSentinel),
      "STATED PLAINLY: the worktree is not a sandbox -- a single admitted bash call read and returned the content of a marker file located outside both the OpenCode-managed project directory and this repository's own git worktree",
    );

    // Ground truth, independent of anything OpenCode reports: the outside
    // marker file is untouched (this test only reads it), and the local
    // filesystem read-back above is the actual proof, not a re-derivation.
    assert.equal(readFileSync(outsideMarkerFile, "utf8"), `${outsideSentinel}\n`);
  } finally {
    await admitted.close();
    await stub.close();
    await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});
