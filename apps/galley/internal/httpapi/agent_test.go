package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/auth"
	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

func decodeAs[T any](t *testing.T, body any) T {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	var out T
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func errorCode(body any) any {
	return body.(map[string]any)["error"].(map[string]any)["code"]
}

func createAgentForTest(t *testing.T, handler http.Handler, cookie *http.Cookie, name string, kind AgentKind) Agent {
	t.Helper()
	body, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/agents", fmt.Sprintf(`{"name":%q,"kind":%q}`, name, kind), http.StatusCreated)
	return decodeAs[Agent](t, body)
}

func assignAgentBody(agentID string) string {
	return fmt.Sprintf(`{"type":"agent","agentId":%q}`, agentID)
}

func listAgentsForTest(t *testing.T, handler http.Handler, cookie *http.Cookie) []Agent {
	t.Helper()
	body, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, "/api/agents", "", http.StatusOK)
	return decodeAs[AgentList](t, body).Agents
}

func findAgent(agents []Agent, id string) (Agent, bool) {
	for _, agent := range agents {
		if agent.Id == id {
			return agent, true
		}
	}
	return Agent{}, false
}

func TestCreateAgent_ValidatesNameAndKind(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	for _, body := range []string{
		``,
		`{}`,
		`{"kind":"coding"}`,
		`{"name":"","kind":"coding"}`,
		`{"name":"   ","kind":"coding"}`,
		`{"name":null,"kind":"coding"}`,
		fmt.Sprintf(`{"name":%q,"kind":"coding"}`, strings.Repeat("界", 45)+uuid.NewString()),
		fmt.Sprintf(`{"name":%q}`, uuid.NewString()),
		fmt.Sprintf(`{"name":%q,"kind":""}`, uuid.NewString()),
		fmt.Sprintf(`{"name":%q,"kind":"Coding"}`, uuid.NewString()),
		fmt.Sprintf(`{"name":%q,"kind":"design"}`, uuid.NewString()),
		fmt.Sprintf(`{"name":%q,"kind":"coding","model":"x"}`, uuid.NewString()),
	} {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/agents", body, http.StatusBadRequest)
		if errorCode(result) != "invalid_request" {
			t.Fatalf("body %s: %v", body, result)
		}
	}

	name := uuid.NewString()
	created := createAgentForTest(t, handler, cookie, "  "+name+"\t", AgentKindResearch)
	if created.Name != name || created.Kind != AgentKindResearch || created.CreatedAt == "" {
		t.Fatalf("created = %+v", created)
	}
	if _, err := uuid.Parse(created.Id); err != nil {
		t.Fatalf("id %q is not a UUID: %v", created.Id, err)
	}
	maxName := strings.Repeat("界", 44) + uuid.NewString()
	if got := createAgentForTest(t, handler, cookie, "  "+maxName+"  ", AgentKindCoding); got.Name != maxName || got.Kind != AgentKindCoding {
		t.Fatalf("80-character name = %+v", got)
	}
}

func TestCreateAgent_DuplicateNameIgnoringCaseIsRejected(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	name := "Agent " + uuid.NewString()
	createAgentForTest(t, handler, cookie, name, AgentKindCoding)
	for _, candidate := range []string{name, strings.ToUpper(name), strings.ToLower(name), " " + name + " "} {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/agents", fmt.Sprintf(`{"name":%q,"kind":"research"}`, candidate), http.StatusConflict)
		if errorCode(result) != "duplicate_agent_name" {
			t.Fatalf("duplicate %q: %v", candidate, result)
		}
	}
	matches := 0
	for _, agent := range listAgentsForTest(t, handler, cookie) {
		if strings.EqualFold(agent.Name, name) {
			matches++
		}
	}
	if matches != 1 {
		t.Fatalf("name %q listed %d times", name, matches)
	}
}

func TestCreateAgent_ConcurrentDuplicateNamesYieldOneAgent(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	for trial := range 5 {
		name := uuid.NewString()
		codes := raceRequests(handler, cookie, []request{
			{http.MethodPost, "/api/agents", fmt.Sprintf(`{"name":%q,"kind":"coding"}`, name)},
			{http.MethodPost, "/api/agents", fmt.Sprintf(`{"name":%q,"kind":"research"}`, strings.ToUpper(name))},
		})
		if codes[http.StatusCreated] != 1 || codes[http.StatusConflict] != 1 {
			t.Fatalf("trial %d: statuses = %v, want one 201 and one 409", trial, codes)
		}
	}
}

