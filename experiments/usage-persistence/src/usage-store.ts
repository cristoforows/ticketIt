import pg from "pg";
import type { Citation } from "./citations.js";
import {
  computeRoundTotals,
  type CostClassification,
  type RoundTotals,
  type SearchCostBreakdown,
  type TokenCount,
  type UsageObservation,
  type UsageObservationSource,
} from "./usage-ingest.js";

/**
 * Postgres-backed persistence for `UsageObservation`s -- the "Galley
 * ingestion substitute" table for #26. Lives in the SAME PostgreSQL
 * database the native harness's checkpointer/RoundRegistry already use
 * (`ticketit_m1_native`, or `NATIVE_HARNESS_DATABASE_URL`), as its own
 * table (`usage_observations`), never touching `checkpoints` or
 * `round_registry`.
 *
 * Deduplication (issue #26, "Feeding the same observation twice ... yields
 * one record and unchanged totals") is enforced with a UNIQUE constraint on
 * `generation_id` plus `ON CONFLICT (generation_id) DO NOTHING`.
 */
export class UsageObservationStore {
  private readonly pool: pg.Pool;
  private readonly ownsPool: boolean;

  constructor(pool: pg.Pool, ownsPool = false) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  static fromConnectionString(connectionString: string): UsageObservationStore {
    return new UsageObservationStore(new pg.Pool({ connectionString }), true);
  }

