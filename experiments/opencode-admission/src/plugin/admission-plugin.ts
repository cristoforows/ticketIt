/**
 * The OpenCode admission-bridge plugin for M1.9 (issue #20).
 *
 * IMPORTANT: this file is never imported or executed by this package's own
 * `node --test` process. It is loaded and executed by the pinned OpenCode
 * server itself (Bun runtime), referenced from `Config.plugin` as an
 * absolute `file://` URL (see `src/admitted-opencode.ts`,
 * `startAdmittedOpenCode`). Registration mechanism, verified against this
 * pinned build (`opencode-ai`/`@opencode-ai/sdk` 1.18.31):
 *
 * - `Config.plugin` is `Array<string>` in the bare `@opencode-ai/sdk`
 *   generated types (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`,
 *   line ~1067: `plugin?: Array<string>;`) and `Array<string | [string,
 *   PluginOptions]>` in `@opencode-ai/plugin`'s own `Config` type
 *   (`node_modules/@opencode-ai/plugin/dist/index.d.ts`). This bridge uses
 *   the plain-string form (a `file://` URL to this file), so no cast past
 *   the harness's own `Partial<Config>` type is needed.
 * - The exact accepted string forms for one `plugin` entry, and the
 *   plugin-module shape, are documented in this pinned executable's own
 *   embedded "customize-opencode" builtin skill text (extracted with
 *   `strings -a node_modules/opencode-ai/bin/opencode.exe`, searching for
 *   "## Plugins" — this is baked into the compiled CLI binary itself, not
 *   read from the website):
 *
 *     "plugin:" is an array. Each entry is one of:
 *     ```json
 *     "plugin": [
 *       "opencode-gemini-auth",            // npm spec, latest
 *       "opencode-foo@1.2.3",              // npm spec, pinned
 *       "./local-plugin.ts",               // file path, relative to the declaring config
 *       "file:///abs/path/plugin.js",      // file URL
 *       ["opencode-bar", { "key": "val" }] // tuple form with options
 *     ```
 *     Auto-discovered plugins (no config entry needed): any `*.ts` or `*.js`
 *     file in `.opencode/plugin/` or `.opencode/plugins/`.
 *     A plugin module exports `default` (or any named export) of type
 *     `Plugin = (input: PluginInput, options?) => Promise<Hooks>`.
 *
 *   This bridge uses the explicit `file:///abs/path/...` form (not
 *   auto-discovery), because `startManagedOpenCode`'s `extraConfig` is the
 *   only hook this package has into the harness's generated config, and the
 *   auto-discovery directories live inside a temporary project directory
 *   the harness creates internally, after the point this package could
 *   place a file there.
 * - Also confirmed the same way (same embedded skill text, "Hook surface"):
 *   `tool.execute.before`/`tool.execute.after` receive `(input, output)` and
 *   "mutate `output` in place; return `void`". Denial is not a declared
 *   return value or thrown-error *type* in this bundled text; the public
 *   docs page (https://opencode.ai/docs/plugins/, fetched 2026-09-19,
 *   unverified against this pinned build until the fixture evidence below)
 *   shows the block-a-tool-call idiom as simply throwing inside the hook:
 *   `if (...) { throw new Error("Do not read .env files") }`. This bridge's
 *   own fixture tests (see ../../test/) are what actually confirm, for
 *   THIS pinned build, that throwing here really does stop dispatch and
 *   what the model/session sees as a result — see
 *   docs/evidence/m1/20-opencode-admission.md, "Fixture/stub evidence".
 * - `Hooks["tool.execute.before"]` and `["tool.execute.after"]` both carry
 *   `callID` (`node_modules/@opencode-ai/plugin/dist/index.d.ts`), which is
 *   what this bridge uses to correlate an admitted dispatch with its later
 *   completion, including across two callIDs dispatched concurrently
 *   (the "parallel requests" scenario).
 *
 * Process-boundary note (why this file reads `process.env` instead of
 * importing the ledger, `shared`, or `opencode-harness` directly): this
 * file runs INSIDE the spawned OpenCode process, a separate OS process
 * from the `node --test` process that hosts the `AdmissionLedger` and its
 * `FakeClock`. It reaches the ledger over the loopback HTTP facade
 * (`shared`'s `startLedgerServer`, per issue #20's instruction to use it
 * "so a plugin in another process can reach the ledger"), never by
 * importing the ledger package into this process. Configuration
 * (ledger URL, agent/account/ticket/round identifiers, the tool name to
 * gate, and the bounded hold-poll parameters) crosses the same process
 * boundary the only way `startManagedOpenCode`'s public API allows
 * (`src/admitted-opencode.ts` sets these as environment variables on
 * *this* Node process immediately before calling `startManagedOpenCode`,
 * the same technique `opencode-harness`'s own isolation env already uses
 * for `HOME`/`XDG_*`, relying on `createOpencodeServer` spawning with
 * `{...process.env}` — see `docs/evidence/m1/16-opencode-boot.md`,
 * "Observed limitations").
 *
 * Extended for M1.10 (issue #21), the action-path coverage matrix, with two
 * additive capabilities, both OFF by default so every #20 test above is
 * unaffected:
 *
 * 1. **Gate-all-tools mode** (`TICKETIT_GATE_ALL_TOOLS=1`): instead of only
 *    gating `input.tool === action` (one configured tool id, default
 *    "bash"), `tool.execute.before` gates EVERY tool call, using the
 *    invoked tool's own id as the ledger `action` (keeping `resource`
 *    fixed at the configured value). This is what makes a single
 *    `AdmissionLedger` — with zero grants, i.e. "deny everything" — usable
 *    to sweep every built-in/custom/MCP tool id in one process: each tool
 *    id becomes its own distinct `(action, resource)` scope, so
 *    `ledger.decisions()` shows exactly which tool ids the hook actually
 *    fired for, correlated by `action`.
 * 2. **An optional plugin-registered custom tool**
 *    (`TICKETIT_CUSTOM_TOOL_NAME`/`TICKETIT_CUSTOM_TOOL_MARKER_FILE`): when
 *    both env vars are set, this plugin ALSO returns a `tool` hook
 *    (`Hooks["tool"]`, `{[name]: ToolDefinition}` — confirmed in
 *    `node_modules/@opencode-ai/plugin/dist/index.d.ts`) registering one
 *    tool via `@opencode-ai/plugin`'s own `tool()` helper
 *    (`node_modules/@opencode-ai/plugin/dist/tool.d.ts`). Its `execute`
 *    appends a line to the given marker file — the side-effect proof for
 *    issue #21's "a custom plugin-registered tool" coverage row. Whether
 *    `tool.execute.before` also gates a plugin-registered tool (as opposed
 *    to only OpenCode's own built-ins) is exactly the open question this
 *    row exists to answer; see `docs/evidence/m1/21-opencode-coverage-matrix.md`.
 */
