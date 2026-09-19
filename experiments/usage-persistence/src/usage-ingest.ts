/**
 * UsageIngest: a Galley ingestion substitute (#26).
 *
 * Normalizes `ChatOpenRouter` adapter output (`usage_metadata`,
 * `response_metadata.usage`) plus raw-response data (recovered via
 * `raw-capture.ts`, per #25's raw-response access path) into usage
 * observations carrying: Round ID, provider generation/message ID, token
 * fields (prompt, completion, reasoning, cached, cache-write where
 * present), cost classified as reported/estimated/unknown with provenance,
 * a search-cost breakdown kept separate from aggregate reported cost, and
 * citations. This is a bounded M1 substitute for Galley's real ingestion
 * pipeline (see docs/usage-accounting.md); it selects no object storage,
 * hosting, model, or provider (open decision D7 untouched).
 */
import { extractCitations, type Citation } from "./citations.js";

/**
 * A token count that is either a known number or explicitly "unknown".
 * `docs/v1-scope.md` ("Usage"): "missing data is unknown rather than zero."
 * Modeling this as a union (rather than defaulting to `0`) makes "unknown"
 * a value that has to be handled, not a number that can be silently summed.
 */
export type TokenCount = number | "unknown";

/**
 * Cost classification with provenance. `docs/v1-scope.md` ("Usage"):
 * "Distinguish estimates and reported costs; missing data is unknown rather
 * than zero."
 */
export type CostClassification =
  | { readonly status: "reported"; readonly amount: number; readonly provenance: string }
  | { readonly status: "estimated"; readonly amount: number; readonly basis: string; readonly provenance: string }
  | { readonly status: "unknown"; readonly reason: string };

/**
 * Search-specific cost breakdown, modeled distinctly from aggregate
 * reported cost so an "unavailable" breakdown is never confused with, or
 * inferred from, the aggregate. See `docs/integration-feasibility.md`
 * ("OpenRouter accounting": "cost, cache-write tokens, usage-only SSE
 * chunks, or search-cost breakdown" are not guaranteed to survive) and
 * issue #26 ("Aggregate reported cost is distinguished from an unavailable
 * search-cost breakdown: record that the breakdown is unavailable rather
 * than inferring it.").
 */
export type SearchCostBreakdown =
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "reported"; readonly amount: number; readonly provenance: string }
  | { readonly status: "estimated"; readonly amount: number; readonly basis: string; readonly provenance: string };

/** Where an observation's data came from. */
export type UsageObservationSource = "adapter" | "raw-capture" | "adapter+raw-capture";

/** One normalized usage/citation observation for a single provider generation. */
export interface UsageObservation {
  readonly roundId: string;
  /** Provider generation or message ID (OpenRouter's top-level `id`, e.g. "gen-usage-1"). */
  readonly generationId: string;
  readonly source: UsageObservationSource;
  readonly promptTokens: TokenCount;
  readonly completionTokens: TokenCount;
  readonly reasoningTokens: TokenCount;
  readonly cachedTokens: TokenCount;
  readonly cacheWriteTokens: TokenCount;
  readonly cost: CostClassification;
  readonly searchCost: SearchCostBreakdown;
  readonly citations: readonly Citation[];
  /** The message content this observation was built from (possibly partial; see `partial`). */
  readonly content: string;
  /** True if `content` is a partial result from a stream that never completed. */
  readonly partial: boolean;
}

const SEARCH_COST_UNAVAILABLE: SearchCostBreakdown = {
  status: "unavailable",
  reason:
    "OpenRouter's usage-accounting docs " +
    "(https://openrouter.ai/docs/guides/guides/usage-accounting) do not document a " +
    "per-search-call cost breakdown field, and no fixture in " +
    "experiments/openrouter-fidelity models one (#25's evidence file, 'Outstanding " +
    "checks'). Recorded as unavailable rather than inferring a portion of the " +
    "aggregate reported cost as search cost.",
};

function numberOrUnknown(value: unknown): TokenCount {
  return typeof value === "number" && Number.isFinite(value) ? value : "unknown";
}

