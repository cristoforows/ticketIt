// Command migrate is the one documented command that applies Galley's
// versioned, forward-only PostgreSQL migrations (apps/galley/internal/
// migrations) to whatever database DATABASE_URL names. It is not run
// automatically by cmd/galley at startup -- see apps/galley/README.md,
// "Database migrations," for that rule and its rationale.
//
// Usage:
//
//	DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable go run ./cmd/migrate
package main

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

func main() {
	if err := run(os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run is factored out of main so a test can supply a fake getenv and
// capture output, matching cmd/galley's own convention.
func run(getenv func(string) string, stdout io.Writer) error {
	databaseURL := getenv("DATABASE_URL")
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL is not set: a PostgreSQL connection string is required " +
			"(postgres://user:password@host:port/dbname) -- see apps/galley/README.md, \"Database configuration\"")
	}

	version, dirty, err := postgres.ApplyMigrations(context.Background(), databaseURL)
	if err != nil {
		return fmt.Errorf("migration failed: %w", err)
	}

	if dirty {
		fmt.Fprintf(stdout, "migrations applied, but schema version %d is marked dirty (a previous migration failed partway) -- investigate before proceeding\n", version)
		return nil
	}
	fmt.Fprintf(stdout, "migrations applied: schema version %d\n", version)
	return nil
}
