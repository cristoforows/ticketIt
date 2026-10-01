export type UsageBasis = "reported" | "estimated";

export interface UsageStep {
  step: "usage";
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  activeMs: number | null;
  basis: UsageBasis;
  providerGenerationId: string | null;
}

export interface DeliverStep {
  step: "deliver";
  bodyMarkdown: string;
  summary: string;
  criteriaAssessment: string;
}

export type EngineStep = { step: "start" } | { step: "wait"; ms: number } | { step: "progress"; note: string } | UsageStep | DeliverStep | { step: "hold" };

export interface EngineScript {
  steps: readonly EngineStep[];
}

export const MAX_WAIT_MS = 3_600_000;
export const NOTE_MAX_LENGTH = 2000;
export const LABEL_MAX_LENGTH = 200;
export const MAX_USAGE_COUNT = Number.MAX_SAFE_INTEGER;
export const BODY_MARKDOWN_MAX_BYTES = 1_048_576;
export const SUMMARY_MAX_LENGTH = 2000;
export const CRITERIA_ASSESSMENT_MAX_LENGTH = 10_000;

export const DEFAULT_ENGINE_SCRIPT: EngineScript = {
  steps: [
    { step: "start" },
    { step: "progress", note: "Reading the Ticket" },
    { step: "wait", ms: 1000 },
    { step: "progress", note: "Working towards the goal" },
    { step: "wait", ms: 1000 },
    { step: "progress", note: "Writing up the result" },
    {
      step: "usage",
      provider: "controlled",
      model: "scripted",
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: "0.004500",
      activeMs: 2000,
      basis: "reported",
      providerGenerationId: null,
    },
    {
      step: "deliver",
      bodyMarkdown: [
        "# Result",
        "",
        "The controlled engine worked through the Ticket's goal and wrote up what it found.",
        "",
        "## Findings",
        "",
        "- Read the goal and the success criteria",
        "- Worked towards the goal in three recorded steps",
        "- Recorded the usage it reported",
        "",
        "This Report was written by a scripted engine; no model ran.",
        "",
      ].join("\n"),
      summary: "A scripted write-up of the Ticket's goal from the controlled engine.",
      criteriaAssessment: "Each success criterion is addressed by the scripted write-up; the Owner judges whether it is met.",
    },
  ],
};

const SUPPORTED_STEPS = "start, wait, progress, usage, deliver, hold";

const USAGE_KEYS = ["provider", "model", "inputTokens", "outputTokens", "costUsd", "activeMs", "basis", "providerGenerationId"];

const DELIVER_KEYS = ["bodyMarkdown", "summary", "criteriaAssessment"];

// Mirrors Galley's limits (round_activity.go, usage_observations.go, round_deliverables.go) so a bad script fails at startup, not by abandoning a Round.
const COST_USD = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/;

export function parseEngineScript(text: string, problems: string[]): EngineScript | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    problems.push("the script is not valid JSON");
    return undefined;
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    problems.push("the script must be a JSON object");
    return undefined;
  }
  const { steps: rawSteps, ...rest } = root as Record<string, unknown>;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    problems.push('"steps" must be a non-empty array');
    return undefined;
  }
  const before = problems.length;
  for (const key of Object.keys(rest)) {
    problems.push(`unknown key ${JSON.stringify(key)}`);
  }
  const steps: EngineStep[] = [];
  rawSteps.forEach((raw: unknown, index) => {
    const step = parseStep(raw, index, rawSteps.length, problems);
    if (step !== undefined) {
      steps.push(step);
    }
  });
  return problems.length === before ? { steps } : undefined;
}

