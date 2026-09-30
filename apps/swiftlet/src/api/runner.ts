import type { components } from "./generated/schema";
import { authenticatedFetch, errorMessage } from "./http";

export type RunnerHealth = components["schemas"]["RunnerHealth"];
export type RunnerHealthState = components["schemas"]["RunnerHealthState"];
export type RunnerPairing = components["schemas"]["RunnerPairing"];

export const RUNNER_HEALTH_REFRESH_MS = 10_000;
export const RUNNER_HEALTH_CHANGED = "ticketit:runner-health-changed";

const HEALTH_ENDPOINT = "/api/runner-health";
const CREDENTIAL_ENDPOINT = "/api/runner-credential";
const STATES: RunnerHealthState[] = ["connected", "disconnected", "not_paired"];
const TOKEN_SHAPE = /^tir_[A-Za-z0-9_-]{43}$/;

const isTimestamp = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isNullableTimestamp = (value: unknown) => value === null || isTimestamp(value);
const isNullableString = (value: unknown) => value === null || typeof value === "string";

export function isRunnerHealth(value: unknown): value is RunnerHealth {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return STATES.includes(record.state as RunnerHealthState) && isTimestamp(record.checkedAt) &&
    isNullableTimestamp(record.pairedAt) && isNullableTimestamp(record.registeredAt) && isNullableTimestamp(record.lastSeenAt) &&
    isNullableString(record.michelinVersion) && isNullableString(record.hostname);
}

async function runnerResponse(path: string, init?: RequestInit): Promise<unknown> {
  const response = await authenticatedFetch(path, init);
  if (response.status === 204) return undefined;
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? `Galley returned an error response: ${response.status} ${response.statusText}`.trim());
  }
  return payload;
}

function announceChange(health: RunnerHealth | undefined) {
  window.dispatchEvent(new CustomEvent(RUNNER_HEALTH_CHANGED, { detail: health }));
}

export async function fetchRunnerHealth(): Promise<RunnerHealth> {
  const payload = await runnerResponse(HEALTH_ENDPOINT);
  if (!isRunnerHealth(payload)) {
    throw new Error("Galley's runner health response was missing a required field.");
  }
  return payload;
}

export async function pairRunner(): Promise<RunnerPairing> {
  const payload = await runnerResponse(CREDENTIAL_ENDPOINT, { method: "POST" });
  const record = payload as Partial<RunnerPairing> | null;
  if (typeof record?.token !== "string" || !TOKEN_SHAPE.test(record.token) || !isRunnerHealth(record.health)) {
    throw new Error("Galley's pairing response was missing a required field.");
  }
  announceChange(record.health);
  return { token: record.token, health: record.health };
}

export async function revokeRunner(): Promise<void> {
  await runnerResponse(CREDENTIAL_ENDPOINT, { method: "DELETE" });
  announceChange(undefined);
}

export function lastSeenLabel(health: Pick<RunnerHealth, "lastSeenAt" | "checkedAt">): string {
  if (health.lastSeenAt === null) return "never connected";
  const seconds = Math.max(0, Math.round((Date.parse(health.checkedAt) - Date.parse(health.lastSeenAt)) / 1000));
  if (seconds < 60) return `last seen ${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `last seen ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `last seen ${hours} h ago`;
  return `last seen ${Math.floor(hours / 24)} days ago`;
}
