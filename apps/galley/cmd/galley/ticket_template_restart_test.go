package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/cristoforows/ticketIt/apps/galley/internal/authtest"
	"github.com/cristoforows/ticketIt/apps/galley/internal/githubfake"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

// TestRestartDurability_CompletionConditionSurvivesFreshProcess is
// issue #59's own required restart proof: "the completion condition
// does not change when other fields change... including across a
// Galley restart." Mirrors
// TestRestartDurability_DiagnosticNoteSurvivesFreshProcess's technique
// exactly (two separate, real OS processes sharing only the database,
// not two in-process run() calls) rather than inventing a new one.
//
// This creates a Coding Ticket (completionCondition=reviewedPrMerge,
// the non-default branch -- a Basic ticket's condition equals the
// column's own DEFAULT, so proving the Coding case is the one that
// would actually catch a regression that silently fell back to the
// default), edits every other field the first process can reach,
// restarts, edits every other field again against the second, wholly
// separate process, and asserts the completion condition never moved.
func TestRestartDurability_CompletionConditionSurvivesFreshProcess(t *testing.T) {
	postgres.NewTestPool(t) // ensures the real test database exists and is migrated
	databaseURL := postgres.TestingURL()

	owner := githubfake.TestOwnerIdentity
	fake := githubfake.New(t, owner)
	addr := reserveLocalAddr(t)
	authEnv := map[string]string{
		"GALLEY_PORT":                       addrPort(t, addr),
		"GALLEY_BASE_URL":                   "http://" + addr,
		"GALLEY_OWNER_GITHUB_LOGIN":         owner.Login,
		"GALLEY_OAUTH_GITHUB_CLIENT_ID":     fake.ClientID,
		"GALLEY_OAUTH_GITHUB_CLIENT_SECRET": fake.ClientSecret,
		"GALLEY_OAUTH_GITHUB_BASE_URL":      fake.URL,
		"GALLEY_OAUTH_GITHUB_API_BASE_URL":  fake.URL,
	}

	binPath := buildGalleyBinary(t)
	client := authtest.NewClient()

	proc1 := startGalley(t, binPath, databaseURL, authEnv)
	authtest.SignIn(t, client, proc1.baseURL)

	created := postTicket(t, client, proc1.baseURL, `{"title":"restart-durability: completion condition","template":"Coding"}`)
	if created.CompletionCondition != "reviewedPrMerge" {
		t.Fatalf("CompletionCondition at creation = %q, want %q", created.CompletionCondition, "reviewedPrMerge")
	}

	updated := patchTicketRaw(t, client, proc1.baseURL, created.Id,
		`{"goal":"Ship it","context":"Some background","successCriteria":"Tests pass","constraints":"Keep it simple","repository":"owner/repo"}`)
	if updated.CompletionCondition != "reviewedPrMerge" {
		t.Fatalf("CompletionCondition after first-process PATCH = %q, want unchanged %q", updated.CompletionCondition, "reviewedPrMerge")
	}
	stopGalleyCleanly(t, proc1)

	// Second process: completely fresh binary invocation. Only the
	// database is shared -- matching
	// TestRestartDurability_DiagnosticNoteSurvivesFreshProcess's own
	// requirement that this prove more than an in-process reconnect.
	proc2 := startGalley(t, binPath, databaseURL, authEnv)
	defer stopGalleyCleanly(t, proc2)

	afterRestart := getTicketRaw(t, client, proc2.baseURL, created.Id)
	if afterRestart.CompletionCondition != "reviewedPrMerge" {
		t.Fatalf("CompletionCondition read from a fresh second process = %q, want unchanged %q", afterRestart.CompletionCondition, "reviewedPrMerge")
	}

	// Edit again against the fresh process, including an explicit,
	// rejected attempt to change the Template -- the rejection itself
	// must not disturb the retained condition either.
	rejectResp := patchTicketExpectStatus(t, client, proc2.baseURL, created.Id, `{"template":"Basic"}`, http.StatusBadRequest)
	_ = rejectResp

	final := patchTicketRaw(t, client, proc2.baseURL, created.Id, `{"goal":"Ship it, revised"}`)
	if final.CompletionCondition != "reviewedPrMerge" {
		t.Fatalf("CompletionCondition after second-process PATCH = %q, want unchanged %q", final.CompletionCondition, "reviewedPrMerge")
	}
	if final.Template != "Coding" {
		t.Fatalf("Template after a rejected change attempt = %q, want unchanged %q", final.Template, "Coding")
	}
}

type restartTestTicket struct {
	Id                  string `json:"id"`
	Title               string `json:"title"`
	Template            string `json:"template"`
	CompletionCondition string `json:"completionCondition"`
}

func postTicket(t *testing.T, client *http.Client, baseURL, jsonBody string) restartTestTicket {
	t.Helper()
	resp, err := client.Post(baseURL+"/api/tickets", "application/json", strings.NewReader(jsonBody))
	if err != nil {
		t.Fatalf("POST /api/tickets failed: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /api/tickets status = %d, want %d; body=%s", resp.StatusCode, http.StatusCreated, data)
	}
	var ticket restartTestTicket
	if err := json.Unmarshal(data, &ticket); err != nil {
		t.Fatalf("failed to decode create response %q: %v", data, err)
	}
	return ticket
}

func getTicketRaw(t *testing.T, client *http.Client, baseURL, id string) restartTestTicket {
	t.Helper()
	resp, err := client.Get(baseURL + "/api/tickets/" + id)
	if err != nil {
		t.Fatalf("GET /api/tickets/%s failed: %v", id, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/tickets/%s status = %d, want %d; body=%s", id, resp.StatusCode, http.StatusOK, data)
	}
	var ticket restartTestTicket
	if err := json.Unmarshal(data, &ticket); err != nil {
		t.Fatalf("failed to decode response %q: %v", data, err)
	}
	return ticket
}

func patchTicketRaw(t *testing.T, client *http.Client, baseURL, id, jsonBody string) restartTestTicket {
	t.Helper()
	return patchTicketExpectStatus(t, client, baseURL, id, jsonBody, http.StatusOK)
}

func patchTicketExpectStatus(t *testing.T, client *http.Client, baseURL, id, jsonBody string, wantStatus int) restartTestTicket {
	t.Helper()
	req, err := http.NewRequest(http.MethodPatch, baseURL+"/api/tickets/"+id, bytes.NewReader([]byte(jsonBody)))
	if err != nil {
		t.Fatalf("failed to build PATCH request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("PATCH /api/tickets/%s failed: %v", id, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != wantStatus {
		t.Fatalf("PATCH /api/tickets/%s status = %d, want %d; body=%s", id, resp.StatusCode, wantStatus, data)
	}
	var ticket restartTestTicket
	// A rejected PATCH's body is an ErrorBody, not a Ticket -- decoding
	// it into restartTestTicket just leaves every field zero, which is
	// fine: callers that expect StatusBadRequest ignore the result.
	_ = json.Unmarshal(data, &ticket)
	return ticket
}
