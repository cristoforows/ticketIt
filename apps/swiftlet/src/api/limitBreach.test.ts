import { describe, expect, it } from "vitest";
import { formatSeconds, limitBreachLabel, parseLimitBreach } from "./limitBreach";

const WALL_CLOCK = { kind: "wall_clock", limit: 14400, measured: 14401, breachedAt: "2026-10-01T14:00:01Z" };

describe("parseLimitBreach", () => {
  it("keeps null and a well-formed breach of either kind", () => {
    expect(parseLimitBreach(null)).toBeNull();
    expect(parseLimitBreach(WALL_CLOCK)).toEqual(WALL_CLOCK);
    expect(parseLimitBreach({ ...WALL_CLOCK, kind: "denial_loop", limit: 1, measured: 1 })).toEqual({ ...WALL_CLOCK, kind: "denial_loop", limit: 1, measured: 1 });
  });

  it.each([
    ["an absent field", undefined],
    ["an array", [WALL_CLOCK]],
    ["a string", "wall_clock"],
    ["an unknown kind", { ...WALL_CLOCK, kind: "budget" }],
    ["no kind", { ...WALL_CLOCK, kind: undefined }],
    ["a limit of zero", { ...WALL_CLOCK, limit: 0, measured: 0 }],
    ["a fractional limit", { ...WALL_CLOCK, limit: 1.5 }],
    ["a string limit", { ...WALL_CLOCK, limit: "14400" }],
    ["a measure under the limit", { ...WALL_CLOCK, measured: 14399 }],
    ["an unsafe measure", { ...WALL_CLOCK, measured: 2 ** 53 }],
    ["no breachedAt", { ...WALL_CLOCK, breachedAt: undefined }],
    ["a numeric breachedAt", { ...WALL_CLOCK, breachedAt: 5 }],
  ])("rejects %s", (_name, value) => {
    expect(parseLimitBreach(value)).toBeUndefined();
  });
});

describe("limitBreachLabel", () => {
  it.each([
    [0, "0s"],
    [1, "1s"],
    [59, "59s"],
    [60, "1m0s"],
    [90, "1m30s"],
    [3599, "59m59s"],
    [3600, "1h0m0s"],
    [14401, "4h0m1s"],
    [604800, "168h0m0s"],
  ])("prints %i seconds as Go does: %s", (seconds, printed) => {
    expect(formatSeconds(seconds)).toBe(printed);
  });

  it("names the limit kind with the measure of the limit", () => {
    expect(limitBreachLabel({ ...WALL_CLOCK, kind: "wall_clock" })).toBe("Active time limit reached: 4h0m1s of 4h0m0s");
    expect(limitBreachLabel({ ...WALL_CLOCK, kind: "denial_loop", limit: 10, measured: 10 })).toBe("Denied-check limit reached: 10 of 10");
  });
});
