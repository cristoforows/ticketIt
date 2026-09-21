package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5" // registers the "pgx5" scheme MigrateURL produces
	"github.com/golang-migrate/migrate/v4/source/iofs"

	"github.com/cristoforows/ticketIt/apps/galley/internal/migrations"
)

// ApplyMigrations applies every pending migration in
// internal/migrations to databaseURL, forward-only, and returns the
// resulting schema version. It is the one documented command's
// implementation (see apps/galley/README.md, "Database migrations,"
// and cmd/migrate) and is also called directly by the test suite's
// database setup, so both paths always apply the exact same,
// version-controlled migrations. Calling it against an
// already-up-to-date database is a no-op (golang-migrate's
// ErrNoChange), which is what makes it safe to call from every test
// run.
func ApplyMigrations(ctx context.Context, databaseURL string) (version int, dirty bool, err error) {
	migrateURL, err := MigrateURL(databaseURL)
	if err != nil {
		return 0, false, err
	}

	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		return 0, false, fmt.Errorf("failed to load embedded migrations: %w", err)
	}

	m, err := migrate.NewWithSourceInstance("iofs", src, migrateURL)
	if err != nil {
		return 0, false, fmt.Errorf("failed to initialize the migration runner: %w", err)
	}
	defer m.Close()

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return 0, false, fmt.Errorf("failed to apply migrations: %w", err)
	}

	v, d, err := m.Version()
	if err != nil {
		if errors.Is(err, migrate.ErrNilVersion) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("failed to read the applied migration version: %w", err)
	}
	return int(v), d, nil
}
