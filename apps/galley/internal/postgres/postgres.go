// Package postgres wraps Galley's PostgreSQL connectivity: a pgx
// connection pool, a live reachability/migration-version health check
// for GET /api/status, and the migration runner shared by cmd/migrate
// and the test suite.
//
// Nothing in this package ever logs or returns a connection string --
// only fixed, generic messages and errors produced by pgx itself
// (which never includes the password in its own error text). See
// apps/galley/README.md, "Database configuration," for the full
// rationale.
package postgres

import (
	"context"
	"fmt"
	"net/url"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool creates a connection pool for databaseURL. Per pgxpool's own
// design, this parses and validates configuration synchronously (an
// error here means a malformed DATABASE_URL -- a configuration
// problem worth failing Galley's startup over) but does not itself
// connect to the database, so Galley can still boot and serve while
// its configured database is temporarily unreachable: reachability is
// instead checked live, per request, by CheckHealth below.
func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		// Deliberately not wrapping err's text: some parse failures
		// echo back the offending input, which would leak the
		// connection string (and any credentials in it) into
		// whatever logs or terminal captures this error.
		return nil, fmt.Errorf("failed to initialize the database connection pool: DATABASE_URL could not be parsed as a PostgreSQL connection string")
	}
	return pool, nil
}

// MigrateURL rewrites databaseURL's scheme to "pgx5", the scheme
// github.com/golang-migrate/migrate/v4/database/pgx/v5 expects to
// select its driver, without altering any other part of the URL. The
// result still contains whatever credentials databaseURL had --
// callers must not log it, same as databaseURL itself.
func MigrateURL(databaseURL string) (string, error) {
	u, err := url.Parse(databaseURL)
	if err != nil {
		return "", fmt.Errorf("DATABASE_URL could not be parsed as a PostgreSQL connection string")
	}
	switch u.Scheme {
	case "postgres", "postgresql":
	default:
		return "", fmt.Errorf("DATABASE_URL must use the postgres:// or postgresql:// scheme")
	}
	u.Scheme = "pgx5"
	return u.String(), nil
}

// parseForDisplay returns only databaseURL's scheme, host, port, and
// path (database name) -- with any userinfo (user and/or password)
// stripped -- so a diagnostic message can name which database a test
// tried to reach without ever printing credentials.
func parseForDisplay(databaseURL string) (string, error) {
	u, err := url.Parse(databaseURL)
	if err != nil {
		return "", err
	}
	u.User = nil
	u.RawQuery = ""
	return u.String(), nil
}
