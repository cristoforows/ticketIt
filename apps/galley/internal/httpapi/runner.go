package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/cristoforows/ticketIt/apps/galley/internal/auth"
)

const (
	runnerHealthWindow        = 30 * time.Second
	runnerTimeout             = 5 * time.Second
	michelinVersionMaxLength  = 64
	runnerHostnameMaxLength   = 253
	runnerRecordColumns       = `paired_at, registered_at, last_seen_at, michelin_version, hostname`
	runnerNotRegisteredReason = "this runner credential has not registered; call POST /api/runner/register first"
)

type runnerRecord struct {
	pairedAt        time.Time
	registeredAt    *time.Time
	lastSeenAt      *time.Time
	michelinVersion *string
	hostname        *string
}

type authenticatedRunner struct {
	id         int64
	ownerID    int64
	registered bool
	lastSeenAt *time.Time
}

// Truncated to PostgreSQL's microsecond precision so a response agrees with the value read back.
func (s *server) clockNow() time.Time {
	return s.now().UTC().Truncate(time.Microsecond)
}

func scanRunnerRecord(row pgx.Row) (runnerRecord, error) {
	var rec runnerRecord
	err := row.Scan(&rec.pairedAt, &rec.registeredAt, &rec.lastSeenAt, &rec.michelinVersion, &rec.hostname)
	return rec, err
}

func runnerHealth(now time.Time, rec *runnerRecord) RunnerHealth {
	if rec == nil {
		return RunnerHealth{State: RunnerNotPaired, CheckedAt: now}
	}
	state := RunnerDisconnected
	if runnerConnected(now, rec.lastSeenAt) {
		state = RunnerConnected
	}
	pairedAt := rec.pairedAt.UTC()
	return RunnerHealth{
		State:           state,
		CheckedAt:       now,
		PairedAt:        &pairedAt,
		RegisteredAt:    utcOrNil(rec.registeredAt),
		LastSeenAt:      utcOrNil(rec.lastSeenAt),
		MichelinVersion: rec.michelinVersion,
		Hostname:        rec.hostname,
	}
}

func runnerConnected(now time.Time, lastSeenAt *time.Time) bool {
	return lastSeenAt != nil && now.Sub(*lastSeenAt) < runnerHealthWindow
}

func utcOrNil(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	utc := t.UTC()
	return &utc
}

func (s *server) GetRunnerHealth(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), runnerTimeout)
	defer cancel()
	rec, err := scanRunnerRecord(s.pool.QueryRow(ctx, `SELECT `+runnerRecordColumns+` FROM runners WHERE owner_id = $1`, owner.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, runnerHealth(s.clockNow(), nil))
		return
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to read runner health")
		return
	}
	writeJSON(w, http.StatusOK, runnerHealth(s.clockNow(), &rec))
}

func (s *server) PairRunner(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	token, hash, err := auth.NewRunnerToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "failed to generate a runner credential")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), runnerTimeout)
	defer cancel()
	now := s.clockNow()
	rec, err := pairRunnerForOwner(ctx, s, owner.ID, hash, now)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to pair the runner")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, RunnerPairing{Token: token, Health: runnerHealth(now, &rec)})
}

func pairRunnerForOwner(ctx context.Context, s *server, ownerID int64, hash []byte, now time.Time) (runnerRecord, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return runnerRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The Owner row lock serialises concurrent pairings; runners_one_per_owner alone would fail the later one.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM owners WHERE id = $1 FOR UPDATE`, ownerID); err != nil {
		return runnerRecord{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM runners WHERE owner_id = $1`, ownerID); err != nil {
		return runnerRecord{}, err
	}
	rec, err := scanRunnerRecord(tx.QueryRow(ctx, `INSERT INTO runners (owner_id, token_hash, paired_at)
		VALUES ($1, $2, $3) RETURNING `+runnerRecordColumns, ownerID, hash, now))
	if err != nil {
		return runnerRecord{}, err
	}
	return rec, tx.Commit(ctx)
}

