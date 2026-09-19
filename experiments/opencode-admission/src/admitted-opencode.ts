import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  startManagedOpenCode,
  type ManagedOpenCode,
  type ManagedOpenCodeCloseResult,
  type StubProviderOptions,
} from "opencode-harness";
import { AdmissionLedger, FakeClock, startLedgerServer, type LedgerServerHandle } from "shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute `file://` URL to the plugin module, for `Config.plugin`. */
export const ADMISSION_PLUGIN_URL: string = pathToFileURL(
  path.join(__dirname, "plugin", "admission-plugin.ts"),
).href;

/**
 * Environment variable names the plugin (`src/plugin/admission-plugin.ts`)
 * reads inside the spawned OpenCode process. Exported so tests and this
 * module use one shared source of truth instead of duplicated string
 * literals on both sides of the process boundary.
 */
export const ADMISSION_ENV = {
  ledgerUrl: "TICKETIT_LEDGER_URL",
  agentId: "TICKETIT_AGENT_ID",
  account: "TICKETIT_ACCOUNT",
  ticketId: "TICKETIT_TICKET_ID",
  roundId: "TICKETIT_ROUND_ID",
  action: "TICKETIT_ACTION",
  resource: "TICKETIT_RESOURCE",
  holdPollMs: "TICKETIT_HOLD_POLL_MS",
  holdMaxAttempts: "TICKETIT_HOLD_MAX_ATTEMPTS",
} as const;

export interface StartAdmittedOpenCodeOptions {
  /** The stub model provider, same shape `startManagedOpenCode` accepts. */
  stub: StubProviderOptions;
  /** Additional OpenCode config merged in (e.g. `{ permission: { bash: "ask" } }`). */
  extraConfig?: Record<string, unknown>;
  /** Fixture identifiers. Every field has a stable default so tests only override what they're exercising. */
  agentId?: string;
  account?: string;
  ticketId?: string;
  /**
   * Round ID to configure the plugin with. Defaults to a fresh `randomUUID()`
   * generated *before* the OpenCode session exists — mirroring production
   * order, where Galley creates the Round (and its ID) at claim time,
   * before Michelin ever starts OpenCode (docs/contracts/execution-interface.md,
   * "Work claim"). `opencode-harness`'s own `createRoundMapping` cannot be
   * reused here because it always mints its own `randomUUID()` bound to an
   * already-created engine execution reference (see
   * `experiments/opencode-harness/src/round-mapping.ts`); it has no
   * parameter for a caller-supplied Round ID created earlier. This
   * package does not modify that file (per issue #20's instructions); see
   * `attachRoundMapping` below for the equivalent identity-mapping record
   * this package needs, implemented locally, noted in the PR as a
   * candidate to move upstream into opencode-harness later.
   */
  roundId?: string;
  /** Tool id to gate. Defaults to "bash" (OpenCode's built-in shell tool, per issue #20's scope). */
  action?: string;
  /** Opaque resource scope string for the admission ledger. Defaults to "shell". */
  resource?: string;
  /** Poll interval while a "hold" decision is being retried. Default 150ms. */
  holdPollIntervalMs?: number;
  /** Max poll attempts before a persistent "hold" is treated as non-admission. Default 30 (~4.5s at the default interval). */
  holdMaxAttempts?: number;
  /** Supply a pre-existing FakeClock (e.g. to share one across assertions). Defaults to a fresh `FakeClock(0)`. */
  clock?: FakeClock;
}

export interface AdmittedOpenCode {
  ledger: AdmissionLedger;
  clock: FakeClock;
  ledgerServer: LedgerServerHandle;
  managed: ManagedOpenCode;
  agentId: string;
  account: string;
  ticketId: string;
  roundId: string;
  action: string;
  resource: string;
  close(): Promise<{ managed: ManagedOpenCodeCloseResult }>;
}

