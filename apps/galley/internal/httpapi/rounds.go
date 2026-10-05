package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The open states' one Go definition; rounds_one_open_per_owner's
// predicate (000013) is the SQL one.
const openRoundStatesSQL = `('claimed', 'running', 'waiting_for_input')`

const oneOpenRoundPerOwnerIndex = "rounds_one_open_per_owner"

const roundOpenCode = "round_open"
const roundOpenMessage = "this Ticket has an open Round; it can be changed once the Round ends"

const (
	claimNotReplayableCode     = "claim_not_replayable"
	claimNotReplayableMessage  = "the Round this idempotency key claimed is no longer claimed"
	claimKeyOtherRunnerMessage = "this idempotency key was used by another runner"
	claimWorkShape             = `request body must be JSON matching {"idempotencyKey"}`
)

type claimOutcome int

const (
	claimNone claimOutcome = iota
	claimCreated
	claimReplayed
	claimKeyOtherRunner
	claimKeyNotReplayable
)

func (s *server) ClaimWork(w http.ResponseWriter, r *http.Request) {
	runner, ok := s.requireRunner(w, r)
	if !ok {
		return
	}
	var req ClaimWorkRequest
	if !decodeStrictJSON(w, r, &req, claimWorkShape) {
		return
	}
	if !validEventText(req.IdempotencyKey, idempotencyKeyMaxLength) {
		writeError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf(`"idempotencyKey" must be 1 to %d characters without control characters`, idempotencyKeyMaxLength))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	claim, outcome, err := claimRoundForRunner(ctx, s.pool, runner, req.IdempotencyKey, s.clockNow())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to claim work")
		return
	}
	switch outcome {
	case claimCreated:
		writeJSON(w, http.StatusCreated, claim)
	case claimReplayed:
		writeJSON(w, http.StatusOK, claim)
	case claimKeyOtherRunner:
		writeError(w, http.StatusConflict, idempotencyKeyConflictCode, claimKeyOtherRunnerMessage)
	case claimKeyNotReplayable:
		writeError(w, http.StatusConflict, claimNotReplayableCode, claimNotReplayableMessage)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func decideClaimReplay(holderID, callerID int64, state string) claimOutcome {
	switch {
	case holderID != callerID:
		return claimKeyOtherRunner
	case state != string(RoundClaimed):
		return claimKeyNotReplayable
	default:
		return claimReplayed
	}
}

// Lock order: the Owner's priority lock, then Ticket rows in priority
// order, then the Round insert. The key lookup follows the priority lock
// so a concurrent claim with the same key sees the committed Round.
func claimRoundForRunner(ctx context.Context, pool *pgxpool.Pool, runner authenticatedRunner, key string, now time.Time) (RunnerClaim, claimOutcome, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return RunnerClaim{}, claimNone, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	ownerID := runner.ownerID
	if err := lockOwnerPriority(ctx, tx, ownerID); err != nil {
		return RunnerClaim{}, claimNone, err
	}
	var holderID int64
	var state string
	var payload []byte
	err = tx.QueryRow(ctx, `SELECT runner_id, state, claim_payload FROM rounds WHERE owner_id = $1 AND claim_idempotency_key = $2`, ownerID, key).
		Scan(&holderID, &state, &payload)
	if err == nil {
		outcome := decideClaimReplay(holderID, runner.id, state)
		if outcome != claimReplayed {
			return RunnerClaim{}, outcome, nil
		}
		var claim RunnerClaim
		if err := json.Unmarshal(payload, &claim); err != nil {
			return RunnerClaim{}, claimNone, err
		}
		return claim, claimReplayed, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return RunnerClaim{}, claimNone, err
	}
	if !runnerConnected(now, runner.lastSeenAt) {
		return RunnerClaim{}, claimNone, nil
	}
	var slotTaken bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM rounds WHERE owner_id = $1 AND state IN `+openRoundStatesSQL+`)`, ownerID).Scan(&slotTaken); err != nil {
		return RunnerClaim{}, claimNone, err
	}
	if slotTaken {
		return RunnerClaim{}, claimNone, nil
	}
	candidates, err := claimCandidates(ctx, tx, ownerID)
	if err != nil {
		return RunnerClaim{}, claimNone, err
	}
	for _, id := range candidates {
		_, found, err := lockTicketForMutation(ctx, tx, ownerID, id)
		if err != nil {
			return RunnerClaim{}, claimNone, err
		}
		if !found {
			continue
		}
		locked, err := readLockedTicket(ctx, tx, ownerID, id, now)
		if err != nil {
			return RunnerClaim{}, claimNone, err
		}
		if !decideAgentWorkRequest(workflowStateOf(locked)) {
			continue
		}
		claim, err := insertClaimedRound(ctx, tx, ownerID, runner.id, key, locked, now)
		if isUniqueViolation(err, oneOpenRoundPerOwnerIndex) {
			return RunnerClaim{}, claimNone, nil
		}
		if err != nil {
			return RunnerClaim{}, claimNone, err
		}
		if err := tx.Commit(ctx); err != nil {
			return RunnerClaim{}, claimNone, err
		}
		return claim, claimCreated, nil
	}
	return RunnerClaim{}, claimNone, nil
}

// A superset of the Tickets requesting work; decideAgentWorkRequest
// decides on each locked row.
func claimCandidates(ctx context.Context, tx pgx.Tx, ownerID int64) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT public_id::text FROM tickets
		WHERE owner_id = $1 AND archived_at IS NULL AND status = $2 AND assignee_type = $3
		ORDER BY priority_rank, id`, ownerID, string(Ready), string(TicketAssigneeTypeAgent))
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func insertClaimedRound(ctx context.Context, tx pgx.Tx, ownerID, runnerID int64, key string, ticket Ticket, now time.Time) (RunnerClaim, error) {
	claim := RunnerClaim{
		RoundId: uuid.NewString(),
		Agent:   *ticket.AssigneeAgent,
		Ticket: ClaimedTicket{
			Id:              ticket.Id,
			Title:           ticket.Title,
			Goal:            ticket.Goal,
			Context:         ticket.Context,
			SuccessCriteria: ticket.SuccessCriteria,
			Constraints:     ticket.Constraints,
			Repository:      ticket.Repository,
		},
	}
	var roundRowID int64
	err := tx.QueryRow(ctx,
		`INSERT INTO rounds (owner_id, public_id, ticket_id, agent_id, sequence, state, claim_epoch, claimed_at, runner_id, claim_idempotency_key, claim_payload)
		 SELECT t.owner_id, $3::uuid, t.id, t.assignee_agent_id,
		        COALESCE((SELECT max(sequence) FROM rounds WHERE ticket_id = t.id), 0) + 1, $4,
		        COALESCE((SELECT max(claim_epoch) FROM rounds WHERE ticket_id = t.id), 0) + 1, $5, $6, $7, '{}'::jsonb
		   FROM tickets t WHERE t.owner_id = $1 AND t.public_id = $2::uuid
		 RETURNING id, sequence, claim_epoch`,
		ownerID, ticket.Id, claim.RoundId, string(RoundClaimed), now, runnerID, key,
	).Scan(&roundRowID, &claim.Sequence, &claim.ClaimEpoch)
	if err != nil {
		return RunnerClaim{}, err
	}
	claim.Ticket.Feedback, err = consumeFeedback(ctx, tx, ownerID, roundRowID)
	if err != nil {
		return RunnerClaim{}, err
	}
	payload, err := json.Marshal(claim)
	if err != nil {
		return RunnerClaim{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE rounds SET claim_payload = $2 WHERE id = $1`, roundRowID, payload)
	return claim, err
}

func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}