func (s *server) RevokeRunner(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), runnerTimeout)
	defer cancel()
	if _, err := s.pool.Exec(ctx, `DELETE FROM runners WHERE owner_id = $1`, owner.ID); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to revoke the runner")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// A session cookie is refused even beside a valid bearer token (#130, Decisions: Transport).
func (s *server) requireRunner(w http.ResponseWriter, r *http.Request) (authenticatedRunner, bool) {
	if _, err := r.Cookie(SessionCookieName); err == nil {
		writeUnauthenticated(w)
		return authenticatedRunner{}, false
	}
	headers := r.Header.Values("Authorization")
	if len(headers) != 1 {
		writeUnauthenticated(w)
		return authenticatedRunner{}, false
	}
	token, ok := bearerToken(headers[0])
	if !ok {
		writeUnauthenticated(w)
		return authenticatedRunner{}, false
	}
	hash, ok := auth.RunnerTokenHash(token)
	if !ok {
		writeUnauthenticated(w)
		return authenticatedRunner{}, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), runnerTimeout)
	defer cancel()
	var runner authenticatedRunner
	err := s.pool.QueryRow(ctx, `SELECT id, owner_id, registered_at IS NOT NULL, last_seen_at FROM runners WHERE token_hash = $1`, hash).
		Scan(&runner.id, &runner.ownerID, &runner.registered, &runner.lastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeUnauthenticated(w)
		return authenticatedRunner{}, false
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to verify the runner credential")
		return authenticatedRunner{}, false
	}
	return runner, true
}

// RFC 9110 auth schemes are case-insensitive.
func bearerToken(authorization string) (string, bool) {
	scheme, token, _ := strings.Cut(strings.TrimLeft(authorization, " "), " ")
	return token, strings.EqualFold(scheme, "Bearer")
}

func validateRunnerText(w http.ResponseWriter, field, raw string, maxLength int) (string, bool) {
	value := strings.TrimSpace(raw)
	if value == "" || utf8.RuneCountInString(value) > maxLength || strings.ContainsFunc(value, isControlRune) {
		writeError(w, http.StatusBadRequest, "invalid_request",
			fmt.Sprintf("%q must be non-empty, at most %d characters after trimming, and free of control characters", field, maxLength))
		return "", false
	}
	return value, true
}

func isControlRune(r rune) bool {
	return r < 0x20 || r == 0x7f
}

func (s *server) RegisterRunner(w http.ResponseWriter, r *http.Request) {
	runner, ok := s.requireRunner(w, r)
	if !ok {
		return
	}
	var req RegisterRunnerRequest
	if !decodeStrictJSON(w, r, &req, `request body must be JSON matching {"michelinVersion": "...", "hostname": "..."}`) {
		return
	}
	version, ok := validateRunnerText(w, "michelinVersion", req.MichelinVersion, michelinVersionMaxLength)
	if !ok {
		return
	}
	hostname, ok := validateRunnerText(w, "hostname", req.Hostname, runnerHostnameMaxLength)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), runnerTimeout)
	defer cancel()
	now := s.clockNow()
	tag, err := s.pool.Exec(ctx, `UPDATE runners SET registered_at = $2, last_seen_at = $2, michelin_version = $3, hostname = $4
		WHERE id = $1`, runner.id, now, version, hostname)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to register the runner")
		return
	}
	if tag.RowsAffected() == 0 {
		writeUnauthenticated(w)
		return
	}
	writeJSON(w, http.StatusOK, RunnerRegistration{RegisteredAt: now})
}

func (s *server) RunnerHeartbeat(w http.ResponseWriter, r *http.Request) {
	runner, ok := s.requireRunner(w, r)
	if !ok {
		return
	}
	if !runner.registered {
		writeError(w, http.StatusConflict, "runner_not_registered", runnerNotRegisteredReason)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), runnerTimeout)
	defer cancel()
	now := s.clockNow()
	tag, err := s.pool.Exec(ctx, `UPDATE runners SET last_seen_at = $2 WHERE id = $1`, runner.id, now)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to record the heartbeat")
		return
	}
	if tag.RowsAffected() == 0 {
		writeUnauthenticated(w)
		return
	}
	writeJSON(w, http.StatusOK, RunnerHeartbeat{LastSeenAt: now})
}
