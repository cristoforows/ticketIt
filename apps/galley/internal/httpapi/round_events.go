package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	idempotencyKeyMaxLength  = 200
	engineReferenceMaxLength = 200
	claimEpochMax            = 1<<31 - 1

	idempotencyKeyConflictCode    = "idempotency_key_conflict"
	idempotencyKeyConflictMessage = "this idempotency key was already recorded with a different payload"
	staleClaimEpochCode           = "stale_claim_epoch"
	staleClaimEpochMessage        = "claimEpoch is not this Round's current claim epoch"
	roundNotOpenCode              = "round_not_open"
	roundNotOpenMessage           = "this Round is no longer open"
	eventOutOfOrderCode           = "event_out_of_order"
	observationIDConflictCode     = "observation_id_conflict"
	observationIDConflictMessage  = "this observationId is already recorded for another Round"
	roundNotFoundMessage          = "no round with that identifier"
	roundEventFailedMessage       = "failed to record the event"
)

const roundEventShape = `request body must be JSON matching {"type", "idempotencyKey", "claimEpoch", "occurredAt", "data"}`

type roundEvent struct {
	eventType       RoundEventType
	idempotencyKey  string
	claimEpoch      int
	occurredAt      time.Time
	payloadHash     []byte
	engineReference string
	note            string
	usage           usageObservation
}

type lockedRound struct {
	id        int64
	state     string
	epoch     int
	open      bool
	startedAt *time.Time
}

type roundEventRejection struct {
	status  int
	code    string
	message string
}

type recordedRoundEvent struct {
	found     bool
	replayed  bool
	rejection *roundEventRejection
	result    RoundEventResult
}

var errRoundEventTicketNotReady = errors.New("the Ticket of a claimed Round is not Ready")

func writeRoundNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", roundNotFoundMessage)
}

func eventOutOfOrderMessage(eventType RoundEventType, state RoundState) string {
	return fmt.Sprintf("%s cannot be reported while the Round is %s", eventType, state)
}

