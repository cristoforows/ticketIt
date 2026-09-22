package httpapi

import (
	"context"
	"net/http"
	"sort"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// knownPublicTables is every table issue #60's migrations create,
// verified against a live migrated database rather than inferred from
// the migration files. Any new table breaks
// TestManualLifecycleActionsCreateNoExecutionRecords' table-set
// assertion on purpose, forcing a deliberate look at whether manual
// lifecycle actions write to it. See
// docs/evidence/m2/60-lifecycle-transitions.md.
var knownPublicTables = []string{
	"diagnostic_notes",
	"oauth_states",
	"owner_identities",
	"owners",
	"schema_migrations",
	"sessions",
	"tickets",
}

func publicTableNames(t *testing.T, pool *pgxpool.Pool) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`)
	if err != nil {
		t.Fatalf("failed to list public tables: %v", err)
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("failed to scan table name: %v", err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("failed to read table list: %v", err)
	}
	return names
}

func tableRowCount(t *testing.T, pool *pgxpool.Pool, table string) int64 {
	t.Helper()
	var count int64
	// table is always a knownPublicTables literal, never request-derived.
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM `+table).Scan(&count); err != nil {
		t.Fatalf("failed to count rows in %s: %v", table, err)
	}
	return count
}

// TestManualLifecycleActionsCreateNoExecutionRecords is issue #60's
// guardrail for "human assignment and every manual transition create
// no Round, no work request, and no queue entry, and start nothing."
// Asserting that sentence directly would pass vacuously -- M2 has no
// such table -- and would keep passing after a future milestone added
// one, the failure mode issue #59 found and #60 is warned to avoid.
//
// Instead, after driving every manual command this slice adds through
// the real API on one Ticket: the schema's table set is still exactly
// knownPublicTables, and every known table but tickets has an
// unchanged row count, with tickets itself growing by exactly one.
func TestManualLifecycleActionsCreateNoExecutionRecords(t *testing.T) {
	baseURL, client, pool, _ := devServerWithSessionAndPoolForTickets(t)

	tablesBefore := publicTableNames(t, pool)
	before := map[string]int64{}
	for _, table := range knownPublicTables {
		before[table] = tableRowCount(t, pool, table)
	}

	created := createTicketWithTemplate(t, client, baseURL, uniqueTitle(t), Basic)
	if resp := assignOwnerHTTP(t, client, baseURL, created.Id); resp.status != http.StatusOK {
		t.Fatalf("assign: status = %d, want 200; error=%+v", resp.status, resp.errBody)
	}
	for _, to := range []TicketStatus{Ready, InProgress, Blocked, InProgress, InReview} {
		if resp := changeStatus(t, client, baseURL, created.Id, to); resp.status != http.StatusOK {
			t.Fatalf("change status to %s: status = %d, want 200; error=%+v", to, resp.status, resp.errBody)
		}
	}
	if resp := acceptTicketHTTP(t, client, baseURL, created.Id); resp.status != http.StatusOK {
		t.Fatalf("accept: status = %d, want 200; error=%+v", resp.status, resp.errBody)
	}
	if resp := changeStatus(t, client, baseURL, created.Id, Ready); resp.status != http.StatusOK {
		t.Fatalf("change status Done -> Ready: status = %d, want 200; error=%+v", resp.status, resp.errBody)
	}
	if resp := unassignHTTP(t, client, baseURL, created.Id); resp.status != http.StatusOK {
		t.Fatalf("unassign: status = %d, want 200; error=%+v", resp.status, resp.errBody)
	}

	tablesAfter := publicTableNames(t, pool)
	wantTables := append([]string(nil), knownPublicTables...)
	sort.Strings(wantTables)
	if !equalStrings(tablesBefore, wantTables) {
		t.Fatalf("public tables before this test's own actions = %v, want exactly %v -- knownPublicTables is out of date", tablesBefore, wantTables)
	}
	if !equalStrings(tablesAfter, wantTables) {
		t.Fatalf("public tables after the manual lifecycle actions above = %v, want exactly %v (unchanged) -- "+
			"a new table appeared, which is exactly the trip wire knownPublicTables exists to catch", tablesAfter, wantTables)
	}

	for _, table := range knownPublicTables {
		after := tableRowCount(t, pool, table)
		switch table {
		case "tickets":
			if after != before[table]+1 {
				t.Errorf("tickets row count = %d, want %d (before %d + the one Ticket this test created)", after, before[table]+1, before[table])
			}
		default:
			if after != before[table] {
				t.Errorf("%s row count changed from %d to %d -- a manual lifecycle command inserted into a table it should never touch", table, before[table], after)
			}
		}
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