type request struct{ method, path, body string }

func raceRequests(handler http.Handler, cookie *http.Cookie, requests []request) map[int]int {
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make(chan int, len(requests))
	for _, r := range requests {
		wg.Add(1)
		go func(r request) {
			defer wg.Done()
			req := httptest.NewRequest(r.method, r.path, strings.NewReader(r.body))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(cookie)
			rec := httptest.NewRecorder()
			<-start
			handler.ServeHTTP(rec, req)
			results <- rec.Code
		}(r)
	}
	close(start)
	wg.Wait()
	close(results)
	codes := map[int]int{}
	for code := range results {
		codes[code]++
	}
	return codes
}

func TestListAgents_OrderedCaseInsensitively(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	suffix := uuid.NewString()
	z := createAgentForTest(t, handler, cookie, "z-"+suffix, AgentKindCoding)
	upperB := createAgentForTest(t, handler, cookie, "B-"+suffix, AgentKindResearch)
	a := createAgentForTest(t, handler, cookie, "a-"+suffix, AgentKindCoding)
	positions := map[string]int{}
	for index, agent := range listAgentsForTest(t, handler, cookie) {
		positions[agent.Id] = index
	}
	if !(positions[a.Id] < positions[upperB.Id] && positions[upperB.Id] < positions[z.Id]) {
		t.Fatalf("positions a=%d B=%d z=%d, want case-insensitive ascending", positions[a.Id], positions[upperB.Id], positions[z.Id])
	}
	if result, _, _ := badgeRequest(t, handler, nil, http.MethodGet, "/api/agents", "", http.StatusUnauthorized); errorCode(result) != "unauthenticated" {
		t.Fatalf("unauthenticated list: %v", result)
	}
	if result, _, _ := badgeRequest(t, handler, nil, http.MethodPost, "/api/agents", `{"name":"x","kind":"coding"}`, http.StatusUnauthorized); errorCode(result) != "unauthenticated" {
		t.Fatalf("unauthenticated create: %v", result)
	}
	if result, _, _ := badgeRequest(t, handler, nil, http.MethodPatch, "/api/agents/"+a.Id, `{"name":"x"}`, http.StatusUnauthorized); errorCode(result) != "unauthenticated" {
		t.Fatalf("unauthenticated rename: %v", result)
	}
}

func TestRenameAgent_ValidatesNameAndKeepsKind(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	agent := createAgentForTest(t, handler, cookie, uuid.NewString(), AgentKindResearch)
	path := "/api/agents/" + agent.Id
	for _, body := range []string{
		``,
		`{}`,
		`{"name":""}`,
		`{"name":"   "}`,
		`{"name":null}`,
		fmt.Sprintf(`{"name":%q}`, strings.Repeat("界", 45)+uuid.NewString()),
		`{"kind":"coding"}`,
		fmt.Sprintf(`{"name":%q,"kind":"coding"}`, uuid.NewString()),
		fmt.Sprintf(`{"name":%q,"kind":"research"}`, uuid.NewString()),
	} {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPatch, path, body, http.StatusBadRequest)
		if errorCode(result) != "invalid_request" {
			t.Fatalf("body %s: %v", body, result)
		}
	}
	if listed, _ := findAgent(listAgentsForTest(t, handler, cookie), agent.Id); listed != agent {
		t.Fatalf("rejected renames changed the Agent: %+v, want %+v", listed, agent)
	}

	maxName := strings.Repeat("界", 44) + uuid.NewString()
	result, _, _ := badgeRequest(t, handler, cookie, http.MethodPatch, path, fmt.Sprintf(`{"name":%q}`, " "+maxName+" "), http.StatusOK)
	renamed := decodeAs[Agent](t, result)
	if renamed.Name != maxName || renamed.Id != agent.Id || renamed.Kind != AgentKindResearch || renamed.CreatedAt != agent.CreatedAt {
		t.Fatalf("renamed = %+v", renamed)
	}
	result, _, _ = badgeRequest(t, handler, cookie, http.MethodPatch, path, fmt.Sprintf(`{"name":%q}`, strings.ToUpper(maxName)), http.StatusOK)
	if got := decodeAs[Agent](t, result); got.Name != strings.ToUpper(maxName) {
		t.Fatalf("own name in a different case = %+v", got)
	}
	if listed, _ := findAgent(listAgentsForTest(t, handler, cookie), agent.Id); listed.Name != strings.ToUpper(maxName) || listed.Kind != AgentKindResearch {
		t.Fatalf("listed after rename = %+v", listed)
	}
}

