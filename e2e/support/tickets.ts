import { expect, type APIRequestContext, type Page } from "@playwright/test";

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
  state: "claimed" | "running" | "waiting_for_input" | "delivered" | "stopped" | "failed" | "interrupted";
  agent: { id: string; name: string; kind: AgentKind };
  claimedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  questions: RoundQuestion[];
  /** The Owner's feedback on this Round, oldest first (issue #164). */
  feedback: RoundFeedback[];
  /** Oldest first (issue #165). */
  permissionRequests: PermissionRequest[];
  /** Galley's latest 50, oldest first; `authorityCheckCount` counts them all (issue #165). */
  authorityChecks: AuthorityCheck[];
  authorityCheckCount: number;
  /** Michelin's evidence or explanation, set exactly when `state` is `stopped` (issue #160), `failed` or `interrupted` (issue #161). */
  outcomeNote: string | null;
  /** Galley's latest 50 notes, oldest first (issue #162). */
  activity: RoundActivityNote[];
  /** Opaque: pass to listRoundActivity for the 50 before `activity`; null once nothing is earlier. */
  earlierActivityCursor: string | null;
  usage: RoundUsage;
  /** Set exactly when `state` is `delivered` (issue #136). */
  deliverable: { bodyMarkdown: string; summary: string; criteriaAssessment: string } | null;
  /** Set exactly when the Owner's attestation ended the Round (issue #171). */
  attestation: RoundAttestation | null;
  /** The technical limit that requested this Round's Stop (issue #172). */
  limitBreach: RoundLimitBreach | null;
}

export interface RoundLimitBreach {
  kind: "wall_clock" | "denial_loop";
  /** Seconds for wall_clock, denied checks for denial_loop. */
  limit: number;
  measured: number;
  breachedAt: string;
}

export type AttestationBasis = "runner_process_ended" | "runner_host_off" | "other";

export interface RoundAttestation {
  attestedAt: string;
  basis: AttestationBasis;
  note: string | null;
  roundState: "claimed" | "running" | "waiting_for_input";
  claimEpoch: number;
  holderLastSeenAt: string | null;
  holderHealth: "connected" | "disconnected" | "replaced" | "not_paired";
  reconcileExecution: "running" | "stopped" | "unknown" | null;
}

export interface RoundQuestion {
  id: string;
  text: string;
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
}

export interface PermissionRequest {
  id: string;
  account: string;
  action: string;
  resource: string;
  substituteAccount: boolean;
  requestedAt: string;
  decision: "approved" | "declined" | null;
  decidedAt: string | null;
  grantId: string | null;
  /** The expired time grant this request renews (issue #166). */
  renewsGrantId: string | null;
}

export interface PermissionGrant {
  id: string;
  agent: { id: string; name: string; kind: AgentKind };
  account: string;
  /** Full access to the account, which records no action or resource (issue #167). */
  full: boolean;
  action: string | null;
  resource: string | null;
  substituteAccount: boolean;
  form: "ticket" | "time";
  /** Derived from Galley's clock when read; no stored state changes at expiry (issue #166). */
  state: "active" | "expired" | "revoked" | "ended_at_done";
  expiresAt: string | null;
  remainingSeconds: number | null;
  roundId: string;
  createdAt: string;
  approvedAt: string;
  revokedAt: string | null;
  /** Set exactly when the Ticket reached Done and ended a ticket grant (issue #169). */
  endedAt: string | null;
  allowedActions: { revoke: { available: boolean; reason?: { code: string; message: string } } };
  /** The open Rounds a revoke would stop (issue #168). */
  coveredOpenRounds: { roundId: string; sequence: number; ticketId: string; ticketTitle: string }[];
}

export interface AuthorityCheck {
  account: string;
  action: string;
  resource: string;
  decision: "allow" | "deny";
  grantId: string | null;
  /** On a deny, the newest expired time grant for the same Agent and scope (issue #166). */
  expiredGrantId: string | null;
  checkedAt: string;
}

export interface RoundFeedback {
  id: string;
  body: string;
  createdAt: string;
  consumedBy: { roundId: string; sequence: number } | null;
}

export interface RoundActivityNote {
  seq: number;
  note: string;
  occurredAt: string;
}

export interface RoundActivityPage {
  activity: RoundActivityNote[];
  earlierActivityCursor: string | null;
}

