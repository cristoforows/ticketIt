import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolveDatabaseUrl, assertDatabaseReachable } from "native-harness/src/index.js";
import { UsageObservationStore, type UsageObservation } from "../src/index.js";

/**
 * DB-backed rules for #26's "Galley ingestion substitute":
 *
 * - "The same observation fed twice (same generation ID) yields one
 *   record and unchanged totals."
 * - Round-trip fidelity through Postgres: citations (with codepoint
 *   offsets), cost classification/provenance, and the partial flag must
 *   survive a reload from a FRESH store instance and pool.
 *
 * Uses the SAME local PostgreSQL database as native-harness's checkpointer
 * (`ticketit_m1_native` / `NATIVE_HARNESS_DATABASE_URL`), its own
 * `usage_observations` table (`npm run db:setup`).
 */
const connectionString = resolveDatabaseUrl();

before(async () => {
  await assertDatabaseReachable(connectionString);
});

function makeObservation(overrides: Partial<UsageObservation> = {}): UsageObservation {
  return {
    roundId: randomUUID(),
    generationId: `gen-${randomUUID()}`,
    source: "adapter",
    promptTokens: 100,
    completionTokens: 20,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    cost: { status: "reported", amount: 0.01, provenance: "test" },
    searchCost: { status: "unavailable", reason: "test" },
    citations: [
      {
        url: "https://example.com/x",
        title: "t",
        content: "c",
        startCodepoint: 0,
        endCodepoint: 3,
        citedText: "abc",
      },
    ],
    content: "hello",
    partial: false,
    ...overrides,
  };
}

test("record: feeding the same generation ID twice yields one record and unchanged totals", async () => {
  const store = UsageObservationStore.fromConnectionString(connectionString);
  const observation = makeObservation();
  try {
    const first = await store.record(observation);
    assert.equal(first.inserted, true);

    const totalsAfterFirst = await store.totalsForRound(observation.roundId);
    assert.equal(totalsAfterFirst.observationCount, 1);
    assert.equal(totalsAfterFirst.promptTokens.sum, 100);
    assert.equal(totalsAfterFirst.cost.reportedSum, 0.01);

    // Replay the exact same observation (same generation ID) a second time.
    const second = await store.record(observation);
    assert.equal(second.inserted, false, "a duplicate generation ID must not create a second row");
    assert.equal(second.id, first.id, "the duplicate resolves to the SAME existing row");

    const totalsAfterSecond = await store.totalsForRound(observation.roundId);
    assert.equal(totalsAfterSecond.observationCount, 1, "still exactly one record");
    assert.equal(totalsAfterSecond.promptTokens.sum, 100, "totals unchanged by the replay");
    assert.equal(totalsAfterSecond.cost.reportedSum, 0.01);

    const rowsForRound = await store.observationsForRound(observation.roundId);
    assert.equal(rowsForRound.length, 1);
  } finally {
    await store.deleteForRound(observation.roundId);
    await store.end();
  }
});

test(
  "round-trip through Postgres preserves citations (codepoint offsets), cost classification/basis, and the " +
    "partial flag, read back from a FRESH store instance and pool",
  async () => {
    const observation = makeObservation({
      cost: { status: "estimated", amount: 0.00041, basis: "fixture pricing v1", provenance: "test" },
      partial: true,
      promptTokens: "unknown",
    });

    const writeStore = UsageObservationStore.fromConnectionString(connectionString);
    try {
      const { inserted } = await writeStore.record(observation);
      assert.equal(inserted, true);
    } finally {
      await writeStore.end();
    }

    // A FRESH store instance and pool -- simulates reading from a
    // different process than the one that wrote the observation.
    const readStore = UsageObservationStore.fromConnectionString(connectionString);
    try {
      const reloaded = await readStore.getByGenerationId(observation.generationId);
      assert.ok(reloaded);
      assert.equal(reloaded!.promptTokens, "unknown", "unknown survives the round-trip, not coerced to 0/null-as-zero");
      assert.equal(reloaded!.partial, true);
      assert.equal(reloaded!.cost.status, "estimated");
      if (reloaded!.cost.status === "estimated") {
        assert.equal(reloaded!.cost.amount, 0.00041);
        assert.equal(reloaded!.cost.basis, "fixture pricing v1", "the estimation basis survives the round-trip");
      }
      assert.equal(reloaded!.citations.length, 1);
      assert.equal(reloaded!.citations[0]!.startCodepoint, 0);
      assert.equal(reloaded!.citations[0]!.endCodepoint, 3);
      assert.equal(reloaded!.citations[0]!.citedText, "abc");
    } finally {
      await readStore.deleteForRound(observation.roundId);
      await readStore.end();
    }
  },
);
