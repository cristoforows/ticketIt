package postgres

import (
	"context"
	"errors"
	"io/fs"
	"net/url"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4/database"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5"

	"github.com/cristoforows/ticketIt/apps/galley/internal/migrations"
)

func TestApplyMigrations_ConcurrentRunsAgainstEmptyDatabase(t *testing.T) {
	want := latestEmbeddedMigrationVersion(t)
	for i := 0; i < 3; i++ {
		databaseURL := NewEmptyTestDatabase(t)
		raceMigrations(t, databaseURL, want)
	}
}

type migrationResult struct {
	version int
	dirty   bool
	err     error
}

func raceMigrations(t *testing.T, databaseURL string, wantVersion int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	u, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatalf("failed to parse the fresh database URL: %v", err)
	}
	holder, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatalf("failed to connect to the fresh database: %v", err)
	}
	defer holder.Close(context.Background())

	// golang-migrate's pgx/v5 driver keys its advisory lock on the URL
	// path (leading slash included), the schema, and the migrations table.
	lockID, err := database.GenerateAdvisoryLockId(u.Path, "public", "schema_migrations")
	if err != nil {
		t.Fatalf("failed to derive the migration lock id: %v", err)
	}
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_lock($1::bigint)`, lockID); err != nil {
		t.Fatalf("failed to take the migration lock: %v", err)
	}

	start := make(chan struct{})
	results := make(chan migrationResult, 2)
	for range 2 {
		go func() {
			<-start
			v, d, err := ApplyMigrations(ctx, databaseURL)
			results <- migrationResult{v, d, err}
		}()
	}
	close(start)

	waitForAdvisoryLockWaiters(t, ctx, holder, 2)
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_unlock($1::bigint)`, lockID); err != nil {
		t.Fatalf("failed to release the migration lock: %v", err)
	}

	for range 2 {
		r := <-results
		if r.err != nil {
			t.Fatalf("ApplyMigrations() error = %v", r.err)
		}
		if r.version != wantVersion || r.dirty {
			t.Errorf("ApplyMigrations() = (version %d, dirty %v), want (%d, false)", r.version, r.dirty, wantVersion)
		}
	}

	var appliedRows int
	if err := holder.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version = $1 AND NOT dirty`, wantVersion).Scan(&appliedRows); err != nil {
		t.Fatalf("failed to read schema_migrations: %v", err)
	}
	if appliedRows != 1 {
		t.Errorf("schema_migrations clean rows at version %d = %d, want 1", wantVersion, appliedRows)
	}
	for _, table := range []string{"diagnostic_notes", "owners", "owner_identities", "sessions", "oauth_states", "tickets"} {
		var exists bool
		if err := holder.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); err != nil {
			t.Fatalf("failed to check table %s: %v", table, err)
		}
		if !exists {
			t.Errorf("table %s does not exist after the concurrent migration runs", table)
		}
	}
}

func waitForAdvisoryLockWaiters(t *testing.T, ctx context.Context, conn *pgx.Conn, want int) {
	t.Helper()
	for {
		var waiting int
		err := conn.QueryRow(ctx,
			`SELECT count(*) FROM pg_locks
			  WHERE locktype = 'advisory' AND NOT granted
			    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
		).Scan(&waiting)
		if err != nil {
			t.Fatalf("failed to count advisory lock waiters (want %d): %v", want, err)
		}
		if waiting == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func latestEmbeddedMigrationVersion(t *testing.T) int {
	t.Helper()
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		t.Fatalf("failed to load embedded migrations: %v", err)
	}
	defer src.Close()
	v, err := src.First()
	if err != nil {
		t.Fatalf("failed to read the first embedded migration: %v", err)
	}
	for {
		next, err := src.Next(v)
		if errors.Is(err, fs.ErrNotExist) {
			return int(v)
		}
		if err != nil {
			t.Fatalf("failed to read the embedded migration after %d: %v", v, err)
		}
		v = next
	}
}
