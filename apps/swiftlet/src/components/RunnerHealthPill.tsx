import { useEffect, useSyncExternalStore } from "react";
import { fetchRunnerHealth, lastSeenLabel, RUNNER_HEALTH_CHANGED, RUNNER_HEALTH_REFRESH_MS, type RunnerHealth } from "../api/runner";
import { UnauthenticatedError } from "../api/session";
import { HealthPill, localTimestamp, type HealthPillState } from "./ui";

export type HealthView = { kind: "loading" } | { kind: "loaded"; health: RunnerHealth } | { kind: "error" };

export function runnerHealthLabel(health: RunnerHealth): string {
  switch (health.state) {
    case "connected":
      return "Runner connected";
    case "disconnected":
      return "Runner disconnected";
    case "not_paired":
      return "Runner not paired";
  }
}

const LOADING: HealthView = { kind: "loading" };

const shared = {
  view: LOADING as HealthView,
  latest: 0,
  timer: undefined as number | undefined,
  listeners: new Set<() => void>(),
  unauthenticated: new Set<() => void>(),
};

function publish(view: HealthView) {
  shared.view = view;
  shared.listeners.forEach((listener) => listener());
}

async function reloadSharedHealth(): Promise<void> {
  const request = ++shared.latest;
  try {
    const health = await fetchRunnerHealth();
    if (request === shared.latest) publish({ kind: "loaded", health });
  } catch (error) {
    if (error instanceof UnauthenticatedError) shared.unauthenticated.forEach((callback) => callback());
    if (request === shared.latest) publish({ kind: "error" });
  }
}

const onHealthChanged = () => void reloadSharedHealth();

function subscribeSharedHealth(listener: () => void): () => void {
  shared.listeners.add(listener);
  if (shared.listeners.size === 1) {
    void reloadSharedHealth();
    shared.timer = window.setInterval(() => void reloadSharedHealth(), RUNNER_HEALTH_REFRESH_MS);
    window.addEventListener(RUNNER_HEALTH_CHANGED, onHealthChanged);
  }
  return () => {
    shared.listeners.delete(listener);
    if (shared.listeners.size > 0) return;
    window.clearInterval(shared.timer);
    window.removeEventListener(RUNNER_HEALTH_CHANGED, onHealthChanged);
    shared.latest++;
    shared.view = LOADING;
  };
}

const subscribeNothing = () => () => {};

// The header, the receipt and the Runner page share one poll so they never disagree (M4 gate, #162).
export function useRunnerHealth(onUnauthenticated: () => void, enabled = true): { view: HealthView; reload: () => Promise<void> } {
  const view = useSyncExternalStore(enabled ? subscribeSharedHealth : subscribeNothing, () => (enabled ? shared.view : LOADING));

  useEffect(() => {
    if (!enabled) return;
    shared.unauthenticated.add(onUnauthenticated);
    return () => { shared.unauthenticated.delete(onUnauthenticated); };
  }, [onUnauthenticated, enabled]);

  return { view, reload: reloadSharedHealth };
}

export function RunnerHealthIndicator({ view, tone = "ground", live = true }: { view: HealthView; tone?: "ground" | "paper"; live?: boolean }) {
  const health: HealthPillState = view.kind === "loaded" ? view.health.state : "unknown";
  const label = view.kind === "loaded" ? runnerHealthLabel(view.health) : view.kind === "error" ? "Runner status unavailable" : "Checking runner…";
  const lastSeen = view.kind === "loaded" && view.health.state === "disconnected" ? lastSeenLabel(view.health) : undefined;
  return (
    <HealthPill
      health={health}
      tone={tone}
      data-testid="runner-health-pill"
      title={view.kind === "loaded" && view.health.lastSeenAt ? `Last heartbeat ${localTimestamp(view.health.lastSeenAt)}` : undefined}
    >
      <span role={live ? "status" : undefined} data-testid="runner-health-state">{label}</span>
      {lastSeen && <span data-testid="runner-health-last-seen" className="font-normal normal-case tracking-normal">· {lastSeen}</span>}
    </HealthPill>
  );
}

export function RunnerHealthPill({ onUnauthenticated }: { onUnauthenticated: () => void }) {
  const { view } = useRunnerHealth(onUnauthenticated);
  return <RunnerHealthIndicator view={view} />;
}