/** Extracts plain text from a LangChain message `content` field (string or content-block array). */
export function messageContentToString(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "object" && block !== null && "text" in block ? String((block as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

function classifyCostFromRawUsage(usage: Record<string, unknown> | undefined, provenance: string): CostClassification {
  const cost = usage?.["cost"];
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return { status: "reported", amount: cost, provenance };
  }
  return {
    status: "unknown",
    reason: "no numeric `cost` field present in the usage payload this observation was built from",
  };
}

interface RawUsageShape {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly cost?: unknown;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown };
  readonly prompt_tokens_details?: { readonly cached_tokens?: unknown; readonly cache_write_tokens?: unknown };
}

/**
 * Shape of the fields `ChatOpenRouter` actually exposes on the `AIMessage`
 * it returns, per #25's fidelity matrix: `usage_metadata` (normalized,
 * missing cost and cache-write) and `response_metadata.usage` (the raw
 * passthrough object, complete except when it never arrives at all -- the
 * usage-only-trailing-chunk case in stream mode).
 */
export interface AdapterMessageShape {
  readonly content: unknown;
  readonly id?: string;
  readonly usage_metadata?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly input_token_details?: { readonly cache_read?: unknown };
    readonly output_token_details?: { readonly reasoning?: unknown };
  };
  readonly response_metadata?: { readonly usage?: RawUsageShape; readonly annotations?: unknown };
  readonly additional_kwargs?: { readonly annotations?: unknown };
}

/**
 * Builds a `UsageObservation` from ONLY what `ChatOpenRouter` itself
 * surfaces on the returned message -- the "honest, adapter-only" path.
 * Per #25: citations never reach this surface at all (empty array here,
 * always), cache-write tokens are only reachable via the raw
 * `response_metadata.usage` passthrough (not `usage_metadata`), and if
 * usage never arrived on the message at all (e.g. the usage-only trailing
 * SSE chunk, dropped by the adapter in stream mode), every token field and
 * the cost are "unknown" here -- not zero.
 */
export function normalizeFromAdapterMessage(params: {
  readonly roundId: string;
  readonly message: AdapterMessageShape;
  readonly partial?: boolean;
}): UsageObservation {
  const { roundId, message } = params;
  const content = messageContentToString(message.content);
  const usageMetadata = message.usage_metadata;
  const rawUsage = message.response_metadata?.usage;

  const promptTokens = numberOrUnknown(usageMetadata?.input_tokens);
  const completionTokens = numberOrUnknown(usageMetadata?.output_tokens);
  const reasoningTokens = numberOrUnknown(usageMetadata?.output_token_details?.reasoning);
  const cachedTokens = numberOrUnknown(usageMetadata?.input_token_details?.cache_read);
  // Cache-write is never normalized into usage_metadata by this adapter
  // version (#25: convertUsageMetadata only maps cached_tokens/audio_tokens);
  // only reachable via the raw response_metadata.usage passthrough.
  const cacheWriteTokens = numberOrUnknown(rawUsage?.prompt_tokens_details?.cache_write_tokens);

  const cost = classifyCostFromRawUsage(
    rawUsage as Record<string, unknown> | undefined,
    "adapter-surfaced raw passthrough (response_metadata.usage); usage_metadata itself has no cost field (#25)",
  );

  // additional_kwargs.annotations / response_metadata.annotations: #25
  // confirmed neither is ever populated by this adapter version. Always [].
  const annotations = message.additional_kwargs?.annotations ?? message.response_metadata?.annotations;

  return {
    roundId,
    generationId: message.id ?? "unknown-generation",
    source: "adapter",
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    cacheWriteTokens,
    cost,
    searchCost: SEARCH_COST_UNAVAILABLE,
    citations: extractCitations(content, annotations),
    content,
    partial: params.partial ?? false,
  };
}

/** A raw response, normalized to one shape regardless of whether it came from a JSON body or merged SSE events. */
export interface MergedRawResponse {
  readonly id: string | undefined;
  readonly model: string | undefined;
  readonly content: string;
  readonly annotations: unknown;
  readonly usage: RawUsageShape | undefined;
}

