import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The three fixed-input kinds this experiment materializes per Round, per
 * `docs/agent-execution.md` ("Agent configuration in v1", "Skills",
 * "Recipe versions") and CONTEXT.md's Skill/Recipe glossary entries:
 * Agent instructions, one Skill (a `SKILL.md` body), and one Recipe
 * (Markdown background supplied as Ticket context).
 */
export interface FixedInputVersion {
  /** Agent instructions Markdown content (the `instructions` config field's file content). */
  instructions: string;
  /** The Skill's `SKILL.md` body, i.e. everything after the frontmatter. */
  skillBody: string;
  /** Recipe Markdown content, supplied to the model as Ticket context (see materializeRoundInputs). */
  recipe: string;
}

/**
 * A stand-in for ticketIt's shared recipe/skill library (see CONTEXT.md's
 * Recipe/Skill glossary entries: "a reusable document supplied ... stored
 * in a shared library" / "Reusable instructions assigned to an Agent").
 * This is a single mutable directory outside any Round's own isolated
 * OpenCode process -- publishing a new version here models an owner
 * editing the library while a Round is mid-flight. Its content only
 * reaches a Round through an explicit `materializeRoundInputs` call, never
 * automatically.
 */
export interface Library {
  root: string;
  skillName: string;
}

export function createLibrary(root: string, skillName: string): Library {
  mkdirSync(root, { recursive: true });
  return { root, skillName };
}

function instructionsPath(library: Library): string {
  return path.join(library.root, "instructions.md");
}
function skillPath(library: Library): string {
  return path.join(library.root, "skill", `${library.skillName}.md`);
}
function recipePath(library: Library): string {
  return path.join(library.root, "recipe.md");
}

/**
 * Publish a new version into the library's mutable location. Models "the
 * owner edits the recipe/skill library" -- has no effect on any
 * already-materialized Round-private copy (see `materializeRoundInputs`),
 * only on Rounds that materialize *after* this call.
 */
export function publishLibraryVersion(library: Library, version: FixedInputVersion): void {
  mkdirSync(path.dirname(skillPath(library)), { recursive: true });
  writeFileSync(instructionsPath(library), version.instructions);
  writeFileSync(skillPath(library), version.skillBody);
  writeFileSync(recipePath(library), version.recipe);
}

export function readLibraryVersion(library: Library): FixedInputVersion {
  return {
    instructions: readFileSync(instructionsPath(library), "utf8"),
    skillBody: readFileSync(skillPath(library), "utf8"),
    recipe: readFileSync(recipePath(library), "utf8"),
  };
}

/** Relative path (from a Round's `projectDir`) of the materialized instructions file. */
export const ROUND_INSTRUCTIONS_RELATIVE_PATH = "AGENT-INSTRUCTIONS.md";

export interface MaterializedRoundInputs {
  /** Relative path (from `projectDir`) of the materialized instructions file; pass into `extraConfig.instructions`. */
  instructionsRelativePath: string;
  /** Absolute path of the materialized instructions file. */
  instructionsAbsolutePath: string;
  /** Absolute path of the Round-private project Skill directory (`.opencode/skill/<name>/`). */
  skillDir: string;
  /** Absolute path of the Round-private Skill file (`.opencode/skill/<name>/SKILL.md`). */
  skillFile: string;
  /** Absolute path of the Round-private Recipe snapshot file (kept with the Round, not read by OpenCode itself). */
  recipePrivatePath: string;
  /** The Recipe content read from the library at materialization time -- embed this into the Round's initial prompt as Ticket context. */
  recipeText: string;
}

/**
 * Copy the library's CURRENT version into a fresh Round-private location
 * under `projectDir` (a Round's own isolated OpenCode project worktree --
 * see `startManagedOpenCode`). This is the "Round-private location the
 * session uses" the issue asks for: a snapshot taken once, at Round start,
 * that nothing else in this experiment ever writes to again. Isolation
 * for the rest of the Round's lifetime is a property of this discipline
 * (never re-copying into an already-materialized Round), not of an
 * OpenCode engine snapshot feature -- see
 * docs/evidence/m1/19-opencode-fixed-inputs.md, "Observed limitations",
 * for why the engine's own instructions-file reads are NOT cached
 * (re-read from disk on every request) and this distinction matters.
 *
 * The Skill is materialized as an actual project Skill
 * (`.opencode/skill/<name>/SKILL.md`, an engine-native discovery
 * location -- see the pinned build's own embedded "customize-opencode"
 * skill, "Where files live", cited in the evidence file) so the engine's
 * own skill mechanism (the built-in "skill" tool) can load it, rather
 * than the app inventing a bespoke delivery path.
 *
 * The Recipe has no OpenCode-native equivalent (it is a ticketIt-only
 * concept -- background information, not something the engine "loads");
 * it is materialized as a private snapshot file for round-history
 * retention (see `docs/agent-execution.md`, "Recipe versions": "Retain
 * the versions used by earlier rounds") and its text is returned here so
 * the caller can embed it directly into the Round's initial prompt as
 * Ticket context (the model receives it because it is part of what was
 * sent, not because OpenCode discovered it from a file).
 */
export function materializeRoundInputs(projectDir: string, library: Library): MaterializedRoundInputs {
  const version = readLibraryVersion(library);

  const instructionsAbsolutePath = path.join(projectDir, ROUND_INSTRUCTIONS_RELATIVE_PATH);
  writeFileSync(instructionsAbsolutePath, version.instructions);

  const skillDir = path.join(projectDir, ".opencode", "skill", library.skillName);
  mkdirSync(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  writeFileSync(
    skillFile,
    `---\nname: ${library.skillName}\ndescription: Use ONLY when asked to demonstrate the ${library.skillName} skill for M1.8's fixed-inputs proof.\n---\n${version.skillBody}`,
  );

  const ticketItDir = path.join(projectDir, ".ticketit");
  mkdirSync(ticketItDir, { recursive: true });
  const recipePrivatePath = path.join(ticketItDir, "recipe.md");
  writeFileSync(recipePrivatePath, version.recipe);

  return {
    instructionsRelativePath: ROUND_INSTRUCTIONS_RELATIVE_PATH,
    instructionsAbsolutePath,
    skillDir,
    skillFile,
    recipePrivatePath,
    recipeText: version.recipe,
  };
}
