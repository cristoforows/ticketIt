import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

interface MinimalPackageJson {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
}

function readOpencodeAiPackageJson(): { path: string; pkg: MinimalPackageJson } {
  // opencode-ai has no "exports" map, so its package.json is a plain
  // resolvable subpath.
  const pkgJsonPath = require.resolve("opencode-ai/package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as MinimalPackageJson;
  return { path: pkgJsonPath, pkg };
}

/**
 * Find the package.json for `packageName`, starting from a file inside
 * it and walking up. Needed for `@opencode-ai/sdk`: unlike `opencode-ai`,
 * it declares an "exports" map that does not list "./package.json", so
 * `require.resolve("@opencode-ai/sdk/package.json")` is rejected
 * (ERR_PACKAGE_PATH_NOT_EXPORTED) even though the file exists on disk.
 * Walking up from the resolved main entry and reading the file directly
 * with `fs` bypasses the exports restriction (which only governs
 * module resolution, not plain filesystem reads).
 */
function findPackageJson(startFile: string, packageName: string): { path: string; pkg: MinimalPackageJson } {
  let dir = path.dirname(startFile);
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as MinimalPackageJson;
      if (pkg.name === packageName) return { path: candidate, pkg };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`could not locate package.json for ${packageName} starting from ${startFile}`);
    dir = parent;
  }
}

function readOpencodeSdkPackageJson(): { path: string; pkg: MinimalPackageJson } {
  // @opencode-ai/sdk's "exports" map only declares an "import" condition
  // for ".", not "require"/"default", so a CJS-style require.resolve()
  // (which createRequire uses) fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
  // import.meta.resolve performs ESM resolution instead, which matches.
  const entryUrl = import.meta.resolve("@opencode-ai/sdk");
  return findPackageJson(fileURLToPath(entryUrl), "@opencode-ai/sdk");
}

/** The exact pinned `opencode-ai` version resolved from `node_modules`. */
export function resolveOpencodeVersion(): string {
  const { pkg } = readOpencodeAiPackageJson();
  if (!pkg.version) throw new Error("opencode-ai package.json has no version field");
  return pkg.version;
}

/** The exact pinned `@opencode-ai/sdk` version resolved from `node_modules`. */
export function resolveOpencodeSdkVersion(): string {
  const { pkg } = readOpencodeSdkPackageJson();
  if (!pkg.version) throw new Error("@opencode-ai/sdk package.json has no version field");
  return pkg.version;
}

/**
 * Absolute path to the pinned `opencode` executable file itself (not a
 * PATH-resolved command). Read from the package's own `bin` field rather
 * than hardcoded, since the shipped file is named `opencode.exe` on every
 * platform (including macOS/Linux) despite not being a Windows binary.
 */
export function resolveOpencodeBinary(): string {
  const { path: pkgJsonPath, pkg } = readOpencodeAiPackageJson();
  const bin = pkg.bin;
  const relative = typeof bin === "string" ? bin : bin?.opencode;
  if (!relative) throw new Error("opencode-ai package.json has no 'bin' entry for 'opencode'");
  return path.resolve(path.dirname(pkgJsonPath), relative);
}

/**
 * The `node_modules/.bin` directory that contains the correctly-named
 * `opencode` symlink (npm's standard bin-linking behavior). The SDK's
 * `createOpencodeServer` helper spawns the bare command `opencode`
 * resolved through `PATH` (via `cross-spawn`), so this directory must be
 * prepended to `PATH` for the pinned local binary to be found instead of
 * any globally-installed one (there is none on this machine, but the
 * harness must not depend on that).
 */
export function resolveOpencodeBinDir(): string {
  const { path: pkgJsonPath } = readOpencodeAiPackageJson();
  const nodeModulesDir = path.dirname(path.dirname(pkgJsonPath));
  return path.join(nodeModulesDir, ".bin");
}

/**
 * Run `opencode debug config` (a pinned-version CLI subcommand: "show
 * resolved configuration") against an explicit `env`/`cwd` and return the
 * parsed JSON. Used to prove config isolation independently of the SDK's
 * HTTP `config.get()` call.
 */
export function readResolvedOpencodeConfig(env: NodeJS.ProcessEnv, cwd: string): unknown {
  const stdout = execFileSync(resolveOpencodeBinary(), ["debug", "config"], {
    env,
    cwd,
    encoding: "utf8",
    timeout: 15000,
  });
  return JSON.parse(stdout);
}

/**
 * Run `opencode debug paths` ("show global paths (data, config, cache,
 * state)") against an explicit `env`/`cwd` and return the parsed
 * key/value pairs.
 */
export function readOpencodePaths(env: NodeJS.ProcessEnv, cwd: string): Record<string, string> {
  const stdout = execFileSync(resolveOpencodeBinary(), ["debug", "paths"], {
    env,
    cwd,
    encoding: "utf8",
    timeout: 15000,
  });
  const result: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (match) result[match[1]!] = match[2]!.trim();
  }
  return result;
}
