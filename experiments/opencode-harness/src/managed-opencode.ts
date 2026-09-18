import cp from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOpencodeClient,
  createOpencodeServer,
  type Config,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { isolatedEnvOverrides, makeIsolatedPaths, type IsolatedPaths } from "./env.js";
import { resolveOpencodeBinDir } from "./locate.js";

/**
 * Find a free TCP port on 127.0.0.1 by briefly binding to port 0 and
 * reading back what the OS assigned.
 *
 * Not just a nicety: the pinned CLI's own `--port=0` ("pick an ephemeral
 * port") was observed to be unreliable when spawned through the SDK's
 * `createOpencodeServer` helper — most runs got a real ephemeral port,
 * but some runs (and every run through `node_modules/.bin/opencode`'s
 * symlink, and every direct invocation with the literal flag
 * `--port=0`, tested outside a temp/isolated HOME) deterministically
 * came back on port 4096 instead. An explicit, specific, non-zero
 * `--port=<N>` was honored correctly in every trial. See
 * docs/evidence/m1/16-opencode-boot.md, "Observed limitations".
 */
async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not determine a free port"));
      });
    });
  });
}

export interface StubProviderOptions {
  /** Provider id registered in OpenCode's config. Default "stub". */
  providerId?: string;
  /** Model id registered under that provider. Default "stub-model". */
  modelId?: string;
  /** The stub's OpenAI-compatible base URL, e.g. `${stubModelServer.url}/v1`. */
  baseUrl: string;
  /** Synthetic fixture API key, never a real credential. Default "stub-fixture-key". */
  apiKey?: string;
}

export interface StartManagedOpenCodeOptions {
  stub: StubProviderOptions;
  /** Milliseconds to wait for "opencode server listening" before failing. Default 15000. */
  serverTimeoutMs?: number;
  /**
   * Whether to set `OPENCODE_DISABLE_MODELS_FETCH=true` so startup does not
   * depend on network access to the public models.dev catalog. Default
   * true (deterministic). Set to false to observe that fetch instead; see
   * docs/evidence/m1/16-opencode-boot.md for what was independently
   * observed with it enabled.
   */
  disableModelsFetch?: boolean;
  /** Additional config merged on top of the generated stub-provider config. */
  extraConfig?: Partial<Config>;
}

export interface ManagedOpenCodeSessionHelpers {
  create(title?: string): Promise<{ id: string; [key: string]: unknown }>;
  promptText(sessionId: string, text: string): Promise<unknown>;
  messages(sessionId: string): Promise<unknown[]>;
}

export interface ManagedOpenCodeCloseResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Non-null if the spawned process (or its pid) was still observable after close(). */
  orphanCheckError: string | null;
}

export interface ManagedOpenCode {
  /** The full generated OpenCode SDK client. */
  client: OpencodeClient;
  /** Convenience helpers layered on `client.session`. */
  session: ManagedOpenCodeSessionHelpers;
  serverUrl: string;
  /** The temporary git worktree directory OpenCode was started in. */
  projectDir: string;
  /** The isolated HOME directory (see `isolatedPaths` for the full set). */
  homeDir: string;
  isolatedPaths: IsolatedPaths;
  pid: number | undefined;
  providerId: string;
  modelId: string;
  close(): Promise<ManagedOpenCodeCloseResult>;
}

function buildConfig(
  stub: Required<StubProviderOptions>,
  extra: Partial<Config> | undefined,
): Config {
  const base: Config = {
    $schema: "https://opencode.ai/config.json",
    username: "opencode-harness",
    enabled_providers: [stub.providerId],
    provider: {
      [stub.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Stub",
        options: {
          baseURL: stub.baseUrl,
          apiKey: stub.apiKey,
        },
        models: {
          [stub.modelId]: { name: "Stub Model" },
        },
      },
    },
    model: `${stub.providerId}/${stub.modelId}`,
  };
  return { ...base, ...extra };
}

function initTempGitProject(root: string): string {
  const projectDir = path.join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: projectDir, stdio: "pipe" });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "opencode-harness@example.invalid"]);
  run(["config", "user.name", "opencode-harness"]);
  writeFileSync(path.join(projectDir, "README.md"), "OpenCode harness temporary project.\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "opencode-harness: initial commit"]);
  return projectDir;
}

