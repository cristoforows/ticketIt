import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveRunnerCredential } from "./credentials.ts";

const TOKEN = `tir_${"A".repeat(42)}Q`;

describe("resolveRunnerCredential", () => {
  it("builds a bearer header from MICHELIN_RUNNER_TOKEN", () => {
    const problems: string[] = [];
    const credential = resolveRunnerCredential({ MICHELIN_RUNNER_TOKEN: TOKEN }, problems);
    expect(problems).toEqual([]);
    expect(credential?.authorizationHeader()).toBe(`Bearer ${TOKEN}`);
  });

  it("never reveals the token through string, JSON, inspection, or spreading", () => {
    const credential = resolveRunnerCredential({ MICHELIN_RUNNER_TOKEN: TOKEN }, []);
    const renderings = [String(credential), `${credential}`, JSON.stringify({ credential }), inspect(credential), inspect({ ...credential }), JSON.stringify(credential)];
    for (const rendering of renderings) {
      expect(rendering).not.toContain(TOKEN.slice(4));
    }
  });

  it.each([
    ["missing", undefined, "is required"],
    ["empty", "", "is required"],
    ["wrong prefix", `tis_${"A".repeat(43)}`, "must be tir_"],
    ["short", `tir_${"A".repeat(42)}`, "must be tir_"],
    ["long", `tir_${"A".repeat(44)}`, "must be tir_"],
    ["standard base64", `tir_${"+".repeat(43)}`, "must be tir_"],
    ["padded", `tir_${"A".repeat(43)}=`, "must be tir_"],
    ["surrounding whitespace", ` tir_${"A".repeat(43)}`, "must be tir_"],
  ])("rejects a %s token without echoing it", (_name, value, message) => {
    const problems: string[] = [];
    expect(resolveRunnerCredential({ MICHELIN_RUNNER_TOKEN: value }, problems)).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(message);
    if (value) {
      expect(problems[0]).not.toContain(value.trim().slice(4));
    }
  });
});