func (s *server) ReportRoundEvent(w http.ResponseWriter, r *http.Request, roundId string) {
	runner, ok := s.requireRunner(w, r)
	if !ok {
		return
	}
	roundID, ok := canonicalPublicID(roundId)
	if !ok {
		writeRoundNotFound(w)
		return
	}
	var req RoundEventRequest
	if !decodeStrictJSON(w, r, &req, roundEventShape) {
		return
	}
	event, problem := validateRoundEvent(req)
	if problem != "" {
		writeError(w, http.StatusBadRequest, "invalid_request", problem)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	recorded, err := recordRoundEvent(ctx, s.pool, runner.ownerID, roundID, event, s.clockNow())
	switch {
	case errors.Is(err, errRoundEventTicketNotReady):
		s.logger.Error("round event refused: the Ticket of a claimed Round is not Ready", "roundId", roundID, "eventType", event.eventType)
		writeError(w, http.StatusInternalServerError, "internal_error", roundEventFailedMessage)
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", roundEventFailedMessage)
	case !recorded.found:
		writeRoundNotFound(w)
	case recorded.rejection != nil:
		writeError(w, recorded.rejection.status, recorded.rejection.code, recorded.rejection.message)
	case recorded.replayed:
		writeJSON(w, http.StatusOK, recorded.result)
	default:
		writeJSON(w, http.StatusCreated, recorded.result)
	}
}

func validateRoundEvent(req RoundEventRequest) (roundEvent, string) {
	if !req.Type.Valid() {
		return roundEvent{}, `"type" must be one of: execution_started, progress, usage_observed`
	}
	if !validEventText(req.IdempotencyKey, idempotencyKeyMaxLength) {
		return roundEvent{}, fmt.Sprintf(`"idempotencyKey" must be 1 to %d characters without control characters`, idempotencyKeyMaxLength)
	}
	if req.ClaimEpoch < 1 || req.ClaimEpoch > claimEpochMax {
		return roundEvent{}, `"claimEpoch" must be a positive integer`
	}
	occurredAt, err := time.Parse(time.RFC3339Nano, req.OccurredAt)
	if err != nil {
		return roundEvent{}, `"occurredAt" must be an RFC 3339 timestamp`
	}
	data, err := req.Data.MarshalJSON()
	if err != nil {
		return roundEvent{}, `"data" must be a JSON object`
	}
	event := roundEvent{eventType: req.Type, idempotencyKey: req.IdempotencyKey, claimEpoch: req.ClaimEpoch, occurredAt: occurredAt}
	var problem string
	switch req.Type {
	case RoundEventExecutionStarted:
		event.engineReference, problem = validateExecutionStartedData(data)
	case RoundEventProgress:
		event.note, problem = validateProgressData(data)
	case RoundEventUsageObserved:
		event.usage, problem = validateUsageObservedData(data)
		if problem == "" && event.usage.id != req.IdempotencyKey {
			problem = `"idempotencyKey" must equal "data.observationId" for usage_observed`
		}
	}
	if problem != "" {
		return roundEvent{}, problem
	}
	event.payloadHash, err = roundEventPayloadHash(req.Type, req.ClaimEpoch, occurredAt, data)
	if err != nil {
		return roundEvent{}, `"data" must be a JSON object`
	}
	return event, ""
}

func validEventText(value string, maxLength int) bool {
	return value != "" && utf8.RuneCountInString(value) <= maxLength && !strings.ContainsFunc(value, isControlRune)
}

func validateExecutionStartedData(raw []byte) (string, string) {
	const shape = `"data" must be an object with exactly "engineReference"`
	fields, ok := exactObject(raw, "engineReference")
	if !ok {
		return "", shape
	}
	var reference string
	if err := json.Unmarshal(fields["engineReference"], &reference); err != nil {
		return "", shape
	}
	if !validEventText(reference, engineReferenceMaxLength) {
		return "", fmt.Sprintf(`"engineReference" must be 1 to %d characters without control characters`, engineReferenceMaxLength)
	}
	return reference, ""
}

// The runner event path is the one writer allowed to change a Ticket under its own open Round,
// so it takes the raw row lock and never lockMutableTicket. Lock order: the Owner's priority
// lock, the Ticket row, then the Round row.
func recordRoundEvent(ctx context.Context, pool *pgxpool.Pool, ownerID int64, roundID string, event roundEvent, now time.Time) (recordedRoundEvent, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return recordedRoundEvent{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var ticketID string
	err = tx.QueryRow(ctx, `SELECT t.public_id::text FROM rounds r JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		WHERE r.owner_id = $1 AND r.public_id = $2::uuid`, ownerID, roundID).Scan(&ticketID)
	if errors.Is(err, pgx.ErrNoRows) {
		return recordedRoundEvent{}, nil
	}
	if err != nil {
		return recordedRoundEvent{}, err
	}
	if err := lockOwnerPriority(ctx, tx, ownerID); err != nil {
		return recordedRoundEvent{}, err
	}
	if _, found, err := lockTicketForMutation(ctx, tx, ownerID, ticketID); err != nil || !found {
		return recordedRoundEvent{}, err
	}
	var round lockedRound
	err = tx.QueryRow(ctx, `SELECT id, state, claim_epoch, state IN `+openRoundStatesSQL+`, started_at FROM rounds
		WHERE owner_id = $1 AND public_id = $2::uuid FOR UPDATE`, ownerID, roundID).Scan(&round.id, &round.state, &round.epoch, &round.open, &round.startedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return recordedRoundEvent{}, nil
	}
	if err != nil {
		return recordedRoundEvent{}, err
	}

	var storedHash []byte
	var stored RoundEventResult
	err = tx.QueryRow(ctx, `SELECT payload_hash, result FROM round_events WHERE round_id = $1 AND idempotency_key = $2`,
		round.id, event.idempotencyKey).Scan(&storedHash, &stored)
	switch {
	case err == nil && bytes.Equal(storedHash, event.payloadHash):
		return recordedRoundEvent{found: true, replayed: true, result: stored}, nil
	case err == nil:
		return recordedRoundEvent{found: true, rejection: &roundEventRejection{http.StatusConflict, idempotencyKeyConflictCode, idempotencyKeyConflictMessage}}, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return recordedRoundEvent{}, err
	}
	if rejection := decideRoundEvent(round, event.eventType, event.claimEpoch); rejection != nil {
		return recordedRoundEvent{found: true, rejection: rejection}, nil
	}

	result := RoundEventResult{RoundId: roundID, Type: event.eventType, State: RoundRunning}
	switch event.eventType {
	case RoundEventExecutionStarted:
		startedAt, err := startRound(ctx, tx, ownerID, ticketID, round.id, event.engineReference, now)
		if err != nil {
			return recordedRoundEvent{}, err
		}
		result.StartedAt = startedAt.UTC()
	case RoundEventProgress:
		seq, err := appendActivity(ctx, tx, ownerID, round.id, event.note, event.occurredAt)
		if err != nil {
			return recordedRoundEvent{}, err
		}
		result.StartedAt, result.Seq = round.startedAt.UTC(), &seq
	case RoundEventUsageObserved:
		recorded, err := insertUsageObservation(ctx, tx, ownerID, round.id, event.usage, event.occurredAt)
		if err != nil {
			return recordedRoundEvent{}, err
		}
		if !recorded {
			return recordedRoundEvent{found: true, rejection: &roundEventRejection{http.StatusConflict, observationIDConflictCode, observationIDConflictMessage}}, nil
		}
		result.StartedAt, result.ObservationId = round.startedAt.UTC(), &event.usage.id
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return recordedRoundEvent{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO round_events (owner_id, round_id, idempotency_key, type, claim_epoch, occurred_at, received_at, payload_hash, result)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		ownerID, round.id, event.idempotencyKey, string(event.eventType), event.claimEpoch, event.occurredAt, now, event.payloadHash, encoded); err != nil {
		return recordedRoundEvent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return recordedRoundEvent{}, err
	}
	return recordedRoundEvent{found: true, result: result}, nil
}

func decideRoundEvent(round lockedRound, eventType RoundEventType, claimEpoch int) *roundEventRejection {
	switch {
	case claimEpoch != round.epoch:
		return &roundEventRejection{http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage}
	case !round.open:
		return &roundEventRejection{http.StatusConflict, roundNotOpenCode, roundNotOpenMessage}
	case !roundStateTakes(RoundState(round.state), eventType):
		return &roundEventRejection{http.StatusConflict, eventOutOfOrderCode, eventOutOfOrderMessage(eventType, RoundState(round.state))}
	}
	return nil
}

// Progress and usage are facts about execution, which Galley knows began only once execution_started is recorded.
func roundStateTakes(state RoundState, eventType RoundEventType) bool {
	switch eventType {
	case RoundEventExecutionStarted:
		return state == RoundClaimed
	case RoundEventProgress, RoundEventUsageObserved:
		return state == RoundRunning
	}
	return false
}

func startRound(ctx context.Context, tx pgx.Tx, ownerID int64, ticketID string, roundID int64, engineReference string, now time.Time) (time.Time, error) {
	var startedAt time.Time
	if err := tx.QueryRow(ctx, `UPDATE rounds SET state = $3, started_at = GREATEST($4::timestamptz, claimed_at)
		WHERE id = $1 AND owner_id = $2 RETURNING started_at`, roundID, ownerID, string(RoundRunning), now).Scan(&startedAt); err != nil {
		return time.Time{}, err
	}
	if err := attachEngineReference(ctx, tx, ownerID, roundID, engineReference, now); err != nil {
		return time.Time{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE tickets SET status = $3, updated_at = now()
		WHERE owner_id = $1 AND public_id = $2::uuid AND status = $4`, ownerID, ticketID, string(InProgress), string(Ready))
	if err != nil {
		return time.Time{}, err
	}
	if tag.RowsAffected() != 1 {
		return time.Time{}, errRoundEventTicketNotReady
	}
	return startedAt, nil
}

// A new reference retires the current one rather than replacing it (ADR 0002).
func attachEngineReference(ctx context.Context, tx pgx.Tx, ownerID, roundID int64, reference string, at time.Time) error {
	if _, err := tx.Exec(ctx, `UPDATE round_engine_references SET is_current = false WHERE owner_id = $1 AND round_id = $2 AND is_current`, ownerID, roundID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO round_engine_references (owner_id, round_id, reference, is_current, attached_at) VALUES ($1, $2, $3, true, $4)`,
		ownerID, roundID, reference, at)
	return err
}
