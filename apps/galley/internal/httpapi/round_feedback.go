package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	roundFeedbackMaxLength = 10000

	feedbackNotAvailableCode = "feedback_not_available"
	addRoundFeedbackShape    = `request body must be JSON matching {"body": "..."}`
)

func decideFeedback(state ticketWorkflowState, roundDelivered bool) *transitionRejection {
	switch {
	case state.archived:
		return &transitionRejection{code: feedbackNotAvailableCode, message: "Feedback is not available on an archived Ticket"}
	case !state.agentAssigned():
		return &transitionRejection{code: feedbackNotAvailableCode, message: "Feedback needs an Agent-assigned Ticket"}
	case state.openRoundID != "":
		return &transitionRejection{code: feedbackNotAvailableCode, message: "Feedback is not available while the Ticket has an open Round", roundID: state.openRoundID}
	case state.status != InReview && state.status != Done:
		return &transitionRejection{
			code:    feedbackNotAvailableCode,
			message: fmt.Sprintf("Feedback needs a Ticket in In Review or Done (current status %s)", state.status),
		}
	case !roundDelivered:
		return &transitionRejection{code: feedbackNotAvailableCode, message: "Feedback needs a delivered Round"}
	}
	return nil
}

func (s *server) AddRoundFeedback(w http.ResponseWriter, r *http.Request, id string, roundId string) {
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
	var req AddRoundFeedbackRequest
	if !decodeStrictJSON(w, r, &req, addRoundFeedbackShape) {
		return
	}
	if !validMultilineText(req.Body, utf8.RuneCountInString(req.Body), roundFeedbackMaxLength) {
		writeError(w, http.StatusBadRequest, "invalid_request",
			fmt.Sprintf(`"body" must be 1 to %d characters, not blank, without control characters other than tab and line feed`, roundFeedbackMaxLength))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	ticket, found, rejection, err := addFeedbackForOwner(ctx, s.pool, owner.ID, ticketID, roundID, req.Body, s.clockNow())
	switch {
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to record the feedback")
	case !found:
		writeRoundNotFound(w)
	case rejection != nil:
		writeTransitionRejection(w, rejection)
	default:
		writeJSON(w, http.StatusCreated, ticket)
	}
}

// The Ticket row lock serialises this with rework, reopening and the claim, which all take it.
func addFeedbackForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, ticketID, roundID, body string, now time.Time) (Ticket, bool, *transitionRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	_, found, err := lockTicketForMutation(ctx, tx, ownerID, ticketID)
	if err != nil || !found {
		return Ticket{}, found, nil, err
	}
	var ticketRowID, roundRowID int64
	var roundState string
	err = tx.QueryRow(ctx, `SELECT r.ticket_id, r.id, r.state FROM rounds r JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		WHERE t.owner_id = $1 AND t.public_id = $2::uuid AND r.public_id = $3::uuid`, ownerID, ticketID, roundID).Scan(&ticketRowID, &roundRowID, &roundState)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, false, nil, nil
	}
	if err != nil {
		return Ticket{}, false, nil, err
	}
	ticket, err := readLockedTicket(ctx, tx, ownerID, ticketID, now)
	if err != nil {
		return Ticket{}, true, nil, err
	}
	if rejection := decideFeedback(workflowStateOf(ticket), roundState == string(RoundDelivered)); rejection != nil {
		return Ticket{}, true, rejection, nil
	}
	if _, err := tx.Exec(ctx, `INSERT INTO round_feedback (owner_id, public_id, ticket_id, round_id, body, created_at) VALUES ($1, $2::uuid, $3, $4, $5, $6)`,
		ownerID, uuid.NewString(), ticketRowID, roundRowID, body, now); err != nil {
		return Ticket{}, true, nil, err
	}
	if err := loadTicketBadges(ctx, tx, ownerID, &ticket); err != nil {
		return Ticket{}, true, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Ticket{}, true, nil, err
	}
	return ticket, true, nil, nil
}

// Runs in the claim's transaction under its Ticket row lock, so feedback is consumed exactly when the Round is created.
func consumeFeedback(ctx context.Context, tx pgx.Tx, ownerID, roundRowID int64) ([]ClaimedFeedback, error) {
	rows, err := tx.Query(ctx, `WITH consumed AS (
			UPDATE round_feedback f SET consumed_by_round_id = n.id
			  FROM rounds n
			 WHERE n.owner_id = $1 AND n.id = $2 AND f.owner_id = n.owner_id AND f.ticket_id = n.ticket_id AND f.consumed_by_round_id IS NULL
			RETURNING f.id, f.round_id, f.body, f.created_at)
		SELECT r.public_id::text, r.sequence, c.body, c.created_at FROM consumed c JOIN rounds r ON r.id = c.round_id ORDER BY c.id`, ownerID, roundRowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	feedback := []ClaimedFeedback{}
	for rows.Next() {
		var item ClaimedFeedback
		if err := rows.Scan(&item.RoundId, &item.RoundSequence, &item.Body, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.CreatedAt = item.CreatedAt.UTC()
		feedback = append(feedback, item)
	}
	return feedback, rows.Err()
}

func roundFeedback(ctx context.Context, tx pgx.Tx, ownerID int64, roundIDs []int64) (map[int64][]RoundFeedback, error) {
	rows, err := tx.Query(ctx, `SELECT f.round_id, f.public_id::text, f.body, f.created_at, c.public_id::text, c.sequence
		FROM round_feedback f LEFT JOIN rounds c ON c.owner_id = f.owner_id AND c.id = f.consumed_by_round_id
		WHERE f.owner_id = $1 AND f.round_id = ANY($2) ORDER BY f.round_id, f.id`, ownerID, roundIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	feedback := map[int64][]RoundFeedback{}
	for rows.Next() {
		var roundID int64
		var item RoundFeedback
		var consumerID *string
		var consumerSequence *int
		if err := rows.Scan(&roundID, &item.Id, &item.Body, &item.CreatedAt, &consumerID, &consumerSequence); err != nil {
			return nil, err
		}
		item.CreatedAt = item.CreatedAt.UTC()
		if consumerID != nil {
			item.ConsumedBy = &RoundFeedbackConsumer{RoundId: *consumerID, Sequence: *consumerSequence}
		}
		feedback[roundID] = append(feedback[roundID], item)
	}
	return feedback, rows.Err()
}
