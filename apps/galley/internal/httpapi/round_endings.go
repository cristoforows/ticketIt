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
	stopEvidenceMaxLength = 2000

	stoppedBadgeKey  = "stopped"
	stoppedBadgeName = "Stopped"
)

var errStoppedTicketNotActive = errors.New("the Ticket of a stopped Round is neither Ready nor In Progress")

func validateStopConfirmedData(raw []byte) (string, string) {
	const shape = `"data" must be an object with exactly "evidence"`
	fields, ok := exactObject(raw, "evidence")
	if !ok {
		return "", shape
	}
	var evidence string
	if err := json.Unmarshal(fields["evidence"], &evidence); err != nil {
		return "", shape
	}
	if !validMultilineText(evidence, utf8.RuneCountInString(evidence), stopEvidenceMaxLength) {
		return "", fmt.Sprintf(`"evidence" must be 1 to %d characters, not blank, without control characters other than tab and line feed`, stopEvidenceMaxLength)
	}
	return evidence, ""
}

func stopRound(ctx context.Context, tx pgx.Tx, ownerID int64, ticketID string, roundID int64, evidence string, now time.Time) (time.Time, error) {
	var endedAt time.Time
	if err := tx.QueryRow(ctx, `UPDATE rounds SET state = $3, outcome_note = $4, ended_at = GREATEST($5::timestamptz, COALESCE(started_at, claimed_at))
		WHERE id = $1 AND owner_id = $2 RETURNING ended_at`, roundID, ownerID, string(RoundStopped), evidence, now).Scan(&endedAt); err != nil {
		return time.Time{}, err
	}
	var ticketRowID int64
	err := tx.QueryRow(ctx, `UPDATE tickets SET status = $3, updated_at = now()
		WHERE owner_id = $1 AND public_id = $2::uuid AND status IN ($4, $5) RETURNING id`,
		ownerID, ticketID, string(Backlog), string(Ready), string(InProgress)).Scan(&ticketRowID)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, errStoppedTicketNotActive
	}
	if err != nil {
		return time.Time{}, err
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