function parseStep(raw: unknown, index: number, total: number, problems: string[]): EngineStep | undefined {
  const at = `steps[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(`${at}: must be an object`);
    return undefined;
  }
  const { step: name, ...fields } = raw as Record<string, unknown>;
  if (typeof name !== "string") {
    problems.push(`${at}: "step" must be a string naming the step`);
    return undefined;
  }
  const known = new Set<string>();
  const flaws = problems.length;
  if (index === 0 && name !== "start") {
    problems.push(`${at}: the first step must be "start"`);
  } else if (index > 0 && name === "start") {
    problems.push(`${at}: "start" may appear only once, as the first step`);
  }
  switch (name) {
    case "start":
      break;
    case "hold":
    case "deliver":
      if (index < total - 1) {
        problems.push(`${at}: ${JSON.stringify(name)} may only be the last step; "hold" and "deliver" are mutually exclusive`);
      }
      if (name === "deliver") {
        DELIVER_KEYS.forEach((key) => known.add(key));
        checkDeliverable(fields, at, problems);
      }
      break;
    case "wait":
      known.add("ms");
      if (!Number.isInteger(fields["ms"]) || (fields["ms"] as number) < 1 || (fields["ms"] as number) > MAX_WAIT_MS) {
        problems.push(`${at}: "ms" must be an integer from 1 to ${MAX_WAIT_MS}`);
      }
      break;
    case "progress":
      known.add("note");
      if (!validNote(fields["note"])) {
        problems.push(`${at}: "note" must be 1 to ${NOTE_MAX_LENGTH} characters, not blank, without control characters other than tab and line feed`);
      }
      break;
    case "usage":
      USAGE_KEYS.forEach((key) => known.add(key));
      checkUsage(fields, at, problems);
      break;
    default:
      problems.push(`${at}: unknown step ${JSON.stringify(name)}; supported steps are ${SUPPORTED_STEPS}`);
      return undefined;
  }
  for (const key of Object.keys(fields)) {
    if (!known.has(key)) {
      problems.push(`${at}: unknown key ${JSON.stringify(key)}`);
    }
  }
  if (problems.length > flaws) {
    return undefined;
  }
  switch (name) {
    case "wait":
      return { step: "wait", ms: fields["ms"] as number };
    case "progress":
      return { step: "progress", note: fields["note"] as string };
    case "usage":
      return {
        step: "usage",
        provider: fields["provider"] as string,
        model: fields["model"] as string,
        inputTokens: (fields["inputTokens"] ?? null) as number | null,
        outputTokens: (fields["outputTokens"] ?? null) as number | null,
        costUsd: (fields["costUsd"] ?? null) as string | null,
        activeMs: (fields["activeMs"] ?? null) as number | null,
        basis: fields["basis"] as UsageBasis,
        providerGenerationId: (fields["providerGenerationId"] ?? null) as string | null,
      };
    case "deliver":
      return { step: "deliver", bodyMarkdown: fields["bodyMarkdown"] as string, summary: fields["summary"] as string, criteriaAssessment: fields["criteriaAssessment"] as string };
    default:
      return { step: name as "start" | "hold" };
  }
}

function hasControl(text: string, allowed: string): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0)!;
    return (code < 0x20 || code === 0x7f) && !allowed.includes(char);
  });
}

// Go's unicode.IsSpace, which Galley's blank check uses; JavaScript's \s differs at U+0085 and U+FEFF.
const NOT_GO_SPACE = /[^\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

function validMultilineText(value: unknown, measure: (text: string) => number, maxLength: number): value is string {
  if (typeof value !== "string") return false;
  const length = measure(value);
  return length >= 1 && length <= maxLength && NOT_GO_SPACE.test(value) && !hasControl(value, "\t\n");
}

const codePoints = (text: string): number => [...text].length;
const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function validNote(value: unknown): value is string {
  return validMultilineText(value, codePoints, NOTE_MAX_LENGTH);
}

function checkDeliverable(fields: Record<string, unknown>, at: string, problems: string[]): void {
  const rule = "not blank, without control characters other than tab and line feed";
  if (!validMultilineText(fields["bodyMarkdown"], utf8Bytes, BODY_MARKDOWN_MAX_BYTES)) {
    problems.push(`${at}: "bodyMarkdown" must be 1 to ${BODY_MARKDOWN_MAX_BYTES} bytes of UTF-8, ${rule}`);
  }
  if (!validMultilineText(fields["summary"], codePoints, SUMMARY_MAX_LENGTH)) {
    problems.push(`${at}: "summary" must be 1 to ${SUMMARY_MAX_LENGTH} characters, ${rule}`);
  }
  if (!validMultilineText(fields["criteriaAssessment"], codePoints, CRITERIA_ASSESSMENT_MAX_LENGTH)) {
    problems.push(`${at}: "criteriaAssessment" must be 1 to ${CRITERIA_ASSESSMENT_MAX_LENGTH} characters, ${rule}`);
  }
}

function validLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = [...value].length;
  return length >= 1 && length <= LABEL_MAX_LENGTH && !hasControl(value, "");
}

// Absent and null both mean unknown; zero is a known value.
function checkUsage(fields: Record<string, unknown>, at: string, problems: string[]): void {
  for (const key of ["provider", "model"]) {
    if (!validLabel(fields[key])) {
      problems.push(`${at}: "${key}" must be 1 to ${LABEL_MAX_LENGTH} characters without control characters`);
    }
  }
  for (const key of ["inputTokens", "outputTokens", "activeMs"]) {
    const value = fields[key];
    if (value !== undefined && value !== null && !(Number.isSafeInteger(value) && (value as number) >= 0)) {
      problems.push(`${at}: "${key}" must be null or an integer from 0 to ${MAX_USAGE_COUNT}`);
    }
  }
  const cost = fields["costUsd"];
  if (cost !== undefined && cost !== null && !(typeof cost === "string" && COST_USD.test(cost))) {
    problems.push(`${at}: "costUsd" must be null or a decimal string from "0" to "999999.999999" with at most 6 decimal places`);
  }
  if (fields["basis"] !== "reported" && fields["basis"] !== "estimated") {
    problems.push(`${at}: "basis" must be "reported" or "estimated"`);
  }
  const generation = fields["providerGenerationId"];
  if (generation !== undefined && generation !== null && !validLabel(generation)) {
    problems.push(`${at}: "providerGenerationId" must be null or 1 to ${LABEL_MAX_LENGTH} characters without control characters`);
  }
}
