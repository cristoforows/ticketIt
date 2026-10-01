package httpapi

import (
	"context"
	"errors"
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

func (s *server) ClaimWork(w http.ResponseWriter, r *http.Request) {
	runner, ok := s.requireRunner(w, r)
	if !ok {
		return
	}
	now := s.clockNow()
	if !runnerConnected(now, runner.lastSeenAt) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	claim, claimed, err := claimRoundForOwner(ctx, s.pool, runner.ownerID, now)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to claim work")
		return
	}
	if !claimed {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusCreated, claim)
}

// Lock order: the Owner's priority lock, then Ticket rows in priority
// order, then the Round insert.
func claimRoundForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, now time.Time) (RunnerClaim, bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return RunnerClaim{}, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	if err := lockOwnerPriority(ctx, tx, ownerID); err != nil {
		return RunnerClaim{}, false, err
	}
	var slotTaken bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM rounds WHERE owner_id = $1 AND state IN `+openRoundStatesSQL+`)`, ownerID).Scan(&slotTaken); err != nil {
		return RunnerClaim{}, false, err
	}
	if slotTaken {
		return RunnerClaim{}, false, nil
	}
	candidates, err := claimCandidates(ctx, tx, ownerID)
	if err != nil {
		return RunnerClaim{}, false, err
	}
	for _, id := range candidates {
		_, found, err := lockTicketForMutation(ctx, tx, ownerID, id)
		if err != nil {
			return RunnerClaim{}, false, err
		}
		if !found {
			continue
		}
		locked, err := readLockedTicket(ctx, tx, ownerID, id)
		if err != nil {
			return RunnerClaim{}, false, err
		}
		if !decideAgentWorkRequest(workflowStateOf(locked)) {
			continue
		}
		claim, err := insertClaimedRound(ctx, tx, ownerID, locked, now)
		if isUniqueViolation(err, oneOpenRoundPerOwnerIndex) {
			return RunnerClaim{}, false, nil
		}
		if err != nil {
			return RunnerClaim{}, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return RunnerClaim{}, false, err
		}
		return claim, true, nil
	}
	return RunnerClaim{}, false, nil
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

func insertClaimedRound(ctx context.Context, tx pgx.Tx, ownerID int64, ticket Ticket, now time.Time) (RunnerClaim, error) {
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
	err := tx.QueryRow(ctx,
		`INSERT INTO rounds (owner_id, public_id, ticket_id, agent_id, sequence, state, claim_epoch, claimed_at)
		 SELECT t.owner_id, $3::uuid, t.id, t.assignee_agent_id,
		        COALESCE((SELECT max(sequence) FROM rounds WHERE ticket_id = t.id), 0) + 1, $4, 1, $5
		   FROM tickets t WHERE t.owner_id = $1 AND t.public_id = $2::uuid
		 RETURNING sequence, claim_epoch`,
		ownerID, ticket.Id, claim.RoundId, string(RoundClaimed), now,
	).Scan(&claim.Sequence, &claim.ClaimEpoch)
	return claim, err
}

func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}
