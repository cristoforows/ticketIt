package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OwnerView is the signed-in Owner data a valid session resolves to --
// exactly what GET /api/session and the requireSession HTTP gate need,
// nothing GitHub-specific beyond the display login (see Owner's
// contract doc for why login is display-only).
type OwnerView struct {
	ID    int64
	Login string
}

// CreateSession persists a new session for ownerID, expiring after
// SessionTTL, and returns the raw token the caller delivers in the
// session cookie -- only its hash is ever persisted (see auth.go).
func CreateSession(ctx context.Context, pool *pgxpool.Pool, ownerID int64) (raw string, expiresAt time.Time, err error) {
	return CreateSessionWithExpiry(ctx, pool, ownerID, time.Now().Add(SessionTTL))
}

// CreateSessionWithExpiry is CreateSession with an explicit expiry,
// factored out so tests can manufacture an already-expired session
// without waiting SessionTTL or reaching through a second code path
// that production never uses.
func CreateSessionWithExpiry(ctx context.Context, pool *pgxpool.Pool, ownerID int64, expiresAt time.Time) (raw string, expiry time.Time, err error) {
	raw, err = generateOpaqueToken()
	if err != nil {
		return "", time.Time{}, err
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO sessions (owner_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
		ownerID, hashToken(raw), expiresAt,
	)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to persist session: %w", err)
	}
	return raw, expiresAt, nil
}

// LookupSession resolves raw to the Owner it belongs to, if any
// unexpired session matches its hash. ok is false for a token that is
// missing, unknown, or expired -- callers do not need to and cannot
// distinguish those cases, which is deliberate: none of them should
// produce a different response than a generic "sign-in required."
func LookupSession(ctx context.Context, pool *pgxpool.Pool, raw string) (owner OwnerView, ok bool, err error) {
	if raw == "" {
		return OwnerView{}, false, nil
	}
	var (
		ownerID int64
		login   string
	)
	err = pool.QueryRow(ctx,
		`SELECT s.owner_id, oi.login
		   FROM sessions s
		   JOIN owner_identities oi ON oi.owner_id = s.owner_id
		  WHERE s.token_hash = $1 AND s.expires_at > now()
		  LIMIT 1`,
		hashToken(raw),
	).Scan(&ownerID, &login)
	switch {
	case err == nil:
		return OwnerView{ID: ownerID, Login: login}, true, nil
	case errors.Is(err, pgx.ErrNoRows):
		return OwnerView{}, false, nil
	default:
		return OwnerView{}, false, fmt.Errorf("failed to look up session: %w", err)
	}
}

// DeleteSession revokes the session matching raw, if any. Deleting a
// token that does not match any row is not an error: sign-out is
// idempotent from the caller's point of view.
func DeleteSession(ctx context.Context, pool *pgxpool.Pool, raw string) error {
	if raw == "" {
		return nil
	}
	if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, hashToken(raw)); err != nil {
		return fmt.Errorf("failed to revoke session: %w", err)
	}
	return nil
}
