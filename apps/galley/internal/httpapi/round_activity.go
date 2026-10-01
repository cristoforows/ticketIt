package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	activityNoteMaxLength = 2000
	activityWindow        = 50
)

func validateProgressData(raw []byte) (string, string) {
	const shape = `"data" must be an object with exactly "note"`
	fields, ok := exactObject(raw, "note")
	if !ok {
		return "", shape
	}
	var note string
	if err := json.Unmarshal(fields["note"], &note); err != nil {
		return "", shape
	}
	if !validActivityNote(note) {
		return "", fmt.Sprintf(`"note" must be 1 to %d characters, not blank, without control characters other than tab and line feed`, activityNoteMaxLength)
	}
	return note, ""
}

func validActivityNote(note string) bool {
	return utf8.RuneCountInString(note) <= activityNoteMaxLength &&
		strings.TrimFunc(note, unicode.IsSpace) != "" &&
		!strings.ContainsFunc(note, func(r rune) bool { return isControlRune(r) && r != '\t' && r != '\n' })
}

func exactObject(raw []byte, keys ...string) (map[string]json.RawMessage, bool) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || len(fields) != len(keys) {
		return nil, false
	}
	for _, key := range keys {
		if _, ok := fields[key]; !ok {
			return nil, false
		}
	}
	return fields, true
}

// Every event holds its Round's Ticket row lock, which alone serialises the max(seq) read with the insert, so seq is gap-free per Round.
func appendActivity(ctx context.Context, tx pgx.Tx, ownerID, roundID int64, note string, occurredAt time.Time) (int, error) {
	var seq int
	err := tx.QueryRow(ctx, `INSERT INTO round_activity (owner_id, round_id, seq, note, occurred_at)
		SELECT $1, $2, COALESCE(max(seq), 0) + 1, $3, $4 FROM round_activity WHERE round_id = $2
		RETURNING seq`, ownerID, roundID, note, occurredAt).Scan(&seq)
	return seq, err
}

func latestActivity(ctx context.Context, tx pgx.Tx, ownerID int64, roundIDs []int64) (map[int64][]RoundActivityNote, error) {
	rows, err := tx.Query(ctx, `SELECT round_id, seq, note, occurred_at FROM (
			SELECT round_id, seq, note, occurred_at, row_number() OVER (PARTITION BY round_id ORDER BY seq DESC) AS newest
			FROM round_activity WHERE owner_id = $1 AND round_id = ANY($2)
		) latest WHERE newest <= $3 ORDER BY round_id, seq`, ownerID, roundIDs, activityWindow)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	activity := map[int64][]RoundActivityNote{}
	for rows.Next() {
		var roundID int64
		var note RoundActivityNote
		if err := rows.Scan(&roundID, &note.Seq, &note.Note, &note.OccurredAt); err != nil {
			return nil, err
		}
		note.OccurredAt = note.OccurredAt.UTC()
		activity[roundID] = append(activity[roundID], note)
	}
	return activity, rows.Err()
}
