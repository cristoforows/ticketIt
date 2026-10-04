package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
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
	"agents",
	"badges",
	"diagnostic_notes",
	"oauth_states",
	"owner_identities",
	"owners",
	"permission_grants",
	"permission_requests",
	"round_activity",
	"round_authority_checks",
	"round_commands",
	"round_deliverables",
	"round_engine_references",
	"round_events",
	"round_feedback",
	"round_questions",
	"rounds",
	"runners",
	"schema_migrations",
	"sessions",
	"tickets",
	"ticket_badges",
	"usage_observations",
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
// knownPublicTables, and every known table but tickets and agents has
// an unchanged row count, with those two growing by exactly one each.
func TestManualLifecycleActionsCreateNoExecutionRecords(t *testing.T) {
	baseURL, client, pool, _ := devServerWithSessionAndPoolForTickets(t)

	tablesBefore := publicTableNames(t, pool)
	before := map[string]int64{}
	for _, table := range knownPublicTables {
		before[table] = tableRowCount(t, pool, table)
	}

	created := createTicketWithTemplate(t, client, baseURL, uniqueTitle(t), Basic)
	if resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Goal: strPtr("g"), SuccessCriteria: strPtr("s"), Repository: strPtr("owner/repo")}); resp.StatusCode != http.StatusOK {
		t.Fatalf("fill Agent inputs: status = %d; body=%s", resp.StatusCode, body)
	}
	agent := createAgentHTTP(t, client, baseURL, AgentKindCoding)
	assign := func(body AssignTicketRequest) {
		t.Helper()
		if resp := doLifecycleRequest(t, client, http.MethodPut, baseURL+"/api/tickets/"+created.Id+"/assignee", body); resp.status != http.StatusOK {
			t.Fatalf("assign %s: status = %d, want 200; error=%+v", body.Type, resp.status, resp.errBody)
		}
	}
	toAgent := AssignTicketRequest{Type: AssignTicketRequestTypeAgent, AgentId: &agent.Id}
	toOwner := AssignTicketRequest{Type: AssignTicketRequestTypeOwner}
	assign(toAgent)
	assign(toOwner)
	assign(toAgent)
	if resp := changeStatus(t, client, baseURL, created.Id, Ready); resp.status != http.StatusOK || !resp.ticket.RequestingAgentWork {
		t.Fatalf("change status to Ready with an Agent: status = %d, requestingAgentWork = %t; error=%+v", resp.status, resp.ticket.RequestingAgentWork, resp.errBody)
	}
	if resp := doLifecycleRequest(t, client, http.MethodPost, baseURL+"/api/tickets/"+created.Id+"/stop", nil); resp.status != http.StatusBadRequest || resp.errBody.Error.Code != stopNotAvailableCode {
		t.Fatalf("stop without an open Round: status = %d, want 400 %s; error=%+v", resp.status, stopNotAvailableCode, resp.errBody)
	}
	answerPath := baseURL + "/api/tickets/" + created.Id + "/rounds/" + uuid.NewString() + "/questions/" + uuid.NewString() + "/answer"
	if resp := doLifecycleRequest(t, client, http.MethodPost, answerPath, AnswerQuestionRequest{Answer: "yes"}); resp.status != http.StatusNotFound {
		t.Fatalf("answer without a question: status = %d, want 404; error=%+v", resp.status, resp.errBody)
	}
	permissionPath := baseURL + "/api/tickets/" + created.Id + "/rounds/" + uuid.NewString() + "/permission-requests/" + uuid.NewString()
	if resp := doLifecycleRequest(t, client, http.MethodPost, permissionPath+"/approve", ApprovePermissionRequest{Form: PermissionGrantFormTicket}); resp.status != http.StatusNotFound {
		t.Fatalf("approval without a Permission request: status = %d, want 404; error=%+v", resp.status, resp.errBody)
	}
	expiresAt := time.Now().Add(time.Hour)
	if resp := doLifecycleRequest(t, client, http.MethodPost, permissionPath+"/approve", ApprovePermissionRequest{Form: PermissionGrantFormTime, ExpiresAt: &expiresAt}); resp.status != http.StatusNotFound {
		t.Fatalf("time approval without a Permission request: status = %d, want 404; error=%+v", resp.status, resp.errBody)
	}
	if resp := doLifecycleRequest(t, client, http.MethodPost, permissionPath+"/decline", nil); resp.status != http.StatusNotFound {
		t.Fatalf("decline without a Permission request: status = %d, want 404; error=%+v", resp.status, resp.errBody)
	}
	feedbackPath := baseURL + "/api/tickets/" + created.Id + "/rounds/" + uuid.NewString() + "/feedback"
	if resp := doLifecycleRequest(t, client, http.MethodPost, feedbackPath, AddRoundFeedbackRequest{Body: "more"}); resp.status != http.StatusNotFound {
		t.Fatalf("feedback without a Round: status = %d, want 404; error=%+v", resp.status, resp.errBody)
	}
	for _, to := range []TicketStatus{Backlog, Ready} {
		if resp := changeStatus(t, client, baseURL, created.Id, to); resp.status != http.StatusOK || len(resp.ticket.Badges) != 0 {
			t.Fatalf("change status to %s: status = %d, badges = %+v, want 200 and none; error=%+v", to, resp.status, resp.ticket.Badges, resp.errBody)
		}
	}
	assign(toOwner)
	for _, to := range []TicketStatus{InProgress, Blocked} {
		if resp := changeStatus(t, client, baseURL, created.Id, to); resp.status != http.StatusOK {
			t.Fatalf("change status to %s: status = %d, want 200; error=%+v", to, resp.status, resp.errBody)
		}
	}
	assign(toAgent)
	if resp := changeStatus(t, client, baseURL, created.Id, Ready); resp.status != http.StatusOK || !resp.ticket.RequestingAgentWork {
		t.Fatalf("recover Blocked -> Ready with an Agent: status = %d, requestingAgentWork = %t; error=%+v", resp.status, resp.ticket.RequestingAgentWork, resp.errBody)
	}
	assign(toOwner)
	for _, to := range []TicketStatus{InProgress, InReview} {
		if resp := changeStatus(t, client, baseURL, created.Id, to); resp.status != http.StatusOK {
			t.Fatalf("change status to %s: status = %d, want 200; error=%+v", to, resp.status, resp.errBody)
		}
	}
	assign(toAgent)
	if resp := requestReworkHTTP(t, client, baseURL, created.Id); resp.status != http.StatusOK || !resp.ticket.RequestingAgentWork {
		t.Fatalf("request rework: status = %d, requestingAgentWork = %t; error=%+v", resp.status, resp.ticket.RequestingAgentWork, resp.errBody)
	}
	assign(toOwner)
	for _, to := range []TicketStatus{InProgress, InReview} {
		if resp := changeStatus(t, client, baseURL, created.Id, to); resp.status != http.StatusOK {
			t.Fatalf("change status to %s: status = %d, want 200; error=%+v", to, resp.status, resp.errBody)
		}
	}
	if resp := acceptTicketHTTP(t, client, baseURL, created.Id); resp.status != http.StatusOK {
		t.Fatalf("accept: status = %d, want 200; error=%+v", resp.status, resp.errBody)
	}
	assign(toAgent)
	if resp := changeStatus(t, client, baseURL, created.Id, Ready); resp.status != http.StatusOK || !resp.ticket.RequestingAgentWork {
		t.Fatalf("change status Done -> Ready with an Agent: status = %d, requestingAgentWork = %t; error=%+v", resp.status, resp.ticket.RequestingAgentWork, resp.errBody)
	}
	if resp := unassignHTTP(t, client, baseURL, created.Id); resp.status != http.StatusOK {
		t.Fatalf("unassign: status = %d, want 200; error=%+v", resp.status, resp.errBody)
	}
	neighbour := createTicket(t, client, baseURL, uniqueTitle(t))
	if resp := changeStatus(t, client, baseURL, neighbour.Id, Ready); resp.status != http.StatusOK {
		t.Fatalf("change the neighbour to Ready: status = %d, want 200; error=%+v", resp.status, resp.errBody)
	}
	if resp := doLifecycleRequest(t, client, http.MethodPost, baseURL+"/api/tickets/"+neighbour.Id+"/position", ReorderTicketRequest{Before: &created.Id}); resp.status != http.StatusOK {
		t.Fatalf("reorder: status = %d, want 200; error=%+v", resp.status, resp.errBody)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/tickets/"+created.Id+"/archive", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("archive: status = %d, want 200", res.StatusCode)
	}
	req, err = http.NewRequest(http.MethodPost, baseURL+"/api/tickets/"+created.Id+"/restore", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("restore: status = %d, want 200", res.StatusCode)
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
			if after != before[table]+2 {
				t.Errorf("%s row count = %d, want %d (before %d + the two rows this test created)", table, after, before[table]+2, before[table])
			}
		case "agents":
			if after != before[table]+1 {
				t.Errorf("%s row count = %d, want %d (before %d + the one row this test created)", table, after, before[table]+1, before[table])
			}
		case "rounds":
			if after != before[table] {
				t.Errorf("rounds row count changed from %d to %d -- a manual action, including the recovery from Blocked, created a Round; only a runner claim may", before[table], after)
			}
		case "round_events", "round_engine_references":
			if after != before[table] {
				t.Errorf("%s row count changed from %d to %d -- a manual action recorded a runner event or an engine reference; only a runner's event may", table, before[table], after)
			}
		case "round_activity", "usage_observations":
			if after != before[table] {
				t.Errorf("%s row count changed from %d to %d -- a manual action recorded Round activity or usage; only a runner's progress or usage_observed event, or its Reconcile changing the recorded execution, may", table, before[table], after)
			}
		case "round_deliverables":
			if after != before[table] {
				t.Errorf("%s row count changed from %d to %d -- a manual action recorded a deliverable; only a runner's delivered event may", table, before[table], after)
			}
		case "badges", "ticket_badges":
			if after != before[table] {
				t.Errorf("%s row count changed from %d to %d -- a manual move to Backlog created or attached a Badge; only a confirmed Stop attaches the Stopped Badge", table, before[table], after)
			}
		case "round_questions":
			if after != before[table] {
				t.Errorf("%s row count changed from %d to %d -- a manual action recorded a question; only a runner's question_raised event may", table, before[table], after)
			}
		case "permission_requests", "permission_grants", "round_authority_checks":
			if after != before[table] {
				t.Errorf("%s row count changed from %d to %d -- a manual action recorded a Permission request, grant or authority check; only a runner's permission_requested event, the Owner's approval of it and a runner's authority check may", table, before[table], after)
			}
		case "round_feedback":
			if after != before[table] {
				t.Errorf("%s row count changed from %d to %d -- a manual lifecycle action recorded Round feedback; only the Owner's feedback command may", table, before[table], after)
			}
		case "round_commands":
			if after != before[table] {
				t.Errorf("%s row count changed from %d to %d -- a manual lifecycle action recorded a Round command; only a Stop request on an open Round, an answer to its question, an approval of its Permission request or a revoke of a grant covering it may", table, before[table], after)
			}
		default:
			if after != before[table] {
				t.Errorf("%s row count changed from %d to %d -- a manual lifecycle command inserted into a table it should never touch", table, before[table], after)
			}
		}
	}
}

func createAgentHTTP(t *testing.T, client *http.Client, baseURL string, kind AgentKind) Agent {
	t.Helper()
	data, err := json.Marshal(CreateAgentRequest{Name: uuid.NewString(), Kind: kind})
	if err != nil {
		t.Fatal(err)
	}
	res, err := client.Post(baseURL+"/api/agents", "application/json", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var agent Agent
	if err := json.NewDecoder(res.Body).Decode(&agent); err != nil || res.StatusCode != http.StatusCreated {
		t.Fatalf("create Agent: status = %d, error = %v", res.StatusCode, err)
	}
	return agent
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
