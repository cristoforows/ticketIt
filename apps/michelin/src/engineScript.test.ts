import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_SCRIPT, parseEngineScript } from "./engineScript.ts";

function parse(text: string) {
  const problems: string[] = [];
  const script = parseEngineScript(text, problems);
  return { script, problems };
}

const scriptOf = (...steps: unknown[]) => JSON.stringify({ steps });

describe("the built-in default script", () => {
  it("starts, notes progress three times a second apart, observes usage once, then holds where M4.10 will deliver", () => {
    expect(DEFAULT_ENGINE_SCRIPT.steps.map((step) => step.step)).toEqual(["start", "progress", "wait", "progress", "wait", "progress", "usage", "hold"]);
    expect(DEFAULT_ENGINE_SCRIPT.steps.filter((step) => step.step === "wait")).toEqual([
      { step: "wait", ms: 1000 },
      { step: "wait", ms: 1000 },
    ]);
  });

  it("is a script its own parser accepts unchanged", () => {
    const { script, problems } = parse(JSON.stringify(DEFAULT_ENGINE_SCRIPT));
    expect(problems).toEqual([]);
    expect(script).toEqual(DEFAULT_ENGINE_SCRIPT);
  });
});

const USAGE = {
  step: "usage",
  provider: "openrouter",
  model: "m",
  inputTokens: 10,
  outputTokens: 0,
  costUsd: "0.000001",
  activeMs: 5,
  basis: "estimated",
  providerGenerationId: "gen-1",
};
const UNKNOWN_USAGE = { step: "usage", provider: "p", model: "m", inputTokens: null, outputTokens: null, costUsd: null, activeMs: null, basis: "reported", providerGenerationId: null };

describe("parseEngineScript", () => {
  it.each([
    ["start then hold", scriptOf({ step: "start" }, { step: "hold" }), [{ step: "start" }, { step: "hold" }]],
    ["start alone", scriptOf({ step: "start" }), [{ step: "start" }]],
    ["start, wait, hold", scriptOf({ step: "start" }, { step: "wait", ms: 1500 }, { step: "hold" }), [{ step: "start" }, { step: "wait", ms: 1500 }, { step: "hold" }]],
    ["waits at both bounds", scriptOf({ step: "start" }, { step: "wait", ms: 1 }, { step: "wait", ms: 3_600_000 }), [{ step: "start" }, { step: "wait", ms: 1 }, { step: "wait", ms: 3_600_000 }]],
    ["start then a finite wait", scriptOf({ step: "start" }, { step: "wait", ms: 50 }), [{ step: "start" }, { step: "wait", ms: 50 }]],
    ["progress notes at both length bounds", scriptOf({ step: "start" }, { step: "progress", note: "x" }, { step: "progress", note: "é".repeat(2000) }), [{ step: "start" }, { step: "progress", note: "x" }, { step: "progress", note: "é".repeat(2000) }]],
    ["a note with tabs and line feeds", scriptOf({ step: "start" }, { step: "progress", note: "a\tb\nc" }), [{ step: "start" }, { step: "progress", note: "a\tb\nc" }]],
    ["a fully known usage", scriptOf({ step: "start" }, USAGE), [{ step: "start" }, USAGE]],
    ["a usage with every figure null", scriptOf({ step: "start" }, UNKNOWN_USAGE), [{ step: "start" }, UNKNOWN_USAGE]],
    ["a usage with absent figures, read as unknown", scriptOf({ step: "start" }, { step: "usage", provider: "p", model: "m", basis: "reported" }), [{ step: "start" }, UNKNOWN_USAGE]],
    ["usage at the count and cost bounds", scriptOf({ step: "start" }, { ...USAGE, inputTokens: Number.MAX_SAFE_INTEGER, costUsd: "999999.999999" }), [{ step: "start" }, { ...USAGE, inputTokens: Number.MAX_SAFE_INTEGER, costUsd: "999999.999999" }]],
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
    ["an unknown step name", scriptOf({ step: "start" }, { step: "sleep", ms: 5 }), /steps\[1\].*unknown step "sleep".*start, wait, progress, usage, hold/],
    ["progress without a note", scriptOf({ step: "start" }, { step: "progress" }), /steps\[1\].*"note"/],
    ["an empty note", scriptOf({ step: "start" }, { step: "progress", note: "" }), /steps\[1\].*"note"/],
    ["a blank note", scriptOf({ step: "start" }, { step: "progress", note: " \n\t\u00a0" }), /steps\[1\].*"note".*not blank/],
    ["a note over 2000 characters", scriptOf({ step: "start" }, { step: "progress", note: "é".repeat(2001) }), /steps\[1\].*"note".*2000/],
    ["a note with a carriage return", scriptOf({ step: "start" }, { step: "progress", note: "a\rb" }), /steps\[1\].*"note".*control/],
    ["a note that is not a string", scriptOf({ step: "start" }, { step: "progress", note: 5 }), /steps\[1\].*"note"/],
    ["an unknown key on progress", scriptOf({ step: "start" }, { step: "progress", note: "n", seq: 1 }), /steps\[1\].*unknown key "seq"/],
    ["usage without a provider", scriptOf({ step: "start" }, { ...USAGE, provider: undefined }), /steps\[1\].*"provider"/],
    ["usage with an empty model", scriptOf({ step: "start" }, { ...USAGE, model: "" }), /steps\[1\].*"model"/],
    ["usage with a model over 200 characters", scriptOf({ step: "start" }, { ...USAGE, model: "m".repeat(201) }), /steps\[1\].*"model"/],
    ["usage with a negative token count", scriptOf({ step: "start" }, { ...USAGE, inputTokens: -1 }), /steps\[1\].*"inputTokens"/],
    ["usage with a fractional token count", scriptOf({ step: "start" }, { ...USAGE, outputTokens: 1.5 }), /steps\[1\].*"outputTokens"/],
    ["usage with an unsafe count", scriptOf({ step: "start" }, { ...USAGE, activeMs: Number.MAX_SAFE_INTEGER + 1 }), /steps\[1\].*"activeMs"/],
    ["usage with a numeric cost", scriptOf({ step: "start" }, { ...USAGE, costUsd: 0.5 }), /steps\[1\].*"costUsd"/],
    ["usage with seven decimal places", scriptOf({ step: "start" }, { ...USAGE, costUsd: "0.0000001" }), /steps\[1\].*"costUsd"/],
    ["usage with a cost over the bound", scriptOf({ step: "start" }, { ...USAGE, costUsd: "1000000" }), /steps\[1\].*"costUsd"/],
    ["usage with a negative cost", scriptOf({ step: "start" }, { ...USAGE, costUsd: "-1" }), /steps\[1\].*"costUsd"/],
    ["usage without a basis", scriptOf({ step: "start" }, { ...USAGE, basis: undefined }), /steps\[1\].*"basis"/],
    ["usage with an unknown basis", scriptOf({ step: "start" }, { ...USAGE, basis: "guessed" }), /steps\[1\].*"basis"/],
    ["usage with an empty generation id", scriptOf({ step: "start" }, { ...USAGE, providerGenerationId: "" }), /steps\[1\].*"providerGenerationId"/],
    ["usage naming its own observationId", scriptOf({ step: "start" }, { ...USAGE, observationId: "x" }), /steps\[1\].*unknown key "observationId"/],
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

  it("rejects the deliver step and names the slice that adds it", () => {
    const { script, problems } = parse(scriptOf({ step: "start" }, { step: "deliver" }));
    expect(script).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/steps\[1\].*"deliver".*M4\.10/);
    expect(problems[0]).toContain("start, wait, progress, usage, hold");
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
