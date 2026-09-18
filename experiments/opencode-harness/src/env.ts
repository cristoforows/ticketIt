import path from "node:path";

/**
 * The set of directories a single managed OpenCode instance is isolated
 * into. Every directory lives under one temporary `root`, so removing
 * `root` removes the entire isolated tree.
 */
export interface IsolatedPaths {
  root: string;
  /** Redirected `HOME` (and `OPENCODE_TEST_HOME`). */
  homeDir: string;
  /** Redirected `XDG_CONFIG_HOME`. */
  configHome: string;
  /** Redirected `XDG_DATA_HOME`. */
  dataHome: string;
  /** Redirected `XDG_CACHE_HOME`. */
  cacheHome: string;
  /** Redirected `XDG_STATE_HOME`. */
  stateHome: string;
  /** Redirected `TMPDIR` (Node's `os.tmpdir()` is not XDG-controlled). */
  tmpDir: string;
  /**
   * Redirected `OPENCODE_CONFIG_DIR`. Belt-and-suspenders alongside
   * `XDG_CONFIG_HOME`: the pinned build resolves the global config
   * directory as `OPENCODE_CONFIG_DIR ?? $XDG_CONFIG_HOME/opencode`
   * (see `docs/evidence/m1/16-opencode-boot.md`, "Documentation
   * research" / "Fixture evidence" for how this was determined).
   */
  opencodeConfigDir: string;
}

export function makeIsolatedPaths(root: string): IsolatedPaths {
  const homeDir = path.join(root, "home");
  const configHome = path.join(homeDir, ".config");
  return {
    root,
    homeDir,
    configHome,
    dataHome: path.join(homeDir, ".local", "share"),
    cacheHome: path.join(homeDir, ".cache"),
    stateHome: path.join(homeDir, ".local", "state"),
    tmpDir: path.join(root, "tmp"),
    opencodeConfigDir: path.join(configHome, "opencode"),
  };
}

/**
 * Build the explicit environment-variable overrides needed to isolate an
 * OpenCode process into `paths` instead of the real developer machine's
 * config/data/cache/state. `extra` is merged in last (e.g. `PATH`,
 * `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_CONFIG_CONTENT`).
 */
export function isolatedEnvOverrides(
  paths: IsolatedPaths,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    HOME: paths.homeDir,
    // OPENCODE_TEST_HOME is a dedicated override the pinned binary reads
    // (`process.env.OPENCODE_TEST_HOME ?? os.homedir()`), found by
    // reading the compiled CLI's strings; see the evidence file.
    OPENCODE_TEST_HOME: paths.homeDir,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_DATA_HOME: paths.dataHome,
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_STATE_HOME: paths.stateHome,
    OPENCODE_CONFIG_DIR: paths.opencodeConfigDir,
    TMPDIR: paths.tmpDir,
    ...extra,
  };
}
