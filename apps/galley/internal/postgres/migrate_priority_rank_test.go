package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5"

	"github.com/cristoforows/ticketIt/apps/galley/internal/migrations"
)

func migrateTo(t *testing.T, databaseURL string, version uint) {
	t.Helper()
	migrateURL, err := MigrateURL(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, migrateURL)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if err := m.Migrate(version); err != nil {
		t.Fatalf("migrate to %d: %v", version, err)
	}
}

func TestMigration12_BackfillsPriorityRankNewestFirstPerOwner(t *testing.T) {
	databaseURL := NewEmptyTestDatabase(t)
	migrateTo(t, databaseURL, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())

	var first, second int64
	if err := conn.QueryRow(ctx, `INSERT INTO owners DEFAULT VALUES RETURNING id`).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO owners (singleton) VALUES (false) RETURNING id`).Scan(&second); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	for _, row := range []struct {
		owner    int64
		title    string
		at       time.Time
		archived bool
	}{
		{first, "oldest", base, false},
		{first, "tied, inserted first", base.Add(time.Hour), false},
		{first, "tied, inserted second", base.Add(time.Hour), false},
		{first, "archived", base.Add(30 * time.Minute), true},
		{second, "second Owner older", base, false},
		{second, "second Owner newer", base.Add(time.Minute), false},
	} {
		if _, err := conn.Exec(ctx,
			`INSERT INTO tickets (owner_id, title, status, created_at, archived_at) VALUES ($1, $2, 'Backlog', $3, CASE WHEN $4 THEN now() END)`,
			row.owner, row.title, row.at, row.archived); err != nil {
			t.Fatal(err)
		}
	}

	migrateTo(t, databaseURL, 12)

	want := map[string]int64{
		"tied, inserted second": 1024,
		"tied, inserted first":  2048,
		"archived":              3072,
		"oldest":                4096,
		"second Owner newer":    1024,
		"second Owner older":    2048,
	}
	rows, err := conn.Query(ctx, `SELECT title, priority_rank FROM tickets`)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for rows.Next() {
		var title string
		var rank int64
		if err := rows.Scan(&title, &rank); err != nil {
			t.Fatal(err)
		}
		got[title] = rank
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) {
		t.Fatalf("ranks = %v, want %v", got, want)
	}
	for title, rank := range want {
		if got[title] != rank {
			t.Errorf("%s rank = %d, want %d", title, got[title], rank)
		}
	}
}
