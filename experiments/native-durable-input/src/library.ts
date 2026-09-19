import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Stand-in for the shared library that holds an agent's instructions, a
 * Skill, and a Recipe (docs/agent-execution.md, "Skills" / "Recipe
 * versions"; docs/v1-scope.md, "Agents, recipes, and skills": "Each round
 * fixes the model, instructions, and skill versions used"). This is a
 * plain mutable JSON file -- exactly the kind of "mutable ambient file" a
 * naive resume implementation might re-read, which is what scenario 3
 * (fixed inputs across a pause) exists to catch. It is NOT the durable
 * per-thread record a resumed round must actually read from; see
 * `ExecutionSnapshotStore` in `src/execution-snapshot-store.ts` for that.
 */
export type LibraryVersionLabel = "A" | "B";

export interface LibraryContent {
  readonly version: LibraryVersionLabel;
  readonly systemPromptBase: string;
  readonly skillText: string;
  readonly recipeText: string;
}

const VERSIONS: Record<LibraryVersionLabel, LibraryContent> = {
  A: {
    version: "A",
    systemPromptBase: "You are a scripted research agent (instructions version A).",
    skillText: "Skill v A: summarize findings in three bullet points.",
    recipeText: "Recipe v A: the client prefers concise, citation-free summaries.",
  },
  B: {
    version: "B",
    systemPromptBase: "You are a scripted research agent (instructions version B).",
    skillText: "Skill v B: summarize findings with full citations.",
    recipeText: "Recipe v B: the client now requires citations for every claim.",
  },
};

/** Combines the base instructions, Skill text, and Recipe text into one system-prompt string. */
export function composeSystemPrompt(content: LibraryContent): string {
  return [
    content.systemPromptBase,
    `Skill: ${content.skillText}`,
    `Recipe: ${content.recipeText}`,
  ].join("\n\n");
}

export class LibraryStore {
  constructor(private readonly filePath: string) {}

  /** "Publishes" a version by overwriting the live library file, as an owner edit would. */
  publish(version: LibraryVersionLabel): void {
    writeFileSync(this.filePath, JSON.stringify(VERSIONS[version]), "utf8");
  }

  /** Reads the currently published content, publishing version A first if nothing has been published yet. */
  read(): LibraryContent {
    if (!existsSync(this.filePath)) {
      this.publish("A");
    }
    return JSON.parse(readFileSync(this.filePath, "utf8")) as LibraryContent;
  }
}
