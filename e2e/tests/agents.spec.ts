import { test, expect, type Locator, type Page } from "@playwright/test";
import { signIn } from "../support/sign-in";
import { createAgent, createTicket, listAgents, type Agent, type Ticket } from "../support/tickets";

async function assignThroughReceipt(page: Page, receipt: Locator, option: string): Promise<Ticket> {
  await receipt.getByLabel("Assign to").selectOption({ label: option });
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/assignee") && r.request().method() === "PUT"),
    receipt.getByTestId("ticket-detail-assign-button").click(),
  ]);
  expect(response.status()).toBe(200);
  return response.json();
}

async function fetchTicket(page: Page, id: string): Promise<Ticket> {
  const response = await page.request.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test("create and rename Agents, assign them on Basic and Coding Tickets, then replace with the Owner", async ({ page, request }) => {
  await signIn(page, request, "owner");
  const stamp = Date.now();
  const scoutName = `Scout ${stamp}`;
  const renamed = `Scout Prime ${stamp}`;
  const builder = await createAgent(page, `Builder ${stamp}`, "coding");

  await page.goto("/");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Agents" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await page.getByLabel("Name", { exact: true }).fill(scoutName);
  await page.getByLabel("Kind").selectOption({ label: "Research" });
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/agents") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create Agent" }).click(),
  ]);
  expect(created.status()).toBe(201);
  const scout = await created.json() as Agent;
  expect(scout).toMatchObject({ name: scoutName, kind: "research" });
  const scoutRow = page.getByTestId(`agent-row-${scout.id}`);
  await expect(scoutRow.getByTestId("agent-name")).toHaveText(scoutName);
  await expect(scoutRow.getByTestId("agent-kind")).toHaveText("Research");

  await page.getByLabel("Name", { exact: true }).fill(scoutName.toUpperCase());
  const [duplicate] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/agents") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create Agent" }).click(),
  ]);
  expect(duplicate.status()).toBe(409);
  const rejection = await duplicate.json() as { error: { code: string; message: string } };
  expect(rejection.error.code).toBe("duplicate_agent_name");
  await expect(page.getByTestId("agent-create-error")).toHaveText(rejection.error.message);

  await scoutRow.getByRole("button", { name: `Rename ${scoutName}` }).click();
  await scoutRow.getByLabel(`New name for ${scoutName}`).fill(renamed);
  const [renameResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/agents/${scout.id}`) && r.request().method() === "PATCH"),
    scoutRow.getByRole("button", { name: "Save" }).click(),
  ]);
  expect(renameResponse.status()).toBe(200);
  expect(await renameResponse.json()).toMatchObject({ id: scout.id, name: renamed, kind: "research" });
  await expect(scoutRow.getByTestId("agent-name")).toHaveText(renamed);
  await expect(scoutRow.getByRole("button", { name: `Rename ${renamed}` })).toBeFocused();
  const agents = await listAgents(page);
  expect(agents.find(({ id }) => id === scout.id)).toMatchObject({ name: renamed, kind: "research" });

  const basic = await createTicket(page, `agent basic ${stamp}`, "Basic");
  const coding = await createTicket(page, `agent coding ${stamp}`, "Coding");

  await page.getByRole("link", { name: "Board" }).click();
  const basicSlip = page.getByTestId(`board-ticket-${basic.id}`);
  await basicSlip.getByRole("link").click();
  const modal = page.getByRole("dialog", { name: "Ticket details" });
  await expect(modal.getByRole("option", { name: renamed })).toBeAttached();
  const offered = await modal.getByLabel("Assign to").locator("option:not([disabled])").allTextContents();
  expect(offered).toEqual(["Me", ...agents.map(({ name }) => name)]);
  const basicAssigned = await assignThroughReceipt(page, modal, renamed);
  expect(basicAssigned).toMatchObject({ assigneeType: "agent", assigneeAgent: { id: scout.id, name: renamed, kind: "research" }, status: "Backlog", template: "Basic" });
  await expect(modal.getByTestId("ticket-detail-assignee")).toHaveText(renamed);
  await modal.getByRole("button", { name: "Close" }).click();
  await expect(basicSlip.getByTestId("board-assignee")).toHaveText(`Assignee: ${renamed}`);
  expect(await fetchTicket(page, basic.id)).toMatchObject({ assigneeType: "agent", assigneeAgent: { id: scout.id, name: renamed } });

  await page.goto(`/tickets/${coding.id}`);
  const receipt = page.getByTestId("ticket-detail");
  const codingAssigned = await assignThroughReceipt(page, receipt, builder.name);
  expect(codingAssigned).toMatchObject({ assigneeType: "agent", assigneeAgent: { id: builder.id, name: builder.name, kind: "coding" }, status: "Backlog", template: "Coding" });
  await expect(receipt.getByTestId("ticket-detail-assignee")).toHaveText(builder.name);

  const ownerAssigned = await assignThroughReceipt(page, receipt, "Me");
  expect(ownerAssigned).toMatchObject({ assigneeType: "owner", assigneeAgent: null, status: "Backlog" });
  await expect(receipt.getByTestId("ticket-detail-assignee")).toHaveText("Owner");
  expect(await fetchTicket(page, coding.id)).toMatchObject({ assigneeType: "owner", assigneeAgent: null });

  await page.goto("/board");
  await expect(page.getByTestId(`board-ticket-${coding.id}`).getByTestId("board-assignee")).toHaveText("Assignee: Owner");
  await expect(basicSlip.getByTestId("board-assignee")).toHaveText(`Assignee: ${renamed}`);
});