func TestRenameAgent_DuplicateNameIgnoringCaseIsRejected(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	taken := createAgentForTest(t, handler, cookie, "Taken "+uuid.NewString(), AgentKindCoding)
	agent := createAgentForTest(t, handler, cookie, uuid.NewString(), AgentKindCoding)
	for _, candidate := range []string{taken.Name, strings.ToLower(taken.Name), strings.ToUpper(taken.Name)} {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPatch, "/api/agents/"+agent.Id, fmt.Sprintf(`{"name":%q}`, candidate), http.StatusConflict)
		if errorCode(result) != "duplicate_agent_name" {
			t.Fatalf("rename to %q: %v", candidate, result)
		}
	}
	if listed, _ := findAgent(listAgentsForTest(t, handler, cookie), agent.Id); listed != agent {
		t.Fatalf("rejected rename changed the Agent: %+v", listed)
	}
}

func TestRenameAgent_ConcurrentRenamesToOneNameYieldOneWinner(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	for trial := range 5 {
		first := createAgentForTest(t, handler, cookie, uuid.NewString(), AgentKindCoding)
		second := createAgentForTest(t, handler, cookie, uuid.NewString(), AgentKindResearch)
		name := uuid.NewString()
		codes := raceRequests(handler, cookie, []request{
			{http.MethodPatch, "/api/agents/" + first.Id, fmt.Sprintf(`{"name":%q}`, name)},
			{http.MethodPatch, "/api/agents/" + second.Id, fmt.Sprintf(`{"name":%q}`, strings.ToUpper(name))},
		})
		if codes[http.StatusOK] != 1 || codes[http.StatusConflict] != 1 {
			t.Fatalf("trial %d: statuses = %v, want one 200 and one 409", trial, codes)
		}
	}
}

func TestRenameAgent_UnknownAndMalformedIdentifiers404(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	for _, id := range []string{uuid.NewString(), "not-a-uuid", "00000000-0000-0000-0000-000000000000"} {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPatch, "/api/agents/"+id, `{"name":"anything"}`, http.StatusNotFound)
		if errorCode(result) != "not_found" {
			t.Fatalf("rename %s: %v", id, result)
		}
	}
}

func ticketWithoutAssignee(ticket Ticket) Ticket {
	ticket.AssigneeType = ""
	ticket.AssigneeAgent = nil
	ticket.AllowedActions = TicketAllowedActions{}
	ticket.RequestingAgentWork = false
	ticket.UpdatedAt = ""
	return ticket
}

