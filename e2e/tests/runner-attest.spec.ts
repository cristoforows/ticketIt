import { once } from "node:events";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signIn, signInWithoutBrowser } from "../support/sign-in";
import { pairRunnerViaApi, startMichelin, type EngineScriptStep, type RunningMichelin } from "../support/runner";
import { assignTicketDirect, attestCessationDirect, changeTicketStatusDirect, createAgent, createTicket, listRounds, updateTicketDirect, type Round, type Ticket } from "../support/tickets";

const COPY = "ticketIt cannot tell whether this Round is still running. Confirm only after making sure it has stopped, for example by ending the Michelin process or switching off its machine. If it is still running, its work continues outside ticketIt. The Round will end as Interrupted and the Ticket will move to Blocked. Nothing already done is undone.";
const UNKNOWN = "Reconciled with the runner: the runner cannot confirm execution";
const HOLDING: EngineScriptStep[] = [{ step: "start" }, { step: "progress", note: "Reading the Ticket" }, { step: "hold" }];
const DELIVERING: EngineScriptStep[] = [
  { step: "start" },
  { step: "progress", note: "Reading the Ticket again" },
  { step: "deliver", bodyMarkdown: "# Report\n\nDone.", summary: "Covered it", criteriaAssessment: "A summary exists" },
];

async function ticket(api: APIRequestContext, id: string): Promise<Ticket> {
  const response = await api.get(`/api/tickets/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const lines = (log: string, msg: string) => log.split("\n").filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

async function queueForAgent(api: APIRequestContext, title: string, agentName: string): Promise<Ticket> {
  const agent = await createAgent(api, agentName, "research");
  const queued = await createTicket(api, title);
  expect((await updateTicketDirect(api, queued.id, { goal: "Summarise the findings", successCriteria: "A summary exists" })).ok).toBe(true);
  expect((await assignTicketDirect(api, queued.id, { type: "agent", agentId: agent.id })).ok).toBe(true);
  expect((await changeTicketStatusDirect(api, queued.id, "Ready")).ok).toBe(true);
  return queued;
}

async function exitCleanly(michelin: RunningMichelin): Promise<void> {
  michelin.child.kill("SIGTERM");
  const [code] = await once(michelin.child, "exit");
  expect(code).toBe(0);
}

async function attestInTheBrowser(page: Page, ticketId: string, basisLabel: string, note?: string): Promise<Round> {
  const open = page.getByTestId("ticket-detail-attest-open");
  await expect(open).toHaveText("Attest that execution has ceased");
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Attest that execution has ceased" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("ticket-detail-attest-copy")).toHaveText(COPY);
  await expect(page.getByTestId("ticket-detail-attest-cancel")).toBeFocused();
  await expect(page.getByTestId("ticket-detail-attest-confirm")).toBeDisabled();
  await page.getByTestId("ticket-detail-attest-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("ticket-detail-locked")).toBeVisible();

  await open.click();
  await dialog.getByRole("radio", { name: basisLabel }).check();
  if (note !== undefined) {
    await expect(page.getByTestId("ticket-detail-attest-confirm")).toBeDisabled();
    await dialog.getByLabel("Note (required)").fill(note);
  }
  const [attested] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/tickets/${ticketId}/rounds/`) && r.url().endsWith("/attest-cessation")),
    page.getByTestId("ticket-detail-attest-confirm").click(),
  ]);
  expect(attested.status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  return attested.json();
}

async function expectAttestedReceipt(page: Page, explanation: string, basisLabel: string, note: string | null): Promise<void> {
  const section = page.getByTestId("ticket-detail-rounds");
  await expect(page.getByTestId("ticket-detail-status")).toHaveText("Blocked");
  await expect(page.getByTestId("ticket-detail-locked")).toHaveCount(0);
  await expect(page.getByTestId("ticket-detail-attest")).toHaveCount(0);
  await expect(section.getByTestId("ticket-detail-round-interrupted")).toHaveText("Interrupted");
  await expect(section.getByTestId("ticket-detail-round-outcome-note")).toHaveText(explanation);
  const record = section.getByTestId("ticket-detail-round-attestation");
  await expect(record.getByRole("heading", { name: "Ended by your attestation" })).toBeVisible();
  await expect(record.getByTestId("ticket-detail-round-attestation-basis")).toHaveText(basisLabel);
  await expect(record.getByTestId("ticket-detail-round-attestation-note")).toHaveCount(note === null ? 0 : 1);
  if (note !== null) await expect(record.getByTestId("ticket-detail-round-attestation-note")).toHaveText(note);
  await expect(record.getByTestId("ticket-detail-round-attestation-at").locator("time")).toHaveCount(1);
}

