package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CreateState persists a fresh anti-replay OAuth state (hashed, with
// StateTTL expiry) and returns the raw value the caller sends to the
// provider and binds to the browser via a cookie -- see
// docs/evidence/m2/54-oauth-session.md for the full replay/cross-session
// mitigation this and ConsumeState together implement.
func CreateState(ctx context.Context, pool *pgxpool.Pool) (raw string, err error) {
	raw, err = generateOpaqueToken()
	if err != nil {
		return "", err
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO oauth_states (state_hash, expires_at) VALUES ($1, $2)`,
		hashToken(raw), time.Now().Add(StateTTL),
	)
	if err != nil {
		return "", fmt.Errorf("failed to persist oauth state: %w", err)
	}
	return raw, nil
}

// ConsumeState deletes and returns whether a still-unexpired state
// record matching raw exists. It is single-use by construction: the
// matching row is deleted in the same statement that finds it, so a
// second call with the same raw value -- a replay -- always reports ok
// = false, whether or not it has also expired.
func ConsumeState(ctx context.Context, pool *pgxpool.Pool, raw string) (ok bool, err error) {
	if raw == "" {
		return false, nil
	}
	var id int64
	err = pool.QueryRow(ctx,
		`DELETE FROM oauth_states WHERE state_hash = $1 AND expires_at > now() RETURNING id`,
		hashToken(raw),
	).Scan(&id)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, pgx.ErrNoRows):
		return false, nil
	default:
		return false, fmt.Errorf("failed to consume oauth state: %w", err)
	}
}
