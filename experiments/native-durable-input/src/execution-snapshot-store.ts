import pg from "pg";
import type { LibraryVersionLabel } from "./library.js";

/**
 * Durable, per-thread execution snapshot: the resolved system-prompt text
 * (folding in the Skill and Recipe text -- see `composeSystemPrompt` in
 * `src/library.ts`) that a Round is fixed to at its start, stored in the
 * same PostgreSQL database as the checkpointer, in a dedicated table --
 * mirroring `RoundRegistry`'s own pattern in native-harness
 * (`experiments/native-harness/src/round-registry.ts`).
 *
 * This exists because `createAgent`'s `systemPrompt` is a construction-time
 * option, not something the LangGraph checkpointer itself persists per
 * thread (see docs/evidence/m1/23-native-durable-input.md, "Documentation
 * research"): a process resuming a paused Round must reconstruct the agent
 * with the SAME systemPrompt string the Round started with, sourced from
 * durable state, never by re-reading the (mutable) library file --
 * docs/agent-execution.md, "Recipe versions": "Edits to the library do not
 * change the recipe content used by an existing round, including a round
 * paused for human input." `save()` uses `ON CONFLICT DO NOTHING` so only
 * the Round's first (start-of-round) write ever takes effect, matching
 * "fixed... at the start of each round."
 */
export interface ExecutionSnapshot {
  readonly threadId: string;
  readonly version: LibraryVersionLabel;
  readonly systemPrompt: string;
}

export class ExecutionSnapshotStore {
  private readonly pool: pg.Pool;
  private readonly ownsPool: boolean;

  constructor(pool: pg.Pool, ownsPool = false) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  static fromConnectionString(connectionString: string): ExecutionSnapshotStore {
    return new ExecutionSnapshotStore(new pg.Pool({ connectionString }), true);
  }

  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS execution_snapshots (
        thread_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  /** Fixes the snapshot for a thread. A later call for the same thread is a no-op (round-start fixation). */
  async save(snapshot: ExecutionSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO execution_snapshots (thread_id, version, system_prompt)
       VALUES ($1, $2, $3)
       ON CONFLICT (thread_id) DO NOTHING`,
      [snapshot.threadId, snapshot.version, snapshot.systemPrompt],
    );
  }

  async load(threadId: string): Promise<ExecutionSnapshot | undefined> {
    const result = await this.pool.query<{ thread_id: string; version: LibraryVersionLabel; system_prompt: string }>(
      "SELECT thread_id, version, system_prompt FROM execution_snapshots WHERE thread_id = $1",
      [threadId],
    );
    const row = result.rows[0];
    return row
      ? { threadId: row.thread_id, version: row.version, systemPrompt: row.system_prompt }
      : undefined;
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.pool.query("DELETE FROM execution_snapshots WHERE thread_id = $1", [threadId]);
  }

  async end(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}
