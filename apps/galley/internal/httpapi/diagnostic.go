package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// diagnosticTimeout bounds each diagnostic query, matching
// postgres.HealthTimeout's rationale: an unreachable database should
// fail the request promptly with the shared error shape, not hang it.
const diagnosticTimeout = 5 * time.Second

// server also implements the generated ServerInterface's two
// development-only operations (ListDiagnosticNotes,
// CreateDiagnosticNote) against the diagnostic_notes table (see
// apps/galley/internal/migrations). These are gated in NewHandler at
// route *registration*, not here: this file has no notion of
// "production," and does not need one -- when Galley registers these
// routes at all is the only thing that decides whether a caller can
// ever reach this code. See docs/evidence/m2/52-postgresql-persistence.md
// for why registration-time gating was chosen over a check inside
// these methods.
//
// This is intentionally a hand-rolled implementation against the pool,
// not a repository/ORM layer: issue #52 adds no domain tables, and a
// single development-only table does not justify one yet.

func (s *server) ListDiagnosticNotes(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), diagnosticTimeout)
	defer cancel()

	notes, err := queryDiagnosticNotes(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to read diagnostic notes")
		return
	}
	writeJSON(w, http.StatusOK, DiagnosticNoteList{Notes: notes})
}

func (s *server) CreateDiagnosticNote(w http.ResponseWriter, r *http.Request) {
	var req CreateDiagnosticNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", `request body must be JSON matching {"note": "..."}`)
		return
	}
	if req.Note == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", `"note" must be a non-empty string`)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), diagnosticTimeout)
	defer cancel()

	note, err := insertDiagnosticNote(ctx, s.pool, req.Note)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to write the diagnostic note")
		return
	}
	writeJSON(w, http.StatusCreated, note)
}

func insertDiagnosticNote(ctx context.Context, pool *pgxpool.Pool, note string) (DiagnosticNote, error) {
	var (
		result    DiagnosticNote
		createdAt time.Time
	)
	err := pool.QueryRow(ctx,
		`INSERT INTO diagnostic_notes (note) VALUES ($1) RETURNING id, note, created_at`,
		note,
	).Scan(&result.Id, &result.Note, &createdAt)
	if err != nil {
		return DiagnosticNote{}, err
	}
	result.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	return result, nil
}

func queryDiagnosticNotes(ctx context.Context, pool *pgxpool.Pool) ([]DiagnosticNote, error) {
	rows, err := pool.Query(ctx, `SELECT id, note, created_at FROM diagnostic_notes ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	notes := []DiagnosticNote{}
	for rows.Next() {
		var (
			note      DiagnosticNote
			createdAt time.Time
		)
		if err := rows.Scan(&note.Id, &note.Note, &createdAt); err != nil {
			return nil, err
		}
		note.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		notes = append(notes, note)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return notes, nil
}
