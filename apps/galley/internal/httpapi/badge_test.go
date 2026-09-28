package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

func badgeTestHandler(t *testing.T) (http.Handler, *pgxpool.Pool, *http.Cookie) {
	t.Helper()
	pool := postgres.NewTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment}, time.Now(), pool, testLogger(&bytes.Buffer{}))
	return handler, pool, mintTestSessionCookie(t, pool)
}

func badgeRequest(t *testing.T, handler http.Handler, cookie *http.Cookie, method, path, body string, want int) (any, *httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != want {
		t.Fatalf("%s %s: status=%d, want %d; body=%s", method, path, rec.Code, want, rec.Body.String())
	}
	var result any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result, rec, req
}

func TestBadges_ValidationOrderingAndConcurrentUniqueness(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	root := "/api/badges"
	for _, body := range []string{`{}`, `{"name":"   "}`, `{"name":"` + strings.Repeat("界", 81) + `"}`, `{"name":null}`, `{"name":"ok","other":true}`} {
		response, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, root, body, http.StatusBadRequest)
		if response.(map[string]any)["error"].(map[string]any)["code"] != "invalid_request" {
			t.Fatalf("invalid body %s: %v", body, response)
		}
	}
	name := uuid.NewString()
	created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, root, fmt.Sprintf(`{"name":"  %s  "}`, name), http.StatusCreated)
	badge := created.(map[string]any)
	if badge["name"] != name || badge["createdAt"] == "" {
		t.Fatalf("created badge = %v", badge)
	}
	if _, err := uuid.Parse(badge["id"].(string)); err != nil {
		t.Fatal(err)
	}
	maxName := strings.Repeat("界", 44) + uuid.NewString()
	maxBadge, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, root, fmt.Sprintf(`{"name":%q}`, maxName), http.StatusCreated)
	if maxBadge.(map[string]any)["name"] != maxName {
		t.Fatalf("80-character Unicode name changed: %v", maxBadge)
	}
	duplicate, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, root, fmt.Sprintf(`{"name":"%s"}`, strings.ToUpper(name)), http.StatusConflict)
	if duplicate.(map[string]any)["error"].(map[string]any)["code"] != "duplicate_badge_name" {
		t.Fatalf("duplicate = %v", duplicate)
	}
	list, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, root, "", http.StatusOK)
	var matches int
	for _, item := range list.(map[string]any)["badges"].([]any) {
		if strings.EqualFold(item.(map[string]any)["name"].(string), name) {
			matches++
		}
	}
	if matches != 1 {
		t.Fatalf("name %q appears %d times", name, matches)
	}
	first := "a-" + uuid.NewString()
	last := "z-" + uuid.NewString()
	badgeRequest(t, handler, cookie, http.MethodPost, root, fmt.Sprintf(`{"name":%q}`, strings.ToUpper(last)), http.StatusCreated)
	badgeRequest(t, handler, cookie, http.MethodPost, root, fmt.Sprintf(`{"name":%q}`, first), http.StatusCreated)
	ordered, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, root, "", http.StatusOK)
	positions := map[string]int{}
	for index, item := range ordered.(map[string]any)["badges"].([]any) {
		positions[item.(map[string]any)["name"].(string)] = index
	}
	if positions[first] >= positions[strings.ToUpper(last)] {
		t.Fatalf("Badge list not sorted case-insensitively: %v", positions)
	}

	concurrentName := uuid.NewString()
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for _, candidate := range []string{concurrentName, strings.ToUpper(concurrentName)} {
		wg.Add(1)
		go func(candidate string) {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, root, strings.NewReader(fmt.Sprintf(`{"name":%q}`, candidate)))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(cookie)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			results <- rec.Code
		}(candidate)
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for status := range results {
		counts[status]++
	}
	if counts[http.StatusCreated] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatalf("concurrent create statuses = %v", counts)
	}
}

