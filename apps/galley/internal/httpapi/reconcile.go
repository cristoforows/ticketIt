package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	reconcileShape            = `request body must be JSON matching {"held": [] or [{"roundId", "claimEpoch", "execution": "running" | "stopped" | "unknown"}]}`
	runnerDisconnectedCode    = "runner_disconnected"
	runnerDisconnectedMessage = "authority is not checked while the runner is disconnected"
	reconcileRequiredCode     = "reconcile_required"
	reconcileRequiredMessage  = "authority is not checked until the runner reconciles this Round"
)

var reconcileNotes = map[HeldExecution]string{
	HeldRunning: "Reconciled with the runner: execution running",
	HeldUnknown: "Reconciled with the runner: the runner cannot confirm execution",
	HeldStopped: "Reconciled with the runner: the runner reports execution stopped",
}

type reconcileFlag int

const (
	reconcileFlagUnchanged reconcileFlag = iota
	reconcileFlagCleared
	reconcileFlagSet
)

type reconcileDecision struct {
	disposition    ReconcileDisposition
	cessationEvent *CessationEvent
	flag           reconcileFlag
	execution      HeldExecution
}

// Belief is never evidence of cessation: only the runner's own cessation event, through the event ladder, ends a Round.
func decideReconcile(belief HeldExecution, stopRequested bool) reconcileDecision {
	switch belief {
	case HeldRunning:
		if stopRequested {
			return reconcileDecision{disposition: ReconcileStop, flag: reconcileFlagCleared, execution: HeldRunning}
		}
		return reconcileDecision{disposition: ReconcileContinue, flag: reconcileFlagCleared, execution: HeldRunning}
	case HeldStopped:
		event := CessationInterrupted
		if stopRequested {
			event = CessationStopConfirmed
		}
		return reconcileDecision{disposition: ReconcileReportCessation, cessationEvent: &event, flag: reconcileFlagUnchanged, execution: HeldStopped}
	default:
		return reconcileDecision{disposition: ReconcileHold, flag: reconcileFlagSet, execution: HeldUnknown}
	}
}

func (d reconcileDecision) required(current bool) bool {
	switch d.flag {
	case reconcileFlagCleared:
		return false
	case reconcileFlagSet:
		return true
	default:
		return current
	}
}

type reconcilingRound struct {
	id                int64
	publicID          string
	state             RoundState
	epoch             int
	ticketStatus      TicketStatus
	required          bool
	recordedExecution *HeldExecution
	stopRequested     bool
	callerHolds       bool
}

func decideReconcileTarget(round reconcilingRound, held HeldRound) *roundEventRejection {
	switch {
	case !round.callerHolds:
		return runnerNotHolderRejection()
	case held.ClaimEpoch != round.epoch:
		return &roundEventRejection{http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage}
	case !OpenRoundState(round.state).Valid():
		return &roundEventRejection{http.StatusConflict, roundNotOpenCode, roundNotOpenMessage}
	}
	return nil
}