async function readyClaimsRoundTwo(page: Page, api: APIRequestContext, ticketId: string, michelin: RunningMichelin, round1: Round): Promise<void> {
  const [readied] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${ticketId}/status`) && r.request().method() === "POST"),
    page.getByTestId("ticket-detail-status-button-Ready").click(),
  ]);
  expect(readied.status()).toBe(200);
  await expect.poll(async () => (await ticket(api, ticketId)).status, { timeout: 20_000 }).toBe("InReview");
  const rounds = await listRounds(api, ticketId);
  expect(rounds.map((round) => [round.sequence, round.state])).toEqual([[2, "delivered"], [1, "interrupted"]]);
  expect(rounds[1]).toEqual(round1);
  expect(rounds[0]!.attestation).toBeNull();
  const claimed = lines(michelin.output(), "round claimed").map((each) => [each["roundId"], each["sequence"], each["claimEpoch"]]);
  expect(claimed).toEqual([[rounds[0]!.id, 2, 2]]);
}

test.setTimeout(120_000);

test("a killed runner's Round stays locked until the Owner attests it stopped: Interrupted, Blocked, and Ready claims Round 2", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const runner = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  await signInWithoutBrowser(api);
  const queued = await queueForAgent(api, `Attest killed ${stamp}`, `Killed ${stamp}`);
  const token = await pairRunnerViaApi(api);
  const first = startMichelin(token, 500, HOLDING);
  let second: RunningMichelin | undefined;
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(() => first.output(), { timeout: 15_000 }).toContain('"msg":"engine holding"');
    const roundId = (await ticket(api, queued.id)).openRound!.id;
    first.child.kill("SIGKILL");
    await once(first.child, "exit");

    const connected = await ticket(api, queued.id);
    expect(connected.allowedActions.attestCessation).toMatchObject({ available: false, reason: { code: "attestation_not_available" } });
    expect(await attestCessationDirect(api, queued.id, roundId, "runner_process_ended")).toEqual({ status: 400, errorCode: "attestation_not_available" });

    const advanced = await api.post("/api/dev/clock/advance", { data: { seconds: 31 } });
    expect(advanced.status()).toBe(200);
    const disconnected = await ticket(api, queued.id);
    expect(disconnected).toMatchObject({ status: "InProgress", openRound: { id: roundId, state: "running", waitingReason: "runner_disconnected" } });
    expect(disconnected.allowedActions.attestCessation).toEqual({ available: true });
    expect(disconnected.allowedActions.accept.reason).toMatchObject({ code: "round_open", roundId });

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-runner-disconnected")).toBeVisible();
    const attested = await attestInTheBrowser(page, queued.id, "I ended the Michelin process");
    const explanation = "Ended by Owner attestation: the Michelin process was ended.";
    expect(attested).toMatchObject({
      id: roundId,
      state: "interrupted",
      outcomeNote: explanation,
      attestation: { basis: "runner_process_ended", note: null, roundState: "running", claimEpoch: 1, holderHealth: "disconnected", holderLastSeenAt: expect.any(String), reconcileExecution: null },
    });
    await expectAttestedReceipt(page, explanation, "I ended the Michelin process", null);

    expect(await ticket(api, queued.id)).toMatchObject({ status: "Blocked", openRound: null, delivery: null, badges: [] });
    const [round1] = await listRounds(api, queued.id);
    expect(round1!.activity.map((note) => note.note)).toEqual(["Reading the Ticket", explanation]);
    expect(round1).toEqual(attested);

    const repeat = await attestCessationDirect(api, queued.id, roundId, "other", "a second try");
    expect(repeat).toEqual({ status: 200, round: round1 });
    const late = await runner.post(`/api/runner/rounds/${roundId}/events`, {
      headers: { authorization: `Bearer ${token}` },
      data: { type: "progress", idempotencyKey: `late-${stamp}`, claimEpoch: 1, occurredAt: new Date().toISOString(), data: { note: "still here" } },
    });
    expect(late.status()).toBe(409);
    expect((await late.json() as { error: { code: string } }).error.code).toBe("round_not_open");
    expect(await listRounds(api, queued.id)).toEqual([round1]);

    second = startMichelin(token, 500, DELIVERING);
    await readyClaimsRoundTwo(page, api, queued.id, second, round1!);
    expect(second.output()).not.toContain("round event refused");
    expect(second.output()).not.toContain(token);
    await exitCleanly(second);
    exited = true;
  } finally {
    if (!exited) second?.child.kill("SIGKILL");
    if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill("SIGKILL");
    await context.close();
    await runner.dispose();
    await api.dispose();
  }
});

test("a restarted runner that cannot confirm execution holds the Round until the Owner attests it stopped; the same runner then claims Round 2", async ({ playwright, browser, request }) => {
  const baseURL = process.env.E2E_BASE_URL;
  const api = await playwright.request.newContext({ baseURL });
  const stamp = Date.now();
  await signInWithoutBrowser(api);
  const queued = await queueForAgent(api, `Attest unknown ${stamp}`, `Restarted ${stamp}`);
  const token = await pairRunnerViaApi(api);
  const first = startMichelin(token, 500, HOLDING);
  let restarted: RunningMichelin | undefined;
  let exited = false;
  const context = await browser.newContext({ baseURL });
  try {
    await expect.poll(() => first.output(), { timeout: 15_000 }).toContain('"msg":"engine holding"');
    const roundId = (await ticket(api, queued.id)).openRound!.id;
    first.child.kill("SIGKILL");
    await once(first.child, "exit");

    restarted = startMichelin(token, 500, DELIVERING);
    await expect.poll(async () => (await ticket(api, queued.id)).openRound?.waitingReason, { timeout: 15_000 }).toBe("execution_unknown");
    const unknown = await ticket(api, queued.id);
    expect(unknown).toMatchObject({ status: "InProgress", openRound: { id: roundId, state: "running" } });
    expect(unknown.allowedActions.attestCessation).toEqual({ available: true });

    const page = await context.newPage();
    await signIn(page, request, "owner");
    await page.goto(`/tickets/${queued.id}`);
    await expect(page.getByTestId("ticket-detail-execution-unknown")).toBeVisible();
    const note = "Rebooted the laptop running Michelin";
    const attested = await attestInTheBrowser(page, queued.id, "Other", note);
    const explanation = "Ended by Owner attestation: other.";
    expect(attested).toMatchObject({
      id: roundId,
      state: "interrupted",
      outcomeNote: explanation,
      attestation: { basis: "other", note, roundState: "running", claimEpoch: 1, holderHealth: "connected", holderLastSeenAt: expect.any(String), reconcileExecution: "unknown" },
    });
    await expectAttestedReceipt(page, explanation, "Other", note);
    expect(await ticket(api, queued.id)).toMatchObject({ status: "Blocked", openRound: null, delivery: null, badges: [] });
    const [round1] = await listRounds(api, queued.id);
    expect(round1!.activity.map((each) => each.note)).toEqual(["Reading the Ticket", UNKNOWN, explanation]);

    const later = restarted;
    await readyClaimsRoundTwo(page, api, queued.id, later, round1!);
    const log = later.output();
    const reconciled = lines(log, "reconciled");
    expect(reconciled.length).toBeGreaterThanOrEqual(1);
    expect(new Set(reconciled.map((line) => `${line["roundId"]} ${line["execution"]} ${line["disposition"]}`))).toEqual(new Set([`${roundId} unknown hold`]));
    expect(log.lastIndexOf('"msg":"reconciled"')).toBeLessThan(log.indexOf('"msg":"round claimed"'));
    expect(log).not.toContain("round event refused");
    expect(log).not.toContain(token);
    await exitCleanly(later);
    exited = true;
  } finally {
    if (!exited) restarted?.child.kill("SIGKILL");
    if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill("SIGKILL");
    await context.close();
    await api.dispose();
  }
});
