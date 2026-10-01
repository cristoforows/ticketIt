package httpapi

import (
	"context"
	"net/http"

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

func listRoundsForTicket(ctx context.Context, pool *pgxpool.Pool, ownerID int64, ticketID string) ([]TicketRound, bool, error) {
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid)`, ownerID, ticketID).Scan(&exists); err != nil || !exists {
		return nil, false, err
	}
	rows, err := pool.Query(ctx, `SELECT r.public_id::text, r.sequence, r.state,
			json_build_object('id', a.public_id, 'name', a.name, 'kind', a.kind), r.claimed_at, r.started_at, r.ended_at
		FROM rounds r
		JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		JOIN agents a ON a.owner_id = r.owner_id AND a.id = r.agent_id
		WHERE t.owner_id = $1 AND t.public_id = $2::uuid
		ORDER BY r.sequence DESC`, ownerID, ticketID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	rounds := []TicketRound{}
	for rows.Next() {
		var round TicketRound
		var state string
		if err := rows.Scan(&round.Id, &round.Sequence, &state, &round.Agent, &round.ClaimedAt, &round.StartedAt, &round.EndedAt); err != nil {
			return nil, false, err
		}
		round.State = RoundState(state)
		round.ClaimedAt = round.ClaimedAt.UTC()
		round.StartedAt = utcOrNil(round.StartedAt)
		round.EndedAt = utcOrNil(round.EndedAt)
		rounds = append(rounds, round)
	}
	return rounds, true, rows.Err()
}