func TestBadges_AttachOwnerScopeAndTicketResponses(t *testing.T) {
	handler, pool, cookie := badgeTestHandler(t)
	name := uuid.NewString()
	create := func(name string) TicketBadge {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/badges", fmt.Sprintf(`{"name":%q}`, name), http.StatusCreated)
		item := result.(map[string]any)
		return TicketBadge{Id: item["id"].(string), Name: item["name"].(string)}
	}
	z := create("z-" + name)
	a := create("A-" + name)
	createTicket := func() Ticket {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", fmt.Sprintf(`{"title":%q}`, name), http.StatusCreated)
		data, _ := json.Marshal(result)
		var ticket Ticket
		if err := json.Unmarshal(data, &ticket); err != nil {
			t.Fatal(err)
		}
		if ticket.Badges == nil || len(ticket.Badges) != 0 {
			t.Fatalf("new Ticket badges = %v", ticket.Badges)
		}
		return ticket
	}
	first, second := createTicket(), createTicket()
	for _, id := range []string{first.Id, second.Id} {
		for _, badge := range []TicketBadge{z, a, z} {
			result, _, _ := badgeRequest(t, handler, cookie, http.MethodPut, "/api/tickets/"+id+"/badges/"+badge.Id, "", http.StatusOK)
			items := result.(map[string]any)["badges"].([]any)
			if len(items) > 2 {
				t.Fatalf("duplicate attachment: %v", items)
			}
		}
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets/"+id, "", http.StatusOK)
		items := result.(map[string]any)["badges"].([]any)
		got := []string{items[0].(map[string]any)["id"].(string), items[1].(map[string]any)["id"].(string)}
		if !reflect.DeepEqual(got, []string{a.Id, z.Id}) {
			t.Fatalf("ordered badges = %v, want %s, %s", got, a.Id, z.Id)
		}
	}
	list, _, _ := badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets", "", http.StatusOK)
	for _, item := range list.(map[string]any)["tickets"].([]any) {
		ticket := item.(map[string]any)
		if ticket["id"] == first.Id || ticket["id"] == second.Id {
			if len(ticket["badges"].([]any)) != 2 {
				t.Fatalf("list Ticket has no badges: %v", ticket)
			}
		}
	}
	for _, ids := range [][2]string{{"bad", a.Id}, {first.Id, "bad"}, {uuid.NewString(), a.Id}, {first.Id, uuid.NewString()}} {
		result, _, _ := badgeRequest(t, handler, cookie, http.MethodPut, "/api/tickets/"+ids[0]+"/badges/"+ids[1], "", http.StatusNotFound)
		if result.(map[string]any)["error"].(map[string]any)["code"] != "not_found" {
			t.Fatalf("unknown id returned %v", result)
		}
	}
	if result, _, _ := badgeRequest(t, handler, nil, http.MethodGet, "/api/badges", "", http.StatusUnauthorized); result.(map[string]any)["error"].(map[string]any)["code"] != "unauthenticated" {
		t.Fatalf("unauthenticated list: %v", result)
	}
	var ownerID int64
	if err := pool.QueryRow(context.Background(), `SELECT owner_id FROM badges WHERE public_id = $1::uuid`, a.Id).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if err := loadTicketBadges(context.Background(), pool, ownerID+1000000, &first); err != nil || len(first.Badges) != 0 {
		t.Fatalf("foreign owner badges = %v, error = %v", first.Badges, err)
	}
	if badges, err := listBadgesForOwner(context.Background(), pool, ownerID+1000000); err != nil || len(badges) != 0 {
		t.Fatalf("foreign owner Badge list = %v, error = %v", badges, err)
	}
	if found, err := attachBadgeForOwner(context.Background(), pool, ownerID+1000000, first.Id, a.Id); err != nil || found {
		t.Fatalf("foreign owner attach found = %t, error = %v", found, err)
	}
	if _, found, err := getTicketForOwner(context.Background(), pool, ownerID+1000000, first.Id); err != nil || found {
		t.Fatalf("foreign owner Ticket found = %t, error = %v", found, err)
	}
}