func (s *server) ReconcileRunner(w http.ResponseWriter, r *http.Request) {
	runner, ok := s.requireRunner(w, r)
	if !ok {
		return
	}
	var req ReconcileRequest
	if !decodeStrictJSON(w, r, &req, reconcileShape) {
		return
	}
	if req.Held == nil || len(req.Held) > 1 {
		writeError(w, http.StatusBadRequest, "invalid_request", reconcileShape)
		return
	}
	var held *HeldRound
	if len(req.Held) == 1 {
		held = &req.Held[0]
		if held.RoundId == "" || held.ClaimEpoch < 1 || held.ClaimEpoch > claimEpochMax || !held.Execution.Valid() {
			writeError(w, http.StatusBadRequest, "invalid_request", reconcileShape)
			return
		}
		if held.RoundId, ok = canonicalPublicID(held.RoundId); !ok {
			writeRoundNotFound(w)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	result, found, rejection, err := reconcileRound(ctx, s.pool, runner.ownerID, runner.id, held, s.clockNow())
	switch {
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to reconcile")
	case !found:
		writeRoundNotFound(w)
	case rejection != nil:
		writeError(w, rejection.status, rejection.code, rejection.message)
	default:
		writeJSON(w, http.StatusOK, result)
	}
}

// Lock order is the event ladder's: the Owner's priority lock, the Ticket row, then the Round row. The Ticket row lock
// also serialises the activity note's seq with every event's.
func reconcileRound(ctx context.Context, pool *pgxpool.Pool, ownerID, runnerID int64, held *HeldRound, now time.Time) (ReconcileResult, bool, *roundEventRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return ReconcileResult{}, false, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockOwnerPriority(ctx, tx, ownerID); err != nil {
		return ReconcileResult{}, false, nil, err
	}
	var ticketID string
	if held == nil {
		err = tx.QueryRow(ctx, `SELECT t.public_id::text FROM rounds r JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
			WHERE r.owner_id = $1 AND r.state IN `+openRoundStatesSQL, ownerID).Scan(&ticketID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ReconcileResult{}, true, nil, nil
		}
	} else {
		err = tx.QueryRow(ctx, `SELECT t.public_id::text FROM rounds r JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
			WHERE r.owner_id = $1 AND r.public_id = $2::uuid`, ownerID, held.RoundId).Scan(&ticketID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ReconcileResult{}, false, nil, nil
		}
	}
	if err != nil {
		return ReconcileResult{}, false, nil, err
	}
	if _, found, err := lockTicketForMutation(ctx, tx, ownerID, ticketID); err != nil || !found {
		return ReconcileResult{}, false, nil, err
	}
	var round reconcilingRound
	var recorded *string
	var holderID *int64
	err = tx.QueryRow(ctx, `SELECT r.id, r.public_id::text, r.runner_id, r.state, r.claim_epoch, t.status, r.reconcile_required, r.reconcile_execution,
			EXISTS (SELECT 1 FROM round_commands c WHERE c.owner_id = r.owner_id AND c.round_id = r.id AND c.type = $4)
		FROM rounds r JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		WHERE r.owner_id = $1 AND t.public_id = $2::uuid AND ($3::uuid IS NULL AND r.state IN `+openRoundStatesSQL+` OR r.public_id = $3::uuid)
		FOR UPDATE OF r`, ownerID, ticketID, heldRoundID(held), string(RunnerCommandStop)).
		Scan(&round.id, &round.publicID, &holderID, &round.state, &round.epoch, &round.ticketStatus, &round.required, &recorded, &round.stopRequested)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReconcileResult{}, held == nil, nil, nil
	}
	if err != nil {
		return ReconcileResult{}, false, nil, err
	}
	if recorded != nil {
		execution := HeldExecution(*recorded)
		round.recordedExecution = &execution
	}
	round.callerHolds = runnerHolds(holderID, runnerID)
	belief := HeldUnknown
	if held != nil {
		if rejection := decideReconcileTarget(round, *held); rejection != nil {
			return ReconcileResult{}, true, rejection, nil
		}
		belief = held.Execution
	}
	decision := decideReconcile(belief, round.stopRequested)
	// Another runner's Round: answered as unknown, but that runner's Reconcile says nothing about this Round's execution, so nothing is recorded.
	if !round.callerHolds {
		return ReconcileResult{Round: reconciledRound(round, decision, []RunnerCommand{})}, true, nil, nil
	}
	required := decision.required(round.required)
	executionChanged := round.recordedExecution == nil || *round.recordedExecution != decision.execution
	if executionChanged || required != round.required {
		if _, err := tx.Exec(ctx, `UPDATE rounds SET reconcile_required = $2, reconcile_execution = $3, reconciled_at = $4 WHERE id = $1`,
			round.id, required, string(decision.execution), now); err != nil {
			return ReconcileResult{}, true, nil, err
		}
	}
	if executionChanged {
		if _, err := appendActivity(ctx, tx, ownerID, round.id, reconcileNotes[decision.execution], now); err != nil {
			return ReconcileResult{}, true, nil, err
		}
	}
	commands, _, err := pendingRoundCommands(ctx, tx, ownerID, runnerID, round.publicID)
	if err != nil {
		return ReconcileResult{}, true, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReconcileResult{}, true, nil, err
	}
	return ReconcileResult{Round: reconciledRound(round, decision, commands)}, true, nil, nil
}

func reconciledRound(round reconcilingRound, decision reconcileDecision, commands []RunnerCommand) *ReconciledRound {
	return &ReconciledRound{
		RoundId:        round.publicID,
		State:          OpenRoundState(round.state),
		TicketStatus:   round.ticketStatus,
		ClaimEpoch:     round.epoch,
		Disposition:    decision.disposition,
		CessationEvent: decision.cessationEvent,
		Commands:       commands,
	}
}

func heldRoundID(held *HeldRound) *string {
	if held == nil {
		return nil
	}
	return &held.RoundId
}

// Read in the caller's transaction, after its own flag write, so the answer is the state the caller leaves behind.
func ownerOpenRoundAwaitsReconcile(ctx context.Context, tx pgx.Tx, ownerID int64) (bool, error) {
	var flagged bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM rounds WHERE owner_id = $1 AND state IN `+openRoundStatesSQL+` AND reconcile_required)`, ownerID).Scan(&flagged)
	return flagged, err
}

func flagOwnerOpenRound(ctx context.Context, tx pgx.Tx, ownerID int64) error {
	_, err := tx.Exec(ctx, `UPDATE rounds SET reconcile_required = true WHERE owner_id = $1 AND state IN `+openRoundStatesSQL+` AND NOT reconcile_required`, ownerID)
	return err
}
