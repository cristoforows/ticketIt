package auth

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

var testIdentity = ProviderIdentity{ID: 4242, Login: "gc-test-owner"}

func TestCreateSession_DeletesExpiredSessions(t *testing.T) {
	pool := postgres.NewEmptyMigratedTestPool(t)
	ctx := context.Background()
	ownerID, _, err := ResolveOwner(ctx, pool, testIdentity.Login, testIdentity)
	if err != nil {
		t.Fatalf("ResolveOwner() error = %v", err)
	}

	live, _, err := CreateSession(ctx, pool, ownerID, time.Hour)
	if err != nil {
		t.Fatalf("failed to create a live session: %v", err)
	}
	expired, _, err := CreateSessionWithExpiry(ctx, pool, ownerID, time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatalf("failed to create an expired session: %v", err)
	}
	if !sessionRowExists(t, pool, expired) {
		t.Fatal("expired session row missing before the triggering CreateSession")
	}

	fresh, _, err := CreateSession(ctx, pool, ownerID, time.Hour)
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	if sessionRowExists(t, pool, expired) {
		t.Error("expired session row survived CreateSession")
	}
	for name, raw := range map[string]string{"live": live, "fresh": fresh} {
		if _, ok, err := LookupSession(ctx, pool, raw); err != nil || !ok {
			t.Errorf("LookupSession(%s) = (ok %v, err %v), want ok", name, ok, err)
		}
	}
}

func TestCreateState_DeletesExpiredStates(t *testing.T) {
	pool := postgres.NewEmptyMigratedTestPool(t)
	ctx := context.Background()

	live, err := CreateState(ctx, pool)
	if err != nil {
		t.Fatalf("failed to create a live state: %v", err)
	}
	expired, err := generateOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO oauth_states (state_hash, expires_at) VALUES ($1, now() - interval '1 minute')`,
		hashToken(expired),
	); err != nil {
		t.Fatalf("failed to insert an expired state: %v", err)
	}
	if !stateRowExists(t, pool, expired) {
		t.Fatal("expired state row missing before the triggering CreateState")
	}

	fresh, err := CreateState(ctx, pool)
	if err != nil {
		t.Fatalf("CreateState() error = %v", err)
	}

	if stateRowExists(t, pool, expired) {
		t.Error("expired state row survived CreateState")
	}
	for name, raw := range map[string]string{"live": live, "fresh": fresh} {
		if ok, err := ConsumeState(ctx, pool, raw); err != nil || !ok {
			t.Errorf("ConsumeState(%s) = (ok %v, err %v), want ok", name, ok, err)
		}
	}
}

func sessionRowExists(t *testing.T, pool *pgxpool.Pool, raw string) bool {
	t.Helper()
	var exists bool
	if err := pool.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM sessions WHERE token_hash = $1)`, hashToken(raw),
	).Scan(&exists); err != nil {
		t.Fatalf("failed to query sessions: %v", err)
	}
	return exists
}

func stateRowExists(t *testing.T, pool *pgxpool.Pool, raw string) bool {
	t.Helper()
	var exists bool
	if err := pool.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM oauth_states WHERE state_hash = $1)`, hashToken(raw),
	).Scan(&exists); err != nil {
		t.Fatalf("failed to query oauth_states: %v", err)
	}
	return exists
}
