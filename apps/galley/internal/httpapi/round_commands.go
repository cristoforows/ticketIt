package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	oneStopPerRoundIndex = "round_commands_one_stop_per_round"

	commandAlreadyAcknowledgedCode    = "command_already_acknowledged"
	commandAlreadyAcknowledgedMessage = "this command is already acknowledged with another outcome"
	roundOrCommandNotFoundMessage     = "no round or command with that identifier"
	acknowledgeCommandShape           = `request body must be JSON matching {"outcome": "applied" | "ignored"}`
)

func (s *server) RequestTicketStop(w http.ResponseWriter, r *http.Request, id string) {
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
	ticket, found, rejection, err := requestStopForOwner(ctx, s.pool, owner.ID, id, s.clockNow())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to request stop")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	if rejection != nil {
		writeTransitionRejection(w, rejection)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

func requestStopForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, id string, now time.Time) (Ticket, bool, *transitionRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	lock, found, err := lockTicketForMutation(ctx, tx, ownerID, id)
	if err != nil || !found {
		return Ticket{}, found, nil, err
	}
	rejection := decideStop(ticketWorkflowState{ticketLock: lock})
	if rejection != nil && rejection.code != stopAlreadyRequestedCode {
		return Ticket{}, true, rejection, nil
	}
	if rejection == nil {
		_, err := tx.Exec(ctx, `INSERT INTO round_commands (owner_id, round_id, public_id, type, claim_epoch, issued_at)
			SELECT owner_id, id, $3::uuid, $4, claim_epoch, $5 FROM rounds WHERE owner_id = $1 AND public_id = $2::uuid`,
			ownerID, lock.openRoundID, uuid.NewString(), string(RunnerCommandStop), now)
		if isUniqueViolation(err, oneStopPerRoundIndex) {
			_ = tx.Rollback(ctx)
			ticket, found, err := getTicketForOwner(ctx, pool, ownerID, id, now)
			return ticket, found, nil, err
		}
		if err != nil {
			return Ticket{}, true, nil, err
		}
	}
	ticket, err := readLockedTicket(ctx, tx, ownerID, id, now)
	if err != nil {
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

func (s *server) ListRoundCommands(w http.ResponseWriter, r *http.Request, roundId string) {
	runner, ok := s.requireRunner(w, r)
	if !ok {
		return
	}
	roundID, ok := canonicalPublicID(roundId)
	if !ok {
		writeRoundNotFound(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	commands, found, err := pendingRoundCommands(ctx, s.pool, runner.ownerID, roundID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to read the round's commands")
		return
	}
	if !found {
		writeRoundNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, RunnerCommandList{Commands: commands})
}

func pendingRoundCommands(ctx context.Context, pool *pgxpool.Pool, ownerID int64, roundID string) ([]RunnerCommand, bool, error) {
	rows, err := pool.Query(ctx, `SELECT c.public_id::text, c.type, c.claim_epoch, c.issued_at, q.question_id::text, q.answer
		FROM rounds r
		LEFT JOIN round_commands c ON c.owner_id = r.owner_id AND c.round_id = r.id AND c.acknowledged_at IS NULL AND r.state IN `+openRoundStatesSQL+`
		LEFT JOIN round_questions q ON q.owner_id = c.owner_id AND q.id = c.question_id
		WHERE r.owner_id = $1 AND r.public_id = $2::uuid
		ORDER BY c.type = $3 DESC, c.issued_at, c.id`, ownerID, roundID, string(RunnerCommandStop))
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	found := false
	commands := []RunnerCommand{}
	for rows.Next() {
		found = true
		var id, commandType, questionID, answer *string
		var epoch *int
		var issuedAt *time.Time
		if err := rows.Scan(&id, &commandType, &epoch, &issuedAt, &questionID, &answer); err != nil {
			return nil, false, err
		}
		if id == nil {
			continue
		}
		command := RunnerCommand{Id: *id, Type: RunnerCommandType(*commandType), ClaimEpoch: *epoch, IssuedAt: issuedAt.UTC()}
		if questionID != nil {
			command.Answer = &RunnerCommandAnswerData{QuestionId: *questionID, Text: *answer}
		}
		commands = append(commands, command)
	}
	return commands, found, rows.Err()
}

func (s *server) AcknowledgeRoundCommand(w http.ResponseWriter, r *http.Request, roundId string, commandId string) {
	runner, ok := s.requireRunner(w, r)
	if !ok {
		return
	}
	roundID, roundOK := canonicalPublicID(roundId)
	commandID, commandOK := canonicalPublicID(commandId)
	if !roundOK || !commandOK {
		writeError(w, http.StatusNotFound, "not_found", roundOrCommandNotFoundMessage)
		return
	}
	var req AcknowledgeRoundCommandRequest
	if !decodeStrictJSON(w, r, &req, acknowledgeCommandShape) {
		return
	}
	if !req.Outcome.Valid() {
		writeError(w, http.StatusBadRequest, "invalid_request", acknowledgeCommandShape)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	ack, found, conflict, err := acknowledgeRoundCommand(ctx, s.pool, runner.ownerID, roundID, commandID, req.Outcome, s.clockNow())
	switch {
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to acknowledge the command")
	case !found:
		writeError(w, http.StatusNotFound, "not_found", roundOrCommandNotFoundMessage)
	case conflict:
		writeError(w, http.StatusConflict, commandAlreadyAcknowledgedCode, commandAlreadyAcknowledgedMessage)
	default:
		writeJSON(w, http.StatusOK, ack)
	}
}

func acknowledgeRoundCommand(ctx context.Context, pool *pgxpool.Pool, ownerID int64, roundID, commandID string, outcome RunnerCommandAckOutcome, now time.Time) (RoundCommandAcknowledgement, bool, bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return RoundCommandAcknowledgement{}, false, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	var rowID int64
	var acknowledgedAt *time.Time
	var stored *string
	err = tx.QueryRow(ctx, `SELECT c.id, c.acknowledged_at, c.ack_outcome
		FROM round_commands c JOIN rounds r ON r.owner_id = c.owner_id AND r.id = c.round_id
		WHERE c.owner_id = $1 AND r.public_id = $2::uuid AND c.public_id = $3::uuid
		FOR UPDATE OF c`, ownerID, roundID, commandID).Scan(&rowID, &acknowledgedAt, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return RoundCommandAcknowledgement{}, false, false, nil
	}
	if err != nil {
		return RoundCommandAcknowledgement{}, false, false, err
	}
	if acknowledgedAt != nil {
		if RunnerCommandAckOutcome(*stored) != outcome {
			return RoundCommandAcknowledgement{}, true, true, nil
		}
		return RoundCommandAcknowledgement{Id: commandID, AcknowledgedAt: acknowledgedAt.UTC(), Outcome: outcome}, true, false, nil
	}
	var at time.Time
	if err := tx.QueryRow(ctx, `UPDATE round_commands SET acknowledged_at = $2, ack_outcome = $3 WHERE id = $1 RETURNING acknowledged_at`,
		rowID, now, string(outcome)).Scan(&at); err != nil {
		return RoundCommandAcknowledgement{}, true, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RoundCommandAcknowledgement{}, true, false, err
	}
	return RoundCommandAcknowledgement{Id: commandID, AcknowledgedAt: at.UTC(), Outcome: outcome}, true, false, nil
}
