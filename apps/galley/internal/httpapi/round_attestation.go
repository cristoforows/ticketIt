package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	attestationNoteMaxLength       = 1000
	attestationNotAvailableCode    = "attestation_not_available"
	attestCessationShape           = `request body must be JSON matching {"basis": "runner_process_ended" | "runner_host_off" | "other", "note"}`
	attestationNotePrefix          = "Ended by Owner attestation: "
	attestationFailedMessage       = "failed to record the attestation"
	attestationNeedsOpenRound      = "attestation needs an open Round"
	attestationArchivedTicket      = "an archived Ticket's Round cannot be attested"
	attestationHolderStillReported = "the runner that claimed this Round is connected and has not reported that it cannot confirm execution; Stop it instead"
)

var attestationBasisLabels = map[AttestationBasis]string{
	AttestationRunnerProcessEnded: "the Michelin process was ended",
	AttestationRunnerHostOff:      "the machine running Michelin was off",
	AttestationOther:              "other",
}

type cessationFacts struct {
	archived          bool
	roundOpen         bool
	holderHealth      RoundHolderHealth
	recordedExecution *HeldExecution
}

func holderHealthOf(holderID, currentRunnerID *int64, currentConnected bool) RoundHolderHealth {
	switch {
	case currentRunnerID == nil:
		return HolderNotPaired
	case !runnerHolds(holderID, *currentRunnerID):
		return HolderReplaced
	case currentConnected:
		return HolderConnected
	default:
		return HolderDisconnected
	}
}

// A connected holder that has not reported unknown can still confirm its own cessation, so the Owner Stops it instead (#171, D5).
func decideCessationAttestation(f cessationFacts) *transitionRejection {
	switch {
	case f.archived:
		return &transitionRejection{code: attestationNotAvailableCode, message: attestationArchivedTicket}
	case !f.roundOpen:
		return &transitionRejection{code: attestationNotAvailableCode, message: attestationNeedsOpenRound}
	case f.holderHealth == HolderConnected && (f.recordedExecution == nil || *f.recordedExecution != HeldUnknown):
		return &transitionRejection{code: attestationNotAvailableCode, message: attestationHolderStillReported}
	}
	return nil
}

func attestationExplanation(basis AttestationBasis) string {
	return attestationNotePrefix + attestationBasisLabels[basis] + "."
}

func validateAttestation(req AttestCessationRequest) string {
	if !req.Basis.Valid() {
		return attestCessationShape
	}
	if req.Note != nil && !validMultilineText(*req.Note, utf8.RuneCountInString(*req.Note), attestationNoteMaxLength) {
		return fmt.Sprintf(`"note" must be 1 to %d characters, not blank, without control characters other than tab and line feed`, attestationNoteMaxLength)
	}
	if req.Basis == AttestationOther && req.Note == nil {
		return `"note" is required with basis "other"`
	}
	return ""
}