func TestAssignTicket_AgentOnBothTemplatesAndReassignmentKeepsTheRest(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	research := createAgentForTest(t, handler, cookie, "Research "+uuid.NewString(), AgentKindResearch)
	coding := createAgentForTest(t, handler, cookie, "Coding "+uuid.NewString(), AgentKindCoding)
	badge, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/badges", fmt.Sprintf(`{"name":%q}`, uuid.NewString()), http.StatusCreated)
	for _, template := range []TicketTemplate{Basic, Coding} {
		t.Run(string(template), func(t *testing.T) {
			created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets",
				fmt.Sprintf(`{"title":%q,"template":%q,"goal":"g","successCriteria":"s","repository":"r"}`, uuid.NewString(), template), http.StatusCreated)
			path := "/api/tickets/" + decodeAs[Ticket](t, created).Id
			badgeRequest(t, handler, cookie, http.MethodPut, path+"/badges/"+badge.(map[string]any)["id"].(string), "", http.StatusOK)
			badgeRequest(t, handler, cookie, http.MethodPost, path+"/status", `{"status":"Ready"}`, http.StatusOK)
			before, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, path, "", http.StatusOK)
			baseline := ticketWithoutAssignee(decodeAs[Ticket](t, before))

			for _, step := range []struct {
				name  string
				body  string
				agent *Agent
			}{
				{"research Agent", assignAgentBody(research.Id), &research},
				{"coding Agent", assignAgentBody(coding.Id), &coding},
				{"same Agent again", assignAgentBody(coding.Id), &coding},
				{"Owner", `{"type":"owner"}`, nil},
				{"back to an Agent", assignAgentBody(research.Id), &research},
			} {
				result, _, _ := badgeRequest(t, handler, cookie, http.MethodPut, path+"/assignee", step.body, http.StatusOK)
				for _, ticket := range []Ticket{decodeAs[Ticket](t, result), getTicketFromList(t, handler, cookie, path)} {
					wantType, wantAgent := TicketAssigneeTypeOwner, (*TicketAssigneeAgent)(nil)
					if step.agent != nil {
						wantType = TicketAssigneeTypeAgent
						wantAgent = &TicketAssigneeAgent{Id: step.agent.Id, Name: step.agent.Name, Kind: step.agent.Kind}
					}
					if ticket.AssigneeType != wantType || fmt.Sprint(ticket.AssigneeAgent) != fmt.Sprint(wantAgent) {
						t.Fatalf("%s: assignee = %q %+v, want %q %+v", step.name, ticket.AssigneeType, ticket.AssigneeAgent, wantType, wantAgent)
					}
					if got := ticketWithoutAssignee(ticket); !reflect.DeepEqual(got, baseline) {
						t.Fatalf("%s changed more than the Assignee:\n got %+v\nwant %+v", step.name, got, baseline)
					}
				}
			}
			result, _, _ := badgeRequest(t, handler, cookie, http.MethodDelete, path+"/assignee", "", http.StatusOK)
			if ticket := decodeAs[Ticket](t, result); ticket.AssigneeType != "" || ticket.AssigneeAgent != nil {
				t.Fatalf("unassigned = %q %+v", ticket.AssigneeType, ticket.AssigneeAgent)
			}
		})
	}
}

func getTicketFromList(t *testing.T, handler http.Handler, cookie *http.Cookie, path string) Ticket {
	t.Helper()
	id := strings.TrimPrefix(path, "/api/tickets/")
	body, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets", "", http.StatusOK)
	for _, ticket := range decodeAs[TicketList](t, body).Tickets {
		if ticket.Id == id {
			return ticket
		}
	}
	t.Fatalf("Ticket %s missing from the list", id)
	return Ticket{}
}

func TestAssignTicket_AgentAllowedInEveryStatus(t *testing.T) {
	handler, pool, cookie := badgeTestHandler(t)
	ownerID := resolveTestOwner(t, pool)
	agent := createAgentForTest(t, handler, cookie, uuid.NewString(), AgentKindResearch)
	for _, status := range allTicketStatuses {
		t.Run(string(status), func(t *testing.T) {
			created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", fmt.Sprintf(`{"title":%q,"goal":"g","successCriteria":"s"}`, uuid.NewString()), http.StatusCreated)
			id := decodeAs[Ticket](t, created).Id
			setTicketStatusDirect(t, pool, ownerID, id, status)
			result, _, _ := badgeRequest(t, handler, cookie, http.MethodPut, "/api/tickets/"+id+"/assignee", assignAgentBody(agent.Id), http.StatusOK)
			ticket := decodeAs[Ticket](t, result)
			if ticket.Status != status || ticket.AssigneeType != TicketAssigneeTypeAgent || ticket.AssigneeAgent == nil || ticket.AssigneeAgent.Id != agent.Id {
				t.Fatalf("assigned = %s %q %+v", ticket.Status, ticket.AssigneeType, ticket.AssigneeAgent)
			}
		})
	}
}

