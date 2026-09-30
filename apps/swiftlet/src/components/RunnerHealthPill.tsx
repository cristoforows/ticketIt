import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRunnerHealth, lastSeenLabel, RUNNER_HEALTH_CHANGED, RUNNER_HEALTH_REFRESH_MS, type RunnerHealth } from "../api/runner";
import { UnauthenticatedError } from "../api/session";
import { HealthPill, type HealthPillState } from "./ui";

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

export function useRunnerHealth(onUnauthenticated: () => void): { view: HealthView; reload: () => Promise<void> } {
  const [view, setView] = useState<HealthView>({ kind: "loading" });
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    try {
      const health = await fetchRunnerHealth();
      if (request === latest.current) setView({ kind: "loaded", health });
    } catch (error) {
      if (error instanceof UnauthenticatedError) onUnauthenticated();
      if (request === latest.current) setView({ kind: "error" });
    }
  }, [onUnauthenticated]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), RUNNER_HEALTH_REFRESH_MS);
    const onChanged = () => void reload();
    window.addEventListener(RUNNER_HEALTH_CHANGED, onChanged);
    return () => {
      latest.current++;
      window.clearInterval(timer);
      window.removeEventListener(RUNNER_HEALTH_CHANGED, onChanged);
    };
  }, [reload]);

  return { view, reload };
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
      title={view.kind === "loaded" && view.health.lastSeenAt ? `Last heartbeat ${new Date(view.health.lastSeenAt).toLocaleString()}` : undefined}
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
