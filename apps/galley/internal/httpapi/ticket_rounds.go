package httpapi

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (s *server) ListTicketRounds(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, ok = canonicalPublicID(id)
	if !ok {
		writeTicketNotFound(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	rounds, found, err := listRoundsForTicket(ctx, s.pool, owner.ID, id)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to read the ticket's rounds")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, TicketRoundList{Rounds: rounds})
}

// One read-only snapshot, so a Round's activity, usage, questions, feedback, Permission requests and authority checks agree with each other and with the Round.
func listRoundsForTicket(ctx context.Context, pool *pgxpool.Pool, ownerID int64, ticketID string) ([]TicketRound, bool, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid)`, ownerID, ticketID).Scan(&exists); err != nil || !exists {
		return nil, false, err
	}
	rows, err := tx.Query(ctx, `SELECT r.id, r.public_id::text, r.sequence, r.state,
			json_build_object('id', a.public_id, 'name', a.name, 'kind', a.kind), r.claimed_at, r.started_at, r.ended_at,
			CASE WHEN d.id IS NOT NULL THEN json_build_object('bodyMarkdown', d.body_markdown, 'summary', d.summary, 'criteriaAssessment', d.criteria_assessment) END,
			r.outcome_note
		FROM rounds r
		JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		JOIN agents a ON a.owner_id = r.owner_id AND a.id = r.agent_id
		LEFT JOIN round_deliverables d ON d.owner_id = r.owner_id AND d.round_id = r.id
		WHERE t.owner_id = $1 AND t.public_id = $2::uuid
		ORDER BY r.sequence DESC`, ownerID, ticketID)
	if err != nil {
		return nil, false, err
	}
	rounds := []TicketRound{}
	var ids []int64
	for rows.Next() {
		var id int64
		var round TicketRound
		var state string
		if err := rows.Scan(&id, &round.Id, &round.Sequence, &state, &round.Agent, &round.ClaimedAt, &round.StartedAt, &round.EndedAt, &round.Deliverable, &round.OutcomeNote); err != nil {
			rows.Close()
			return nil, false, err
		}
		round.State = RoundState(state)
		round.ClaimedAt = round.ClaimedAt.UTC()
		round.StartedAt = utcOrNil(round.StartedAt)
		round.EndedAt = utcOrNil(round.EndedAt)
		rounds = append(rounds, round)
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	activity, err := latestActivity(ctx, tx, ownerID, ids)
	if err != nil {
		return nil, false, err
	}
	usage, err := roundUsageSummaries(ctx, tx, ownerID, ids)
	if err != nil {
		return nil, false, err
	}
	questions, err := roundQuestions(ctx, tx, ownerID, ids)
	if err != nil {
		return nil, false, err
	}
	feedback, err := roundFeedback(ctx, tx, ownerID, ids)
	if err != nil {
		return nil, false, err
	}
	requests, err := roundPermissionRequests(ctx, tx, ownerID, ids)
	if err != nil {
		return nil, false, err
	}
	checks, err := roundAuthorityChecks(ctx, tx, ownerID, ids)
	if err != nil {
		return nil, false, err
	}
	for i, id := range ids {
		rounds[i].Activity = activity[id].Activity
		rounds[i].EarlierActivityCursor = activity[id].EarlierActivityCursor
		rounds[i].Usage = usage[id]
		rounds[i].Questions = questions[id]
		if rounds[i].Questions == nil {
			rounds[i].Questions = []RoundQuestion{}
		}
		rounds[i].Feedback = feedback[id]
		if rounds[i].Feedback == nil {
			rounds[i].Feedback = []RoundFeedback{}
		}
		rounds[i].PermissionRequests = requests[id]
		if rounds[i].PermissionRequests == nil {
			rounds[i].PermissionRequests = []PermissionRequest{}
		}
		rounds[i].AuthorityChecks = checks[id].checks
		if rounds[i].AuthorityChecks == nil {
			rounds[i].AuthorityChecks = []RoundAuthorityCheck{}
		}
		rounds[i].AuthorityCheckCount = checks[id].count
	}
	return rounds, true, nil
}
