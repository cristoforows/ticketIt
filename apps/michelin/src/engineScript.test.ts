import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_SCRIPT, parseEngineScript } from "./engineScript.ts";

function parse(text: string) {
  const problems: string[] = [];
  const script = parseEngineScript(text, problems);
  return { script, problems };
}

const scriptOf = (...steps: unknown[]) => JSON.stringify({ steps });

describe("the built-in default script", () => {
  it("starts and then holds, until progress and delivery land with M4.9 and M4.10", () => {
    expect(DEFAULT_ENGINE_SCRIPT).toEqual({ steps: [{ step: "start" }, { step: "hold" }] });
  });
});

describe("parseEngineScript", () => {
  it.each([
    ["start then hold", scriptOf({ step: "start" }, { step: "hold" }), [{ step: "start" }, { step: "hold" }]],
    ["start alone", scriptOf({ step: "start" }), [{ step: "start" }]],
    ["start, wait, hold", scriptOf({ step: "start" }, { step: "wait", ms: 1500 }, { step: "hold" }), [{ step: "start" }, { step: "wait", ms: 1500 }, { step: "hold" }]],
    ["waits at both bounds", scriptOf({ step: "start" }, { step: "wait", ms: 1 }, { step: "wait", ms: 3_600_000 }), [{ step: "start" }, { step: "wait", ms: 1 }, { step: "wait", ms: 3_600_000 }]],
    ["start then a finite wait", scriptOf({ step: "start" }, { step: "wait", ms: 50 }), [{ step: "start" }, { step: "wait", ms: 50 }]],
  ])("accepts %s", (_name, text, steps) => {
    const { script, problems } = parse(text);
    expect(problems).toEqual([]);
    expect(script).toEqual({ steps });
  });

  it.each([
    ["not JSON", "{", /is not valid JSON/],
    ["an empty file", "", /is not valid JSON/],
    ["a JSON array", "[]", /must be a JSON object/],
    ["JSON null", "null", /must be a JSON object/],
    ["an object without steps", "{}", /"steps" must be a non-empty array/],
    ["steps that is not an array", '{"steps":{}}', /"steps" must be a non-empty array/],
    ["an empty steps array", '{"steps":[]}', /"steps" must be a non-empty array/],
    ["an unknown top-level key", '{"steps":[{"step":"start"}],"loop":true}', /unknown key "loop"/],
  ])("rejects %s", (_name, text, message) => {
    const { script, problems } = parse(text);
    expect(script).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(message);
  });

  it.each([
    ["a first step that is not start", scriptOf({ step: "wait", ms: 10 }, { step: "start" }), /steps\[0\].*start/],
    ["a missing start", scriptOf({ step: "hold" }), /steps\[0\].*start/],
    ["start twice", scriptOf({ step: "start" }, { step: "start" }), /steps\[1\].*start.*once/],
    ["hold before the last step", scriptOf({ step: "start" }, { step: "hold" }, { step: "wait", ms: 10 }), /steps\[1\].*hold.*last/],
    ["two holds", scriptOf({ step: "start" }, { step: "hold" }, { step: "hold" }), /steps\[1\].*hold.*last/],
    ["a step that is not an object", scriptOf({ step: "start" }, "wait"), /steps\[1\].*must be an object/],
    ["a step without a name", scriptOf({ step: "start" }, { ms: 5 }), /steps\[1\].*"step" must be a string/],
    ["a step name that is not a string", scriptOf({ step: "start" }, { step: 7 }), /steps\[1\].*"step" must be a string/],
    ["an unknown step name", scriptOf({ step: "start" }, { step: "sleep", ms: 5 }), /steps\[1\].*unknown step "sleep".*start, wait, hold/],
    ["wait without ms", scriptOf({ step: "start" }, { step: "wait" }), /steps\[1\].*"ms"/],
    ["wait with zero ms", scriptOf({ step: "start" }, { step: "wait", ms: 0 }), /steps\[1\].*"ms".*1.*3600000/],
    ["wait with negative ms", scriptOf({ step: "start" }, { step: "wait", ms: -5 }), /steps\[1\].*"ms"/],
    ["wait with fractional ms", scriptOf({ step: "start" }, { step: "wait", ms: 1.5 }), /steps\[1\].*"ms"/],
    ["wait with string ms", scriptOf({ step: "start" }, { step: "wait", ms: "10" }), /steps\[1\].*"ms"/],
    ["wait with too many ms", scriptOf({ step: "start" }, { step: "wait", ms: 3_600_001 }), /steps\[1\].*"ms"/],
    ["an unknown key on start", scriptOf({ step: "start", ms: 5 }), /steps\[0\].*unknown key "ms"/],
    ["an unknown key on wait", scriptOf({ step: "start" }, { step: "wait", ms: 5, seconds: 1 }), /steps\[1\].*unknown key "seconds"/],
    ["an unknown key on hold", scriptOf({ step: "start" }, { step: "hold", ms: 5 }), /steps\[1\].*unknown key "ms"/],
  ])("rejects %s, naming the step index", (_name, text, message) => {
    const { script, problems } = parse(text);
    expect(script).toBeUndefined();
    expect(problems.some((problem) => message.test(problem))).toBe(true);
  });

  it.each([
    ["progress", { step: "progress", note: "hello" }, /steps\[1\].*"progress".*M4\.9/],
    ["usage", { step: "usage" }, /steps\[1\].*"usage".*M4\.9/],
    ["deliver", { step: "deliver" }, /steps\[1\].*"deliver".*M4\.10/],
  ])("rejects the %s step and names the slice that adds it", (_name, step, message) => {
    const { script, problems } = parse(scriptOf({ step: "start" }, step));
    expect(script).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(message);
    expect(problems[0]).toContain("start, wait, hold");
  });

  it("reports every problem at once, each with its step index", () => {
    const { script, problems } = parse(scriptOf({ step: "wait", ms: 0 }, { step: "deliver" }, { step: "hold" }, { step: "start" }));
    expect(script).toBeUndefined();
    expect(problems.filter((problem) => /steps\[0\]/.test(problem)).length).toBeGreaterThanOrEqual(1);
    expect(problems.some((problem) => /steps\[1\].*deliver/.test(problem))).toBe(true);
    expect(problems.some((problem) => /steps\[2\].*hold.*last/.test(problem))).toBe(true);
    expect(problems.some((problem) => /steps\[3\].*start/.test(problem))).toBe(true);
  });

  it("never echoes the file's content in a problem", () => {
    const { problems } = parse('{"steps": [{"step": "start", "secret-looking-value": "tir_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"}]}');
    expect(problems).toHaveLength(1);
    expect(problems[0]).not.toContain("tir_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
    const invalid = parse("{ tir_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
    expect(invalid.problems.join(" ")).not.toContain("tir_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
  });
});
