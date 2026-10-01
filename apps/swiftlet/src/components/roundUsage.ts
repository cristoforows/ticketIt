import type { RoundUsage, UsageCount } from "../api/rounds";

export interface UsageFigure {
  text: string;
  estimated: boolean;
}

/** Cost stays a decimal string from Galley to the screen, so no float ever rounds it. */
export function dollars(costUsd: string): string {
  const [whole, fraction = ""] = costUsd.split(".");
  const cents = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

export function activeTime(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3_600).toLocaleString("en-US")} h ${Math.floor((seconds % 3_600) / 60)} min`;
}

function figure(sum: string | null, complete: boolean, estimated: boolean): UsageFigure {
  if (sum === null) return { text: "Unknown", estimated: false };
  return { text: complete ? sum : `≥ ${sum} (incomplete)`, estimated };
}

export function costFigure(usage: RoundUsage): UsageFigure {
  return figure(usage.costUsd === null ? null : dollars(usage.costUsd), usage.complete, usage.estimated);
}

export function countFigure(count: UsageCount, format: (value: number) => string = (value) => value.toLocaleString("en-US")): UsageFigure {
  return figure(count.sum === null ? null : format(count.sum), count.complete, count.estimated);
}