  /** Creates the `usage_observations` table if it does not already exist. Idempotent. */
  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS usage_observations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        round_id UUID NOT NULL,
        generation_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        prompt_tokens BIGINT,
        completion_tokens BIGINT,
        reasoning_tokens BIGINT,
        cached_tokens BIGINT,
        cache_write_tokens BIGINT,
        cost_status TEXT NOT NULL,
        cost_amount DOUBLE PRECISION,
        cost_basis TEXT,
        cost_provenance TEXT NOT NULL,
        search_cost_status TEXT NOT NULL,
        search_cost_amount DOUBLE PRECISION,
        search_cost_basis TEXT,
        search_cost_reason TEXT,
        citations JSONB NOT NULL DEFAULT '[]',
        content TEXT NOT NULL,
        partial BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS usage_observations_round_id_idx ON usage_observations (round_id)`);
  }

  /**
   * Records one usage observation. Deduplicated by `generation_id`:
   * inserting the exact same generation a second time is a no-op (the
   * existing row's id is returned, `inserted: false`), so replayed
   * observations never create a second record or change any total.
   */
  async record(observation: UsageObservation): Promise<{ inserted: boolean; id: string }> {
    const result = await this.pool.query<{ id: string }>(
      `
      INSERT INTO usage_observations (
        round_id, generation_id, source,
        prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, cache_write_tokens,
        cost_status, cost_amount, cost_basis, cost_provenance,
        search_cost_status, search_cost_amount, search_cost_basis, search_cost_reason,
        citations, content, partial
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (generation_id) DO NOTHING
      RETURNING id
      `,
      [
        observation.roundId,
        observation.generationId,
        observation.source,
        tokenToSql(observation.promptTokens),
        tokenToSql(observation.completionTokens),
        tokenToSql(observation.reasoningTokens),
        tokenToSql(observation.cachedTokens),
        tokenToSql(observation.cacheWriteTokens),
        observation.cost.status,
        observation.cost.status === "unknown" ? null : observation.cost.amount,
        observation.cost.status === "estimated" ? observation.cost.basis : null,
        costProvenance(observation.cost),
        observation.searchCost.status,
        observation.searchCost.status === "unavailable" ? null : observation.searchCost.amount,
        observation.searchCost.status === "estimated" ? observation.searchCost.basis : null,
        searchCostReason(observation.searchCost),
        JSON.stringify(observation.citations),
        observation.content,
        observation.partial,
      ],
    );
    if (result.rows[0]) {
      return { inserted: true, id: result.rows[0].id };
    }
    const existing = await this.pool.query<{ id: string }>("SELECT id FROM usage_observations WHERE generation_id = $1", [
      observation.generationId,
    ]);
    return { inserted: false, id: existing.rows[0]!.id };
  }

  /** Every observation recorded for a Round, oldest first. */
  async observationsForRound(roundId: string): Promise<UsageObservation[]> {
    const result = await this.pool.query("SELECT * FROM usage_observations WHERE round_id = $1 ORDER BY created_at ASC", [
      roundId,
    ]);
    return result.rows.map(rowToObservation);
  }

  /** A single observation by its provider generation ID, or `undefined` if never recorded. */
  async getByGenerationId(generationId: string): Promise<UsageObservation | undefined> {
    const result = await this.pool.query("SELECT * FROM usage_observations WHERE generation_id = $1", [generationId]);
    return result.rows[0] ? rowToObservation(result.rows[0]) : undefined;
  }

  /** Computed totals for a Round, from its (already deduplicated) stored observations. */
  async totalsForRound(roundId: string): Promise<RoundTotals> {
    const observations = await this.observationsForRound(roundId);
    return computeRoundTotals(roundId, observations);
  }

  /** Total row count across all Rounds. Test-cleanup / sanity use only. */
  async count(): Promise<number> {
    const result = await this.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM usage_observations");
    return Number(result.rows[0]?.count ?? "0");
  }

  /** Deletes every observation for a Round. Test cleanup only -- this is not how a real Round's history is erased. */
  async deleteForRound(roundId: string): Promise<void> {
    await this.pool.query("DELETE FROM usage_observations WHERE round_id = $1", [roundId]);
  }

  async end(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

function tokenToSql(value: TokenCount): number | null {
  return value === "unknown" ? null : value;
}

function costProvenance(cost: CostClassification): string {
  return cost.status === "unknown" ? cost.reason : cost.provenance;
}

function searchCostReason(searchCost: SearchCostBreakdown): string | null {
  return searchCost.status === "unavailable" ? searchCost.reason : null;
}

function rowTokenToTokenCount(value: unknown): TokenCount {
  return value === null || value === undefined ? "unknown" : Number(value);
}

function rowToObservation(row: Record<string, unknown>): UsageObservation {
  const cost: CostClassification =
    row["cost_status"] === "reported"
      ? { status: "reported", amount: Number(row["cost_amount"]), provenance: String(row["cost_provenance"]) }
      : row["cost_status"] === "estimated"
        ? {
            status: "estimated",
            amount: Number(row["cost_amount"]),
            basis: String(row["cost_basis"]),
            provenance: String(row["cost_provenance"]),
          }
        : { status: "unknown", reason: String(row["cost_provenance"]) };

  const searchCost: SearchCostBreakdown =
    row["search_cost_status"] === "reported"
      ? { status: "reported", amount: Number(row["search_cost_amount"]), provenance: String(row["cost_provenance"]) }
      : row["search_cost_status"] === "estimated"
        ? {
            status: "estimated",
            amount: Number(row["search_cost_amount"]),
            basis: String(row["search_cost_basis"]),
            provenance: String(row["cost_provenance"]),
          }
        : { status: "unavailable", reason: String(row["search_cost_reason"] ?? "") };

  return {
    roundId: String(row["round_id"]),
    generationId: String(row["generation_id"]),
    source: row["source"] as UsageObservationSource,
    promptTokens: rowTokenToTokenCount(row["prompt_tokens"]),
    completionTokens: rowTokenToTokenCount(row["completion_tokens"]),
    reasoningTokens: rowTokenToTokenCount(row["reasoning_tokens"]),
    cachedTokens: rowTokenToTokenCount(row["cached_tokens"]),
    cacheWriteTokens: rowTokenToTokenCount(row["cache_write_tokens"]),
    cost,
    searchCost,
    citations: (row["citations"] as Citation[] | null) ?? [],
    content: String(row["content"]),
    partial: Boolean(row["partial"]),
  };
}