func TestAssignTicket_RejectsInvalidBodiesAndUnknownAgentsWithoutChange(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	agent := createAgentForTest(t, handler, cookie, uuid.NewString(), AgentKindCoding)
	created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", fmt.Sprintf(`{"title":%q}`, uuid.NewString()), http.StatusCreated)
	path := "/api/tickets/" + decodeAs[Ticket](t, created).Id
	badgeRequest(t, handler, cookie, http.MethodPut, path+"/assignee", `{"type":"owner"}`, http.StatusOK)
	before, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, path, "", http.StatusOK)
	for _, tc := range []struct {
		body string
		want int
		code string
	}{
		{``, http.StatusBadRequest, "invalid_request"},
		{`{}`, http.StatusBadRequest, "invalid_request"},
		{`{"type":""}`, http.StatusBadRequest, "invalid_request"},
		{`{"type":"Owner"}`, http.StatusBadRequest, "invalid_request"},
		{`{"type":"robot"}`, http.StatusBadRequest, "invalid_request"},
		{`{"type":null}`, http.StatusBadRequest, "invalid_request"},
		{`{"type":"agent"}`, http.StatusBadRequest, "invalid_request"},
		{`{"type":"agent","agentId":null}`, http.StatusBadRequest, "invalid_request"},
		{fmt.Sprintf(`{"type":"owner","agentId":%q}`, agent.Id), http.StatusBadRequest, "invalid_request"},
		{fmt.Sprintf(`{"type":"agent","agentId":%q,"name":"x"}`, agent.Id), http.StatusBadRequest, "invalid_request"},
		{`{"type":"agent","agentId":"not-a-uuid"}`, http.StatusNotFound, "not_found"},
		{`{"type":"agent","agentId":""}`, http.StatusNotFound, "not_found"},
		{assignAgentBody(uuid.NewString()), http.StatusNotFound, "not_found"},
	} {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPut, path+"/assignee", tc.body, tc.want)
		if errorCode(result) != tc.code {
			t.Fatalf("body %s: %v, want %s", tc.body, result, tc.code)
		}
		after, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, path, "", http.StatusOK)
		if fmt.Sprint(after) != fmt.Sprint(before) {
			t.Fatalf("rejected body %s changed the Ticket: before=%v after=%v", tc.body, before, after)
		}
	}
	for _, id := range []string{uuid.NewString(), "not-a-uuid"} {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPut, "/api/tickets/"+id+"/assignee", assignAgentBody(agent.Id), http.StatusNotFound)
		if errorCode(result) != "not_found" {
			t.Fatalf("unknown Ticket %s: %v", id, result)
		}
	}
}

func TestTicketResponses_CarryAssigneeAgentAndReflectRename(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	agent := createAgentForTest(t, handler, cookie, uuid.NewString(), AgentKindCoding)
	created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", fmt.Sprintf(`{"title":%q}`, uuid.NewString()), http.StatusCreated)
	if created.(map[string]any)["assigneeAgent"] != nil {
		t.Fatalf("new Ticket assigneeAgent = %v, want null", created.(map[string]any)["assigneeAgent"])
	}
	if _, present := created.(map[string]any)["assigneeAgent"]; !present {
		t.Fatal("new Ticket omits assigneeAgent")
	}
	path := "/api/tickets/" + created.(map[string]any)["id"].(string)
	badgeRequest(t, handler, cookie, http.MethodPut, path+"/assignee", assignAgentBody(agent.Id), http.StatusOK)
	renamed := "Renamed " + uuid.NewString()
	badgeRequest(t, handler, cookie, http.MethodPatch, "/api/agents/"+agent.Id, fmt.Sprintf(`{"name":%q}`, renamed), http.StatusOK)
	want := fmt.Sprint(map[string]any{"id": agent.Id, "name": renamed, "kind": "coding"})
	got, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, path, "", http.StatusOK)
	if fmt.Sprint(got.(map[string]any)["assigneeAgent"]) != want || got.(map[string]any)["assigneeType"] != "agent" {
		t.Fatalf("GET assignee = %v %v, want agent %s", got.(map[string]any)["assigneeType"], got.(map[string]any)["assigneeAgent"], want)
	}
	if listed := getTicketFromList(t, handler, cookie, path); listed.AssigneeAgent == nil || listed.AssigneeAgent.Name != renamed {
		t.Fatalf("list assigneeAgent = %+v", listed.AssigneeAgent)
	}
	edited, _, _ := badgeRequest(t, handler, cookie, http.MethodPatch, path, `{"goal":"still assigned","successCriteria":"s","repository":"r"}`, http.StatusOK)
	if fmt.Sprint(edited.(map[string]any)["assigneeAgent"]) != want {
		t.Fatalf("PATCH response assigneeAgent = %v", edited.(map[string]any)["assigneeAgent"])
	}
	moved, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, path+"/status", `{"status":"Ready"}`, http.StatusOK)
	if fmt.Sprint(moved.(map[string]any)["assigneeAgent"]) != want {
		t.Fatalf("status response assigneeAgent = %v", moved.(map[string]any)["assigneeAgent"])
	}
	archived, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, path+"/archive", "", http.StatusOK)
	if fmt.Sprint(archived.(map[string]any)["assigneeAgent"]) != want {
		t.Fatalf("archive response assigneeAgent = %v", archived.(map[string]any)["assigneeAgent"])
	}
}

