import { join } from "node:path";

/**
 * All file paths this experiment's fixtures use are derived from a single
 * `tmpDir` the test creates fresh per run (`fs.mkdtempSync`) and passes to
 * both processes as an argv value, and from the thread ID, which is unique
 * per run (`durable-input-<randomUUID>`). This keeps concurrent/repeated
 * local runs, and other agents' concurrent work in the shared scratchpad,
 * from ever colliding -- see experiments/README.md and this slice's setup
 * rule 4 ("Scratchpad collision").
 */
export function markerFilePath(tmpDir: string, threadId: string): string {
  return join(tmpDir, `marker-${threadId}.json`);
}

export function libraryFilePath(tmpDir: string, libraryId: string): string {
  return join(tmpDir, `library-${libraryId}.json`);
}

export function flagFilePath(tmpDir: string, threadId: string): string {
  return join(tmpDir, `flag-${threadId}.txt`);
}
