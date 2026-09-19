# M1.15 — Usage and citation persistence through checkpoint and ingestion substitute

## Purpose

Prove the persistence half of feasibility experiment S4 ("OpenRouter payload
fidelity") from
[docs/integration-feasibility.md](../../integration-feasibility.md), for
[M1.15 — Usage and citation persistence through checkpoint and ingestion
substitute (#26)](https://github.com/cristoforows/ticketIt/issues/26):

- **Part 1**: run the OpenRouter fixtures
  ([#25](https://github.com/cristoforows/ticketIt/issues/25),
  `experiments/openrouter-fidelity`) through the native harness
  ([#22](https://github.com/cristoforows/ticketIt/issues/22),
  `experiments/native-harness`) with the REAL, pinned `ChatOpenRouter`
  adapter pointed at `FakeOpenRouterServer`, used as the model inside
  `createHarnessAgent` with the PostgreSQL checkpointer; reload the thread
  from a fresh checkpointer instance and pool; record exactly what
  survived (content, citations, usage fields).
- **Part 2**: a Galley ingestion substitute (`UsageIngest`) that normalizes
  adapter output plus raw-response data into usage observations carrying
  Round ID, provider generation/message ID, token fields, cost classified
  as reported/estimated/unknown with provenance, a search-cost breakdown
  kept separate from aggregate reported cost, and citations — with dedupe,
  unknown-is-not-zero, and incomplete-total-visibility rules.

This informs open decision [D7](../../open-decisions.md) (native model
unselected) and the usage-accounting rules for M9
([docs/usage-accounting.md](../../usage-accounting.md)). No real OpenRouter
credentials or network calls are used anywhere in this slice, per
`experiments/README.md`.

## Exact versions

- Node: `v26.9.0` (matches `experiments/.nvmrc` and this package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- PostgreSQL: 17.11 (Homebrew), local, default port 5432 — the SAME
  database `experiments/native-harness` already sets up
  (`ticketit_m1_native`, or `NATIVE_HARNESS_DATABASE_URL`)
- `typescript`: `7.0.2` (devDependency, pinned exact, matches every other
  experiment package)
- `tsx`: `4.23.13` (devDependency, pinned exact)
- `@types/node`: `26.6.1`, `@types/pg`: `8.23.1` (devDependencies, pinned
  exact)
- `@langchain/core`: `1.2.11` (dependency, pinned exact — matches #22/#25)
- `@langchain/openrouter`: `0.4.13` (dependency, pinned exact — matches
  #25; exports `ChatOpenRouter`)
- `pg`: `8.23.0` (dependency, pinned exact — matches #22)
- `native-harness`: `file:../native-harness` (#22's package, unmodified)
- `openrouter-fidelity`: `file:../openrouter-fidelity` (#25's package,
  unmodified — this package imports its `FakeOpenRouterServer` and
  fixtures directly via `openrouter-fidelity/src/server.js` /
  `openrouter-fidelity/src/fixtures.js`, the same subpath-import
  convention already used between `native-durable-input` and
  `native-harness`)
- `shared`: `file:../shared` (unmodified)

Resolved transitively (via `npm ls --all` against the committed
`package-lock.json`; not directly pinned by this package, but fixed by the
lockfile): `@langchain/openai@1.5.13`, `openai@7.19.0` (note: #25 recorded
`openai@7.18.0` at its review time; the registry has since published a
newer patch matching `@langchain/openrouter@0.4.13`'s still-unpinned
`^7.x` range — this package's own `package-lock.json` pins the exact
resolved tree, so this is a recorded observation, not a live risk),
`eventsource-parser@4.1.1`, `zod@4.6.5`, `langsmith@0.10.4`,
`@langchain/langgraph@1.4.15` (via `native-harness`),
`@langchain/langgraph-checkpoint-postgres@1.0.5` (via `native-harness`),
`langchain@1.5.11` (via `native-harness`), `pg-pool@3.14.0`.

## Reproducible commands

```sh
cd experiments/native-harness
npm ci
npm run db:setup   # creates ticketit_m1_native, checkpointer + round_registry tables

cd ../openrouter-fidelity
npm ci

cd ../usage-persistence
npm ci
npm run db:setup   # creates this package's own usage_observations table
npm test
npm run typecheck
```

`npm test` takes ~0.6s (21 tests; several touch the local PostgreSQL
database, none touch a network endpoint other than `FakeOpenRouterServer`
on `127.0.0.1`). Verified from a clean `node_modules` (`rm -rf node_modules
&& npm ci && npm test && npm run typecheck`).

## Documentation research (unverified)

- [LangChain JS message serialization](https://docs.langchain.com/oss/javascript/langgraph/persistence)
  documents that LangGraph checkpoints persist "channel values," but does
  not document, at the level of detail needed here, exactly which
  properties of a `BaseMessage` survive a serialize/deserialize round-trip
  versus which are runtime-only convenience fields. This experiment
  answers that empirically instead (see "Fixture/stub evidence" below);
  reading the installed package's own `Serializable` base class
  (`@langchain/core/dist/load/serializable.js`, method `toJSON()`) confirms
  the mechanism: `toJSON()` serializes `this.lc_kwargs` (the constructor
  arguments captured at construction time) and nothing else. A property
  assigned to a message instance AFTER construction (not passed as a
  constructor kwarg) is invisible to `toJSON()` and therefore absent from
  what the checkpointer's `JsonPlusSerializer` writes to Postgres.
- [LangGraph JS `getState`](https://docs.langchain.com/oss/javascript/langgraph/persistence)
  ("Adding memory") documents `graph.getState(config)` returning the
  current channel values for a thread; used here as the "reload from a
  fresh process" mechanism instead of reading `checkpointer.getTuple()`'s
  raw `channel_values` directly, since the latter's exact channel key name
  for `createAgent`'s built-in state is an implementation detail this
  slice did not need to depend on.
- Everything else this record depends on regarding adapter behavior
  (dropped citations, dropped cache-write/cost from `usage_metadata`, the
  usage-only-trailing-chunk stream drop, the raw-response
  fetch-interception access path) is #25's documentation research and
  fixture evidence, cited by reference rather than re-derived here; see
  [docs/evidence/m1/25-openrouter-fidelity.md](25-openrouter-fidelity.md).

## Fixture/stub evidence (observed)

All results below are directly observed by running `npm test` (**21/21
passing**) in `experiments/usage-persistence/` against a real
`ChatOpenRouter@0.4.13` instance pointed at `FakeOpenRouterServer`
(127.0.0.1, ephemeral port) and a real local PostgreSQL 17 database
(`ticketit_m1_native`) — never a real OpenRouter endpoint. Regression runs
of the packages this one depends on: `experiments/native-harness`
**1/1 passing** (`npm test`) plus `npm run typecheck` clean;
`experiments/openrouter-fidelity` **21/21 passing** (`npm test`) plus
`npm run typecheck` clean. This package's own `npm run typecheck` is also
clean (`tsc -p tsconfig.json --noEmit`, `typescript@7.0.2`).

### Part 1 — checkpoint persistence

**Test**: `test/checkpoint-persistence.test.ts`, "checkpoint persistence:
citations are dropped by the adapter and do NOT survive the checkpoint
reload; they survive only because the harness captured them out of band
and attached them to the Round's own record, with correct codepoint-aware
offsets over multi-byte Unicode."

Procedure: a real `ChatOpenRouter` (citations fixture, `invoke` mode) is
used as the model inside `createHarnessAgent` with a real `PostgresSaver`
checkpointer; `startRawCapture()` (this package's generalization of #25's
monkey-patched-`fetch`-plus-`response.clone()` mechanism) is installed for
exactly the turn. After the turn, the citation is recovered from the raw
capture (`extractRawMessage` + `normalizeFromRawResponse`) and stored via
`UsageObservationStore.record()`, keyed to the Round ID (from
`RoundRegistry.registerRound()`, distinct from the LangGraph thread ID per
ADR 0002). The thread is then reloaded via a **fresh**
`createPostgresCheckpointer()` call (a new `PostgresSaver`, a new
underlying `pg.Pool`) and `agent.getState()`; the citation is reloaded via
a **fresh** `UsageObservationStore.fromConnectionString()` (a new pool).

Observed:

- `content` survives the checkpoint reload exactly
  (`CITATION_PREFIX + CITATION_TEXT + CITATION_SUFFIX`, including the
  precomposed accent and the astral emoji).
- No trace of `"url_citation"` anywhere in the reloaded message
  (`JSON.stringify` check) — confirms #25's finding survives a checkpoint
  round-trip too: there was nothing for the checkpoint to lose, because the
  adapter never captured the annotation in the first place.
- The out-of-band citation, reloaded from a fresh store/pool, has
  `startCodepoint`/`endCodepoint` exactly matching the fixture's
  constructed codepoint offsets, and `citedText` exactly equal to
  `CITATION_TEXT` — codepoint-aware slicing (`Array.from(content).slice(...)`)
  survives the full round-trip (in-process extraction → Postgres JSONB
  storage → fresh-pool reload) over content containing a preceding astral
  surrogate pair.

**Test**: same file, "checkpoint persistence: the raw usage passthrough
(`response_metadata.usage` — cost, cache-write, reasoning, cached, all
unnormalized) survives the checkpoint reload, but LangChain's NORMALIZED
`usage_metadata` convenience field does NOT."

This is a **new finding for this slice**, distinct from #25's adapter-level
findings (#25 characterized what `ChatOpenRouter` surfaces on the message
immediately after a call; this characterizes what a LangGraph/Postgres
checkpoint round-trip does to that same message afterward):

- Immediately after the turn (in-process, nothing reloaded), both
  `usage_metadata` (normalized: `output_token_details.reasoning === 6`,
  `input_token_details.cache_read === 256`) and `response_metadata.usage`
  (raw passthrough: `cost === 0.002145`,
  `prompt_tokens_details.cache_write_tokens === 64`, etc.) are present, per
  #25's fidelity matrix.
- Inspecting `finalMessage.lc_kwargs` directly shows its keys are `content,
  tool_calls, invalid_tool_calls, additional_kwargs, response_metadata, id,
  name` — **`usage_metadata` is not among them.** The OpenAI/OpenRouter
  message converter assigns `usage_metadata` to the message instance AFTER
  construction (a convenience mutation), not as a constructor argument;
  `response_metadata` IS a constructor kwarg.
- `@langchain/core`'s `Serializable.toJSON()` only serializes `lc_kwargs`.
  After a genuine round-trip (write via the original checkpointer, read
  via a brand-new `PostgresSaver` + `pg.Pool` + `agent.getState()`):
  `reloadedFinal.usage_metadata === undefined` (confirmed lost), while
  `reloadedFinal.response_metadata.usage.completion_tokens_details.reasoning_tokens
  === 6`, `.prompt_tokens_details.cached_tokens === 256`, `.cost ===
  0.002145`, and `.prompt_tokens_details.cache_write_tokens === 64` all
  survive intact (confirmed present, raw/unnormalized).
- Consequence for ingestion: `normalizeFromAdapterMessage`, which reads
  prompt/completion/reasoning/cached tokens from `usage_metadata`, reports
  all four as `"unknown"` when run against a message reloaded from the
  checkpoint days later, while `cost` and `cacheWriteTokens` (which the
  function reads from `response_metadata.usage`) are still correctly
  recovered. **The correct pattern — and what every other test in this
  package does — is to build the `UsageObservation` from the FRESH,
  in-process adapter output at turn time and persist that observation
  durably then, never to re-derive it later from a reloaded checkpoint
  message.** This is asserted directly in the test (`freshObservation` has
  all fields; `reloadedObservation` is missing exactly the
  `usage_metadata`-sourced ones).

### Part 2 — Galley ingestion substitute (`UsageIngest`)

Ingestion-rule test names and what each proves (all in
`experiments/usage-persistence/test/`, all passing):

| Rule (issue #26) | Test(s) | Result |
| --- | --- | --- |
| Same observation fed twice (same generation ID) → one record, totals unchanged | `usage-store.test.ts`: "record: feeding the same generation ID twice yields one record and unchanged totals" | `UsageObservationStore.record()`'s `ON CONFLICT (generation_id) DO NOTHING` returns `inserted:false` and the SAME row id on replay; `totalsForRound()` before/after the replay is byte-identical (`observationCount: 1`, same sums). |
| Unknown usage is never summed as zero; the incomplete flag is visible on the TOTAL | `usage-ingest.test.ts`: "computeRoundTotals: unknown usage is never summed as zero..."; `usage-only-chunk-full-path.test.ts`; `truncated-stream-ingest.test.ts` | `tokenTotal()` excludes `"unknown"` contributions from `sum` and sets `incomplete: true` on the `TokenTotal`; `RoundTotals.incomplete` (a field on the total itself, not derived by re-scanning rows) is `true` whenever any contribution was unknown. |
| Aggregate reported cost distinguished from an unavailable search-cost breakdown, never inferred from it | `usage-ingest.test.ts`: "computeRoundTotals: aggregate reported cost is distinguished from..." | `searchCostBreakdown` is a separate field from `cost`; `SEARCH_COST_UNAVAILABLE` is a fixed constant never derived by scaling `reportedSum` — the test asserts `!("amount" in totals.searchCostBreakdown)` even when `reportedSum > 0`. |
| A truncated stream yields unknown tokens with partial content retained | `truncated-stream-ingest.test.ts` (real `ChatOpenRouter.stream()` against the truncated fixture; connection drops, `TypeError: terminated`, exactly `TRUNCATED_CHUNKS_DELIVERED` chunks delivered) | Partial content (`"This response will be cut off before completion because the connection drops unexpectedly "`) is retained verbatim on the observation; all token fields and cost are `"unknown"`; `RoundTotals.incomplete === true`. |
| An estimated cost carries its estimation basis; mixing estimated with reported in one total keeps both visible | `usage-ingest.test.ts`: "estimateCostFromTokens carries an explicit estimation basis..."; "computeRoundTotals: mixing estimated and reported cost..." | `estimateCostFromTokens()` returns `{status:"estimated", amount, basis, provenance}` using an explicitly-labeled synthetic, test-only pricing table (`FIXTURE_TOKEN_PRICING` — not a real OpenRouter price, selects no model, D7 untouched); a total mixing both keeps `reportedSum`/`estimatedSum`/`hasReported`/`hasEstimated` all independently visible with `status: "mixed"`, and `status: "mixed-with-unknown"` when an unknown contribution is also present. |
| Usage-only-final-chunk fixture through the full path; adapter alone reports nothing, never a silent zero | `usage-only-chunk-full-path.test.ts` | Real `ChatOpenRouter.stream()` against the real fixture server: the adapter-only `UsageObservation` has `promptTokens/completionTokens: "unknown"`, `cost.status: "unknown"`; `computeRoundTotals` on that observation ALONE has `incomplete: true` and `reportedSum: 0` (asserted as "nothing reported", not "reported zero", per the field semantics). A SEPARATE raw-capture-derived observation (`mergeRawSseEvents` reads all 3 raw SSE events the fake server sent, including the empty-`choices` trailing chunk the adapter itself `continue`s past) recovers the true numbers; `mergeObservations` combines them into a complete total. The adapter-only finding is asserted and left standing, not overwritten. |

### Field → survival table

| Field | Adapter-surfaced (in-process) | Survives checkpoint reload | Recovered out-of-band (raw capture) |
| --- | --- | --- | --- |
| Message content | Yes | **Yes** (constructor kwarg) | n/a (already adapter-carried) |
| Citation url/title/content/offsets | **No** (#25: dropped before the message) | No (nothing to persist) | **Yes** — attached to the Round's `usage_observations` row; codepoint offsets exact |
| `usage_metadata` (normalized reasoning/cached tokens) | Yes | **No** (not a constructor kwarg — new finding, this slice) | Not needed for this fixture; would require building the observation before reload |
| `response_metadata.usage` (raw: reasoning, cached, cache-write, cost) | Yes | **Yes** (constructor kwarg) | Not needed for this fixture |
| Usage delivered via the empty-`choices` trailing SSE chunk | **No** (#25: `_streamResponseChunks` `continue`s past it) | No (never reached the message) | **Yes** — raw SSE event capture recovers `prompt_tokens`, `completion_tokens`, `cost`, etc. exactly |
| Truncated-stream partial content | Yes (whatever chunks arrived) | Not exercised through the checkpoint in this slice (see "Outstanding checks") | n/a — retained directly from the in-process partial chunks |

## Real-provider evidence (observed, or "none executed")

None executed. No real OpenRouter API key exists in this environment and
this workspace never calls a real provider (`experiments/README.md`). The
controlled real selected-model smoke test (tool calling, streaming, usage
reporting, citations, through the actual chosen model once one is
selected — open decision D7) remains deferred to **M7**, per
`docs/integration-feasibility.md` ("Follow with a controlled real
selected-model smoke test before research acceptance") and #25's own
evidence file. Reconciliation of this substitute's `UsageObservation`
model against Galley's real ingestion pipeline and real accounting totals
is **M9**'s concern (`docs/usage-accounting.md`).

## Observed limitations

- **The normalized `usage_metadata` checkpoint-loss finding (this slice)
  means a naive re-derivation of usage from a reloaded checkpoint message
  is lossy**, even for fixtures where the adapter itself carried
  everything. This package's own ingestion tests build every
  `UsageObservation` from the fresh, in-process adapter output at turn
  time — never from a later checkpoint reload — specifically to avoid this
  trap; a real Galley ingestion pipeline (M4+) needs the same discipline,
  or it needs to read `response_metadata.usage` (raw) instead of
  `usage_metadata` (normalized) whenever it operates on a reloaded/replayed
  message rather than a fresh one.
- **The usage-only-chunk full-path test (`usage-only-chunk-full-path.test.ts`)
  and the truncated-stream test intentionally bypass `createHarnessAgent`**,
  calling `ChatOpenRouter.stream()` directly. Whether LangChain JS
  `createAgent`'s internal model-call step ever invokes the underlying
  chat model via its streaming API (as opposed to a plain `.invoke()`) for
  an ordinary conversational step is undocumented/uncertain behavior this
  slice did not need to resolve to satisfy the issue's acceptance
  criteria (the checkpoint-survival behavior for whatever the model
  returns is established generically by `checkpoint-persistence.test.ts`,
  which shows the checkpoint just persists `lc_kwargs` regardless of how
  the message was produced). Confirming whether a real production turn
  would route the usage-only-chunk fixture's request through the
  checkpointed agent's SSE path specifically is left to **M7/M9**.
- **`RoundRegistry` rows are never deleted by this package's tests either**
  (consistent with #22's own convention — an append-only registry, not
  scratch state); only `checkpoints` and `usage_observations` rows are
  cleaned up per test, in `finally` blocks, using unique thread/Round/
  generation IDs per run so concurrent/repeated runs never collide.
  Confirmed via direct `psql` counts after a full `npm test` run:
  `checkpoints` and `usage_observations` both `0`; `round_registry`
  non-zero and growing (by design).
- **The `openai` transitive dependency resolved to `7.19.0`** at this
  package's `npm install` time, one patch ahead of #25's recorded
  `7.18.0` — `@langchain/openrouter@0.4.13` does not pin it exactly. This
  package's own committed `package-lock.json` fixes the exact resolved
  tree for reproducibility; no behavioral difference was observed.
- Per `experiments/README.md`, this experiment does not select object
  storage, hosting, a native model, or an OpenCode provider/model.
- All caveats already recorded in #25's evidence file (default-retry
  behavior/timing, the raw-fetch-interception mechanism being global and
  process-wide, the Unicode-offset convention being a constructed
  assumption) apply here unchanged and are not re-derived.

## Outstanding checks and owning milestone

- Real selected-model smoke test (tool calling, streaming, usage
  reporting, citations) against an actual OpenRouter model once one is
  chosen, including whether a real response's usage-only trailing chunk
  and citation-offset convention match this experiment's constructed
  fixtures — **M7** (`docs/agent-execution.md`; `docs/integration-feasibility.md`, S4).
- Whether the truncated-stream and usage-only-chunk paths behave
  identically when driven through `createHarnessAgent`'s checkpointed
  graph (rather than calling `ChatOpenRouter.stream()` directly, as this
  slice does) — **M7**, feeding **M9**.
- A real Galley ingestion pipeline reconciling this substitute's
  `UsageObservation`/`RoundTotals` model against actual ticket/round usage
  totals, dashboards, and the `usage_metadata`-vs-`response_metadata.usage`
  checkpoint-survival distinction found here — **M9**
  (`docs/usage-accounting.md`).
- Whether a real web-search-enabled OpenRouter response ever populates a
  search-specific cost breakdown field this experiment's fixtures don't
  model (per #25's own outstanding checks) — **M7/M9**; this slice's
  `SearchCostBreakdown` type is ready to carry a `"reported"`/`"estimated"`
  variant once that's observed, but defaults to `"unavailable"` today.
- Multi-turn / multi-Round reuse of the same LangGraph thread with usage
  accumulating across multiple generations in one Round — not exercised
  here (each test uses one turn); routed to whichever milestone owns
  multi-turn Round semantics generally (see #22's evidence file, which
  routes the analogous gap to D5/M5).

## Decision impacts (open-decision IDs)

- **D7 (native model unselected)**: untouched. This slice selects no
  OpenRouter model, no object storage, and no hosting — it exercises the
  adapter/checkpoint/ingestion mechanism only, against a fake server and
  constructed fixtures. It does inform D7 by establishing that the
  checkpoint-serialization loss of `usage_metadata` (this slice's new
  finding) and #25's adapter-level fidelity gaps are both properties of
  the `ChatOpenRouter@0.4.13` + LangGraph-checkpoint stack independent of
  which model is eventually selected under D7.
- **Usage accounting rules for M9** (`docs/usage-accounting.md`): this
  slice demonstrates a concrete, working ingestion substitute
  (`UsageIngest`) that satisfies every stated rule (dedupe by generation
  ID, unknown-is-never-zero with a total-level incomplete flag, aggregate
  cost distinct from an unavailable search-cost breakdown, retained
  partial content with unknown usage, visible estimated-vs-reported
  mixing) against real adapter/server behavior, not just synthetic
  objects. It also surfaces a new constraint M9's real ingestion design
  must respect: build usage observations from the fresh, in-process
  adapter output at turn time, not by re-deriving them from a later
  checkpoint/state reload, because LangChain's message serialization drops
  the normalized `usage_metadata` convenience field (though not the raw
  `response_metadata.usage` passthrough) on that round-trip.