/** Builds a `MergedRawResponse` from a raw (non-streaming) JSON invoke body. */
export function extractRawMessage(json: Record<string, unknown>): MergedRawResponse {
  const choices = Array.isArray(json["choices"]) ? (json["choices"] as unknown[]) : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice?.["message"] as Record<string, unknown> | undefined;
  return {
    id: typeof json["id"] === "string" ? (json["id"] as string) : undefined,
    model: typeof json["model"] === "string" ? (json["model"] as string) : undefined,
    content: typeof message?.["content"] === "string" ? (message["content"] as string) : "",
    annotations: message?.["annotations"],
    usage: isRecord(json["usage"]) ? (json["usage"] as RawUsageShape) : undefined,
  };
}

/**
 * Merges a raw SSE event list (every `data: ...` event's JSON payload, in
 * order, as captured independently of the adapter -- see `raw-capture.ts`)
 * into one logical response, WITHOUT the adapter's own
 * `if (!choice?.delta) continue` behavior that silently drops an
 * empty-`choices` usage-only trailing chunk (#25's single most
 * consequential finding). This is the out-of-band recovery path for that
 * exact drop: reading the raw bytes directly recovers the usage this
 * adapter's `.stream()` never surfaces.
 */
export function mergeRawSseEvents(events: readonly Record<string, unknown>[]): MergedRawResponse {
  let id: string | undefined;
  let model: string | undefined;
  let content = "";
  let annotations: unknown[] = [];
  let usage: RawUsageShape | undefined;

  for (const event of events) {
    if (typeof event["id"] === "string") {
      id = event["id"] as string;
    }
    if (typeof event["model"] === "string") {
      model = event["model"] as string;
    }
    if (isRecord(event["usage"])) {
      usage = event["usage"] as RawUsageShape;
    }
    const choices = Array.isArray(event["choices"]) ? (event["choices"] as unknown[]) : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const delta = choice?.["delta"] as Record<string, unknown> | undefined;
    if (delta) {
      if (typeof delta["content"] === "string") {
        content += delta["content"];
      }
      if (Array.isArray(delta["annotations"])) {
        annotations = annotations.concat(delta["annotations"] as unknown[]);
      }
    }
  }

  return { id, model, content, annotations, usage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Builds a `UsageObservation` from a `MergedRawResponse` -- the out-of-band
 * path, independent of whatever `ChatOpenRouter` itself surfaced. Unlike
 * `normalizeFromAdapterMessage`, this recovers citations (never present on
 * the adapter surface) and recovers usage even when it arrived via the
 * empty-`choices` trailing SSE chunk the adapter drops.
 */
export function normalizeFromRawResponse(params: {
  readonly roundId: string;
  readonly raw: MergedRawResponse;
  readonly source?: UsageObservationSource;
  readonly partial?: boolean;
}): UsageObservation {
  const { roundId, raw } = params;
  const usage = raw.usage;

  const promptTokens = numberOrUnknown(usage?.prompt_tokens);
  const completionTokens = numberOrUnknown(usage?.completion_tokens);
  const reasoningTokens = numberOrUnknown(usage?.completion_tokens_details?.reasoning_tokens);
  const cachedTokens = numberOrUnknown(usage?.prompt_tokens_details?.cached_tokens);
  const cacheWriteTokens = numberOrUnknown(usage?.prompt_tokens_details?.cache_write_tokens);

  const cost = classifyCostFromRawUsage(
    usage as Record<string, unknown> | undefined,
    "raw-response capture (fetch interception + response.clone(), out-of-band of the adapter; #25)",
  );

  return {
    roundId,
    generationId: raw.id ?? "unknown-generation",
    source: params.source ?? "raw-capture",
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    cacheWriteTokens,
    cost,
    searchCost: SEARCH_COST_UNAVAILABLE,
    citations: extractCitations(raw.content, raw.annotations),
    content: raw.content,
    partial: params.partial ?? false,
  };
}

/**
 * Merges an adapter-surfaced observation with an out-of-band raw-capture
 * observation of the SAME generation, preferring adapter-carried fields
 * when present (they are the checkpoint-durable ones -- see
 * docs/evidence/m1/26-usage-persistence.md) and falling back to the raw
 * capture only for fields the adapter dropped (citations always; usage only
 * when the adapter genuinely never surfaced it).
 */
export function mergeObservations(adapterObs: UsageObservation, rawObs: UsageObservation): UsageObservation {
  function pick(a: TokenCount, b: TokenCount): TokenCount {
    return a === "unknown" ? b : a;
  }
  const cost = adapterObs.cost.status !== "unknown" ? adapterObs.cost : rawObs.cost;
  const generationId = adapterObs.generationId !== "unknown-generation" ? adapterObs.generationId : rawObs.generationId;
  return {
    roundId: adapterObs.roundId,
    generationId,
    source: "adapter+raw-capture",
    promptTokens: pick(adapterObs.promptTokens, rawObs.promptTokens),
    completionTokens: pick(adapterObs.completionTokens, rawObs.completionTokens),
    reasoningTokens: pick(adapterObs.reasoningTokens, rawObs.reasoningTokens),
    cachedTokens: pick(adapterObs.cachedTokens, rawObs.cachedTokens),
    cacheWriteTokens: pick(adapterObs.cacheWriteTokens, rawObs.cacheWriteTokens),
    cost,
    searchCost: SEARCH_COST_UNAVAILABLE,
    citations: adapterObs.citations.length > 0 ? adapterObs.citations : rawObs.citations,
    content: adapterObs.content.length > 0 ? adapterObs.content : rawObs.content,
    partial: adapterObs.partial || rawObs.partial,
  };
}

/** A synthetic, test-only per-token pricing table (see `FIXTURE_TOKEN_PRICING`). */
export interface FixtureTokenPricing {
  readonly promptPerToken: number;
  readonly completionPerToken: number;
  readonly label: string;
}

/**
 * Synthetic, test-only per-token pricing table used ONLY to exercise the
 * "estimated" cost code path deterministically when a provider usage
 * payload has no `cost` field (e.g. the tool-call fixture in
 * experiments/openrouter-fidelity, whose `usage` object has token counts
 * but no `cost`). This is NOT a real OpenRouter price for any model and
 * selects no provider/model -- open decision D7
 * (docs/open-decisions.md) remains untouched; see experiments/README.md,
 * "Never select object storage, hosting, or a model."
 */
export const FIXTURE_TOKEN_PRICING: FixtureTokenPricing = {
  promptPerToken: 0.000005,
  completionPerToken: 0.000015,
  label:
    "usage-persistence fixture pricing table v1 ($0.000005/prompt-token, " +
    "$0.000015/completion-token) -- synthetic, test-only, not a real OpenRouter price",
};

/**
 * Estimates cost from known token counts using a stated pricing basis. Per
 * issue #26: "An estimated cost carries its estimation basis." Returns
 * `unknown` (never a silently-estimated zero) if either token count is
 * itself unknown.
 */
export function estimateCostFromTokens(
  promptTokens: TokenCount,
  completionTokens: TokenCount,
  pricing: FixtureTokenPricing = FIXTURE_TOKEN_PRICING,
): CostClassification {
  if (promptTokens === "unknown" || completionTokens === "unknown") {
    return { status: "unknown", reason: "cannot estimate cost: prompt or completion token count is itself unknown" };
  }
  const amount = promptTokens * pricing.promptPerToken + completionTokens * pricing.completionPerToken;
  return {
    status: "estimated",
    amount,
    basis: pricing.label,
    provenance: "estimated locally from reported token counts; the provider usage payload had no `cost` field",
  };
}

/** Per-token-field totals: the arithmetic sum over known contributions, plus whether any contribution was unknown. */
export interface TokenTotal {
  readonly sum: number;
  /** True if at least one contributing observation had this field as "unknown" (excluded from `sum`, never summed as zero). */
  readonly incomplete: boolean;
}

/** Aggregated cost across a set of observations, keeping reported/estimated/unknown contributions distinct and visible. */
export interface CostTotal {
  readonly reportedSum: number;
  readonly estimatedSum: number;
  readonly unknownCount: number;
  readonly hasReported: boolean;
  readonly hasEstimated: boolean;
  readonly hasUnknown: boolean;
  readonly status: "reported" | "estimated" | "mixed" | "unknown" | "mixed-with-unknown" | "none";
}

/** Totals for every usage observation attributed to one Round. */
export interface RoundTotals {
  readonly roundId: string;
  readonly observationCount: number;
  readonly promptTokens: TokenTotal;
  readonly completionTokens: TokenTotal;
  readonly reasoningTokens: TokenTotal;
  readonly cachedTokens: TokenTotal;
  readonly cacheWriteTokens: TokenTotal;
  readonly cost: CostTotal;
  readonly searchCostBreakdown: SearchCostBreakdown;
  readonly citations: readonly Citation[];
  /**
   * True if ANY contributing observation has an unknown token field or an
   * unknown cost. Per issue #26: "the flag is visible on the total, not
   * just on the row" -- this field IS that visibility on the total.
   */
  readonly incomplete: boolean;
}

function tokenTotal(observations: readonly UsageObservation[], pick: (o: UsageObservation) => TokenCount): TokenTotal {
  let sum = 0;
  let incomplete = false;
  for (const observation of observations) {
    const value = pick(observation);
    if (value === "unknown") {
      incomplete = true;
    } else {
      sum += value;
    }
  }
  return { sum, incomplete };
}

/**
 * Computes `RoundTotals` for a Round from its (already deduplicated)
 * observations. Pure function: no I/O, so every ingestion rule in issue
 * #26 can be tested against plain in-memory `UsageObservation` arrays
 * independently of Postgres.
 */
export function computeRoundTotals(roundId: string, observations: readonly UsageObservation[]): RoundTotals {
  const promptTokens = tokenTotal(observations, (o) => o.promptTokens);
  const completionTokens = tokenTotal(observations, (o) => o.completionTokens);
  const reasoningTokens = tokenTotal(observations, (o) => o.reasoningTokens);
  const cachedTokens = tokenTotal(observations, (o) => o.cachedTokens);
  const cacheWriteTokens = tokenTotal(observations, (o) => o.cacheWriteTokens);

  let reportedSum = 0;
  let estimatedSum = 0;
  let unknownCount = 0;
  let hasReported = false;
  let hasEstimated = false;
  let hasUnknown = false;
  for (const observation of observations) {
    if (observation.cost.status === "reported") {
      reportedSum += observation.cost.amount;
      hasReported = true;
    } else if (observation.cost.status === "estimated") {
      estimatedSum += observation.cost.amount;
      hasEstimated = true;
    } else {
      unknownCount += 1;
      hasUnknown = true;
    }
  }
  const costStatus: CostTotal["status"] =
    hasUnknown && (hasReported || hasEstimated)
      ? "mixed-with-unknown"
      : hasUnknown
        ? "unknown"
        : hasReported && hasEstimated
          ? "mixed"
          : hasReported
            ? "reported"
            : hasEstimated
              ? "estimated"
              : "none";

  // The aggregate search-cost breakdown is NEVER inferred from reportedSum:
  // if any contributing observation's own breakdown is "unavailable", the
  // aggregate is "unavailable" too, full stop (issue #26).
  const anyUnavailable = observations.some((o) => o.searchCost.status === "unavailable");
  const searchCostBreakdown: SearchCostBreakdown =
    observations.length === 0 || anyUnavailable
      ? SEARCH_COST_UNAVAILABLE
      : observations[0]!.searchCost;

  const incomplete =
    promptTokens.incomplete ||
    completionTokens.incomplete ||
    reasoningTokens.incomplete ||
    cachedTokens.incomplete ||
    cacheWriteTokens.incomplete ||
    hasUnknown;

  return {
    roundId,
    observationCount: observations.length,
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    cacheWriteTokens,
    cost: { reportedSum, estimatedSum, unknownCount, hasReported, hasEstimated, hasUnknown, status: costStatus },
    searchCostBreakdown,
    citations: observations.flatMap((o) => o.citations),
    incomplete,
  };
}
