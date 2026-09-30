import { test, expect, type Locator, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import {
  assignTicketDirect,
  changeTicketStatusDirect,
  createAgent,
  createTicket,
  updateTicketDirect,
  type Ticket,
} from "../support/tickets";

async function fetchTicket(page: Page, id: string): Promise<Ticket> {
  const response = await page.request.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function responseTo(page: Page, id: string, suffix: string, method: string, act: () => Promise<void>) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${id}${suffix}`) && r.request().method() === method),
    act(),
  ]);
  return response;
}

async function editRefinement(receipt: Locator, fields: { goal?: string; successCriteria?: string; repository?: string }) {
  await receipt.getByTestId("ticket-detail-edit-button").click();
  if (fields.goal !== undefined) await receipt.getByTestId("ticket-detail-textarea-goal").fill(fields.goal);
  if (fields.successCriteria !== undefined) await receipt.getByTestId("ticket-detail-textarea-success-criteria").fill(fields.successCriteria);
  if (fields.repository !== undefined) await receipt.getByTestId("ticket-detail-input-repository").fill(fields.repository);
}

async function expectMissingMarkers(receipt: Locator, expected: ("goal" | "success-criteria" | "repository")[]) {
  for (const field of ["goal", "success-criteria", "repository"] as const) {
    await expect(receipt.getByTestId(`ticket-detail-missing-${field}`)).toHaveCount(expected.includes(field) ? 1 : 0);
  }
}

test("Ready first, then a coding Agent: the assignment is refused beside the assignee control until the inputs are filled", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const stamp = Date.now();
  const builder = await createAgent(page, `Readiness Builder ${stamp}`, "coding");
  const ticket = await createTicket(page, `agent-readiness: ready first ${stamp}`, "Basic");
  const ready = await changeTicketStatusDirect(page, ticket.id, "Ready");
  expect(ready.ticket).toMatchObject({ status: "Ready", assigneeType: "", requestingAgentWork: false });

  const direct = await assignTicketDirect(page, ticket.id, { type: "agent", agentId: builder.id });
  expect(direct).toMatchObject({ ok: false, status: 400, errorCode: "agent_readiness_incomplete", missing: ["goal", "successCriteria", "repository"] });

  await page.goto(`/tickets/${ticket.id}`);
  const receipt = page.getByTestId("ticket-detail");
  await expect(receipt.getByRole("option", { name: builder.name })).toBeAttached();
  await receipt.getByLabel("Assign to").selectOption({ label: builder.name });
  const refused = await responseTo(page, ticket.id, "/assignee", "PUT", () => receipt.getByTestId("ticket-detail-assign-button").click());
  expect(refused.status()).toBe(400);
  const { error } = await refused.json() as { error: { code: string; message: string; missing: string[] } };
  expect(error).toEqual({ code: "agent_readiness_incomplete", message: direct.errorMessage, missing: ["goal", "successCriteria", "repository"] });

  const assignError = receipt.getByTestId("ticket-detail-action-error");
  await expect(assignError).toHaveText(error.message);
  await expect(receipt.getByTestId("ticket-detail-assignee-form").locator("xpath=following-sibling::*[1]")).toContainText(error.message);
  await expect(receipt.getByTestId("ticket-detail-status-control").getByTestId("ticket-detail-action-error")).toHaveCount(0);
  await expectMissingMarkers(receipt, ["goal", "success-criteria", "repository"]);
  await expect(receipt.getByTestId("ticket-detail-assignee")).toHaveText("Unassigned");
  expect(await fetchTicket(page, ticket.id)).toMatchObject({ status: "Ready", assigneeType: "", assigneeAgent: null });

  await editRefinement(receipt, { goal: "Ship the fix", successCriteria: "Tests pass", repository: "cristoforows/ticketIt" });
  const saved = await responseTo(page, ticket.id, "", "PATCH", () => receipt.getByTestId("ticket-detail-save-button").click());
  expect(saved.status()).toBe(200);
  await expect(receipt.getByTestId("ticket-detail-field-repository")).toHaveText("cristoforows/ticketIt");

  await receipt.getByLabel("Assign to").selectOption({ label: builder.name });
  const assigned = await responseTo(page, ticket.id, "/assignee", "PUT", () => receipt.getByTestId("ticket-detail-assign-button").click());
  expect(assigned.status()).toBe(200);
  expect(await assigned.json()).toMatchObject({ status: "Ready", assigneeAgent: { id: builder.id }, requestingAgentWork: true });
  await expect(receipt.getByTestId("ticket-detail-queued")).toHaveText(`Queued for ${builder.name}`);
  await expect(receipt.getByTestId("ticket-detail-action-error")).toHaveCount(0);
  await expectMissingMarkers(receipt, []);

  await page.goto("/board");
  await expect(page.getByTestId(`board-ticket-${ticket.id}`).getByTestId("board-queued")).toHaveText(`Queued for ${builder.name}`);
});

test("A research Agent first, then Ready: Galley's reason sits in the Status control, a stale Ready is refused, and filling the inputs queues the Ticket", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const stamp = Date.now();
  const scout = await createAgent(page, `Readiness Scout ${stamp}`, "research");
  const ticket = await createTicket(page, `agent-readiness: agent first ${stamp}`, "Coding");

  await page.goto(`/tickets/${ticket.id}`);
  const receipt = page.getByTestId("ticket-detail");
  await expect(receipt.getByTestId("ticket-detail-status-button-Ready")).toBeVisible();

  const assigned = await assignTicketDirect(page, ticket.id, { type: "agent", agentId: scout.id });
  expect(assigned.ticket).toMatchObject({ status: "Backlog", assigneeAgent: { id: scout.id }, requestingAgentWork: false });
  const advertised = assigned.ticket!.allowedActions;
  expect(advertised.statusChanges).not.toContain("Ready");
  const readyReason = advertised.statusChangeRejections.find(({ status }) => status === "Ready")!.reason;
  expect(readyReason).toMatchObject({ code: "agent_readiness_incomplete", missing: ["goal", "successCriteria"] });
  const blockedReason = advertised.statusChangeRejections.find(({ status }) => status === "Blocked")!.reason;
  expect(blockedReason.code).toBe("agent_owned_transition");

  const refused = await responseTo(page, ticket.id, "/status", "POST", () => receipt.getByTestId("ticket-detail-status-button-Ready").click());
  expect(refused.status()).toBe(400);
  const { error } = await refused.json() as { error: { code: string; message: string; missing: string[] } };
  expect(error).toEqual(readyReason);
  const statusControl = receipt.getByTestId("ticket-detail-status-control");
  await expect(statusControl.getByTestId("ticket-detail-action-error")).toHaveText(error.message);
  await expectMissingMarkers(receipt, ["goal", "success-criteria"]);
  await expect(receipt.getByTestId("ticket-detail-status")).toHaveText("Backlog");

  await page.reload();
  await expect(receipt.getByTestId("ticket-detail-status-button-Ready")).toHaveCount(0);
  await expect(statusControl.getByTestId("ticket-detail-status-unavailable-Ready")).toHaveText(`Ready: ${readyReason.message}`);
  await expect(statusControl.getByTestId("ticket-detail-status-unavailable-Blocked")).toHaveText(`Blocked: ${blockedReason.message}`);
  await expectMissingMarkers(receipt, ["goal", "success-criteria"]);

  await editRefinement(receipt, { goal: "Find the cause" });
  const partial = await responseTo(page, ticket.id, "", "PATCH", () => receipt.getByTestId("ticket-detail-save-button").click());
  expect(partial.status()).toBe(200);
  const stillMissing = (await partial.json() as Ticket).allowedActions.statusChangeRejections.find(({ status }) => status === "Ready")!.reason;
  expect(stillMissing.missing).toEqual(["successCriteria"]);
  await expect(statusControl.getByTestId("ticket-detail-status-unavailable-Ready")).toHaveText(`Ready: ${stillMissing.message}`);
  await expectMissingMarkers(receipt, ["success-criteria"]);

  await editRefinement(receipt, { successCriteria: "Root cause written up" });
  const filled = await responseTo(page, ticket.id, "", "PATCH", () => receipt.getByTestId("ticket-detail-save-button").click());
  expect(filled.status()).toBe(200);
  await expect(statusControl.getByTestId("ticket-detail-status-unavailable-Ready")).toHaveCount(0);
  await expectMissingMarkers(receipt, []);

  const entered = await responseTo(page, ticket.id, "/status", "POST", () => receipt.getByTestId("ticket-detail-status-button-Ready").click());
  expect(entered.status()).toBe(200);
  const queued = await entered.json() as Ticket;
  expect(queued).toMatchObject({ status: "Ready", requestingAgentWork: true });
  expect(queued.allowedActions.statusChanges).not.toContain("InProgress");
  const inProgressReason = queued.allowedActions.statusChangeRejections.find(({ status }) => status === "InProgress")!.reason;
  expect(inProgressReason.code).toBe("agent_owned_transition");
  expect(await changeTicketStatusDirect(page, ticket.id, "InProgress")).toMatchObject({ ok: false, errorCode: inProgressReason.code, errorMessage: inProgressReason.message });
  await expect(receipt.getByTestId("ticket-detail-queued")).toHaveText(`Queued for ${scout.name}`);
  await expect(statusControl.getByTestId("ticket-detail-status-unavailable-InProgress")).toHaveText(`In Progress: ${inProgressReason.message}`);

  const directClear = await updateTicketDirect(page, ticket.id, { goal: "" });
  expect(directClear).toMatchObject({ ok: false, errorCode: "agent_readiness_incomplete", missing: ["goal"] });
  await editRefinement(receipt, { goal: "" });
  const clearRefused = await responseTo(page, ticket.id, "", "PATCH", () => receipt.getByTestId("ticket-detail-save-button").click());
  expect(clearRefused.status()).toBe(400);
  await expect(receipt.getByTestId("ticket-detail-save-error")).toHaveText(directClear.errorMessage!);
  await expect(receipt.getByTestId("ticket-detail-textarea-goal")).toHaveAttribute("aria-invalid", "true");
  await expectMissingMarkers(receipt, ["goal"]);
  await receipt.getByTestId("ticket-detail-cancel-button").click();
  expect(await fetchTicket(page, ticket.id)).toMatchObject({ goal: "Find the cause", requestingAgentWork: true });

  await page.goto("/board");
  await expect(page.getByTestId(`board-ticket-${ticket.id}`).getByTestId("board-queued")).toHaveText(`Queued for ${scout.name}`);
});
