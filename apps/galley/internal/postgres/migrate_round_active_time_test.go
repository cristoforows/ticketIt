package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestMigration29_CountsARunningRoundFromItsStart(t *testing.T) {
	databaseURL := NewEmptyTestDatabase(t)
	migrateTo(t, databaseURL, 28)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())

	started := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	var first, second int64
	if err := conn.QueryRow(ctx, `INSERT INTO owners DEFAULT VALUES RETURNING id`).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO owners (singleton) VALUES (false) RETURNING id`).Scan(&second); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		owner              int64
		title, state, ends string
	}{
		{first, "running", "running", "NULL"},
		{first, "delivered", "delivered", "$3::timestamptz + interval '1 hour'"},
		{second, "other Owner delivered", "delivered", "$3::timestamptz + interval '1 hour'"},
	} {
		if _, err := conn.Exec(ctx, `WITH a AS (INSERT INTO agents (owner_id, public_id, name, kind) VALUES ($1, gen_random_uuid(), $2, 'coding') RETURNING id),
			t AS (INSERT INTO tickets (owner_id, title, status, assignee_type, assignee_agent_id, priority_rank) SELECT $1, $2, 'In Progress', 'agent', a.id, 1024 * (1 + (SELECT count(*) FROM tickets)) FROM a RETURNING id, assignee_agent_id)
			INSERT INTO rounds (owner_id, public_id, ticket_id, agent_id, sequence, state, claim_epoch, claimed_at, started_at, ended_at)
			SELECT $1, gen_random_uuid(), t.id, t.assignee_agent_id, 1, $4, 1, $3::timestamptz, $3::timestamptz, `+row.ends+` FROM t`,
			row.owner, row.title, started, row.state); err != nil {
			t.Fatalf("%s: %v", row.title, err)
		}
	}

	migrateTo(t, databaseURL, 29)

	rows, err := conn.Query(ctx, `SELECT t.title, r.active_ms, r.active_since FROM rounds r JOIN tickets t ON t.id = r.ticket_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]*time.Time{}
	for rows.Next() {
		var title string
		var ms int64
		var since *time.Time
		if err := rows.Scan(&title, &ms, &since); err != nil {
			t.Fatal(err)
		}
		if ms != 0 {
			t.Errorf("%s: active_ms = %d, want 0", title, ms)
		}
		got[title] = since
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got["running"] == nil || !got["running"].Equal(started) || got["delivered"] != nil || got["other Owner delivered"] != nil {
		t.Fatalf("active_since = %v, want only the running Round counted from %s", got, started)
	}
}
