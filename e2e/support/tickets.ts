import type { APIRequestContext, Page } from "@playwright/test";

/** A signed-in page, or a signed-in API context for a spec that must not open a browser. */
export type Api = Page | APIRequestContext;

function apiOf(from: Api): APIRequestContext {
  return "request" in from ? from.request : from;
}

export type TicketTemplate = "Basic" | "Coding";
export type AgentKind = "research" | "coding";
export type TicketStatus = "Backlog" | "Ready" | "InProgress" | "Blocked" | "InReview" | "Done";
export type AgentReadinessInput = "goal" | "successCriteria" | "repository";

export interface ErrorDetail {
  code: string;
  message: string;
  missing?: AgentReadinessInput[];
  roundId?: string;
}

export interface Round {
  id: string;
  sequence: number;
  state: "claimed" | "running" | "delivered";
  agent: { id: string; name: string; kind: AgentKind };
  claimedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  activity: { seq: number; note: string; occurredAt: string }[];
  usage: RoundUsage;
  /** Set exactly when `state` is `delivered` (issue #136). */
  deliverable: { bodyMarkdown: string; summary: string; criteriaAssessment: string } | null;
}

export interface UsageCount {
  sum: number | null;
  complete: boolean;
  estimated: boolean;
}

export interface RoundUsage {
  observations: number;
  complete: boolean;
  estimated: boolean;
  costUsd: string | null;
  inputTokens: UsageCount;
  outputTokens: UsageCount;
  activeMs: UsageCount;
}

const UNKNOWN_COUNT: UsageCount = { sum: null, complete: false, estimated: false };

export const NO_USAGE: RoundUsage = { observations: 0, complete: false, estimated: false, costUsd: null, inputTokens: UNKNOWN_COUNT, outputTokens: UNKNOWN_COUNT, activeMs: UNKNOWN_COUNT };

