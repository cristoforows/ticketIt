// Public API of the usage-persistence tracer package (#26). Import only
// from here; `test/` may reach into `../src/*.js` directly for
// package-internal test helpers, but dependents outside this package
// should not (there are none planned in M1).

export { extractCitations, type Citation } from "./citations.js";

export { startRawCapture, type RawCapture, type RawCaptureSession } from "./raw-capture.js";

export {
  type TokenCount,
  type CostClassification,
  type SearchCostBreakdown,
  type UsageObservationSource,
  type UsageObservation,
  type AdapterMessageShape,
  type MergedRawResponse,
  type FixtureTokenPricing,
  type TokenTotal,
  type CostTotal,
  type RoundTotals,
  FIXTURE_TOKEN_PRICING,
  messageContentToString,
  normalizeFromAdapterMessage,
  extractRawMessage,
  mergeRawSseEvents,
  normalizeFromRawResponse,
  mergeObservations,
  estimateCostFromTokens,
  computeRoundTotals,
} from "./usage-ingest.js";

export { UsageObservationStore } from "./usage-store.js";
