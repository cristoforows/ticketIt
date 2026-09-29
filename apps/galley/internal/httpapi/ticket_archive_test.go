package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/cristoforows/ticketIt/apps/galley/internal/auth"
	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

func TestArchive_RetainsStatusBadgesAndExcludesFilteredCollections(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	badge, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/badges", fmt.Sprintf(`{"name":%q}`, uuid.NewString()), http.StatusCreated)
	badgeID := badge.(map[string]any)["id"].(string)
	for _, tc := range []struct {
		name string
		path []string
		want string
	}{
		{"Backlog", nil, "Backlog"},
		{"Ready", []string{"Ready"}, "Ready"},
		{"InProgress", []string{"Ready", "InProgress"}, "InProgress"},
		{"Blocked", []string{"Blocked"}, "Blocked"},
		{"InReview", []string{"Ready", "InProgress", "InReview"}, "InReview"},
		{"Done", []string{"Ready", "InProgress", "InReview"}, "Done"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", fmt.Sprintf(`{"title":%q}`, uuid.NewString()), http.StatusCreated)
			id := created.(map[string]any)["id"].(string)
			for _, status := range tc.path {
				badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets/"+id+"/status", fmt.Sprintf(`{"status":%q}`, status), http.StatusOK)
			}
			if tc.want == "Done" {
				badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets/"+id+"/accept", "", http.StatusOK)
			}
			badgeRequest(t, handler, cookie, http.MethodPut, "/api/tickets/"+id+"/badges/"+badgeID, "", http.StatusOK)
			archived, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets/"+id+"/archive", "", http.StatusOK)
			ticket := archived.(map[string]any)
			if ticket["status"] != tc.want || ticket["archivedAt"] == nil || len(ticket["badges"].([]any)) != 1 {
				t.Fatalf("archived Ticket lost data: %v", ticket)
			}
			if actions := ticket["allowedActions"].(map[string]any); len(actions["statusChanges"].([]any)) != 0 || actions["accept"].(map[string]any)["reason"].(map[string]any)["code"] != archivedTicketCode {
				t.Fatalf("archived Ticket advertises mutations: %v", actions)
			}
			for _, path := range []string{"/api/tickets", "/api/tickets?badgeId=" + badgeID} {
				list, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, path, "", http.StatusOK)
				for _, item := range list.(map[string]any)["tickets"].([]any) {
					if item.(map[string]any)["id"] == id {
						t.Fatalf("archived Ticket visible in %s", path)
					}
				}
			}
			full, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets/"+id, "", http.StatusOK)
			if full.(map[string]any)["archivedAt"] != ticket["archivedAt"] {
				t.Fatalf("direct read lost archive: %v", full)
			}
		})
	}
}

func TestArchive_AllMutationsRejectWithoutChangingTicket(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", `{"title":"archive guard"}`, http.StatusCreated)
	id := created.(map[string]any)["id"].(string)
	badge, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/badges", fmt.Sprintf(`{"name":%q}`, uuid.NewString()), http.StatusCreated)
	badgeID := badge.(map[string]any)["id"].(string)
	path := "/api/tickets/" + id
	badgePath := path + "/badges/" + badgeID
	badgeRequest(t, handler, cookie, http.MethodPut, badgePath, "", http.StatusOK)
	before, archiveRec, _ := badgeRequest(t, handler, cookie, http.MethodPost, path+"/archive", "", http.StatusOK)
	t.Logf("POST %s/archive -> HTTP %d %s", path, archiveRec.Code, strings.TrimSpace(archiveRec.Body.String()))
	for _, tc := range []struct{ name, method, path, body string }{
		{"edit", http.MethodPatch, path, `{"title":"changed"}`},
		{"status", http.MethodPost, path + "/status", `{"status":"Ready"}`},
		{"accept", http.MethodPost, path + "/accept", ""},
		{"assign", http.MethodPut, path + "/assignee", ""},
		{"unassign", http.MethodDelete, path + "/assignee", ""},
		{"attach", http.MethodPut, badgePath, ""},
		{"detach", http.MethodDelete, badgePath, ""},
		{"archive again", http.MethodPost, path + "/archive", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rejected, rejectedRec, _ := badgeRequest(t, handler, cookie, tc.method, tc.path, tc.body, http.StatusBadRequest)
			t.Logf("%s %s %s -> HTTP %d %s", tc.method, tc.path, tc.body, rejectedRec.Code, strings.TrimSpace(rejectedRec.Body.String()))
			if rejected.(map[string]any)["error"].(map[string]any)["code"] != archivedTicketCode {
				t.Fatalf("unexpected rejection: %v", rejected)
			}
			after, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, path, "", http.StatusOK)
			if fmt.Sprint(after) != fmt.Sprint(before) {
				t.Fatalf("Ticket changed after rejected %s: before=%v after=%v", tc.name, before, after)
			}
		})
	}
}

func TestArchive_OwnerScope(t *testing.T) {
	pool := postgres.NewEmptyMigratedTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment}, time.Now(), pool, testLogger(&bytes.Buffer{}))
	cookie := mintTestSessionCookie(t, pool)
	created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", `{"title":"private"}`, http.StatusCreated)
	id := created.(map[string]any)["id"].(string)
	ctx := context.Background()
	var ownerID int64
	if err := pool.QueryRow(ctx, `INSERT INTO owners (singleton) VALUES (false) RETURNING id`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO owner_identities (owner_id, provider, provider_account_id, login)
		VALUES ($1, 'github', -90093, 'archive-other-owner')`, ownerID); err != nil {
		t.Fatal(err)
	}
	token, _, err := auth.CreateSession(ctx, pool, ownerID, config.DefaultSessionTTL)
	if err != nil {
		t.Fatal(err)
	}
	foreign := &http.Cookie{Name: SessionCookieName, Value: token}
	for _, value := range []string{id, uuid.NewString(), "bad"} {
		result, _, _ := badgeRequest(t, handler, foreign, http.MethodPost, "/api/tickets/"+value+"/archive", "", http.StatusNotFound)
		if result.(map[string]any)["error"].(map[string]any)["code"] != "not_found" {
			t.Fatalf("archive revealed a foreign Ticket: %v", result)
		}
	}
}

func TestArchive_ConcurrentDoubleSubmitOnlyOneSucceeds(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", fmt.Sprintf(`{"title":%q}`, uuid.NewString()), http.StatusCreated)
	path := "/api/tickets/" + created.(map[string]any)["id"].(string) + "/archive"
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, path, nil)
			req.AddCookie(cookie)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			results <- rec.Code
		}()
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for code := range results {
		counts[code]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusBadRequest] != 1 {
		t.Fatalf("concurrent archive responses = %v", counts)
	}
}
