package httpapi

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	usageLabelMaxLength = 200
	maxUsageCount       = 1<<53 - 1
)

// NUMERIC(12,6): at most six digits before the point and six after.
var costUSDPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$`)

var usageObservedKeys = []string{"observationId", "provider", "model", "inputTokens", "outputTokens", "costUsd", "activeMs", "basis", "providerGenerationId"}

const usageObservedShape = `"data" must be an object with exactly "observationId", "provider", "model", "inputTokens", "outputTokens", "costUsd", "activeMs", "basis" and "providerGenerationId"`

type usageObservation struct {
	id                   string
	provider             string
	model                string
	inputTokens          *int64
	outputTokens         *int64
	costUSD              *string
	activeMs             *int64
	basis                UsageObservedDataBasis
	providerGenerationID *string
}

func validateUsageObservedData(raw []byte) (usageObservation, string) {
	fields, ok := exactObject(raw, usageObservedKeys...)
	if !ok {
		return usageObservation{}, usageObservedShape
	}
	var observation usageObservation
	var id string
	if json.Unmarshal(fields["observationId"], &id) != nil || !canonicalRunnerUUID(id) {
		return usageObservation{}, `"observationId" must be a non-nil UUID in lowercase canonical form`
	}
	observation.id = id
	for _, label := range []struct {
		name   string
		target *string
	}{{"provider", &observation.provider}, {"model", &observation.model}} {
		if json.Unmarshal(fields[label.name], label.target) != nil || !validEventText(*label.target, usageLabelMaxLength) {
			return usageObservation{}, `"` + label.name + `" must be 1 to 200 characters without control characters`
		}
	}
	for _, count := range []struct {
		name   string
		target **int64
	}{{"inputTokens", &observation.inputTokens}, {"outputTokens", &observation.outputTokens}, {"activeMs", &observation.activeMs}} {
		value, ok := nullableCount(fields[count.name])
		if !ok {
			return usageObservation{}, `"` + count.name + `" must be null or an integer from 0 to 9007199254740991`
		}
		*count.target = value
	}
	if string(fields["costUsd"]) != "null" {
		var cost string
		if json.Unmarshal(fields["costUsd"], &cost) != nil || !costUSDPattern.MatchString(cost) {
			return usageObservation{}, `"costUsd" must be null or a decimal string from "0" to "999999.999999" with at most 6 decimal places`
		}
		observation.costUSD = &cost
	}
	if json.Unmarshal(fields["basis"], &observation.basis) != nil || !observation.basis.Valid() {
		return usageObservation{}, `"basis" must be one of: reported, estimated`
	}
	if string(fields["providerGenerationId"]) != "null" {
		var generation string
		if json.Unmarshal(fields["providerGenerationId"], &generation) != nil || !validEventText(generation, usageLabelMaxLength) {
			return usageObservation{}, `"providerGenerationId" must be null or 1 to 200 characters without control characters`
		}
		observation.providerGenerationID = &generation
	}
	return observation, ""
}

// One spelling per runner-generated id, so the idempotency key and the stored id are the same text.
func canonicalRunnerUUID(id string) bool {
	parsed, err := uuid.Parse(id)
	return err == nil && parsed != uuid.Nil && parsed.String() == id
}

func nullableCount(raw json.RawMessage) (*int64, bool) {
	text := string(raw)
	if text == "null" {
		return nil, true
	}
	if text == "" || len(text) > 1 && text[0] == '0' {
		return nil, false
	}
	for _, c := range text {
		if c < '0' || c > '9' {
			return nil, false
		}
	}
	value, err := strconv.ParseInt(text, 10, 64)
	if err != nil || value > maxUsageCount {
		return nil, false
	}
	return &value, true
}

// An id already recorded belongs to another Round: this Round's replay never reaches here.
func insertUsageObservation(ctx context.Context, tx pgx.Tx, ownerID, roundID int64, o usageObservation, occurredAt time.Time) (bool, error) {
	tag, err := tx.Exec(ctx, `INSERT INTO usage_observations
			(id, owner_id, round_id, provider, model, input_tokens, output_tokens, cost_usd, active_ms, basis, provider_generation_id, occurred_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::text::numeric, $9, $10, $11, $12)
		ON CONFLICT (id) DO NOTHING`,
		o.id, ownerID, roundID, o.provider, o.model, o.inputTokens, o.outputTokens, o.costUSD, o.activeMs, string(o.basis), o.providerGenerationID, occurredAt)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// A figure is complete when there is at least one observation and every one knows the value;
// estimated when an observation that knows the value is estimated. Unknown values are left out of
// the sum, never added as zero.
func roundUsageSummaries(ctx context.Context, tx pgx.Tx, ownerID int64, roundIDs []int64) (map[int64]RoundUsage, error) {
	rows, err := tx.Query(ctx, `SELECT round_id, count(*),
			sum(cost_usd)::text, count(cost_usd), COALESCE(bool_or(basis = 'estimated') FILTER (WHERE cost_usd IS NOT NULL), false),
			sum(input_tokens)::bigint, count(input_tokens), COALESCE(bool_or(basis = 'estimated') FILTER (WHERE input_tokens IS NOT NULL), false),
			sum(output_tokens)::bigint, count(output_tokens), COALESCE(bool_or(basis = 'estimated') FILTER (WHERE output_tokens IS NOT NULL), false),
			sum(active_ms)::bigint, count(active_ms), COALESCE(bool_or(basis = 'estimated') FILTER (WHERE active_ms IS NOT NULL), false)
		FROM usage_observations WHERE owner_id = $1 AND round_id = ANY($2) GROUP BY round_id`, ownerID, roundIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	summaries := map[int64]RoundUsage{}
	for rows.Next() {
		var roundID int64
		var usage RoundUsage
		var knownCosts int
		var input, output, active countFigure
		if err := rows.Scan(&roundID, &usage.Observations,
			&usage.CostUsd, &knownCosts, &usage.Estimated,
			&input.sum, &input.known, &input.estimated,
			&output.sum, &output.known, &output.estimated,
			&active.sum, &active.known, &active.estimated); err != nil {
			return nil, err
		}
		usage.Complete = knownCosts == usage.Observations
		usage.InputTokens = input.usageCount(usage.Observations)
		usage.OutputTokens = output.usageCount(usage.Observations)
		usage.ActiveMs = active.usageCount(usage.Observations)
		summaries[roundID] = usage
	}
	return summaries, rows.Err()
}

type countFigure struct {
	sum       *int64
	known     int
	estimated bool
}

func (f countFigure) usageCount(observations int) UsageCount {
	count := UsageCount{Complete: f.known == observations, Estimated: f.estimated}
	if f.sum != nil {
		sum := int(*f.sum)
		count.Sum = &sum
	}
	return count
}
