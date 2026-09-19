# usage-persistence

M1.15 ([#26](https://github.com/cristoforows/ticketIt/issues/26)) — the
persistence half of feasibility experiment S4 (see
[docs/integration-feasibility.md](../../docs/integration-feasibility.md)):
runs the OpenRouter fixtures ([#25](https://github.com/cristoforows/ticketIt/issues/25),
`experiments/openrouter-fidelity`) through the native harness
([#22](https://github.com/cristoforows/ticketIt/issues/22),
`experiments/native-harness`) with the REAL, pinned `ChatOpenRouter` adapter
pointed at `FakeOpenRouterServer` and a PostgreSQL checkpointer, proves what
survives a checkpoint reload versus what needs out-of-band raw-response
capture, and a Galley ingestion substitute (`UsageIngest`) that normalizes
usage/citation observations with dedupe, unknown-is-not-zero, and
reported/estimated/unknown cost provenance rules.

Full findings, versions, and the fixture-evidence table are recorded in
[docs/evidence/m1/26-usage-persistence.md](../../docs/evidence/m1/26-usage-persistence.md).
No real credentials, no real provider calls — see
[experiments/README.md](../README.md) for workspace rules.

## What's here

- `src/raw-capture.ts` — `startRawCapture()`: the raw-response access path
  #25 identified (monkey-patch `globalThis.fetch`, read an independent
  `response.clone()`), generalized into a reusable capture session. This is
  the only way to recover data `ChatOpenRouter@0.4.13` drops before it
  reaches the returned message (citation annotations always; usage
  delivered via the empty-`choices` trailing SSE chunk).
- `src/citations.ts` — `extractCitations()`: recovers `url_citation`
  annotations with codepoint-aware substring slicing (`Array.from(content)`,
  never native `.slice()`), per #25's Unicode-offset finding.
- `src/usage-ingest.ts` — `UsageIngest`: normalizes adapter-surfaced
  messages (`normalizeFromAdapterMessage`) and raw-captured responses
  (`extractRawMessage`, `mergeRawSseEvents`, `normalizeFromRawResponse`)
  into a `UsageObservation`, merges an adapter + raw-capture pair
  (`mergeObservations`), estimates cost from tokens with a stated basis
  (`estimateCostFromTokens`), and computes Round totals
  (`computeRoundTotals`) that keep unknown, reported, and estimated
  contributions distinct and visible.
- `src/usage-store.ts` — `UsageObservationStore`: Postgres-backed
  persistence for `UsageObservation`s in the SAME database the native
  harness's checkpointer/`RoundRegistry` already use, deduplicated by a
  `UNIQUE (generation_id)` constraint (`ON CONFLICT DO NOTHING`).
- `test/checkpoint-persistence.test.ts` — Part 1: real `ChatOpenRouter` +
  `FakeOpenRouterServer` + `PostgresSaver`, reloaded from a fresh
  checkpointer instance and pool, asserting exactly what survives.
- `test/usage-only-chunk-full-path.test.ts`, `test/truncated-stream-ingest.test.ts`,
  `test/usage-store.test.ts`, `test/usage-ingest.test.ts` — Part 2: the
  ingestion rules from issue #26, including at least one test running the
  usage-only-final-chunk fixture through the real adapter/server.

## Database setup

Reuses the SAME local PostgreSQL 17 database as `experiments/native-harness`
(`ticketit_m1_native` by default, or `NATIVE_HARNESS_DATABASE_URL`). Run
native-harness's own setup first, then this package's:

```sh
cd experiments/native-harness && npm ci && npm run db:setup
cd ../usage-persistence
npm ci
npm run db:setup   # creates this package's own usage_observations table
npm test
```

`npm run db:setup` (`scripts/db-setup.ts`) does **not** create the database
or touch `checkpoints`/`round_registry` — only its own `usage_observations`
table (idempotent `CREATE TABLE IF NOT EXISTS`). Like native-harness,
`npm test` never silently falls back: `assertDatabaseReachable()` throws a
clear, actionable error if PostgreSQL is unreachable.

## Verify

```sh
cd experiments/usage-persistence
npm ci
npm run db:setup
npm test
npm run typecheck
```

Every test uses a unique thread ID / Round ID / generation ID per run and
cleans up its own checkpoint and `usage_observations` rows in a `finally`
block (consistent with native-harness's own convention; `round_registry`
rows are intentionally never deleted — an append-only registry, per
docs/evidence/m1/22-native-harness-boot.md).
