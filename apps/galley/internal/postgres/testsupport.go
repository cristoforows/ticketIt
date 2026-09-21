package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestDatabaseURL is the default local PostgreSQL connection string
// this module's tests use. Override it with GALLEY_TEST_DATABASE_URL
// for a differently-named or differently-hosted test database. See
// apps/galley/README.md, "Local PostgreSQL setup," for how to create
// this database.
const TestDatabaseURL = "postgres://localhost:5432/ticketit_test?sslmode=disable"

// TestingURL returns GALLEY_TEST_DATABASE_URL if set, else
// TestDatabaseURL.
func TestingURL() string {
	if v := os.Getenv("GALLEY_TEST_DATABASE_URL"); v != "" {
		return v
	}
	return TestDatabaseURL
}

// NewTestPool applies every migration in internal/migrations to
// TestingURL() (a no-op if already applied) and returns a connected,
// pinged pool. Every test that needs real PostgreSQL calls this
// instead of standing up any in-memory or fake substitute -- see
// apps/galley/README.md, "Testing against real PostgreSQL." It fails
// the test immediately, with an actionable message, if that database
// is not reachable; it never falls back to a fake.
func NewTestPool(tb testing.TB) *pgxpool.Pool {
	tb.Helper()

	databaseURL := TestingURL()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, _, err := ApplyMigrations(ctx, databaseURL); err != nil {
		tb.Fatalf("failed to apply migrations to the test database: %v\n"+
			"Create it first: see apps/galley/README.md, \"Local PostgreSQL setup\" "+
			"(expected at %s; override with GALLEY_TEST_DATABASE_URL)", err, redactedURL(databaseURL))
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		tb.Fatalf("failed to construct a connection pool for the test database: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		tb.Fatalf("test database at %s is not reachable: %v\n"+
			"Start PostgreSQL and create it first: see apps/galley/README.md, \"Local PostgreSQL setup\"",
			redactedURL(databaseURL), err)
	}

	tb.Cleanup(pool.Close)
	return pool
}

// redactedURL reports only the host:port/dbname a test tried to
// reach, for a failure message -- never the full connection string
// (which may carry credentials).
func redactedURL(databaseURL string) string {
	u, err := parseForDisplay(databaseURL)
	if err != nil {
		return "(unparseable DATABASE_URL, withheld)"
	}
	return u
}
