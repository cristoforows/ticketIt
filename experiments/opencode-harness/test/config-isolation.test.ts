import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedEnvOverrides, makeIsolatedPaths, readOpencodePaths, readResolvedOpencodeConfig } from "../src/index.js";

/**
 * Positive/negative control for config isolation, independent of a full
 * server boot: uses the pinned CLI's `opencode debug config` subcommand
 * ("show resolved configuration") directly.
 *
 * - Positive control: point HOME straight at the decoy -> the marker
 *   MUST appear. This proves the marker is live and would be observed if
 *   isolation were broken, not just an inert unused file.
 * - Negative control: same decoy HOME, but XDG_CONFIG_HOME and
 *   OPENCODE_CONFIG_DIR redirected to an isolated directory -> the marker
 *   MUST NOT appear, proving those two env vars are what isolates the
 *   global config location.
 */
test("config isolation: decoy marker observed only when pointed at, never through the isolated env", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-harness-isolation-"));
  try {
    const decoyHome = path.join(root, "decoy-home");
    const decoyConfigDir = path.join(decoyHome, ".config", "opencode");
    mkdirSync(decoyConfigDir, { recursive: true });
    const markerModel = "decoy-provider/decoy-marker-model";
    writeFileSync(
      path.join(decoyConfigDir, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", model: markerModel }, null, 2),
    );

    const cwd = path.join(root, "cwd");
    mkdirSync(cwd, { recursive: true });

    // Positive control: HOME is the decoy, nothing else set.
    const positiveEnv: NodeJS.ProcessEnv = { ...process.env, HOME: decoyHome, OPENCODE_TEST_HOME: decoyHome };
    delete positiveEnv.XDG_CONFIG_HOME;
    delete positiveEnv.XDG_DATA_HOME;
    delete positiveEnv.XDG_CACHE_HOME;
    delete positiveEnv.XDG_STATE_HOME;
    delete positiveEnv.OPENCODE_CONFIG_DIR;
    const positiveConfig = readResolvedOpencodeConfig(positiveEnv, cwd) as { model?: string };
    assert.equal(positiveConfig.model, markerModel, "positive control: marker must be observed when HOME points straight at the decoy");

    // Negative control: HOME still the decoy, but the isolated overrides win.
    const isolatedPaths = makeIsolatedPaths(path.join(root, "isolated"));
    mkdirSync(isolatedPaths.homeDir, { recursive: true });
    const isolatedEnv = {
      ...process.env,
      HOME: decoyHome,
      ...isolatedEnvOverrides(isolatedPaths),
    };
    const negativeConfig = readResolvedOpencodeConfig(isolatedEnv, cwd) as { model?: string };
    assert.notEqual(negativeConfig.model, markerModel, "negative control: marker must NOT be observed once XDG_CONFIG_HOME/OPENCODE_CONFIG_DIR are isolated");

    // Confirm the isolated paths actually resolve into our temp tree, not the decoy or the real machine.
    const paths = readOpencodePaths(isolatedEnv, cwd);
    for (const key of ["config", "data", "cache", "state"]) {
      const value = paths[key];
      assert.ok(value, `debug paths should report a "${key}" path`);
      assert.ok(value!.startsWith(isolatedPaths.root), `"${key}" path (${value}) should live under the isolated root, not the decoy or a real machine location`);
      assert.ok(!value!.startsWith(decoyHome), `"${key}" path (${value}) must not be inside the decoy home`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
