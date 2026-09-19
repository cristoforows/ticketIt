import cp from "node:child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  createOpencodeClient,
  createOpencodeServer,
  type Config,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { createOpencodeClient as createOpencodeV2Client, type OpencodeClient as OpencodeV2Client } from "@opencode-ai/sdk/v2";
import { isolatedEnvOverrides, makeIsolatedPaths, resolveOpencodeBinDir, type IsolatedPaths } from "opencode-harness";

/**
 * `opencode-harness`'s `startManagedOpenCode` always calls `mkdtempSync`
 * itself and returns a brand-new, single-use isolated root -- there is no
 * way through its public API to point a second server at directories an
 * earlier `startManagedOpenCode` call already used. That is exactly what
 * scenario 4 (process death) needs: kill one server, then start a second
 * one against the *same* config/data/cache/state directories and project
 * git repo, to see what OpenCode itself persisted to disk and can recover.
 *
 * `startOpencodeAtRoot` is a local, parameterized re-implementation of the
 * relevant slice of `startManagedOpenCode` (env-override mutation, the
 * `cp.spawn` capture trick for a pid, port selection, building both SDK
 * client surfaces) that takes an existing `root`/`projectDir` instead of
 * creating its own. Per this slice's PR notes, accepting a pre-built
 * `IsolatedPaths`/root (skipping the internal `mkdtempSync` and git-init)
 * would be a reasonable enhancement to fold back into the harness itself
 * for whichever later slice next needs "reattach to existing storage"
 * (this one, or M5 stranded-runner recovery); it is intentionally *not*
 * added there now, per this issue's instruction not to modify any file
 * under `experiments/opencode-harness/`.
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

export interface DirectStubProviderOptions {
  providerId?: string;
  modelId?: string;
  baseUrl: string;
  apiKey?: string;
}

function buildConfig(stub: Required<DirectStubProviderOptions>, extra: Partial<Config> | undefined): Config {
  const base: Config = {
    $schema: "https://opencode.ai/config.json",
    username: "opencode-cancellation",
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

export interface StartOpencodeAtRootOptions {
  /** A directory previously created by this function or by the test (e.g. via `mkdtempSync`); reused as-is, never wiped. */
  root: string;
  /** An already-initialized git worktree directory under `root` (or elsewhere) that OpenCode should run against. */
  projectDir: string;
  stub: DirectStubProviderOptions;
  extraConfig?: Partial<Config>;
  serverTimeoutMs?: number;
}

export interface DirectOpencode {
  client: OpencodeClient;
  v2Client: OpencodeV2Client;
  serverUrl: string;
  isolatedPaths: IsolatedPaths;
  pid: number | undefined;
  close(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Start a headless OpenCode server against an existing isolated root
 * (recomputing the same directory layout `makeIsolatedPaths` would have
 * produced for it the first time -- these are pure path-string functions,
 * so calling them again with the same `root` reproduces identical paths
 * without touching anything already on disk) and an existing project git
 * worktree. See the module-level comment for why this exists instead of
 * `startManagedOpenCode`.
 */
export async function startOpencodeAtRoot(options: StartOpencodeAtRootOptions): Promise<DirectOpencode> {
  const providerId = options.stub.providerId ?? "stub";
  const modelId = options.stub.modelId ?? "stub-model";
  const apiKey = options.stub.apiKey ?? "stub-fixture-key";
  const stub: Required<DirectStubProviderOptions> = { providerId, modelId, apiKey, baseUrl: options.stub.baseUrl };

  const isolatedPaths = makeIsolatedPaths(options.root);
  mkdirSync(isolatedPaths.homeDir, { recursive: true });
  mkdirSync(isolatedPaths.tmpDir, { recursive: true });

  const config = buildConfig(stub, options.extraConfig);
  const binDir = resolveOpencodeBinDir();

  const envOverrides = isolatedEnvOverrides(isolatedPaths, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
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
  const client = createOpencodeClient({ baseUrl: server.url, directory: options.projectDir });
  const v2Client = createOpencodeV2Client({ baseUrl: server.url, directory: options.projectDir });

  async function close(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
    try {
      server.close();
    } catch {
      // Best-effort: if the process is already dead (e.g. this handle is
      // being closed after an earlier SIGKILL in the same test), close()
      // may itself fail to signal it; that is expected and not an error
      // for this helper's purpose.
    }
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    if (capturedChild && capturedChild.exitCode === null && capturedChild.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            capturedChild?.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, 5000);
        capturedChild!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (capturedChild) {
      exitCode = capturedChild.exitCode;
      signal = capturedChild.signalCode;
    }
    return { exitCode, signal };
  }

  return { client, v2Client, serverUrl: server.url, isolatedPaths, pid, close };
}
