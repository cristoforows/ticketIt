import { describe, expect, it } from "vitest";
import { activeTime, dollars } from "./roundUsage";

describe("dollars", () => {
  it.each([
    ["0.000000", "$0.00"],
    ["0.004500", "$0.0045"],
    ["0.000001", "$0.000001"],
    ["0.300000", "$0.30"],
    ["12.000000", "$12.00"],
    ["1000123.750000", "$1,000,123.75"],
    ["999999.999999", "$999,999.999999"],
    ["9007199254740993.000001", "$9,007,199,254,740,993.000001"],
  ])("shows %s as %s without passing through a float", (cost, shown) => {
    expect(dollars(cost)).toBe(shown);
  });
});

describe("activeTime", () => {
  it.each([
    [0, "0 ms"],
    [999, "999 ms"],
    [1_000, "1.0 s"],
    [2_049, "2.0 s"],
    [59_999, "59.9 s"],
    [60_000, "1 min 0 s"],
    [3_599_999, "59 min 59 s"],
    [3_600_000, "1 h 0 min"],
    [90_061_000, "25 h 1 min"],
  ])("shows %i ms as %s", (ms, shown) => {
    expect(activeTime(ms)).toBe(shown);
  });
});