export type WaitingReason = "starting" | "working" | "waiting_for_answer" | "waiting_for_permission" | "resuming" | "stopping" | "runner_disconnected" | "reconciling" | "execution_unknown" | "runner_replaced";

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
    stop: { available: boolean; reason?: ErrorDetail };
    answer: { available: boolean; reason?: ErrorDetail };
    feedback: { available: boolean; reason?: ErrorDetail };
    permissionDecision: { available: boolean; reason?: ErrorDetail };
    attestCessation: { available: boolean; reason?: ErrorDetail };
    statusChangeRejections: { status: TicketStatus; reason: ErrorDetail }[];
  };
  requestingAgentWork: boolean;
  /** Null unless a Round is open (issue #132). */
  openRound: {
    id: string;
    sequence: number;
    state: "claimed" | "running" | "waiting_for_input";
    agent: { id: string; name: string; kind: AgentKind };
    claimedAt: string;
    startedAt: string | null;
    /** Set once the Owner requests Stop (issue #159); not a Status. */
    stopRequestedAt: string | null;
    /** Galley's reason the Round is still open (issue #162). */
    waitingReason: WaitingReason;
    /** Set exactly while `state` is `waiting_for_input` (issue #163). */
    question: RoundQuestion | null;
    /** Set exactly while `state` is `waiting_for_input` and no question is (issue #165). */
    permissionRequest: PermissionRequest | null;
    /** Set when a technical limit requested the Stop (issue #172). */
    limitBreach: RoundLimitBreach | null;
  } | null;
  /** The newest 50 grants approved on this Ticket or held for a time by its assigned Agent (issues #165, #166). */
  permissionGrants: PermissionGrant[];
  permissionGrantCount: number;
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

/** Same purpose as changeTicketStatusDirect, for requesting Stop. */
export async function requestStopDirect(from: Api, id: string): Promise<TicketCommandResult> {
  return ticketCommand(from, "POST", `/api/tickets/${id}/stop`);
}

/** Frees the Owner's slot by stopping the Round a live Michelin holds, and waits for Galley to record the confirmed Stop. */
export async function stopRoundThroughGalley(from: Api, id: string, timeout = 15_000): Promise<Ticket> {
  const requested = await requestStopDirect(from, id);
  expect(requested.status).toBe(200);
  let stopped: Ticket | undefined;
  await expect.poll(async () => {
    const response = await apiOf(from).get(`/api/tickets/${id}`);
    stopped = await response.json() as Ticket;
    return stopped.openRound;
  }, { timeout }).toBeNull();
  return stopped!;
}

/** Same purpose as changeTicketStatusDirect, for answering a Round's question. */
export async function answerQuestionDirect(from: Api, id: string, roundId: string, questionId: string, answer: string): Promise<TicketCommandResult> {
  return ticketCommand(from, "POST", `/api/tickets/${id}/rounds/${roundId}/questions/${questionId}/answer`, { answer });
}

/** Same purpose as changeTicketStatusDirect, for feedback on a delivered Round. */
export async function addFeedbackDirect(from: Api, id: string, roundId: string, body: string): Promise<TicketCommandResult> {
  return ticketCommand(from, "POST", `/api/tickets/${id}/rounds/${roundId}/feedback`, { body });
}

/** Same purpose as changeTicketStatusDirect, for the Owner's Permission decision. */
export type GrantChoice = ({ form: "ticket" } | { form: "time"; expiresAt: string }) & { scope?: "requested" | "full" };

export async function decidePermissionDirect(from: Api, id: string, roundId: string, requestId: string, decision: "approve" | "decline", grant: GrantChoice = { form: "ticket" }): Promise<TicketCommandResult> {
  return ticketCommand(from, "POST", `/api/tickets/${id}/rounds/${roundId}/permission-requests/${requestId}/${decision}`, decision === "approve" ? grant : undefined);
}

/** Same purpose as changeTicketStatusDirect, for the Owner's cessation attestation. */
export async function attestCessationDirect(from: Api, id: string, roundId: string, basis: AttestationBasis, note?: string): Promise<{ status: number; round?: Round; errorCode?: string }> {
  const response = await apiOf(from).post(`/api/tickets/${id}/rounds/${roundId}/attest-cessation`, { data: note === undefined ? { basis } : { basis, note } });
  const body = await response.json();
  return response.ok() ? { status: response.status(), round: body as Round } : { status: response.status(), errorCode: body?.error?.code };
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

export async function listRoundActivity(from: Api, ticketId: string, roundId: string, before?: string): Promise<RoundActivityPage> {
  const query = before === undefined ? "" : `?before=${encodeURIComponent(before)}`;
  const response = await apiOf(from).get(`/api/tickets/${ticketId}/rounds/${roundId}/activity${query}`);
  if (!response.ok()) throw new Error(`failed to page activity of Round ${roundId}: ${response.status()} ${await response.text()}`);
  return response.json() as Promise<RoundActivityPage>;
}