export interface Ticket {
  /** Opaque public identifier (issue #57) -- never the internal sequential database id. */
  id: string;
  title: string;
  status: TicketStatus;
  badges: { id: string; name: string }[];
  archivedAt: string | null;
  allowedActions: {
    statusChanges: TicketStatus[];
    accept: { available: boolean; reason?: ErrorDetail };
    rework: { available: boolean; reason?: ErrorDetail };
    statusChangeRejections: { status: TicketStatus; reason: ErrorDetail }[];
  };
  requestingAgentWork: boolean;
  /** Null unless a Round is open (issue #132). */
  openRound: {
    id: string;
    sequence: number;
    state: "claimed" | "running";
    agent: { id: string; name: string; kind: AgentKind };
    claimedAt: string;
    startedAt: string | null;
  } | null;
  /** The latest Round, when it was delivered (issue #136). */
  delivery: {
    roundId: string;
    sequence: number;
    agent: { id: string; name: string; kind: AgentKind };
    deliveredAt: string;
  } | null;
  /** Chosen at capture (issue #59), default Basic -- see docs/ticket-creation.md. */
  template: TicketTemplate;
  /** Derived from template's default once, at creation, and retained thereafter (issue #59, D3). */
  completionCondition: "humanAcceptance" | "reviewedPrMerge";
  /** Manual refinement fields (issue #58) -- "" when never set or cleared. */
  goal: string;
  context: string;
  successCriteria: string;
  constraints: string;
  /** One Ticket repository reference (issue #59, D3), available on either Template -- "" when never set or cleared. */
  repository: string;
  assigneeType: "owner" | "agent" | "";
  /** Null unless assigneeType is "agent" (issue #127). */
  assigneeAgent: { id: string; name: string; kind: AgentKind } | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Creates a Ticket through Galley's own API -- never by writing to
 * PostgreSQL directly (ADR 0001) -- using the signed-in page's own
 * session: `page.request` shares cookie storage and `baseURL` with
 * `page`'s browser context, so this reaches Galley exactly as the
 * signed-in browser would, with no separate sign-in of its own.
 *
 * This is the data-setup convention issue #56 establishes (see
 * README.md, "Adding a spec"): a spec that needs Tickets to already
 * exist as background data -- not as the behavior under test -- calls
 * this rather than driving the capture form itself or reaching into
 * the database. A spec that *is* testing the capture form (like
 * tests/ticket-persistence-before.spec.ts) still drives that form
 * directly instead of calling this.
 *
 * `template` (issue #59) defaults to Basic, mirroring Galley's own
 * CreateTicketRequest default, when a spec does not need to name it.
 */
export async function createTicket(from: Api, title: string, template: TicketTemplate = "Basic"): Promise<Ticket> {
  const response = await apiOf(from).post("/api/tickets", { data: { title, template } });
  if (!response.ok()) {
    throw new Error(
      `failed to create Ticket ${JSON.stringify(title)} via POST /api/tickets: ${response.status()} ${await response.text()}`,
    );
  }
  return response.json();
}

/**
 * Never throws on a rejection, unlike createTicket: callers need
 * Galley's actual code and message to assert the UI shows that live
 * response rather than a hardcoded literal (README.md, "Adding a
 * spec").
 */
export interface TicketCommandResult {
  ok: boolean;
  status: number;
  ticket?: Ticket;
  errorCode?: string;
  errorMessage?: string;
  missing?: AgentReadinessInput[];
  roundId?: string;
}

export async function ticketCommand(
  from: Api,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
): Promise<TicketCommandResult> {
  const response = await apiOf(from).fetch(path, { method, data });
  const body = await response.json();
  if (response.ok()) {
    return { ok: true, status: response.status(), ticket: body as Ticket };
  }
  return { ok: false, status: response.status(), errorCode: body?.error?.code, errorMessage: body?.error?.message, missing: body?.error?.missing, roundId: body?.error?.roundId };
}

/**
 * For background state a spec is not itself testing, and for capturing
 * Galley's live rejection to assert the UI shows it verbatim.
 */
export async function changeTicketStatusDirect(from: Api, id: string, status: TicketStatus): Promise<TicketCommandResult> {
  return ticketCommand(from, "POST", `/api/tickets/${id}/status`, { status });
}

/** Same purpose as changeTicketStatusDirect, for Accept. */
export async function acceptTicketDirect(from: Api, id: string): Promise<TicketCommandResult> {
  return ticketCommand(from, "POST", `/api/tickets/${id}/accept`);
}

/** Same purpose as changeTicketStatusDirect, for requesting rework. */
export async function requestReworkDirect(from: Api, id: string): Promise<TicketCommandResult> {
  return ticketCommand(from, "POST", `/api/tickets/${id}/rework`);
}

export type TicketAssignee = { type: "owner" } | { type: "agent"; agentId: string };

/** Same purpose as changeTicketStatusDirect, for assignment. */
export async function assignTicketDirect(from: Api, id: string, assignee: TicketAssignee): Promise<TicketCommandResult> {
  return ticketCommand(from, "PUT", `/api/tickets/${id}/assignee`, assignee);
}

/** Same purpose as changeTicketStatusDirect, for editing Ticket fields. */
export async function updateTicketDirect(from: Api, id: string, fields: Partial<Pick<Ticket, "title" | "goal" | "context" | "successCriteria" | "constraints" | "repository">>): Promise<TicketCommandResult> {
  return ticketCommand(from, "PATCH", `/api/tickets/${id}`, fields);
}

export function statusLabel(status: TicketStatus): string {
  return status.replace(/(?<=[a-z])(?=[A-Z])/g, " ");
}

export async function openCapture(page: Page, typedTitle?: string): Promise<void> {
  if (typedTitle !== undefined) await page.getByTestId("new-order-input").fill(typedTitle);
  await page.getByTestId("new-order-button").click();
}

export interface Agent {
  id: string;
  name: string;
  kind: AgentKind;
  createdAt: string;
}

/** Same data-setup convention as createTicket, for Agents (issue #127). */
export async function createAgent(from: Api, name: string, kind: AgentKind): Promise<Agent> {
  const response = await apiOf(from).post("/api/agents", { data: { name, kind } });
  if (!response.ok()) {
    throw new Error(`failed to create Agent ${JSON.stringify(name)} via POST /api/agents: ${response.status()} ${await response.text()}`);
  }
  return response.json();
}

export async function listAgents(from: Api): Promise<Agent[]> {
  const response = await apiOf(from).get("/api/agents");
  if (!response.ok()) throw new Error(`failed to list Agents: ${response.status()} ${await response.text()}`);
  return (await response.json() as { agents: Agent[] }).agents;
}

/** Same purpose as changeTicketStatusDirect, for priority order. */
export async function reorderTicketDirect(from: Api, id: string, placement: { before: string } | { after: string }): Promise<TicketCommandResult> {
  return ticketCommand(from, "POST", `/api/tickets/${id}/position`, placement);
}

export async function listRounds(from: Api, ticketId: string): Promise<Round[]> {
  const response = await apiOf(from).get(`/api/tickets/${ticketId}/rounds`);
  if (!response.ok()) throw new Error(`failed to list Rounds of ${ticketId}: ${response.status()} ${await response.text()}`);
  return (await response.json() as { rounds: Round[] }).rounds;
}
