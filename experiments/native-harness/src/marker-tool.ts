import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Side-effect counter a test can inspect after a turn to assert exactly how
 * many times the marker tool actually ran (not just how many times the
 * scripted model requested it).
 */
export class MarkerState {
  private count = 0;
  private readonly notes: string[] = [];

  record(note: string): number {
    this.count += 1;
    this.notes.push(note);
    return this.count;
  }

  get callCount(): number {
    return this.count;
  }

  get calls(): readonly string[] {
    return this.notes;
  }

  reset(): void {
    this.count = 0;
    this.notes.length = 0;
  }
}

const markerToolSchema = z.object({
  note: z
    .string()
    .optional()
    .describe("Optional free-text note to record alongside this marker call."),
});

/**
 * Builds a tool with a side-effect marker: every execution increments
 * `state.callCount` and appends to `state.calls`, so a boot test can assert
 * the marker tool ran exactly once for a scripted tool-calling turn.
 */
export function createMarkerTool(state: MarkerState) {
  return tool(
    async ({ note }: { note?: string }) => {
      const callNumber = state.record(note ?? "");
      return `marker recorded (call #${callNumber})`;
    },
    {
      name: "marker",
      description:
        "Records a side-effect marker. Used only to prove a scripted tool call actually executed.",
      schema: markerToolSchema,
    },
  );
}
