package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	deliverableBodyMaxBytes                = 1 << 20
	deliverableSummaryMaxLength            = 2000
	deliverableCriteriaAssessmentMaxLength = 10000

	// Any JSON spelling of a maximal deliverable fits: \u-escaping every byte of the body takes 6 MiB.
	roundEventBodyMaxBytes        = 8 << 20
	requestTooLargeCode           = "request_too_large"
	roundEventBodyTooLargeMessage = "the request body is larger than 8 MiB"
)

var errDeliveredTicketNotInProgress = errors.New("the Ticket of a running Round is not In Progress")

func validateDeliveredData(raw []byte) (RoundDeliverable, string) {
	const shape = `"data" must be an object with exactly "bodyMarkdown", "summary" and "criteriaAssessment"`
	fields, ok := exactObject(raw, "bodyMarkdown", "summary", "criteriaAssessment")
	if !ok {
		return RoundDeliverable{}, shape
	}
	var deliverable RoundDeliverable
	for key, target := range map[string]*string{"bodyMarkdown": &deliverable.BodyMarkdown, "summary": &deliverable.Summary, "criteriaAssessment": &deliverable.CriteriaAssessment} {
		if err := json.Unmarshal(fields[key], target); err != nil {
			return RoundDeliverable{}, shape
		}
	}
	switch {
	case !validMultilineText(deliverable.BodyMarkdown, len(deliverable.BodyMarkdown), deliverableBodyMaxBytes):
		return RoundDeliverable{}, fmt.Sprintf(`"bodyMarkdown" must be 1 to %d bytes of UTF-8, not blank, without control characters other than tab and line feed`, deliverableBodyMaxBytes)
	case !validMultilineText(deliverable.Summary, utf8.RuneCountInString(deliverable.Summary), deliverableSummaryMaxLength):
		return RoundDeliverable{}, fmt.Sprintf(`"summary" must be 1 to %d characters, not blank, without control characters other than tab and line feed`, deliverableSummaryMaxLength)
	case !validMultilineText(deliverable.CriteriaAssessment, utf8.RuneCountInString(deliverable.CriteriaAssessment), deliverableCriteriaAssessmentMaxLength):
		return RoundDeliverable{}, fmt.Sprintf(`"criteriaAssessment" must be 1 to %d characters, not blank, without control characters other than tab and line feed`, deliverableCriteriaAssessmentMaxLength)
	}
	return deliverable, ""
}

// The slot frees and the open-Round lock lifts because both derive from the Round's open state.
func deliverRound(ctx context.Context, tx pgx.Tx, ownerID int64, ticketID string, roundID int64, deliverable RoundDeliverable, now time.Time) (time.Time, error) {
	if _, err := tx.Exec(ctx, `INSERT INTO round_deliverables (owner_id, round_id, body_markdown, summary, criteria_assessment) VALUES ($1, $2, $3, $4, $5)`,
		ownerID, roundID, deliverable.BodyMarkdown, deliverable.Summary, deliverable.CriteriaAssessment); err != nil {
		return time.Time{}, err
	}
	var endedAt time.Time
	if err := tx.QueryRow(ctx, `UPDATE rounds SET state = $3, ended_at = GREATEST($4::timestamptz, started_at), `+leaveRunningSQL("$4")+`
		WHERE id = $1 AND owner_id = $2 RETURNING ended_at`, roundID, ownerID, string(RoundDelivered), now).Scan(&endedAt); err != nil {
		return time.Time{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE tickets SET status = $3, updated_at = now()
		WHERE owner_id = $1 AND public_id = $2::uuid AND status = $4`, ownerID, ticketID, string(InReview), string(InProgress))
	if err != nil {
		return time.Time{}, err
	}
	if tag.RowsAffected() != 1 {
		return time.Time{}, errDeliveredTicketNotInProgress
	}
	return endedAt, nil
}
