package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// HealthTimeout bounds each live database check GET /api/status
// performs, so an unreachable database degrades that response instead
// of hanging the request indefinitely.
const HealthTimeout = 2 * time.Second

// Health is the live database portion of GET /api/status.
type Health struct {
	// Reachable is true only when pool answered a real query during
	// this check.
	Reachable bool
	// MigrationVersion is the currently applied migration version, or
	// nil if it could not be determined: either the database is
	// unreachable, or it is reachable but no migration has been
	// applied yet (a normal state on a freshly created database,
	// distinct from an error).
	MigrationVersion *int
}

// CheckHealth pings pool and reads the currently applied migration
// version (schema_migrations, the table golang-migrate's pgx5 driver
// maintains). It is called fresh on every GET /api/status request --
// never cached from process start -- so a database outage is visible
// immediately, and recovery is visible immediately too.
//
// A database that is reachable but has no migrations applied yet
// (schema_migrations doesn't exist, or is empty) is reported as
// healthy with a nil MigrationVersion, not as an error: that is this
// package's deliberate distinction between "unreachable" (Reachable
// false) and "reachable, nothing applied yet" (Reachable true,
// MigrationVersion nil).
func CheckHealth(ctx context.Context, pool *pgxpool.Pool) Health {
	ctx, cancel := context.WithTimeout(ctx, HealthTimeout)
	defer cancel()

	if err := pool.Ping(ctx); err != nil {
		return Health{Reachable: false}
	}

	var version int
	err := pool.QueryRow(ctx, `SELECT version FROM schema_migrations LIMIT 1`).Scan(&version)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return Health{Reachable: true}
	case err != nil:
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgerrcode.UndefinedTable {
			// No migration has ever been applied to this database yet.
			return Health{Reachable: true}
		}
		// Reachable enough to answer Ping, but the migration-state
		// query itself failed unexpectedly (e.g. lost the connection
		// mid-query, or a permissions problem) -- treat as
		// unreachable/unhealthy rather than silently reporting "ok"
		// with an unknown version.
		return Health{Reachable: false}
	default:
		v := version
		return Health{Reachable: true, MigrationVersion: &v}
	}
}
