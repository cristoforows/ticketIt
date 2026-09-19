import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * File-based, cross-process side-effect ledger. `native-harness`'s own
 * `MarkerState` (see `experiments/native-harness/src/marker-tool.ts`) is
 * in-memory only and cannot prove anything across the two separate OS
 * processes this issue requires (M1.12, issue #23): Process A's marker
 * calls and Process B's marker calls run in different Node processes with
 * no shared memory, so the side-effect counter has to live on disk.
 *
 * This is a fixture for this experiment only -- not a durability mechanism
 * ticketIt would ship. A real deployment's side effects (tool calls) are
 * whatever the tool actually does (a GitHub API call, a file write, etc.);
 * the "exactly once" guarantee this store proves is about the DECISION to
 * apply a side effect once per distinct (thread, interrupt, answer), not
 * about a generic marker file being a production idempotency mechanism.
 */
export interface MarkerFileState {
  /** How many times a side effect was actually *applied* (idempotent). */
  sideEffectCount: number;
  /** How many times a tool function body started running at all (includes restarts/no-ops). */
  toolInvocations: number;
  /** How many times code placed *before* an `interrupt()` call ran (restart-semantics scenario). */
  beforeInterruptCount: number;
  /** Idempotency keys already applied, so a duplicate resume is recognized and skipped. */
  appliedKeys: string[];
  /** Human-readable notes, oldest first, for evidence/debugging. */
  notes: string[];
}

function emptyState(): MarkerFileState {
  return { sideEffectCount: 0, toolInvocations: 0, beforeInterruptCount: 0, appliedKeys: [], notes: [] };
}

export class MarkerFileStore {
  constructor(private readonly filePath: string) {}

  read(): MarkerFileState {
    if (!existsSync(this.filePath)) {
      return emptyState();
    }
    const raw = readFileSync(this.filePath, "utf8");
    return raw.trim().length > 0 ? (JSON.parse(raw) as MarkerFileState) : emptyState();
  }

  private write(state: MarkerFileState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }

  /** Unconditionally records that a tool function body started running. */
  recordToolInvocation(note: string): MarkerFileState {
    const state = this.read();
    state.toolInvocations += 1;
    state.notes.push(`[toolInvocation #${state.toolInvocations}] ${note}`);
    this.write(state);
    return state;
  }

  /** Unconditionally records a "before the interrupt" side effect (restart-semantics scenario). */
  recordBeforeInterrupt(note: string): MarkerFileState {
    const state = this.read();
    state.beforeInterruptCount += 1;
    state.notes.push(`[beforeInterrupt #${state.beforeInterruptCount}] ${note}`);
    this.write(state);
    return state;
  }

  /**
   * Applies a side effect exactly once for a given idempotency key
   * (thread ID is implicit: each thread gets its own marker file -- see
   * `markerFilePath()` in `src/paths.ts`). A second call with the same key
   * is a harness-level no-op: `applied` is `false` and the count does not
   * increase. This is the mechanism scenario 2 (duplicate reply) exercises.
   */
  recordSideEffectOnce(key: string, note: string): { applied: boolean; sideEffectCount: number } {
    const state = this.read();
    if (state.appliedKeys.includes(key)) {
      state.notes.push(`[duplicate, ignored] key=${key} :: ${note}`);
      this.write(state);
      return { applied: false, sideEffectCount: state.sideEffectCount };
    }
    state.appliedKeys.push(key);
    state.sideEffectCount += 1;
    state.notes.push(`[applied #${state.sideEffectCount}] key=${key} :: ${note}`);
    this.write(state);
    return { applied: true, sideEffectCount: state.sideEffectCount };
  }
}
