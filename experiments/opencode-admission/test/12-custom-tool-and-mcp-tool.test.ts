import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scriptTextTurn, StubModelServer } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_SCRIPT = path.join(__dirname, "fixtures", "local-mcp-server.mjs");

/**
 * Issue #21, priority row 5, part 1: "a custom plugin-registered tool."
 *
 * `startAdmittedOpenCode({ customTool: { name, markerFile } })` (the #21
 * extension in `src/plugin/admission-plugin.ts`) has the SAME admission
 * plugin ALSO return a `tool` hook (`Hooks["tool"]`,
 * `node_modules/@opencode-ai/plugin/dist/index.d.ts`) registering one tool
 * via `@opencode-ai/plugin`'s own `tool()` helper. This tool appends a
 * line to a marker file when its `execute` actually runs. Since it is
 * dispatched through the exact same `tool.execute.before`/`.after` hook
 * surface as every built-in tool (confirmed by this pinned build's own
 * embedded plugin documentation, quoted in
 * `src/plugin/admission-plugin.ts`'s module comment: the hook fires for
 * ANY tool execution, not just built-ins), gating it needs no new
 * mechanism -- this test proves that empirically, both denied (zero
 * grants) and admitted (a matching grant).
 */
test("custom plugin-registered tool: dispatches through the same hook, gated (denied, then allowed)", async () => {
  const scratchRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-custom-tool-"));
  const customToolMarkerFile = path.join(scratchRoot, "custom-tool-marker.log");
  const customToolName = "ticketit_custom_probe_tool";

  const stub = new StubModelServer({
    turns: [
      { content: "", toolCalls: [{ id: "call_custom_1", name: customToolName, arguments: JSON.stringify({ line: "custom-should-not-run" }) }] },
      scriptTextTurn("after denied custom tool"),
      { content: "", toolCalls: [{ id: "call_custom_2", name: customToolName, arguments: JSON.stringify({ line: "custom-executed" }) }] },
      scriptTextTurn("after allowed custom tool"),
    ],
  });
  await stub.start();

  const admitted = await startAdmittedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    gateAllTools: true,
    customTool: { name: customToolName, markerFile: customToolMarkerFile },
  });
  try {
    const idsResult = await admitted.managed.client.tool.ids();
    const ids = (idsResult as { data?: string[] }).data ?? [];
    assert.ok(ids.includes(customToolName), `expected the custom plugin tool "${customToolName}" to be registered; ids: ${JSON.stringify(ids)}`);

    // --- Phase 1: zero grants -- denied, no side effect. ---
    const session = await admitted.managed.session.create("m1-21 custom tool");
    await admitted.managed.session.promptText(session.id, "call the custom tool");

    assert.ok(!existsSync(customToolMarkerFile), "the custom plugin tool must NOT have executed while denied");
    let decisions = admitted.ledger.decisions();
    const customDenied = decisions.find((d) => d.request.action === customToolName);
    assert.ok(customDenied, `expected an admit() call for the custom tool ("${customToolName}"); recorded actions: ${JSON.stringify(decisions.map((d) => d.request.action))}`);
    assert.notEqual(customDenied!.decision, "allow");
    assert.equal(customDenied!.reason, "no-grant");

    // --- Phase 2: grant the scope -- now executes. ---
    admitted.ledger.grant({
      agentId: admitted.agentId,
      account: admitted.account,
      action: customToolName,
      resource: admitted.resource,
      kind: { kind: "ticket", ticketId: admitted.ticketId },
    });
    await admitted.managed.session.promptText(session.id, "call the custom tool again, now with a grant");

    assert.equal(readFileSync(customToolMarkerFile, "utf8"), "custom-executed\n", "the custom plugin tool must have executed exactly once, once admitted");
    decisions = admitted.ledger.decisions();
    const customAllowed = decisions.filter((d) => d.request.action === customToolName).at(-1)!;
    assert.equal(customAllowed.decision, "allow");
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

/**
 * Issue #21, priority row 5, part 2: "a local stdio MCP tool served by a
 * small stdio MCP server."
 *
 * `test/fixtures/local-mcp-server.mjs` is a minimal, dependency-free
 * Model Context Protocol stdio server (newline-delimited JSON-RPC 2.0,
 * https://modelcontextprotocol.io/specification) registering one tool,
 * `mcp_marker_tool`. Wired in via `extraConfig: { mcp: { <name>: { type:
 * "local", command: [...], environment: {...} } } }` -- the
 * `McpLocalConfig` shape declared in
 * `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`.
 *
 * **This is a documented negative result, not a passing gate proof.**
 * During development this fixture was verified correct in isolation
 * (piping the exact JSON-RPC handshake by hand into
 * `local-mcp-server.mjs` directly: `initialize` -> `notifications/
 * initialized` -> `tools/list` -> `tools/call` all worked and the marker
 * file was written). Wired into a real managed OpenCode instance,
 * `client.mcp.status()` reports this server `"connected"`, and this
 * fixture's own `MCP_DEBUG_LOG_FILE` wire log (asserted below) shows
 * OpenCode's client sending `initialize` (requesting protocolVersion
 * "2025-11-05"/"2025-11-25" depending on run) and `tools/list`, and this
 * fixture correctly answering both -- including echoing back whatever
 * protocol version the client requested, after an earlier attempt with a
 * hardcoded "2024-11-05" response produced the exact same silent
 * non-registration described below, ruling out a version-mismatch
 * explanation. Despite a "connected" status and a correct `tools/list`
 * exchange, on this pinned build the tool NEVER becomes dispatchable:
 * `client.tool.ids()`/`client.tool.list()` never list it, and a scripted
 * tool call using its own declared name (`mcp_marker_tool`, unprefixed)
 * is classified by the engine as `"invalid"` (OpenCode's own placeholder
 * tool id for "the model called something unregistered" -- see
 * `test/11-built-in-tools-sweep.test.ts`'s module comment) rather than
 * ever reaching `tool.execute.before` under the MCP tool's own name.
 *
 * This is recorded as an OBSERVED INTEGRATION LIMITATION of this pinned
 * build's local-stdio-MCP wiring (or of some undiscovered additional
 * protocol requirement beyond `initialize`/`tools/list`), not a finding
 * about this bridge's admission hook one way or the other -- a tool that
 * never becomes dispatchable at all cannot be used to test whether
 * admission covers it. See docs/evidence/m1/21-opencode-coverage-matrix.md
 * for the full discussion and the matrix's own "not evaluated" row for
 * this path, and `docs/open-decisions.md` D1 for why this is routed
 * onward rather than silently assumed either safe or unsafe.
 */
test("local stdio MCP tool: connects and answers tools/list, but never becomes dispatchable on this pinned build (observed limitation)", async () => {
  const scratchRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-mcp-tool-"));
  const mcpMarkerFile = path.join(scratchRoot, "mcp-tool-marker.log");
  const mcpDebugLogFile = path.join(scratchRoot, "mcp-debug.log");
  const mcpServerName = "ticketit-coverage-matrix-fixture";

  const stub = new StubModelServer({
    turns: [{ content: "", toolCalls: [{ id: "call_mcp_1", name: "mcp_marker_tool", arguments: JSON.stringify({ line: "mcp-should-not-run" }) }] }, scriptTextTurn("after mcp tool attempt")],
  });
  await stub.start();

  const admitted = await startAdmittedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
    gateAllTools: true,
    extraConfig: {
      mcp: {
        [mcpServerName]: {
          type: "local",
          command: ["node", MCP_SERVER_SCRIPT],
          environment: { MCP_MARKER_FILE: mcpMarkerFile, MCP_DEBUG_LOG_FILE: mcpDebugLogFile },
        },
      },
    },
  });
  try {
    // Confirm the connection itself succeeded and the tools/list exchange
    // happened correctly (this fixture's own wire log, plus OpenCode's own
    // status endpoint) -- establishing this is not a broken fixture.
    const statusResult = await admitted.managed.client.mcp.status();
    const status = (statusResult as { data?: Record<string, { status: string }> }).data ?? {};
    assert.equal(status[mcpServerName]?.status, "connected", `expected the MCP server to report connected; status: ${JSON.stringify(status)}`);

    const wireLog = existsSync(mcpDebugLogFile) ? readFileSync(mcpDebugLogFile, "utf8") : "";
    assert.match(wireLog, /"method":"initialize"/, "expected this fixture to have received an MCP initialize request");
    assert.match(wireLog, /"method":"tools\/list"/, "expected this fixture to have received an MCP tools/list request");
    assert.match(wireLog, /"name":"mcp_marker_tool"/, "expected this fixture's tools/list response to have advertised mcp_marker_tool");

    // The documented negative result: despite the above, the tool never
    // shows up in the registry, and dispatch attempts land on the
    // engine's own "invalid" placeholder rather than ever reaching this
    // bridge's hook under the tool's own name.
    const idsResult = await admitted.managed.client.tool.ids();
    const ids = (idsResult as { data?: string[] }).data ?? [];
    assert.ok(!ids.includes("mcp_marker_tool"), `OBSERVED LIMITATION: expected "mcp_marker_tool" to be ABSENT from tool.ids() on this pinned build despite a connected MCP server; ids: ${JSON.stringify(ids)}`);

    const session = await admitted.managed.session.create("m1-21 mcp tool (documented limitation)");
    await admitted.managed.session.promptText(session.id, "call the mcp tool");

    assert.ok(!existsSync(mcpMarkerFile), "the MCP tool must not have executed -- it never became dispatchable at all");
    const decisions = admitted.ledger.decisions();
    const mcpAction = decisions.find((d) => d.request.action === "mcp_marker_tool");
    assert.equal(mcpAction, undefined, 'OBSERVED LIMITATION: the hook never even saw a call for action "mcp_marker_tool" -- the engine classified the call as its own "invalid" tool id instead, confirming the MCP tool never registered for dispatch on this pinned build');
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});
