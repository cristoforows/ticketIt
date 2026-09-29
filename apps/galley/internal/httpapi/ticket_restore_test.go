package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestRestore_EveryStatusPreservesFieldsBadgesAndRecomputesActions(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	badge, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/badges", fmt.Sprintf(`{"name":%q}`, uuid.NewString()), http.StatusCreated)
	badgeID := badge.(map[string]any)["id"].(string)
	for _, tc := range []struct {
		status string
		path   []string
		want   string
	}{
		{"Backlog", nil, "Backlog"},
		{"Ready", []string{"Ready"}, "Backlog"},
		{"InProgress", []string{"Ready", "InProgress"}, "InProgress"},
		{"Blocked", []string{"Blocked"}, "Blocked"},
		{"InReview", []string{"Ready", "InProgress", "InReview"}, "InReview"},
		{"Done", []string{"Ready", "InProgress", "InReview"}, "Done"},
	} {
		t.Run(tc.status, func(t *testing.T) {
			created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", fmt.Sprintf(`{"title":%q}`, uuid.NewString()), http.StatusCreated)
			id := created.(map[string]any)["id"].(string)
			path := "/api/tickets/" + id
			badgeRequest(t, handler, cookie, http.MethodPatch, path, `{"goal":"Retained goal"}`, http.StatusOK)
			badgeRequest(t, handler, cookie, http.MethodPut, path+"/badges/"+badgeID, "", http.StatusOK)
			for _, status := range tc.path {
				badgeRequest(t, handler, cookie, http.MethodPost, path+"/status", fmt.Sprintf(`{"status":%q}`, status), http.StatusOK)
			}
			if tc.status == "Done" {
				badgeRequest(t, handler, cookie, http.MethodPost, path+"/accept", "", http.StatusOK)
			}
			badgeRequest(t, handler, cookie, http.MethodPost, path+"/archive", "", http.StatusOK)
			restored, restoreRec, _ := badgeRequest(t, handler, cookie, http.MethodPost, path+"/restore", "", http.StatusOK)
			t.Logf("POST %s/restore -> HTTP %d %s", path, restoreRec.Code, strings.TrimSpace(restoreRec.Body.String()))
			ticket := restored.(map[string]any)
			if ticket["status"] != tc.want || ticket["archivedAt"] != nil || ticket["goal"] != "Retained goal" || len(ticket["badges"].([]any)) != 1 {
				t.Fatalf("restored Ticket lost data: %v", ticket)
			}
			if reason, ok := ticket["allowedActions"].(map[string]any)["accept"].(map[string]any)["reason"].(map[string]any); ok && reason["code"] == archivedTicketCode {
				t.Fatalf("restored Ticket still advertises archive reason: %v", ticket)
			}
			visible, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets?badgeId="+badgeID, "", http.StatusOK)
			found := false
			for _, item := range visible.(map[string]any)["tickets"].([]any) {
				if item.(map[string]any)["id"] == id {
					found = true
				}
			}
			if !found {
				t.Fatal("restored Ticket absent from default list")
			}
			badgeRequest(t, handler, cookie, http.MethodPatch, path, `{"goal":"Editable again"}`, http.StatusOK)
			rejected, rejectedRec, _ := badgeRequest(t, handler, cookie, http.MethodPost, path+"/restore", "", http.StatusBadRequest)
			t.Logf("POST %s/restore -> HTTP %d %s", path, rejectedRec.Code, strings.TrimSpace(rejectedRec.Body.String()))
			if rejected.(map[string]any)["error"].(map[string]any)["code"] != "not_archived" {
				t.Fatalf("second restore = %v", rejected)
			}
		})
	}
}

func TestRestore_ArchivedBadgeFilterIsConjunctiveWithORAndOrdered(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	newBadge := func() string {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/badges", fmt.Sprintf(`{"name":%q}`, uuid.NewString()), http.StatusCreated)
		return result.(map[string]any)["id"].(string)
	}
	a, b := newBadge(), newBadge()
	create := func(badges []string, archive bool) string {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", fmt.Sprintf(`{"title":%q}`, uuid.NewString()), http.StatusCreated)
		id := result.(map[string]any)["id"].(string)
		for _, badge := range badges {
			badgeRequest(t, handler, cookie, http.MethodPut, "/api/tickets/"+id+"/badges/"+badge, "", http.StatusOK)
		}
		if archive {
			badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets/"+id+"/archive", "", http.StatusOK)
		}
		return id
	}
	create([]string{a}, false)
	first := create([]string{a}, true)
	second := create([]string{a, b}, true)
	create(nil, true)
	result, listRec, listReq := badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets?archived=true&badgeId="+a+"&badgeId="+b, "", http.StatusOK)
	t.Logf("GET %s -> HTTP %d %s", listReq.URL, listRec.Code, strings.TrimSpace(listRec.Body.String()))
	ids := []string{}
	for _, item := range result.(map[string]any)["tickets"].([]any) {
		ids = append(ids, item.(map[string]any)["id"].(string))
	}
	if !reflect.DeepEqual(ids, []string{second, first}) {
		t.Fatalf("archived OR filter = %v", ids)
	}
	badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets/"+second+"/restore", "", http.StatusOK)
	result, _, _ = badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets?archived=true&badgeId="+a+"&badgeId="+b, "", http.StatusOK)
	items := result.(map[string]any)["tickets"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != first {
		t.Fatalf("restored Ticket remained in Archived filter: %v", items)
	}
}

func TestRestore_ConcurrentArchiveAndRestoreConsistent(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	for range 5 {
		created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", fmt.Sprintf(`{"title":%q}`, uuid.NewString()), http.StatusCreated)
		id := created.(map[string]any)["id"].(string)
		badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets/"+id+"/status", `{"status":"Ready"}`, http.StatusOK)
		start := make(chan struct{})
		results := make(chan struct {
			command string
			status  int
		}, 2)
		var wg sync.WaitGroup
		for _, command := range []string{"archive", "restore"} {
			wg.Add(1)
			go func(command string) {
				defer wg.Done()
				<-start
				req := httptest.NewRequest(http.MethodPost, "/api/tickets/"+id+"/"+command, nil)
				req.AddCookie(cookie)
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)
				results <- struct {
					command string
					status  int
				}{command, rec.Code}
			}(command)
		}
		close(start)
		wg.Wait()
		close(results)
		outcomes := map[string]int{}
		for outcome := range results {
			outcomes[outcome.command] = outcome.status
		}
		if outcomes["archive"] != http.StatusOK || (outcomes["restore"] != http.StatusOK && outcomes["restore"] != http.StatusBadRequest) {
			t.Fatalf("race outcomes = %v", outcomes)
		}
		body, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets/"+id, "", http.StatusOK)
		ticket := body.(map[string]any)
		if outcomes["restore"] == http.StatusOK && (ticket["status"] != "Backlog" || ticket["archivedAt"] != nil) {
			t.Fatalf("restore succeeded but final Ticket = %v", ticket)
		}
		if outcomes["restore"] == http.StatusBadRequest && (ticket["status"] != "Ready" || ticket["archivedAt"] == nil) {
			t.Fatalf("restore rejected but final Ticket = %v", ticket)
		}
	}
}
