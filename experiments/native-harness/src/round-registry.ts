import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Persists the Round ID <-> LangGraph thread ID mapping in a dedicated
 * PostgreSQL table, in the same database as the checkpointer.
 *
 * Per ADR 0002 ("Round identity separate from engine identity") and
 * docs/contracts/execution-interface.md ("Identity model"): the Round ID is
 * issued independently of any engine identifier, and the thread ID (the
 * LangGraph engine execution reference) is a separate record attached to a
 * Round, never the Round ID itself. This class is the M1.11 tracer's stand-in
 * for that mapping; Galley owns the authoritative Round record in later
 * milestones.
 */
export class RoundRegistry {
  private readonly pool: pg.Pool;
  private readonly ownsPool: boolean;

  constructor(pool: pg.Pool, ownsPool = false) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  static fromConnectionString(connectionString: string): RoundRegistry {
    return new RoundRegistry(new pg.Pool({ connectionString }), true);
  }

  /** Creates the `round_registry` table if it does not already exist. */
  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS round_registry (
        round_id UUID PRIMARY KEY,
        thread_id TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  /**
   * Registers a new Round for the given LangGraph thread ID, generating a
   * fresh Round ID (a uuid) distinct from that thread ID, and returns it.
   */
  async registerRound(threadId: string): Promise<string> {
    const roundId = randomUUID();
    await this.pool.query(
      "INSERT INTO round_registry (round_id, thread_id) VALUES ($1, $2)",
      [roundId, threadId],
    );
    return roundId;
  }

  async threadIdForRound(roundId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ thread_id: string }>(
      "SELECT thread_id FROM round_registry WHERE round_id = $1",
      [roundId],
    );
    return result.rows[0]?.thread_id;
  }

  async roundIdForThread(threadId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ round_id: string }>(
      "SELECT round_id FROM round_registry WHERE thread_id = $1",
      [threadId],
    );
    return result.rows[0]?.round_id;
  }

  async rowCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM round_registry",
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async end(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}
