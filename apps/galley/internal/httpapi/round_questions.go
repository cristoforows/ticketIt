package httpapi

import (
	"context"
	"encoding/json"
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
	questionTextMaxLength = 2000
	answerMaxLength       = 2000

	questionAlreadyAnsweredCode    = "question_already_answered"
	questionAlreadyAnsweredMessage = "this question already has an answer"
	answerNotAvailableMessage      = "Answer needs a question the Round waits on"
	answerStopRequestedMessage     = "Stop is already requested for this Round; an answer cannot resume it"
	questionNotFoundMessage        = "no ticket, round or question with that identifier"
	answerQuestionShape            = `request body must be JSON matching {"answer": "..."}`
)

const roundQuestionJSON = `json_build_object('id', q.question_id, 'text', q.text, 'askedAt', q.asked_at, 'answer', q.answer, 'answeredAt', q.answered_at)`

var errWaitingTicketNotMatched = errors.New("the Ticket of a Round raising a question or Permission request is not In Progress, or of a resuming Round not Blocked")

type raisedQuestion struct {
	id, text string
}

func validateQuestionRaisedData(raw []byte) (raisedQuestion, string) {
	const shape = `"data" must be an object with exactly "questionId" and "text"`
	fields, ok := exactObject(raw, "questionId", "text")
	if !ok {
		return raisedQuestion{}, shape
	}
	var question raisedQuestion
	if json.Unmarshal(fields["questionId"], &question.id) != nil || json.Unmarshal(fields["text"], &question.text) != nil {
		return raisedQuestion{}, shape
	}
	if !canonicalRunnerUUID(question.id) {
		return raisedQuestion{}, `"questionId" must be a non-nil UUID in lowercase canonical form`
	}
	if !validMultilineText(question.text, utf8.RuneCountInString(question.text), questionTextMaxLength) {
		return raisedQuestion{}, fmt.Sprintf(`"text" must be 1 to %d characters, not blank, without control characters other than tab and line feed`, questionTextMaxLength)
	}
	return question, ""
}

func validateResumedData(raw []byte) (questionID, requestID, problem string) {
	const shape = `"data" must be an object with exactly "questionId" or exactly "requestId"`
	key := "questionId"
	fields, ok := exactObject(raw, key)
	if !ok {
		key = "requestId"
		if fields, ok = exactObject(raw, key); !ok {
			return "", "", shape
		}
	}
	var id string
	if json.Unmarshal(fields[key], &id) != nil {
		return "", "", shape
	}
	if !canonicalRunnerUUID(id) {
		return "", "", fmt.Sprintf(`%q must be a non-nil UUID in lowercase canonical form`, key)
	}
	if key == "questionId" {
		return id, "", ""
	}
	return "", id, ""
}

func raiseQuestion(ctx context.Context, tx pgx.Tx, ownerID int64, ticketID string, roundID int64, question raisedQuestion, now time.Time) error {
	var questionRowID int64
	if err := tx.QueryRow(ctx, `INSERT INTO round_questions (owner_id, round_id, question_id, text, asked_at) VALUES ($1, $2, $3::uuid, $4, $5) RETURNING id`,
		ownerID, roundID, question.id, question.text, now).Scan(&questionRowID); err != nil {
		return err
	}
	return moveRoundAndTicket(ctx, tx, ownerID, ticketID, roundID, RoundRunning, RoundWaitingForInput, roundAsk{questionID: &questionRowID})
}

func resumeRound(ctx context.Context, tx pgx.Tx, ownerID int64, ticketID string, roundID int64) error {
	return moveRoundAndTicket(ctx, tx, ownerID, ticketID, roundID, RoundWaitingForInput, RoundRunning, roundAsk{})
}

type roundAsk struct {
	questionID, permissionRequestID *int64
}