func TestAgentAssigneeConstraints_RejectInconsistentRows(t *testing.T) {
	pool := postgres.NewEmptyMigratedTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment}, time.Now(), pool, testLogger(&bytes.Buffer{}))
	cookie := mintTestSessionCookie(t, pool)
	foreignCookie, _ := secondOwnerSession(t, pool)
	agent := createAgentForTest(t, handler, cookie, "Mine", AgentKindCoding)
	foreign := createAgentForTest(t, handler, foreignCookie, "Theirs", AgentKindCoding)
	created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", `{"title":"constraints"}`, http.StatusCreated)
	id := created.(map[string]any)["id"].(string)
	ctx := context.Background()
	for _, tc := range []struct {
		name, assigneeType, agent, constraint string
	}{
		{"agent without id", "agent", "", "tickets_assignee_agent_iff_agent_type"},
		{"owner with id", "owner", agent.Id, "tickets_assignee_agent_iff_agent_type"},
		{"unassigned with id", "", agent.Id, "tickets_assignee_agent_iff_agent_type"},
		{"foreign Agent", "agent", foreign.Id, "tickets_assignee_agent_fk"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE tickets SET assignee_type = NULLIF($2, ''),
				assignee_agent_id = (SELECT id FROM agents WHERE public_id::text = NULLIF($3, ''))
				WHERE public_id = $1::uuid`, id, tc.assigneeType, tc.agent)
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.ConstraintName != tc.constraint {
				t.Fatalf("error = %v, want violation of %s", err, tc.constraint)
			}
		})
	}
	_, err := pool.Exec(ctx, `INSERT INTO agents (owner_id, public_id, name, kind)
		SELECT owner_id, $2::uuid, 'MINE', 'coding' FROM agents WHERE public_id = $1::uuid`, agent.Id, uuid.NewString())
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.ConstraintName != "agents_owner_name_ci_unique" {
		t.Fatalf("case-variant duplicate insert error = %v, want agents_owner_name_ci_unique", err)
	}
}

func secondOwnerSession(t *testing.T, pool *pgxpool.Pool) (*http.Cookie, int64) {
	t.Helper()
	ctx := context.Background()
	var ownerID int64
	if err := pool.QueryRow(ctx, `INSERT INTO owners (singleton) VALUES (false) RETURNING id`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO owner_identities (owner_id, provider, provider_account_id, login)
		VALUES ($1, 'github', -99912, 'second-agent-test-owner')`, ownerID); err != nil {
		t.Fatal(err)
	}
	token, _, err := auth.CreateSession(ctx, pool, ownerID, config.DefaultSessionTTL)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: SessionCookieName, Value: token}, ownerID
}

