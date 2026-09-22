package httpapi

import (
	"context"
	"net/http"
	"sort"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// knownPublicTables is every table this module's migrations create as
// of issue #60 -- confirmed directly against a real, freshly migrated
// database (`\dt` against ticketit_test), not merely inferred from
// reading the migration files. M2 has no Round, work request, or queue
// concept anywhere (AGENTS.md, "No AI, Agents, Rounds, or Michelin in
// M2"), so this is also, today, the complete list of tables such a
// concept would need one of.
//
// THIS IS THE GUARDRAIL'S TRIP WIRE: the moment a future migration
// adds any table beyond this list -- a `rounds` table, a
// `work_claims`/`work_queue` table, anything execution-shaped -- this
// list no longer matches the live schema and
// TestManualLifecycleActionsCreateNoExecutionRecords fails immediately
// on its table-set assertion, forcing whoever adds that migration to
// look at this test and decide deliberately whether a manual,
// human-assigned action (this file's own ChangeTicketStatus,
// AcceptTicket, AssignTicketOwner, UnassignTicket) is still creating
// nothing in it. See that test's own doc comment for the second half
// of the proof (row counts), and
// docs/evidence/m2/60-lifecycle-transitions.md, "Proof the suite can
// fail," for a captured red run proving this: this list was
// deliberately mutated (a nonexistent "rounds" entry added, standing
// in for a future migration's real table) with the live schema left
// untouched, and the test failed immediately rather than passing
// vacuously -- reverted afterward.
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
	// table is always one of knownPublicTables' own fixed literals
	// (never request-derived), so building the query this way carries
	// no injection risk.
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM `+table).Scan(&count); err != nil {
		t.Fatalf("failed to count rows in %s: %v", table, err)
	}
	return count
}

// TestManualLifecycleActionsCreateNoExecutionRecords is issue #60's
// guardrail for "human assignment and every manual transition create
// no Round, no work request, and no queue entry, and start nothing."
// A bare assertion of that sentence would be true today for the wrong
// reason -- M2 has no Round/work-request/queue table at all, so
// nothing could prove it -- and would keep passing silently even after
// a future milestone added one, exactly the vacuous-negative-test
// failure mode issue #59 found and #60 is warned to avoid.
//
// This instead makes two falsifiable assertions against real
// PostgreSQL, after driving every manual command this slice adds
// (assign, every allowed Status transition including Accept) through
// the real API on one Ticket:
//
//  1. The complete set of tables in the schema is still exactly
//     knownPublicTables -- see that var's own comment for what would
//     make this fail.
//  2. Every known table OTHER than tickets has the exact same row
//     count after as before. tickets itself grows by exactly one row
//     -- the single Ticket this test creates -- proving these commands
//     insert into tickets and nowhere else.
//
// What would make this fail if a future slice wired up execution:
// either a migration adding a new table (assertion 1), or any of this
// file's handlers inserting a row into an existing table beyond
// tickets itself -- for example, if a future change made
// ChangeTicketStatus or AssignTicketOwner also insert a bookkeeping
// row somewhere when transitioning to In Progress (assertion 2). A
// change that adds Round/queue creation in a genuinely separate
// execution module, gated behind an Agent Assignee that cannot exist
// in M2, would not need to touch this test at all -- which is the
// intended scope: this guards the manual-transition commands
// themselves, not the schema in general.
func TestManualLifecycleActionsCreateNoExecutionRecords(t *testing.T) {
	baseURL, client, pool, _ := devServerWithSessionAndPoolForTickets(t)

	tablesBefore := publicTableNames(t, pool)
	before := map[string]int64{}
	for _, table := range knownPublicTables {
		before[table] = tableRowCount(t, pool, table)
	}

	// Drive every manual command this slice adds through the real API:
	// create, assign, the full allowed forward/back chain including
	// Blocked, Accept to Done, Done -> Ready, and unassign.
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
