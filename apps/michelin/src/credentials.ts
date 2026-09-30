import { inspect } from "node:util";

const TOKEN_VARIABLE = "MICHELIN_RUNNER_TOKEN";
const TOKEN_SHAPE = /^tir_[A-Za-z0-9_-]{43}$/;
const REDACTED = "[redacted runner credential]";

export class RunnerCredential {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  authorizationHeader(): string {
    return `Bearer ${this.#token}`;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

// The one reader of the runner credential: a later web-managed source replaces this module only (#130).
export function resolveRunnerCredential(env: Readonly<Record<string, string | undefined>>, problems: string[]): RunnerCredential | undefined {
  const token = env[TOKEN_VARIABLE];
  if (token === undefined || token === "") {
    problems.push(`${TOKEN_VARIABLE} is required: pair the runner in Swiftlet (Agents, Runner) and put the credential in Michelin's .env`);
    return undefined;
  }
  if (!TOKEN_SHAPE.test(token)) {
    problems.push(`${TOKEN_VARIABLE} must be tir_ followed by 43 base64url characters`);
    return undefined;
  }
  return new RunnerCredential(token);
}
