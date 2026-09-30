import type { components } from "./generated/schema";
import { authenticatedFetch, errorMessage } from "./http";

export type Agent = components["schemas"]["Agent"];
export type AgentKind = components["schemas"]["AgentKind"];
export type AgentSummary = components["schemas"]["TicketAssigneeAgent"];

export const AGENT_KINDS: AgentKind[] = ["research", "coding"];

export const AGENT_NAME_MAX_LENGTH = 80;

const AGENTS_ENDPOINT = "/api/agents";

export function isAgentSummary(value: unknown): value is AgentSummary {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.name === "string" &&
    AGENT_KINDS.includes(record.kind as AgentKind);
}

function isAgent(value: unknown): value is Agent {
  return isAgentSummary(value) && typeof (value as Record<string, unknown>).createdAt === "string";
}

async function agentResponse(path: string, init?: RequestInit): Promise<unknown> {
  const response = await authenticatedFetch(path, init);
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? `Galley returned an error response: ${response.status} ${response.statusText}`.trim());
  }
  return payload;
}

export async function fetchAgents(): Promise<Agent[]> {
  const payload = await agentResponse(AGENTS_ENDPOINT);
  const agents = (payload as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents) || !agents.every(isAgent)) {
    throw new Error("Galley's Agent list was missing or contained an invalid Agent.");
  }
  return agents;
}

async function agentCommand(path: string, method: "POST" | "PATCH", body: object): Promise<Agent> {
  const payload = await agentResponse(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!isAgent(payload)) {
    throw new Error("Galley's Agent response was missing a required field.");
  }
  return payload;
}

export function createAgent(name: string, kind: AgentKind): Promise<Agent> {
  return agentCommand(AGENTS_ENDPOINT, "POST", { name, kind });
}

export function renameAgent(id: string, name: string): Promise<Agent> {
  return agentCommand(`${AGENTS_ENDPOINT}/${encodeURIComponent(id)}`, "PATCH", { name });
}