func (s *server) AttestRoundCessation(w http.ResponseWriter, r *http.Request, id string, roundId string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	ticketID, ticketOK := canonicalPublicID(id)
	roundID, roundOK := canonicalPublicID(roundId)
	if !ticketOK || !roundOK {
		writeRoundNotFound(w)
		return
	}
	var req AttestCessationRequest
	if !decodeStrictJSON(w, r, &req, attestCessationShape) {
		return
	}
	if problem := validateAttestation(req); problem != "" {
		writeError(w, http.StatusBadRequest, "invalid_request", problem)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	found, rejection, err := attestRoundCessation(ctx, s.pool, owner.ID, ticketID, roundID, req, s.clockNow())
	switch {
	case isTicketGuardFailure(err):
		s.logger.Error("attestation refused: "+err.Error(), "roundId", roundID)
		writeError(w, http.StatusInternalServerError, "internal_error", attestationFailedMessage)
		return
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", attestationFailedMessage)
		return
	case !found:
		writeRoundNotFound(w)
		return
	case rejection != nil:
		writeTransitionRejection(w, rejection)
		return
	}
	rounds, _, err := listRoundsForTicket(ctx, s.pool, owner.ID, ticketID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", attestationFailedMessage)
		return
	}
	for _, round := range rounds {
		if round.Id == roundID {
			writeJSON(w, http.StatusOK, round)
			return
		}
	}
	writeRoundNotFound(w)
}

// Lock order is the event ladder's: the Owner's priority lock, the Ticket row, then the Round row, so an attestation and a
// runner event serialise and the second sees the first's outcome. The runners row is read unlocked: heartbeat and register
// lock it and then the Owner's open Round, and either order of the two is a valid serial history.
func attestRoundCessation(ctx context.Context, pool *pgxpool.Pool, ownerID int64, ticketID, roundID string, req AttestCessationRequest, now time.Time) (bool, *transitionRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockOwnerPriority(ctx, tx, ownerID); err != nil {
		return false, nil, err
	}
	lock, found, err := lockTicketForMutation(ctx, tx, ownerID, ticketID)
	if err != nil || !found {
		return false, nil, err
	}
	var rowID, epoch int64
	var holderID *int64
	var state string
	var recorded *string
	var attested bool
	err = tx.QueryRow(ctx, `SELECT r.id, r.runner_id, r.state, r.claim_epoch, r.reconcile_execution,
			EXISTS (SELECT 1 FROM round_attestations a WHERE a.owner_id = r.owner_id AND a.round_id = r.id)
		FROM rounds r JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		WHERE r.owner_id = $1 AND t.public_id = $2::uuid AND r.public_id = $3::uuid FOR UPDATE OF r`, ownerID, ticketID, roundID).
		Scan(&rowID, &holderID, &state, &epoch, &recorded, &attested)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, err
	}
	if attested {
		return true, nil, nil
	}
	var currentRunnerID *int64
	var lastSeenAt *time.Time
	err = tx.QueryRow(ctx, `SELECT id, last_seen_at FROM runners WHERE owner_id = $1`, ownerID).Scan(&currentRunnerID, &lastSeenAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return true, nil, err
	}
	facts := cessationFacts{
		archived:     lock.archived,
		roundOpen:    OpenRoundState(state).Valid(),
		holderHealth: holderHealthOf(holderID, currentRunnerID, runnerConnected(now, lastSeenAt)),
	}
	if recorded != nil {
		execution := HeldExecution(*recorded)
		facts.recordedExecution = &execution
	}
	if rejection := decideCessationAttestation(facts); rejection != nil {
		return true, rejection, nil
	}
	var holderLastSeenAt *time.Time
	if facts.holderHealth == HolderConnected || facts.holderHealth == HolderDisconnected {
		holderLastSeenAt = lastSeenAt
	}
	if _, err := tx.Exec(ctx, `INSERT INTO round_attestations (owner_id, round_id, attested_at, basis, note, round_state, claim_epoch,
			holder_runner_id, holder_last_seen_at, holder_health, reconcile_execution)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		ownerID, rowID, now, string(req.Basis), req.Note, state, epoch, holderID, holderLastSeenAt, string(facts.holderHealth), recorded); err != nil {
		return true, nil, err
	}
	ending := roundEndings[RoundEventInterrupted]
	ending.note = attestationExplanation(req.Basis)
	if _, err := endRound(ctx, tx, ownerID, ticketID, rowID, RoundState(state), ending, now); err != nil {
		return true, nil, err
	}
	if _, err := appendActivity(ctx, tx, ownerID, rowID, ending.note, now); err != nil {
		return true, nil, err
	}
	return true, nil, tx.Commit(ctx)
}

func roundAttestations(ctx context.Context, tx pgx.Tx, ownerID int64, roundIDs []int64) (map[int64]*RoundAttestation, error) {
	rows, err := tx.Query(ctx, `SELECT round_id, attested_at, basis, note, round_state, claim_epoch, holder_last_seen_at, holder_health, reconcile_execution
		FROM round_attestations WHERE owner_id = $1 AND round_id = ANY($2)`, ownerID, roundIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	attestations := map[int64]*RoundAttestation{}
	for rows.Next() {
		var roundID int64
		var a RoundAttestation
		var basis, state, health string
		var execution *string
		if err := rows.Scan(&roundID, &a.AttestedAt, &basis, &a.Note, &state, &a.ClaimEpoch, &a.HolderLastSeenAt, &health, &execution); err != nil {
			return nil, err
		}
		a.AttestedAt = a.AttestedAt.UTC()
		a.HolderLastSeenAt = utcOrNil(a.HolderLastSeenAt)
		a.Basis, a.RoundState, a.HolderHealth = AttestationBasis(basis), OpenRoundState(state), RoundHolderHealth(health)
		if execution != nil {
			held := HeldExecution(*execution)
			a.ReconcileExecution = &held
		}
		attestations[roundID] = &a
	}
	return attestations, rows.Err()
}
