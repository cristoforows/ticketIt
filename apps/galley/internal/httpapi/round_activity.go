package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	activityNoteMaxLength = 2000
	activityWindow        = 50
	invalidCursorCode     = "invalid_cursor"
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
	return validMultilineText(note, utf8.RuneCountInString(note), activityNoteMaxLength)
}

func validMultilineText(value string, length, maxLength int) bool {
	return length <= maxLength &&
		strings.TrimFunc(value, unicode.IsSpace) != "" &&
		!strings.ContainsFunc(value, func(r rune) bool { return isControlRune(r) && r != '\t' && r != '\n' })
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

func latestActivity(ctx context.Context, tx pgx.Tx, ownerID int64, roundIDs []int64) (map[int64]RoundActivityPage, error) {
	rows, err := tx.Query(ctx, `SELECT round_id, seq, note, occurred_at FROM (
			SELECT round_id, seq, note, occurred_at, row_number() OVER (PARTITION BY round_id ORDER BY seq DESC) AS newest
			FROM round_activity WHERE owner_id = $1 AND round_id = ANY($2)
		) latest WHERE newest <= $3 ORDER BY round_id, seq DESC`, ownerID, roundIDs, activityWindow+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	newestFirst := map[int64][]RoundActivityNote{}
	for rows.Next() {
		var roundID int64
		var note RoundActivityNote
		if err := rows.Scan(&roundID, &note.Seq, &note.Note, &note.OccurredAt); err != nil {
			return nil, err
		}
		note.OccurredAt = note.OccurredAt.UTC()
		newestFirst[roundID] = append(newestFirst[roundID], note)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	pages := make(map[int64]RoundActivityPage, len(roundIDs))
	for _, roundID := range roundIDs {
		pages[roundID] = activityPage(newestFirst[roundID])
	}
	return pages, nil
}

// newestFirst holds up to one note more than the window; that note only
// shows an earlier page exists.
func activityPage(newestFirst []RoundActivityNote) RoundActivityPage {
	page := RoundActivityPage{Activity: []RoundActivityNote{}}
	if len(newestFirst) > activityWindow {
		newestFirst = newestFirst[:activityWindow]
		cursor := strconv.Itoa(newestFirst[activityWindow-1].Seq)
		page.EarlierActivityCursor = &cursor
	}
	for i := len(newestFirst) - 1; i >= 0; i-- {
		page.Activity = append(page.Activity, newestFirst[i])
	}
	return page
}

func parseActivityCursor(raw string) (int, bool) {
	seq, err := strconv.Atoi(raw)
	return seq, err == nil && seq >= 1 && strconv.Itoa(seq) == raw
}

func (s *server) ListRoundActivity(w http.ResponseWriter, r *http.Request, id string, roundId string, params ListRoundActivityParams) {
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
	before := math.MaxInt32
	if params.Before != nil {
		if before, ok = parseActivityCursor(*params.Before); !ok {
			writeError(w, http.StatusBadRequest, invalidCursorCode, `"before" must be an earlierActivityCursor from this Round`)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	page, found, err := activityBefore(ctx, s.pool, owner.ID, ticketID, roundID, before)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to read the round's activity")
		return
	}
	if !found {
		writeRoundNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func activityBefore(ctx context.Context, pool *pgxpool.Pool, ownerID int64, ticketID, roundID string, before int) (RoundActivityPage, bool, error) {
	var internalID int64
	err := pool.QueryRow(ctx, `SELECT r.id FROM rounds r JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		WHERE r.owner_id = $1 AND t.public_id = $2::uuid AND r.public_id = $3::uuid`, ownerID, ticketID, roundID).Scan(&internalID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RoundActivityPage{}, false, nil
	}
	if err != nil {
		return RoundActivityPage{}, false, err
	}
	rows, err := pool.Query(ctx, `SELECT seq, note, occurred_at FROM round_activity
		WHERE owner_id = $1 AND round_id = $2 AND seq < $3 ORDER BY seq DESC LIMIT $4`, ownerID, internalID, before, activityWindow+1)
	if err != nil {
		return RoundActivityPage{}, false, err
	}
	defer rows.Close()
	var newestFirst []RoundActivityNote
	for rows.Next() {
		var note RoundActivityNote
		if err := rows.Scan(&note.Seq, &note.Note, &note.OccurredAt); err != nil {
			return RoundActivityPage{}, false, err
		}
		note.OccurredAt = note.OccurredAt.UTC()
		newestFirst = append(newestFirst, note)
	}
	return activityPage(newestFirst), true, rows.Err()
}
