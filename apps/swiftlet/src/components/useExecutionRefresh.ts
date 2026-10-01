import { useEffect, useLayoutEffect, useRef } from "react";
import type { Ticket } from "../api/tickets";

export const EXECUTION_REFRESH_MS = 3_000;

export const awaitsExecution = (ticket: Ticket): boolean => ticket.openRound !== null || ticket.requestingAgentWork;

/** `refresh` reports its own failures; a rejection only ends the call. */
export function useExecutionRefresh(active: boolean, refresh: () => Promise<void>): void {
  const latest = useRef(refresh);
  useLayoutEffect(() => {
    latest.current = refresh;
  });

  useEffect(() => {
    if (!active) return;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      const settled = () => {
        pending = false;
      };
      latest.current().then(settled, settled);
    }, EXECUTION_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active]);
}

/** Galley's data is JSON, so key order is stable and equal text means equal data. */
export function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
