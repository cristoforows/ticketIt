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

export type EngineStep = { step: "start" } | { step: "wait"; ms: number } | { step: "progress"; note: string } | UsageStep | { step: "hold" };

export interface EngineScript {
  steps: readonly EngineStep[];
}

export const MAX_WAIT_MS = 3_600_000;
export const NOTE_MAX_LENGTH = 2000;
export const LABEL_MAX_LENGTH = 200;
export const MAX_USAGE_COUNT = Number.MAX_SAFE_INTEGER;

// Deliver is M4.10 (#136); until then the default holds where it will deliver.
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
    { step: "hold" },
  ],
};

const SUPPORTED_STEPS = "start, wait, progress, usage, hold";

const LATER_STEPS: Readonly<Record<string, string>> = {
  deliver: "M4.10 (#136)",
};

const USAGE_KEYS = ["provider", "model", "inputTokens", "outputTokens", "costUsd", "activeMs", "basis", "providerGenerationId"];

// Mirrors Galley's limits (round_activity.go, usage_observations.go) so a bad script fails at startup, not by abandoning a Round.
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
      if (index < total - 1) {
        problems.push(`${at}: "hold" may only be the last step`);
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
    default: {
      const slice = LATER_STEPS[name];
      problems.push(
        slice === undefined
          ? `${at}: unknown step ${JSON.stringify(name)}; supported steps are ${SUPPORTED_STEPS}`
          : `${at}: ${JSON.stringify(name)} is not supported yet; ${slice} adds it. Supported steps are ${SUPPORTED_STEPS}`,
      );
      return undefined;
    }
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

function validNote(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = [...value].length;
  return length >= 1 && length <= NOTE_MAX_LENGTH && /[^\s]/u.test(value) && !hasControl(value, "\t\n");
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
