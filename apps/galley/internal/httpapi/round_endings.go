package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	outcomeNoteMaxLength = 2000

	stoppedBadgeKey  = "stopped"
	stoppedBadgeName = "Stopped"
)

var errEndingTicketNotActive = errors.New("the Ticket of an ending Round is not Ready while claimed, In Progress while running or Blocked while waiting for input")

type roundEnding struct {
	state              RoundState
	ticketStatus       TicketStatus
	note               string
	attachStoppedBadge bool
}

var roundEndings = map[RoundEventType]roundEnding{
	RoundEventStopConfirmed: {state: RoundStopped, ticketStatus: Backlog, attachStoppedBadge: true},
	RoundEventFailed:        {state: RoundFailed, ticketStatus: Blocked},
	RoundEventInterrupted:   {state: RoundInterrupted, ticketStatus: Blocked},
}

// A Stop a technical limit requested ends the Round Failed: the Owner did not ask for it (#172).
func stopConfirmedEnding(breach *RoundLimitBreach, evidence string) roundEnding {
	if breach == nil {
		ending := roundEndings[RoundEventStopConfirmed]
		ending.note = evidence
		return ending
	}
	ending := roundEndings[RoundEventFailed]
	ending.note = limitBreachExplanation(*breach)
	return ending
}

func ticketStatusHeldBy(state RoundState) TicketStatus {
	switch state {
	case RoundClaimed:
		return Ready
	case RoundWaitingForInput:
		return Blocked
	}
	return InProgress
}

func validateOutcomeNoteData(raw []byte, field string) (string, string) {
	shape := fmt.Sprintf(`"data" must be an object with exactly %q`, field)
	fields, ok := exactObject(raw, field)
	if !ok {
		return "", shape
	}
	var note string
	if err := json.Unmarshal(fields[field], &note); err != nil {
		return "", shape
	}
	if !validMultilineText(note, utf8.RuneCountInString(note), outcomeNoteMaxLength) {
		return "", fmt.Sprintf(`%q must be 1 to %d characters, not blank, without control characters other than tab and line feed`, field, outcomeNoteMaxLength)
	}
	return note, ""
}

// Any Status but the one the Round's open state holds is a broken invariant, refused rather than moved.
func endRound(ctx context.Context, tx pgx.Tx, ownerID int64, ticketID string, roundID int64, from RoundState, ending roundEnding, now time.Time) (time.Time, error) {
	var endedAt time.Time
	if err := tx.QueryRow(ctx, `UPDATE rounds SET state = $3, outcome_note = $4, ended_at = GREATEST($5::timestamptz, COALESCE(started_at, claimed_at)),
			waiting_question_id = NULL, waiting_permission_request_id = NULL, `+leaveRunningSQL("$5")+`
		WHERE id = $1 AND owner_id = $2 RETURNING ended_at`, roundID, ownerID, string(ending.state), ending.note, now).Scan(&endedAt); err != nil {
		return time.Time{}, err
	}
	var ticketRowID int64
	err := tx.QueryRow(ctx, `UPDATE tickets SET status = $3, updated_at = now()
		WHERE owner_id = $1 AND public_id = $2::uuid AND status = $4 RETURNING id`,
		ownerID, ticketID, string(ending.ticketStatus), string(ticketStatusHeldBy(from))).Scan(&ticketRowID)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, errEndingTicketNotActive
	}
	if err != nil {
		return time.Time{}, err
	}
	if !ending.attachStoppedBadge {
		return endedAt, nil
	}
	badgeID, err := ensureStoppedBadge(ctx, tx, ownerID)
	if err != nil {
		return time.Time{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO ticket_badges (owner_id, ticket_id, badge_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		ownerID, ticketRowID, badgeID); err != nil {
		return time.Time{}, err
	}
	return endedAt, nil
}

// The caller holds the Owner's priority lock, which serialises this with every other Stopped Round of the Owner.
// CreateBadge does not take it, so the insert adopts a same-named Badge committed in between.
func ensureStoppedBadge(ctx context.Context, tx pgx.Tx, ownerID int64) (int64, error) {
	var badgeID int64
	err := tx.QueryRow(ctx, `SELECT id FROM badges WHERE owner_id = $1 AND system_key = $2`, ownerID, stoppedBadgeKey).Scan(&badgeID)
	if !errors.Is(err, pgx.ErrNoRows) {
		return badgeID, err
	}
	err = tx.QueryRow(ctx, `UPDATE badges SET system_key = $2 WHERE owner_id = $1 AND lower(name) = lower($3) RETURNING id`,
		ownerID, stoppedBadgeKey, stoppedBadgeName).Scan(&badgeID)
	if !errors.Is(err, pgx.ErrNoRows) {
		return badgeID, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO badges (owner_id, public_id, name, system_key) VALUES ($1, $2::uuid, $3, $4)
		ON CONFLICT (owner_id, lower(name)) DO UPDATE SET system_key = EXCLUDED.system_key RETURNING id`,
		ownerID, uuid.NewString(), stoppedBadgeName, stoppedBadgeKey).Scan(&badgeID)
	return badgeID, err
}
