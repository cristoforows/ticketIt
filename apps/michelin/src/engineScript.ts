export type EngineStep = { step: "start" } | { step: "wait"; ms: number } | { step: "hold" };

export interface EngineScript {
  steps: readonly EngineStep[];
}

export const MAX_WAIT_MS = 3_600_000;

// The full default (start, three progress notes, a usage observation, deliver) lands with M4.9 and M4.10.
export const DEFAULT_ENGINE_SCRIPT: EngineScript = { steps: [{ step: "start" }, { step: "hold" }] };

const SUPPORTED_STEPS = "start, wait, hold";

const LATER_STEPS: Readonly<Record<string, string>> = {
  progress: "M4.9 (#135)",
  usage: "M4.9 (#135)",
  deliver: "M4.10 (#136)",
};

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
  return name === "wait" ? { step: "wait", ms: fields["ms"] as number } : { step: name as "start" | "hold" };
}
