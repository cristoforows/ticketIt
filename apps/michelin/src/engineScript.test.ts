import { describe, expect, it } from "vitest";
import { BODY_MARKDOWN_MAX_BYTES, DEFAULT_ENGINE_SCRIPT, type DeliverStep, parseEngineScript } from "./engineScript.ts";

function parse(text: string) {
  const problems: string[] = [];
  const script = parseEngineScript(text, problems);
  return { script, problems };
}

const scriptOf = (...steps: unknown[]) => JSON.stringify({ steps });

describe("the built-in default script", () => {
  it("starts, notes progress three times a second apart, observes usage once, then delivers a Markdown Report", () => {
    expect(DEFAULT_ENGINE_SCRIPT.steps.map((step) => step.step)).toEqual(["start", "progress", "wait", "progress", "wait", "progress", "usage", "deliver"]);
    const deliver = DEFAULT_ENGINE_SCRIPT.steps.at(-1) as DeliverStep;
    expect(deliver.bodyMarkdown).toMatch(/^# Result\n/);
    expect(deliver.bodyMarkdown).toContain("\n- ");
    expect(deliver.summary.length).toBeGreaterThan(0);
    expect(deliver.criteriaAssessment.length).toBeGreaterThan(0);
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
const DELIVER = { step: "deliver", bodyMarkdown: "# Done\n\n- one\n", summary: "Done.", criteriaAssessment: "Met." };
const FAIL = { step: "fail", explanation: "The repository is gone." };
const INTERRUPT = { step: "interrupt", evidence: "The engine process exited with signal 9." };
const deliverWith = (fields: Record<string, unknown>) => scriptOf({ step: "start" }, { ...DELIVER, ...fields });
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
    [
      "act steps at both length bounds",
      scriptOf({ step: "start" }, { step: "act", account: "controlled", action: "write_note", resource: "notes/a" }, { step: "act", account: "c", action: "a", resource: "é".repeat(200) }),
      [{ step: "start" }, { step: "act", account: "controlled", action: "write_note", resource: "notes/a" }, { step: "act", account: "c", action: "a", resource: "é".repeat(200) }],
    ],
    ["an ask at both length bounds", scriptOf({ step: "start" }, { step: "ask", question: "?" }, { step: "ask", question: "é".repeat(2000) }), [{ step: "start" }, { step: "ask", question: "?" }, { step: "ask", question: "é".repeat(2000) }]],
    ["a usage with every figure null", scriptOf({ step: "start" }, UNKNOWN_USAGE), [{ step: "start" }, UNKNOWN_USAGE]],
    ["a usage with absent figures, read as unknown", scriptOf({ step: "start" }, { step: "usage", provider: "p", model: "m", basis: "reported" }), [{ step: "start" }, UNKNOWN_USAGE]],
    ["usage at the count and cost bounds", scriptOf({ step: "start" }, { ...USAGE, inputTokens: Number.MAX_SAFE_INTEGER, costUsd: "999999.999999" }), [{ step: "start" }, { ...USAGE, inputTokens: Number.MAX_SAFE_INTEGER, costUsd: "999999.999999" }]],
    ["start then deliver", scriptOf({ step: "start" }, DELIVER), [{ step: "start" }, DELIVER]],
    ["progress, usage, then deliver", scriptOf({ step: "start" }, { step: "progress", note: "n" }, USAGE, DELIVER), [{ step: "start" }, { step: "progress", note: "n" }, USAGE, DELIVER]],
    ["a body of exactly 1 MiB", deliverWith({ bodyMarkdown: "a".repeat(BODY_MARKDOWN_MAX_BYTES) }), [{ step: "start" }, { ...DELIVER, bodyMarkdown: "a".repeat(BODY_MARKDOWN_MAX_BYTES) }]],
    ["a body of exactly 1 MiB in two-byte characters", deliverWith({ bodyMarkdown: "é".repeat(BODY_MARKDOWN_MAX_BYTES / 2) }), [{ step: "start" }, { ...DELIVER, bodyMarkdown: "é".repeat(BODY_MARKDOWN_MAX_BYTES / 2) }]],
    ["summary and assessment at their bounds", deliverWith({ summary: "é".repeat(2000), criteriaAssessment: "😀".repeat(10_000) }), [{ step: "start" }, { ...DELIVER, summary: "é".repeat(2000), criteriaAssessment: "😀".repeat(10_000) }]],
    ["tabs and line feeds in a deliverable", deliverWith({ bodyMarkdown: "a\tb\n", summary: "a\tb\n", criteriaAssessment: "a\tb\n" }), [{ step: "start" }, { ...DELIVER, bodyMarkdown: "a\tb\n", summary: "a\tb\n", criteriaAssessment: "a\tb\n" }]],
    ["a note of only U+FEFF, which Galley does not read as blank", scriptOf({ step: "start" }, { step: "progress", note: "\ufeff" }), [{ step: "start" }, { step: "progress", note: "\ufeff" }]],
    ["progress, usage, then fail", scriptOf({ step: "start" }, { step: "progress", note: "n" }, USAGE, FAIL), [{ step: "start" }, { step: "progress", note: "n" }, USAGE, FAIL]],
    ["start then interrupt", scriptOf({ step: "start" }, INTERRUPT), [{ step: "start" }, INTERRUPT]],
    ["an explanation at its length bound", scriptOf({ step: "start" }, { step: "fail", explanation: "é".repeat(2000) }), [{ step: "start" }, { step: "fail", explanation: "é".repeat(2000) }]],
    ["evidence of one character with tabs allowed", scriptOf({ step: "start" }, { step: "interrupt", evidence: "x" }), [{ step: "start" }, { step: "interrupt", evidence: "x" }]],
    ["an explanation with tabs and line feeds", scriptOf({ step: "start" }, { step: "fail", explanation: "a\tb\nc" }), [{ step: "start" }, { step: "fail", explanation: "a\tb\nc" }]],
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
    ["an unknown step name", scriptOf({ step: "start" }, { step: "sleep", ms: 5 }), /steps\[1\].*unknown step "sleep".*start, wait, progress, ask, act, usage, deliver, hold, fail, interrupt/],
    ["deliver before the last step", scriptOf({ step: "start" }, DELIVER, { step: "wait", ms: 10 }), /steps\[1\].*"deliver" may only be the last step/],
    ["deliver then hold", scriptOf({ step: "start" }, DELIVER, { step: "hold" }), /steps\[1\].*"deliver".*last.*mutually exclusive/],
    ["hold then deliver", scriptOf({ step: "start" }, { step: "hold" }, DELIVER), /steps\[1\].*"hold".*last.*mutually exclusive/],
    ["two delivers", scriptOf({ step: "start" }, DELIVER, DELIVER), /steps\[1\].*"deliver".*last/],
    ["fail before the last step", scriptOf({ step: "start" }, FAIL, { step: "wait", ms: 10 }), /steps\[1\].*"fail" may only be the last step/],
    ["interrupt before the last step", scriptOf({ step: "start" }, INTERRUPT, { step: "progress", note: "n" }), /steps\[1\].*"interrupt" may only be the last step/],
    ["fail then deliver", scriptOf({ step: "start" }, FAIL, DELIVER), /steps\[1\].*"fail".*last.*"hold", "deliver", "fail" and "interrupt" are mutually exclusive/],
    ["deliver then fail", scriptOf({ step: "start" }, DELIVER, FAIL), /steps\[1\].*"deliver".*last.*mutually exclusive/],
    ["interrupt then hold", scriptOf({ step: "start" }, INTERRUPT, { step: "hold" }), /steps\[1\].*"interrupt".*last.*mutually exclusive/],
    ["hold then interrupt", scriptOf({ step: "start" }, { step: "hold" }, INTERRUPT), /steps\[1\].*"hold".*last.*mutually exclusive/],
    ["fail then interrupt", scriptOf({ step: "start" }, FAIL, INTERRUPT), /steps\[1\].*"fail".*last.*mutually exclusive/],
    ["fail as the first step", scriptOf(FAIL), /steps\[0\].*start/],
    ["fail without an explanation", scriptOf({ step: "start" }, { step: "fail" }), /steps\[1\].*"explanation" must be 1 to 2000 characters/],
    ["an empty explanation", scriptOf({ step: "start" }, { step: "fail", explanation: "" }), /steps\[1\].*"explanation"/],
    ["a blank explanation", scriptOf({ step: "start" }, { step: "fail", explanation: " \n\u0085" }), /steps\[1\].*"explanation".*not blank/],
    ["an explanation over 2000 characters", scriptOf({ step: "start" }, { step: "fail", explanation: "é".repeat(2001) }), /steps\[1\].*"explanation".*2000/],
    ["an explanation with a carriage return", scriptOf({ step: "start" }, { step: "fail", explanation: "a\rb" }), /steps\[1\].*"explanation".*control/],
    ["an explanation that is not a string", scriptOf({ step: "start" }, { step: "fail", explanation: 5 }), /steps\[1\].*"explanation"/],
    ["fail given evidence", scriptOf({ step: "start" }, { step: "fail", evidence: "x" }), /steps\[1\].*unknown key "evidence"/],
    ["interrupt without evidence", scriptOf({ step: "start" }, { step: "interrupt" }), /steps\[1\].*"evidence" must be 1 to 2000 characters/],
    ["blank evidence", scriptOf({ step: "start" }, { step: "interrupt", evidence: "\t" }), /steps\[1\].*"evidence".*not blank/],
    ["evidence over 2000 characters", scriptOf({ step: "start" }, { step: "interrupt", evidence: "a".repeat(2001) }), /steps\[1\].*"evidence".*2000/],
    ["evidence with an escape character", scriptOf({ step: "start" }, { step: "interrupt", evidence: "a\u001bb" }), /steps\[1\].*"evidence".*control/],
    ["interrupt given an explanation", scriptOf({ step: "start" }, { step: "interrupt", evidence: "x", explanation: "y" }), /steps\[1\].*unknown key "explanation"/],
    ["deliver as the first step", scriptOf(DELIVER), /steps\[0\].*start/],
    ["a body of 1 MiB + 1", deliverWith({ bodyMarkdown: "a".repeat(BODY_MARKDOWN_MAX_BYTES + 1) }), /steps\[1\].*"bodyMarkdown".*1048576 bytes/],
    ["a body of 1 MiB + 1 in two-byte characters", deliverWith({ bodyMarkdown: "é".repeat(BODY_MARKDOWN_MAX_BYTES / 2) + "a" }), /steps\[1\].*"bodyMarkdown"/],
    ["an empty body", deliverWith({ bodyMarkdown: "" }), /steps\[1\].*"bodyMarkdown"/],
    ["a blank body", deliverWith({ bodyMarkdown: " \n\u3000" }), /steps\[1\].*"bodyMarkdown".*not blank/],
    ["a body of only U+0085, which Galley reads as blank", deliverWith({ bodyMarkdown: "\u0085" }), /steps\[1\].*"bodyMarkdown"/],
    ["a body with a carriage return", deliverWith({ bodyMarkdown: "a\r\nb" }), /steps\[1\].*"bodyMarkdown".*control/],
    ["a body that is not a string", deliverWith({ bodyMarkdown: ["a"] }), /steps\[1\].*"bodyMarkdown"/],
    ["deliver without a body", deliverWith({ bodyMarkdown: undefined }), /steps\[1\].*"bodyMarkdown"/],
    ["a summary over 2000 characters", deliverWith({ summary: "é".repeat(2001) }), /steps\[1\].*"summary".*2000/],
    ["a blank summary", deliverWith({ summary: "\t" }), /steps\[1\].*"summary"/],
    ["a summary with an escape character", deliverWith({ summary: "a\u001bb" }), /steps\[1\].*"summary".*control/],
    ["deliver without a summary", deliverWith({ summary: undefined }), /steps\[1\].*"summary"/],
    ["an assessment over 10000 characters", deliverWith({ criteriaAssessment: "a".repeat(10_001) }), /steps\[1\].*"criteriaAssessment".*10000/],
    ["a blank assessment", deliverWith({ criteriaAssessment: "\n" }), /steps\[1\].*"criteriaAssessment"/],
    ["an assessment with DEL", deliverWith({ criteriaAssessment: "a\u007fb" }), /steps\[1\].*"criteriaAssessment".*control/],
    ["deliver without an assessment", deliverWith({ criteriaAssessment: undefined }), /steps\[1\].*"criteriaAssessment"/],
    ["an unknown key on deliver", deliverWith({ pullRequest: "x" }), /steps\[1\].*unknown key "pullRequest"/],
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
    ["an ask without a question", scriptOf({ step: "start" }, { step: "ask" }), /steps\[1\].*"question" must be 1 to 2000/],
    ["an ask with a blank question", scriptOf({ step: "start" }, { step: "ask", question: " \n " }), /steps\[1\].*"question"/],
    ["an ask over 2000 characters", scriptOf({ step: "start" }, { step: "ask", question: "é".repeat(2001) }), /steps\[1\].*"question"/],
    ["an ask with a control character", scriptOf({ step: "start" }, { step: "ask", question: "a\u0007b" }), /steps\[1\].*"question"/],
    ["an ask with an unknown key", scriptOf({ step: "start" }, { step: "ask", question: "q", options: ["a"] }), /steps\[1\].*unknown key "options"/],
    ["an ask before start", scriptOf({ step: "ask", question: "q" }), /steps\[0\].*first step must be "start"/],
    ["an act without a resource", scriptOf({ step: "start" }, { step: "act", account: "controlled", action: "write_note" }), /steps\[1\].*"resource" must be 1 to 200/],
    ["an act with a blank action", scriptOf({ step: "start" }, { step: "act", account: "controlled", action: " ", resource: "notes/a" }), /steps\[1\].*"action"/],
    ["an act with a numeric account", scriptOf({ step: "start" }, { step: "act", account: 7, action: "write_note", resource: "notes/a" }), /steps\[1\].*"account"/],
    ["an act with a control character", scriptOf({ step: "start" }, { step: "act", account: "controlled", action: "write_note", resource: "notes/a\nb" }), /steps\[1\].*"resource"/],
    ["an act over 200 characters", scriptOf({ step: "start" }, { step: "act", account: "controlled", action: "write_note", resource: "é".repeat(201) }), /steps\[1\].*"resource"/],
    ["an act with a form", scriptOf({ step: "start" }, { step: "act", account: "controlled", action: "write_note", resource: "notes/a", form: "ticket" }), /steps\[1\].*unknown key "form"/],
  ])("rejects %s, naming the step index", (_name, text, message) => {
    const { script, problems } = parse(text);
    expect(script).toBeUndefined();
    expect(problems.some((problem) => message.test(problem))).toBe(true);
  });

  it("reports every problem at once, each with its step index", () => {
    const { script, problems } = parse(scriptOf({ step: "wait", ms: 0 }, { step: "deliver" }, { step: "hold" }, { step: "start" }));
    expect(problems.some((problem) => /steps\[1\].*"bodyMarkdown"/.test(problem))).toBe(true);
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