func moveRoundAndTicket(ctx context.Context, tx pgx.Tx, ownerID int64, ticketID string, roundID int64, from, to RoundState, ask roundAsk) error {
	if _, err := tx.Exec(ctx, `UPDATE rounds SET state = $3, waiting_question_id = $4, waiting_permission_request_id = $5 WHERE id = $1 AND owner_id = $2`,
		roundID, ownerID, string(to), ask.questionID, ask.permissionRequestID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE tickets SET status = $3, updated_at = now()
		WHERE owner_id = $1 AND public_id = $2::uuid AND status = $4`, ownerID, ticketID, string(ticketStatusHeldBy(to)), string(ticketStatusHeldBy(from)))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errWaitingTicketNotMatched
	}
	return nil
}

type answerTarget struct {
	roundState    RoundState
	answered      bool
	stopRequested bool
}

// Stop is delivered before an answer and ends the Round, so an answer given after Stop could never resume it.
func decideAnswer(target answerTarget) *transitionRejection {
	switch {
	case target.answered:
		return &transitionRejection{code: questionAlreadyAnsweredCode, message: questionAlreadyAnsweredMessage}
	case !OpenRoundState(target.roundState).Valid():
		return &transitionRejection{code: roundNotOpenCode, message: roundNotOpenMessage}
	case target.roundState != RoundWaitingForInput:
		return &transitionRejection{code: answerNotAvailableCode, message: answerNotAvailableMessage}
	case target.stopRequested:
		return &transitionRejection{code: stopAlreadyRequestedCode, message: answerStopRequestedMessage}
	}
	return nil
}

func decideWaitingAnswer(state ticketWorkflowState) *transitionRejection {
	if state.waitingQuestion == nil {
		return &transitionRejection{code: answerNotAvailableCode, message: answerNotAvailableMessage}
	}
	return decideAnswer(answerTarget{roundState: RoundWaitingForInput, answered: state.waitingQuestion.Answer != nil, stopRequested: state.stopRequested})
}

func normaliseQuestionTimes(question *RoundQuestion) {
	question.AskedAt = question.AskedAt.UTC()
	question.AnsweredAt = utcOrNil(question.AnsweredAt)
}

func writeQuestionNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", questionNotFoundMessage)
}

func (s *server) AnswerRoundQuestion(w http.ResponseWriter, r *http.Request, id string, roundId string, questionId string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	ticketID, ticketOK := canonicalPublicID(id)
	roundID, roundOK := canonicalPublicID(roundId)
	questionID, questionOK := canonicalPublicID(questionId)
	if !ticketOK || !roundOK || !questionOK {
		writeQuestionNotFound(w)
		return
	}
	var req AnswerQuestionRequest
	if !decodeStrictJSON(w, r, &req, answerQuestionShape) {
		return
	}
	if !validMultilineText(req.Answer, utf8.RuneCountInString(req.Answer), answerMaxLength) {
		writeError(w, http.StatusBadRequest, "invalid_request",
			fmt.Sprintf(`"answer" must be 1 to %d characters, not blank, without control characters other than tab and line feed`, answerMaxLength))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	ticket, found, rejection, err := answerQuestionForOwner(ctx, s.pool, owner.ID, ticketID, roundID, questionID, req.Answer, s.clockNow())
	switch {
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to record the answer")
	case !found:
		writeQuestionNotFound(w)
	case rejection != nil:
		writeTransitionRejection(w, rejection)
	default:
		writeJSON(w, http.StatusOK, ticket)
	}
}

// Lock order: the Ticket row, then the question row. Every runner event takes the Ticket row first,
// so the Round cannot end or resume while the answer is decided.
func answerQuestionForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, ticketID, roundID, questionID, answer string, now time.Time) (Ticket, bool, *transitionRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	lock, found, err := lockTicketForMutation(ctx, tx, ownerID, ticketID)
	if err != nil || !found {
		return Ticket{}, found, nil, err
	}
	var roundRowID, questionRowID int64
	var epoch int
	var target answerTarget
	err = tx.QueryRow(ctx, `SELECT r.id, r.state, r.claim_epoch, q.id, q.answered_at IS NOT NULL
		FROM rounds r
		JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		JOIN round_questions q ON q.owner_id = r.owner_id AND q.round_id = r.id
		WHERE t.owner_id = $1 AND t.public_id = $2::uuid AND r.public_id = $3::uuid AND q.question_id = $4::uuid
		FOR UPDATE OF q`, ownerID, ticketID, roundID, questionID).Scan(&roundRowID, &target.roundState, &epoch, &questionRowID, &target.answered)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, false, nil, nil
	}
	if err != nil {
		return Ticket{}, false, nil, err
	}
	target.stopRequested = lock.openRoundID == roundID && lock.stopRequested
	if rejection := decideAnswer(target); rejection != nil {
		return Ticket{}, true, rejection, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE round_questions SET answer = $2, answered_at = GREATEST($3::timestamptz, asked_at) WHERE id = $1`,
		questionRowID, answer, now); err != nil {
		return Ticket{}, true, nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO round_commands (owner_id, round_id, public_id, type, claim_epoch, issued_at, question_id)
		VALUES ($1, $2, $3::uuid, $4, $5, $6, $7)`, ownerID, roundRowID, uuid.NewString(), string(RunnerCommandAnswer), epoch, now, questionRowID); err != nil {
		return Ticket{}, true, nil, err
	}
	ticket, err := readLockedTicket(ctx, tx, ownerID, ticketID, now)
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

func roundQuestions(ctx context.Context, tx pgx.Tx, ownerID int64, roundIDs []int64) (map[int64][]RoundQuestion, error) {
	rows, err := tx.Query(ctx, `SELECT q.round_id, `+roundQuestionJSON+` FROM round_questions q
		WHERE q.owner_id = $1 AND q.round_id = ANY($2) ORDER BY q.round_id, q.id`, ownerID, roundIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	questions := map[int64][]RoundQuestion{}
	for rows.Next() {
		var roundID int64
		var question RoundQuestion
		if err := rows.Scan(&roundID, &question); err != nil {
			return nil, err
		}
		normaliseQuestionTimes(&question)
		questions[roundID] = append(questions[roundID], question)
	}
	return questions, rows.Err()
}