/**
 * Start a headless OpenCode server through the SDK's `createOpencodeServer`
 * helper (spawning the pinned local `opencode` binary), inside a fresh
 * temporary git worktree, with global config/data/cache/state redirected
 * to temporary directories and a custom OpenAI-compatible provider
 * pointing at the given stub.
 *
 * Two pinned-SDK gaps this works around (see
 * docs/evidence/m1/16-opencode-boot.md, "Observed limitations"):
 *  - `ServerOptions` has no way to pass a custom `env` to the spawned
 *    process, so the isolation env vars are set on this process's own
 *    `process.env` immediately before the call and restored immediately
 *    after (the helper always spawns with `env: {...process.env, ...}`).
 *  - The helper's return value exposes no pid/ChildProcess, so
 *    `node:child_process.spawn` is patched for the duration of the call
 *    to capture the process it creates.
 */
export async function startManagedOpenCode(options: StartManagedOpenCodeOptions): Promise<ManagedOpenCode> {
  const providerId = options.stub.providerId ?? "stub";
  const modelId = options.stub.modelId ?? "stub-model";
  const apiKey = options.stub.apiKey ?? "stub-fixture-key";
  const stub: Required<StubProviderOptions> = {
    providerId,
    modelId,
    apiKey,
    baseUrl: options.stub.baseUrl,
  };

  const root = mkdtempSync(path.join(tmpdir(), "opencode-harness-"));
  const projectDir = initTempGitProject(root);
  const isolatedPaths = makeIsolatedPaths(root);
  mkdirSync(isolatedPaths.homeDir, { recursive: true });
  mkdirSync(isolatedPaths.tmpDir, { recursive: true });

  const config = buildConfig(stub, options.extraConfig);
  const binDir = resolveOpencodeBinDir();

  const envOverrides = isolatedEnvOverrides(isolatedPaths, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    OPENCODE_DISABLE_MODELS_FETCH: options.disableModelsFetch === false ? "false" : "true",
  });

  const previousEnv = new Map<string, string | undefined>();
  for (const key of Object.keys(envOverrides)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = envOverrides[key];
  }

  let capturedChild: cp.ChildProcess | undefined;
  const originalSpawn = cp.spawn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cp as any).spawn = (...args: unknown[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const child = (originalSpawn as any)(...args);
    capturedChild = child;
    return child;
  };

  const port = await findFreePort();

  let server: { url: string; close(): void };
  try {
    server = await createOpencodeServer({
      hostname: "127.0.0.1",
      port,
      timeout: options.serverTimeoutMs ?? 15000,
      config,
    });
  } finally {
    cp.spawn = originalSpawn;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const pid = capturedChild?.pid;
  const client = createOpencodeClient({ baseUrl: server.url, directory: projectDir });

  const session: ManagedOpenCodeSessionHelpers = {
    async create(title) {
      const result = await client.session.create({ body: title ? { title } : {} });
      if (result.error) throw new Error(`session.create failed: ${JSON.stringify(result.error)}`);
      return result.data as { id: string; [key: string]: unknown };
    },
    async promptText(sessionId, text) {
      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: providerId, modelID: modelId },
          parts: [{ type: "text", text }],
        },
      });
      if (result.error) throw new Error(`session.prompt failed: ${JSON.stringify(result.error)}`);
      return result.data;
    },
    async messages(sessionId) {
      const result = await client.session.messages({ path: { id: sessionId } });
      if (result.error) throw new Error(`session.messages failed: ${JSON.stringify(result.error)}`);
      return (result.data ?? []) as unknown[];
    },
  };

  async function close(): Promise<ManagedOpenCodeCloseResult> {
    server.close();

    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    if (capturedChild) {
      if (capturedChild.exitCode === null && capturedChild.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            capturedChild?.kill("SIGKILL");
          }, 5000);
          capturedChild!.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      exitCode = capturedChild.exitCode;
      signal = capturedChild.signalCode;
    }

    let orphanCheckError: string | null = null;
    if (pid !== undefined) {
      try {
        process.kill(pid, 0);
        orphanCheckError = `process ${pid} still exists after close()`;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          orphanCheckError = `unexpected error checking pid ${pid}: ${String(err)}`;
        }
      }
    } else {
      orphanCheckError = "no pid was captured for the spawned OpenCode process; cannot verify no orphan remains";
    }

    return { exitCode, signal, orphanCheckError };
  }

  return {
    client,
    session,
    serverUrl: server.url,
    projectDir,
    homeDir: isolatedPaths.homeDir,
    isolatedPaths,
    pid,
    providerId,
    modelId,
    close,
  };
}