import { tool, type Plugin } from "@opencode-ai/plugin";

const DEFAULT_ACTION = "bash";
const DEFAULT_RESOURCE = "shell";
// Bounded hold-poll window: ~30 attempts * 150ms = ~4.5s. This is this
// bridge's own implementation choice for how long `tool.execute.before`
// will hold (wait) on a "hold" decision before treating it as effective
// non-admission; it is NOT a resolution of D8 ("reasonable technical
// loop/time limits"), which this experiment explicitly routes onward
// rather than silently deciding. See docs/evidence/m1/20-opencode-admission.md.
const DEFAULT_HOLD_POLL_MS = 150;
const DEFAULT_HOLD_MAX_ATTEMPTS = 30;

interface AdmitResult {
  admissionId: string;
  decision: "allow" | "deny" | "hold";
  reason: string;
  grantId?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`ticketit-admission-plugin: missing required env var ${name}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const admissionPlugin: Plugin = async () => {
  const ledgerUrl = requiredEnv("TICKETIT_LEDGER_URL");
  const agentId = requiredEnv("TICKETIT_AGENT_ID");
  const account = requiredEnv("TICKETIT_ACCOUNT");
  const ticketId = requiredEnv("TICKETIT_TICKET_ID");
  const roundId = requiredEnv("TICKETIT_ROUND_ID");
  const action = process.env.TICKETIT_ACTION ?? DEFAULT_ACTION;
  const resource = process.env.TICKETIT_RESOURCE ?? DEFAULT_RESOURCE;
  const holdPollMs = Number(process.env.TICKETIT_HOLD_POLL_MS ?? DEFAULT_HOLD_POLL_MS);
  const holdMaxAttempts = Number(process.env.TICKETIT_HOLD_MAX_ATTEMPTS ?? DEFAULT_HOLD_MAX_ATTEMPTS);
  // #21 additions, both off unless explicitly configured (see module comment above).
  const gateAllTools = process.env.TICKETIT_GATE_ALL_TOOLS === "1";
  const customToolName = process.env.TICKETIT_CUSTOM_TOOL_NAME;
  const customToolMarkerFile = process.env.TICKETIT_CUSTOM_TOOL_MARKER_FILE;

  // callID -> admissionId, for admitted-but-not-yet-completed dispatches.
  // Module-scope (per plugin instance, i.e. per OpenCode process), so two
  // concurrently in-flight tool calls (the "parallel requests" scenario)
  // never collide: each has its own callID.
  const dispatchedByCallId = new Map<string, string>();

  async function admitOnce(gatedAction: string): Promise<AdmitResult> {
    const res = await fetch(`${ledgerUrl}/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roundId, ticketId, agentId, account, action: gatedAction, resource }),
    });
    return (await res.json()) as AdmitResult;
  }

  const hooks: Awaited<ReturnType<Plugin>> = {
    "tool.execute.before": async (input, _output) => {
      // Gate-all-tools mode (#21): every tool id becomes its own ledger
      // action; single-action mode (#20, unchanged): only the configured
      // tool id is gated at all, matching every existing #20 test exactly.
      if (!gateAllTools && input.tool !== action) return;
      const gatedAction = gateAllTools ? input.tool : action;

      let result = await admitOnce(gatedAction);
      let attempts = 0;
      // "hold" means the ledger is disconnected but would otherwise allow
      // this scope (see AdmissionLedger#admit's precedence rules). This is
      // this bridge's HOLD capability: it re-polls the ledger, bounded,
      // rather than immediately denying — see docs/evidence/m1/
      // 20-opencode-admission.md, "whether the hook can hold or only deny".
      while (result.decision === "hold" && attempts < holdMaxAttempts) {
        await sleep(holdPollMs);
        result = await admitOnce(gatedAction);
        attempts += 1;
      }

      if (result.decision !== "allow") {
        // Denial mechanism for this pinned build: throwing inside
        // tool.execute.before. See the module comment above and the
        // fixture evidence in docs/evidence/m1/20-opencode-admission.md
        // for exactly what this produces for the model/session.
        throw new Error(
          `ticketit-admission: tool "${input.tool}" not admitted (callID=${input.callID}): ` +
            `decision=${result.decision} reason=${result.reason} admissionId=${result.admissionId} ` +
            `attempts=${attempts}`,
        );
      }

      await fetch(`${ledgerUrl}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ admissionId: result.admissionId }),
      });
      dispatchedByCallId.set(input.callID, result.admissionId);
    },
    "tool.execute.after": async (input, _output) => {
      const admissionId = dispatchedByCallId.get(input.callID);
      if (!admissionId) return; // not a dispatch this bridge admitted (e.g. a different tool).
      dispatchedByCallId.delete(input.callID);
      // Deliberately unconditional: an already-dispatched action completing
      // must be recordable regardless of the ledger's current connectivity
      // (AdmissionLedger#complete does not check `connected`), matching
      // "already-dispatched work may finish" (integration-feasibility.md, S2).
      await fetch(`${ledgerUrl}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ admissionId }),
      });
    },
  };

  // #21 addition: optionally register one custom plugin tool, so this
  // package can test whether tool.execute.before (gated above, same hook,
  // same code path as every built-in tool) also covers a plugin-registered
  // tool, not just OpenCode's own built-ins. Off unless both env vars are
  // set, so every #20 test (which sets neither) gets an identical Hooks
  // object to before this change.
  if (customToolName && customToolMarkerFile) {
    hooks.tool = {
      [customToolName]: tool({
        description: "ticketit coverage-matrix fixture: appends a line to a marker file when actually executed.",
        args: { line: tool.schema.string().default("executed") },
        execute: async (args) => {
          const fs = await import("node:fs/promises");
          await fs.appendFile(customToolMarkerFile, `${args.line}\n`, "utf8");
          return { output: `appended "${args.line}" to marker file` };
        },
      }),
    };
  }

  return hooks;
};

export default admissionPlugin;
