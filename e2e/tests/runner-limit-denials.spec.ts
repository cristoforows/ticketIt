import { once } from "node:events";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep } from "../support/runner";
import { assignTicketDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, updateTicketDirect, type Ticket } from "../support/tickets";

// Galley's default denied-check limit (GALLEY_ROUND_MAX_CONSECUTIVE_DENIALS): run.sh starts Galley with no override.
const LIMIT = 10;
const EXPLANATION = `Technical limit reached: ${LIMIT} consecutive denied authority checks (limit ${LIMIT}).`;
const SCOPE = { account: "controlled", action: "write_note", resource: "notes/never-granted" };
const SCRIPT: EngineScriptStep[] = [
  { step: "start" },
  { step: "progress", note: "Trying the action" },
  { step: "retry_act", ...SCOPE, times: 1000, intervalMs: 100 },
  { step: "deliver", bodyMarkdown: "# Never", summary: "Never delivered", criteriaAssessment: "None" },
];

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

test.setTimeout(90_000);

test("a real Michelin retrying a denied action is stopped by Galley at the denied-check limit; the Round ends Failed, Blocked, without a Permission request", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();

  await signInWithoutBrowser(api);
  const agent = await createAgent(api, `Retrier ${stamp}`, "research");
  const queued = await createTicket(api, `Retry a denied action ${stamp}`);
  expect((await updateTicketDirect(api, queued.id, { goal: "Summarise the findings", successCriteria: "A summary exists" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);

  const token = await pairRunnerViaApi(api);
  const michelin = startMichelin(token, 500, SCRIPT, { commandIntervalMs: 200 });
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(() => michelin.output(), { timeout: 30_000 }).toContain('"msg":"stop confirmation reported"');
    const log = michelin.output();
    const [claim] = lines(log, "round claimed");
    const roundId = String(claim!["roundId"]);
    const checks = lines(log, "authority checked");
    expect(checks.length).toBeGreaterThanOrEqual(LIMIT);
    expect(checks.every((check) => check["decision"] === "deny")).toBe(true);
    expect(lines(log, "stop confirmation reported")).toEqual([expect.objectContaining({ roundId, httpStatus: 201 })]);
    expect(log).not.toContain('"msg":"permission requested"');
    expect(log).not.toContain('"msg":"engine gave up retrying a denied action"');
    expect(log).not.toContain('"msg":"engine delivered"');
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);

    const blocked = await ticket(api, queued.id);
    expect(blocked).toMatchObject({ status: "Blocked", openRound: null, delivery: null, requestingAgentWork: false, badges: [] });
    const [round1] = await listRounds(api, queued.id);
    expect(round1).toMatchObject({
      id: roundId,
      state: "failed",
      outcomeNote: EXPLANATION,
      limitBreach: { kind: "denial_loop", limit: LIMIT, measured: LIMIT, breachedAt: expect.any(String) },
      permissionRequests: [],
      deliverable: null,
    });
    // Checks Michelin made before it pulled the Stop are recorded too, each a deny.
    expect(round1!.authorityCheckCount).toBe(checks.length);
    expect(round1!.authorityChecks.every((check) => check.decision === "deny" && check.resource === SCOPE.resource)).toBe(true);
    expect(round1!.activity.map((note) => note.note)).toContain("Trying the action");

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    const section = page.getByTestId("ticket-detail-rounds");
    await expect(page.getByTestId("ticket-detail-status")).toHaveText("Blocked");
    await expect(section.getByTestId("ticket-detail-round-failed")).toHaveText("Failed");
    await expect(section.getByTestId("ticket-detail-round-limit-breach")).toHaveText(`Denied-check limit reached: ${LIMIT} of ${LIMIT}`);
    await expect(section.getByTestId("ticket-detail-round-outcome-note")).toHaveText(EXPLANATION);

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(lines(michelin.output(), "round claimed")).toHaveLength(1);
    expect(await listRounds(api, queued.id)).toEqual([round1]);

    michelin.child.kill("SIGTERM");
    const [code] = await once(michelin.child, "exit");
    exited = true;
    expect(code).toBe(0);
  } finally {
    if (!exited) michelin.child.kill("SIGKILL");
    await context.close();
    await api.dispose();
  }
});
