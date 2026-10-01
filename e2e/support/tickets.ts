import type { Page } from "@playwright/test";

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
export async function createTicket(page: Page, title: string, template: TicketTemplate = "Basic"): Promise<Ticket> {
  const response = await page.request.post("/api/tickets", { data: { title, template } });
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
  page: Page,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
): Promise<TicketCommandResult> {
  const response = await page.request.fetch(path, { method, data });
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
export async function changeTicketStatusDirect(page: Page, id: string, status: TicketStatus): Promise<TicketCommandResult> {
  return ticketCommand(page, "POST", `/api/tickets/${id}/status`, { status });
}

/** Same purpose as changeTicketStatusDirect, for Accept. */
export async function acceptTicketDirect(page: Page, id: string): Promise<TicketCommandResult> {
  return ticketCommand(page, "POST", `/api/tickets/${id}/accept`);
}

export type TicketAssignee = { type: "owner" } | { type: "agent"; agentId: string };

/** Same purpose as changeTicketStatusDirect, for assignment. */
export async function assignTicketDirect(page: Page, id: string, assignee: TicketAssignee): Promise<TicketCommandResult> {
  return ticketCommand(page, "PUT", `/api/tickets/${id}/assignee`, assignee);
}

/** Same purpose as changeTicketStatusDirect, for editing Ticket fields. */
export async function updateTicketDirect(page: Page, id: string, fields: Partial<Pick<Ticket, "title" | "goal" | "context" | "successCriteria" | "constraints" | "repository">>): Promise<TicketCommandResult> {
  return ticketCommand(page, "PATCH", `/api/tickets/${id}`, fields);
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
export async function createAgent(page: Page, name: string, kind: AgentKind): Promise<Agent> {
  const response = await page.request.post("/api/agents", { data: { name, kind } });
  if (!response.ok()) {
    throw new Error(`failed to create Agent ${JSON.stringify(name)} via POST /api/agents: ${response.status()} ${await response.text()}`);
  }
  return response.json();
}

export async function listAgents(page: Page): Promise<Agent[]> {
  const response = await page.request.get("/api/agents");
  if (!response.ok()) throw new Error(`failed to list Agents: ${response.status()} ${await response.text()}`);
  return (await response.json() as { agents: Agent[] }).agents;
}

/** Same purpose as changeTicketStatusDirect, for priority order. */
export async function reorderTicketDirect(page: Page, id: string, placement: { before: string } | { after: string }): Promise<TicketCommandResult> {
  return ticketCommand(page, "POST", `/api/tickets/${id}/position`, placement);
}
