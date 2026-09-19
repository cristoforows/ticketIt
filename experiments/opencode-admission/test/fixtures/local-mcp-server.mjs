#!/usr/bin/env node
// Minimal local Model Context Protocol (MCP) stdio server, for issue #21's
// "a local stdio MCP server" coverage row. No `@modelcontextprotocol/sdk`
// dependency was added for this: this package's workspace rules pin every
// dependency to an exact version and prefer a small footprint, and the
// stdio wire protocol needed here (newline-delimited JSON-RPC 2.0 --
// https://modelcontextprotocol.io/specification, "Transports": "each
// message is delimited by a newline") is small enough to implement
// directly for a single-tool fixture. Registers exactly one tool,
// `mcp_marker_tool`, whose handler appends a line to a marker file path
// taken from the `MCP_MARKER_FILE` environment variable (set per-test via
// `McpLocalConfig.environment`, so one server file can serve every test
// that needs it with a distinct marker file).
//
// Spawned by OpenCode itself (`Config.mcp.<name> = { type: "local",
// command: ["node", <this file>], environment: {...} }`), never imported
// by this package's own `node --test` process -- the same process-boundary
// shape as `src/plugin/admission-plugin.ts`.
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const markerFile = process.env.MCP_MARKER_FILE;
const debugLogFile = process.env.MCP_DEBUG_LOG_FILE;
function debugLog(direction, message) {
  if (!debugLogFile) return;
  try {
    appendFileSync(debugLogFile, `${direction} ${JSON.stringify(message)}\n`, "utf8");
  } catch {
    // best-effort only
  }
}

function send(message) {
  debugLog("SEND", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    // Echo back the CLIENT's requested protocol version rather than a
    // hardcoded one: this pinned OpenCode build (1.18.31) was observed
    // (via MCP_DEBUG_LOG_FILE during development) requesting
    // "2025-11-25", newer than the "2024-11-05" baseline this fixture
    // originally hardcoded; replying with a version the client did not
    // request appears to leave the connection reporting "connected"
    // (`GET /mcp` / `client.mcp.status()`) while never actually
    // registering this server's tools into the tool registry (`tool.ids()`/
    // `tool.list()` never show them) -- a real, reproducible finding about
    // this pinned build's MCP client requiring an exact/matching
    // `protocolVersion` in the server's `initialize` response, not merely
    // "a decodable one" (documented in docs/evidence/m1/21-opencode-coverage-matrix.md).
    const requestedVersion = (params && params.protocolVersion) || "2024-11-05";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "ticketit-coverage-matrix-fixture-mcp-server", version: "0.1.0" },
      },
    });
    return;
  }

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "mcp_marker_tool",
            description: "ticketit coverage-matrix fixture: appends a line to a marker file (MCP_MARKER_FILE) when actually executed.",
            inputSchema: {
              type: "object",
              properties: { line: { type: "string", description: "line to append; defaults to 'executed'" } },
              required: [],
            },
          },
        ],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params && params.name;
    if (toolName !== "mcp_marker_tool") {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${String(toolName)}` } });
      return;
    }
    const line = (params && params.arguments && params.arguments.line) || "executed";
    if (!markerFile) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "MCP_MARKER_FILE not configured" } });
      return;
    }
    appendFileSync(markerFile, `${line}\n`, "utf8");
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `appended "${line}" to marker file` }], isError: false } });
    return;
  }

  // Any other request (e.g. "ping", "resources/list") this fixture does
  // not implement: respond with a standard JSON-RPC "method not found"
  // rather than hanging the client.
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } });
  }
  // Notifications (no `id`, e.g. "notifications/initialized") require no response.
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // ignore malformed lines rather than crashing the fixture server
  }
  debugLog("RECV", message);
  try {
    handleRequest(message);
  } catch (err) {
    if (message && message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(err && err.message) } });
    }
  }
});
