import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Initialize a minimal git worktree at `<root>/project`, matching
 * `opencode-harness`'s private `initTempGitProject` (`src/managed-opencode.ts`,
 * not exported). Duplicated locally because scenario 4 (process death)
 * needs to create the project directory *once*, up front, and then start
 * two separate OpenCode server processes against that same directory (see
 * `direct-server.ts`) -- `startManagedOpenCode` always creates and owns
 * its own single-use project directory internally.
 */
export function initTempGitProject(root: string): string {
  const projectDir = path.join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: projectDir, stdio: "pipe" });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "opencode-cancellation@example.invalid"]);
  run(["config", "user.name", "opencode-cancellation"]);
  writeFileSync(path.join(projectDir, "README.md"), "opencode-cancellation temporary project.\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "opencode-cancellation: initial commit"]);
  return projectDir;
}