/**
 * Start an `AdmissionLedger` (backed by a `FakeClock`), expose it over
 * `shared`'s loopback HTTP facade (`startLedgerServer`), and start a managed
 * OpenCode server configured to load the admission-bridge plugin
 * (`src/plugin/admission-plugin.ts`) via an absolute `file://` URL in
 * `Config.plugin`. This is the composition root for every scenario test in
 * this package; it never modifies `experiments/opencode-harness` or
 * `experiments/shared` — it only calls their exported public APIs.
 */
export async function startAdmittedOpenCode(options: StartAdmittedOpenCodeOptions): Promise<AdmittedOpenCode> {
  const clock = options.clock ?? new FakeClock(0);
  const ledger = new AdmissionLedger(clock);
  const ledgerServer = await startLedgerServer(ledger, 0);

  const agentId = options.agentId ?? "agent-opencode-admission";
  const account = options.account ?? "agent-opencode-admission@stub";
  const ticketId = options.ticketId ?? "ticket-opencode-admission";
  const roundId = options.roundId ?? randomUUID();
  const action = options.action ?? "bash";
  const resource = options.resource ?? "shell";

  const envVars: Record<string, string> = {
    [ADMISSION_ENV.ledgerUrl]: `http://127.0.0.1:${ledgerServer.port}`,
    [ADMISSION_ENV.agentId]: agentId,
    [ADMISSION_ENV.account]: account,
    [ADMISSION_ENV.ticketId]: ticketId,
    [ADMISSION_ENV.roundId]: roundId,
    [ADMISSION_ENV.action]: action,
    [ADMISSION_ENV.resource]: resource,
  };
  if (options.holdPollIntervalMs !== undefined) {
    envVars[ADMISSION_ENV.holdPollMs] = String(options.holdPollIntervalMs);
  }
  if (options.holdMaxAttempts !== undefined) {
    envVars[ADMISSION_ENV.holdMaxAttempts] = String(options.holdMaxAttempts);
  }

  // `startManagedOpenCode` (opencode-harness) spawns the OpenCode process
  // with `{...process.env}` captured at call time (it has no `env` option
  // of its own — see docs/evidence/m1/16-opencode-boot.md, "Observed
  // limitations"). Setting these on *this* process's env immediately
  // before the call, and restoring them immediately after, is the same
  // technique the harness itself already uses for HOME/XDG_*/PATH.
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(envVars)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  let managed: ManagedOpenCode;
  try {
    managed = await startManagedOpenCode({
      stub: options.stub,
      extraConfig: {
        plugin: [ADMISSION_PLUGIN_URL],
        ...options.extraConfig,
      },
    });
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  async function close(): Promise<{ managed: ManagedOpenCodeCloseResult }> {
    const managedClose = await managed.close();
    await ledgerServer.close();
    return { managed: managedClose };
  }

  return { ledger, clock, ledgerServer, managed, agentId, account, ticketId, roundId, action, resource, close };
}

/**
 * The Round-ID/engine-execution-reference identity mapping (ADR 0002,
 * docs/contracts/execution-interface.md "Identity model"), for a Round ID
 * that was minted *before* the OpenCode session existed (see `roundId`'s
 * doc comment on `StartAdmittedOpenCodeOptions` above for why
 * `opencode-harness`'s `createRoundMapping` cannot be reused for this
 * package's scenarios). Implemented locally rather than editing
 * `opencode-harness/src/round-mapping.ts`; a natural follow-up would be to
 * generalize that function to accept an optional pre-existing Round ID and
 * have this package depend on it instead.
 */
export interface RoundMapping {
  roundId: string;
  engineExecutionReference: string;
}

export function attachRoundMapping(roundId: string, engineExecutionReference: string): RoundMapping {
  if (!roundId) throw new Error("attachRoundMapping requires a non-empty roundId");
  if (!engineExecutionReference) {
    throw new Error("attachRoundMapping requires a non-empty engine execution reference (e.g. an OpenCode session id)");
  }
  return { roundId, engineExecutionReference };
}