func TestAgents_OwnersAreIsolatedThroughHTTP(t *testing.T) {
	pool := postgres.NewEmptyMigratedTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment}, time.Now(), pool, testLogger(&bytes.Buffer{}))
	firstCookie := mintTestSessionCookie(t, pool)
	secondCookie, _ := secondOwnerSession(t, pool)
	first := createAgentForTest(t, handler, firstCookie, "Evidence Agent", AgentKindCoding)
	second := createAgentForTest(t, handler, secondCookie, "EVIDENCE AGENT", AgentKindResearch)
	firstTicket, _, _ := badgeRequest(t, handler, firstCookie, http.MethodPost, "/api/tickets", `{"title":"first Owner ticket"}`, http.StatusCreated)
	secondTicket, _, _ := badgeRequest(t, handler, secondCookie, http.MethodPost, "/api/tickets", `{"title":"second Owner ticket"}`, http.StatusCreated)
	for _, tc := range []struct {
		cookie                  *http.Cookie
		own, foreign            Agent
		ticketID, foreignTicket string
	}{
		{firstCookie, first, second, firstTicket.(map[string]any)["id"].(string), secondTicket.(map[string]any)["id"].(string)},
		{secondCookie, second, first, secondTicket.(map[string]any)["id"].(string), firstTicket.(map[string]any)["id"].(string)},
	} {
		if agents := listAgentsForTest(t, handler, tc.cookie); len(agents) != 1 || agents[0] != tc.own {
			t.Fatalf("Owner sees %+v, want only %+v", agents, tc.own)
		}
		result, rec, _ := badgeRequest(t, handler, tc.cookie, http.MethodPatch, "/api/agents/"+tc.foreign.Id, `{"name":"stolen"}`, http.StatusNotFound)
		t.Logf("PATCH /api/agents/%s (foreign) -> HTTP %d %s", tc.foreign.Id, rec.Code, strings.TrimSpace(rec.Body.String()))
		if errorCode(result) != "not_found" {
			t.Fatalf("foreign rename: %v", result)
		}
		ticketPath := "/api/tickets/" + tc.ticketID
		before, _, _ := badgeRequest(t, handler, tc.cookie, http.MethodGet, ticketPath, "", http.StatusOK)
		result, rec, _ = badgeRequest(t, handler, tc.cookie, http.MethodPut, ticketPath+"/assignee", assignAgentBody(tc.foreign.Id), http.StatusNotFound)
		t.Logf("PUT %s/assignee with a foreign Agent -> HTTP %d %s", ticketPath, rec.Code, strings.TrimSpace(rec.Body.String()))
		if errorCode(result) != "not_found" {
			t.Fatalf("foreign assignment: %v", result)
		}
		after, _, _ := badgeRequest(t, handler, tc.cookie, http.MethodGet, ticketPath, "", http.StatusOK)
		if fmt.Sprint(after) != fmt.Sprint(before) {
			t.Fatalf("foreign assignment changed the Ticket: %v", after)
		}
		badgeRequest(t, handler, tc.cookie, http.MethodPut, "/api/tickets/"+tc.foreignTicket+"/assignee", assignAgentBody(tc.own.Id), http.StatusNotFound)
		assigned, _, _ := badgeRequest(t, handler, tc.cookie, http.MethodPut, ticketPath+"/assignee", assignAgentBody(tc.own.Id), http.StatusOK)
		if got := decodeAs[Ticket](t, assigned).AssigneeAgent; got == nil || got.Id != tc.own.Id || got.Name != tc.own.Name {
			t.Fatalf("own assignment = %+v", got)
		}
	}
	for _, tc := range []struct {
		cookie *http.Cookie
		agent  Agent
	}{{firstCookie, first}, {secondCookie, second}} {
		if agents := listAgentsForTest(t, handler, tc.cookie); len(agents) != 1 || agents[0] != tc.agent {
			t.Fatalf("foreign rename attempt changed Agents: %+v", agents)
		}
	}
	var ownerID int64
	if err := pool.QueryRow(context.Background(), `SELECT owner_id FROM agents WHERE public_id = $1::uuid`, first.Id).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	bogus := ownerID + 1_000_000
	if agents, err := listAgentsForOwner(context.Background(), pool, bogus); err != nil || len(agents) != 0 {
		t.Fatalf("bogus Owner Agents = %v, %v", agents, err)
	}
	if _, found, err := renameAgentForOwner(context.Background(), pool, bogus, first.Id, "x"); err != nil || found {
		t.Fatalf("bogus Owner rename found=%t err=%v", found, err)
	}
}
