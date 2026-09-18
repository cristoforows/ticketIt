/**
 * A fake Git remote reached over a fake SSH transport, for proving that a
 * push's configured SSH identity is observable independently of any API
 * token (docs/agent-execution.md: "Git commit authorship and the account
 * identity used for API actions remain separate configuration
 * concerns"; the same separation applies to the SSH identity used for
 * the Git transport itself).
 *
 * Mechanism: `FakeGitRemote` creates a local bare repository as the
 * "remote", plus a small shell script meant to be used as
 * `GIT_SSH_COMMAND` (or `core.sshCommand`). Git treats `GIT_SSH_COMMAND`
 * as a command line, shell-split, with the target host and the remote
 * git command (e.g. `git-receive-pack '/path'`) appended as further
 * arguments — see `git help git-remote-ext`/`git push` and the
 * `GIT_SSH_COMMAND` description in `git help`: "the command is executed
 * via shell, in which case it is split into words". So a configured
 * value of `"<fake-ssh.sh> -i <identityPath>"` is invoked as
 * `<fake-ssh.sh> -i <identityPath> <host> "<remote-command>"`. The
 * script logs the full argv (including the `-i` identity) to a file,
 * then evaluates the trailing remote-command argument locally, i.e. it
 * runs `git-receive-pack`/`git-upload-pack` directly against the bare
 * repository's real filesystem path instead of connecting anywhere —
 * this repo uses the scp-like remote URL form
 * `git@fake-git-host:<absolute bare repo path>`, so the "remote path"
 * git passes to the transport command is already the real local path,
 * no translation needed. No real SSH connection, key, or network call
 * is ever made; the identity path is a fixture string, not a real key.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One recorded fake-SSH invocation: which identity (`-i` value) it carried, and the full argv line. */
export interface SshInvocation {
  readonly loggedAtIso: string;
  readonly identity: string | null;
  readonly argsLine: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A local bare repository standing in for a GitHub remote, plus a fake
 * SSH command script that logs the identity it was configured with.
 */
export class FakeGitRemote {
  readonly #dir: string;
  readonly #bareRepoPath: string;
  readonly #sshScriptPath: string;
  readonly #logPath: string;

  constructor(rootDir?: string) {
    this.#dir = rootDir ?? mkdtempSync(join(tmpdir(), "fake-git-remote-"));
    this.#bareRepoPath = join(this.#dir, "remote.git");
    this.#sshScriptPath = join(this.#dir, "fake-ssh.sh");
    this.#logPath = join(this.#dir, "ssh-invocations.log");

    mkdirSync(this.#dir, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--bare", this.#bareRepoPath], { stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(this.#logPath, "");
    writeFileSync(this.#sshScriptPath, this.#renderScript(), { mode: 0o755 });
    chmodSync(this.#sshScriptPath, 0o755);
  }

  #renderScript(): string {
    // POSIX-array-indexed extraction of the identity ("-i" value) and the
    // trailing remote-command argument, logged then executed locally.
    return `#!/bin/bash
# Fake SSH transport for experiments/github-delivery (M1.16, issue #27).
# Logs the identity this invocation was configured with, then runs the
# requested git transport command locally instead of connecting anywhere.
set -eu
LOGFILE=${shellQuote(this.#logPath)}
args=("$@")
identity=""
for ((i = 0; i < ${"$"}{#args[@]}; i++)); do
  if [ "${"$"}{args[$i]}" = "-i" ]; then
    identity="${"$"}{args[$((i + 1))]}"
  fi
done
printf '%s\\tIDENTITY=%s\\tARGS=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$identity" "$*" >> "$LOGFILE"
last="${"$"}{args[$((${"$"}{#args[@]} - 1))]}"
eval "$last"
`;
  }

  /** Absolute path to the local bare repository standing in for the remote. */
  get bareRepoPath(): string {
    return this.#bareRepoPath;
  }

  /** The scp-like remote URL git will push/fetch against (`user@host:path`). */
  get remoteUrl(): string {
    return `git@fake-git-host:${this.#bareRepoPath}`;
  }

  /** Absolute path to the fake SSH script, for use as (a prefix of) `GIT_SSH_COMMAND`. */
  get sshScriptPath(): string {
    return this.#sshScriptPath;
  }

  /** Build a `GIT_SSH_COMMAND` value that configures `identityPath` as the `-i` identity. */
  sshCommandFor(identityPath: string): string {
    return `${shellQuote(this.#sshScriptPath)} -i ${shellQuote(identityPath)}`;
  }

  /** Every fake-SSH invocation recorded so far, oldest first. */
  invocations(): SshInvocation[] {
    const raw = readFileSync(this.#logPath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [loggedAtIso = "", rest = ""] = line.split("\tIDENTITY=");
        const [identityPart = "", argsPart = ""] = rest.split("\tARGS=");
        return {
          loggedAtIso,
          identity: identityPart.length > 0 ? identityPart : null,
          argsLine: argsPart,
        };
      });
  }

  /** `git rev-parse <ref>` against the bare repo, or `null` if the ref does not resolve. */
  revParse(ref: string): string | null {
    try {
      return execFileSync("git", ["--git-dir", this.#bareRepoPath, "rev-parse", ref], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      return null;
    }
  }
}
