package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/auth"
	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/githubfake"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

// contractPath is relative to this package directory.
const contractPath = "../../../../contracts/openapi.yaml"

// TestGetStatus_ResponseMatchesContract sends a real request through
// the real handler and validates the response bytes against the
// contract. A generated-type mismatch usually surfaces as a compile
// error; this catches the drift a compiler cannot — contract and
// implementation compiling fine but disagreeing about values (an
// enum/const, or a required field going absent).
func TestGetStatus_ResponseMatchesContract(t *testing.T) {
	pool := postgres.NewTestPool(t)
	doc := loadContract(t)

	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("failed to build a router from %s: %v", contractPath, err)
	}

	startedAt := time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, startedAt, pool, testLogger(&bytes.Buffer{}))

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	validateAgainstContract(t, router, req, rec)
}

// TestGetStatus_DatabaseUnreachableResponseMatchesContract is
// TestGetStatus_ResponseMatchesContract's counterpart for the
// unreachable-database path required by issue #52: the degraded
// "database": {"status": "error", ...} shape must validate against
// the same contract as the healthy shape does.
func TestGetStatus_DatabaseUnreachableResponseMatchesContract(t *testing.T) {
	pool := unreachablePool(t)
	doc := loadContract(t)

	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("failed to build a router from %s: %v", contractPath, err)
	}

	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	validateAgainstContract(t, router, req, rec)
}

// TestDiagnosticNotes_ResponseMatchesContract validates both
// development-only diagnostic operations' real responses against the
// contract, the same way the status endpoint above is validated.
// diagnostic-notes is a non-public route (issue #54), so this needs a
// valid session cookie; it mints one directly via internal/auth
// (bypassing the OAuth round trip, which is exercised in full by
// auth_test.go) since this test is only about response-shape
// validation, not the sign-in flow itself.
func TestDiagnosticNotes_ResponseMatchesContract(t *testing.T) {
	pool := postgres.NewTestPool(t)
	doc := loadContract(t)

	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("failed to build a router from %s: %v", contractPath, err)
	}

	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))
	sessionCookie := mintTestSessionCookie(t, pool)

	createReq := httptest.NewRequest(http.MethodPost, "/api/dev/diagnostic-notes",
		strings.NewReader(`{"note":"contract test note"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createReq.AddCookie(sessionCookie)
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want %d; body=%s", createRec.Code, http.StatusCreated, createRec.Body.String())
	}
	validateAgainstContract(t, router, createReq, createRec)

	listReq := httptest.NewRequest(http.MethodGet, "/api/dev/diagnostic-notes", nil)
	listReq.AddCookie(sessionCookie)
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want %d; body=%s", listRec.Code, http.StatusOK, listRec.Body.String())
	}
	validateAgainstContract(t, router, listReq, listRec)
}

// TestTickets_ResponseMatchesContract validates both Ticket operations'
// real responses against the contract, the same way
// TestDiagnosticNotes_ResponseMatchesContract does above.
func TestTickets_ResponseMatchesContract(t *testing.T) {
	pool := postgres.NewTestPool(t)
	doc := loadContract(t)

	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("failed to build a router from %s: %v", contractPath, err)
	}

	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))
	sessionCookie := mintTestSessionCookie(t, pool)

	createReq := httptest.NewRequest(http.MethodPost, "/api/tickets",
		strings.NewReader(`{"title":"contract test ticket"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createReq.AddCookie(sessionCookie)
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want %d; body=%s", createRec.Code, http.StatusCreated, createRec.Body.String())
	}
	validateAgainstContract(t, router, createReq, createRec)

	listReq := httptest.NewRequest(http.MethodGet, "/api/tickets", nil)
	listReq.AddCookie(sessionCookie)
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want %d; body=%s", listRec.Code, http.StatusOK, listRec.Body.String())
	}
	validateAgainstContract(t, router, listReq, listRec)
}

// TestGetTicket_ResponseMatchesContract validates issue #57's new
// operation the same way TestTickets_ResponseMatchesContract does
// above, for both its 200 and 404 shapes.
func TestGetTicket_ResponseMatchesContract(t *testing.T) {
	pool := postgres.NewTestPool(t)
	doc := loadContract(t)

	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("failed to build a router from %s: %v", contractPath, err)
	}

	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))
	sessionCookie := mintTestSessionCookie(t, pool)

	createReq := httptest.NewRequest(http.MethodPost, "/api/tickets",
		strings.NewReader(`{"title":"get-ticket contract test"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createReq.AddCookie(sessionCookie)
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want %d; body=%s", createRec.Code, http.StatusCreated, createRec.Body.String())
	}
	var created Ticket
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode create response %q: %v", createRec.Body.String(), err)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/tickets/"+created.Id, nil)
	getReq.AddCookie(sessionCookie)
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want %d; body=%s", getRec.Code, http.StatusOK, getRec.Body.String())
	}
	validateAgainstContract(t, router, getReq, getRec)

	notFoundReq := httptest.NewRequest(http.MethodGet, "/api/tickets/"+uuid.NewString(), nil)
	notFoundReq.AddCookie(sessionCookie)
	notFoundRec := httptest.NewRecorder()
	handler.ServeHTTP(notFoundRec, notFoundReq)
	if notFoundRec.Code != http.StatusNotFound {
		t.Fatalf("GET (unknown) status = %d, want %d; body=%s", notFoundRec.Code, http.StatusNotFound, notFoundRec.Body.String())
	}
	validateAgainstContract(t, router, notFoundReq, notFoundRec)
}

// TestUpdateTicket_ResponseMatchesContract validates issue #58's new
// operation the same way TestGetTicket_ResponseMatchesContract does
// above, for both its 200 and 404 shapes, plus the 400 shape a
// rejected refinement field produces.
func TestUpdateTicket_ResponseMatchesContract(t *testing.T) {
	pool := postgres.NewTestPool(t)
	doc := loadContract(t)

	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("failed to build a router from %s: %v", contractPath, err)
	}

	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))
	sessionCookie := mintTestSessionCookie(t, pool)

	createReq := httptest.NewRequest(http.MethodPost, "/api/tickets",
		strings.NewReader(`{"title":"update-ticket contract test"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createReq.AddCookie(sessionCookie)
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want %d; body=%s", createRec.Code, http.StatusCreated, createRec.Body.String())
	}
	var created Ticket
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode create response %q: %v", createRec.Body.String(), err)
	}

	patchReq := httptest.NewRequest(http.MethodPatch, "/api/tickets/"+created.Id,
		strings.NewReader(`{"goal":"Ship it","context":"","successCriteria":"Tests pass"}`))
	patchReq.Header.Set("Content-Type", "application/json")
	patchReq.AddCookie(sessionCookie)
	patchRec := httptest.NewRecorder()
	handler.ServeHTTP(patchRec, patchReq)
	if patchRec.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d; body=%s", patchRec.Code, http.StatusOK, patchRec.Body.String())
	}
	validateAgainstContract(t, router, patchReq, patchRec)

	invalidReq := httptest.NewRequest(http.MethodPatch, "/api/tickets/"+created.Id,
		strings.NewReader(`{"title":"   "}`))
	invalidReq.Header.Set("Content-Type", "application/json")
	invalidReq.AddCookie(sessionCookie)
	invalidRec := httptest.NewRecorder()
	handler.ServeHTTP(invalidRec, invalidReq)
	if invalidRec.Code != http.StatusBadRequest {
		t.Fatalf("PATCH (invalid) status = %d, want %d; body=%s", invalidRec.Code, http.StatusBadRequest, invalidRec.Body.String())
	}
	validateAgainstContract(t, router, invalidReq, invalidRec)

	notFoundReq := httptest.NewRequest(http.MethodPatch, "/api/tickets/"+uuid.NewString(),
		strings.NewReader(`{"goal":"unreachable"}`))
	notFoundReq.Header.Set("Content-Type", "application/json")
	notFoundReq.AddCookie(sessionCookie)
	notFoundRec := httptest.NewRecorder()
	handler.ServeHTTP(notFoundRec, notFoundReq)
	if notFoundRec.Code != http.StatusNotFound {
		t.Fatalf("PATCH (unknown) status = %d, want %d; body=%s", notFoundRec.Code, http.StatusNotFound, notFoundRec.Body.String())
	}
	validateAgainstContract(t, router, notFoundReq, notFoundRec)
}

func TestTicketCommands_ResponseMatchesContract(t *testing.T) {
	pool := postgres.NewTestPool(t)
	router, err := legacy.NewRouter(loadContract(t))
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), pool, testLogger(&bytes.Buffer{}))
	cookie := mintTestSessionCookie(t, pool)
	request := func(method, path, body string, want int) Ticket {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s %s: status=%d, want %d; body=%s", method, path, rec.Code, want, rec.Body.String())
		}
		validateAgainstContract(t, router, req, rec)
		var ticket Ticket
		if want == http.StatusOK || want == http.StatusCreated {
			if err := json.Unmarshal(rec.Body.Bytes(), &ticket); err != nil {
				t.Fatal(err)
			}
		}
		return ticket
	}
	created := request(http.MethodPost, "/api/tickets", `{"title":"commands contract"}`, http.StatusCreated)
	path := "/api/tickets/" + created.Id
	request(http.MethodPost, path+"/status", `{"status":"Done"}`, http.StatusBadRequest)
	request(http.MethodPost, path+"/accept", "", http.StatusBadRequest)
	request(http.MethodPost, path+"/status", `{"status":"Ready"}`, http.StatusOK)
	request(http.MethodPut, path+"/assignee", "", http.StatusOK)
	request(http.MethodDelete, path+"/assignee", "", http.StatusOK)
	request(http.MethodPost, path+"/status", `{"status":"InProgress"}`, http.StatusOK)
	request(http.MethodPost, path+"/status", `{"status":"InReview"}`, http.StatusOK)
	request(http.MethodPost, path+"/accept", "", http.StatusOK)
	for _, operation := range []struct{ method, suffix, body string }{
		{http.MethodPost, "/status", `{"status":"Ready"}`},
		{http.MethodPost, "/accept", ""},
		{http.MethodPut, "/assignee", ""},
		{http.MethodDelete, "/assignee", ""},
	} {
		request(operation.method, "/api/tickets/"+uuid.NewString()+operation.suffix, operation.body, http.StatusNotFound)
	}
}

func TestBadges_ResponsesMatchContractAndMethod405(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	doc := loadContract(t)
	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatal(err)
	}
	badge, rec, req := badgeRequest(t, handler, cookie, http.MethodPost, "/api/badges", fmt.Sprintf(`{"name":%q}`, uuid.NewString()), http.StatusCreated)
	validateAgainstContract(t, router, req, rec)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodGet, "/api/badges", "", http.StatusOK)
	validateAgainstContract(t, router, req, rec)
	created, rec, req := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", `{"title":"badge contract"}`, http.StatusCreated)
	validateAgainstContract(t, router, req, rec)
	path := "/api/tickets/" + created.(map[string]any)["id"].(string) + "/badges/" + badge.(map[string]any)["id"].(string)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodPut, path, "", http.StatusOK)
	validateAgainstContract(t, router, req, rec)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets?badgeId="+badge.(map[string]any)["id"].(string), "", http.StatusOK)
	validateAgainstContract(t, router, req, rec)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodDelete, path, "", http.StatusOK)
	validateAgainstContract(t, router, req, rec)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodDelete, "/api/tickets/bad/badges/"+uuid.NewString(), "", http.StatusNotFound)
	validateAgainstContract(t, router, req, rec)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodPut, "/api/tickets/bad/badges/"+uuid.NewString(), "", http.StatusNotFound)
	validateAgainstContract(t, router, req, rec)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodPost, "/api/badges", fmt.Sprintf(`{"name":%q}`, badge.(map[string]any)["name"]), http.StatusConflict)
	validateAgainstContract(t, router, req, rec)
	for _, tc := range []struct{ method, path, allow string }{
		{http.MethodDelete, "/api/badges", "GET, POST"},
		{http.MethodPost, path, "PUT, DELETE"},
	} {
		result, rec, _ := badgeRequest(t, handler, cookie, tc.method, tc.path, "", http.StatusMethodNotAllowed)
		if rec.Header().Get("Allow") != tc.allow || result.(map[string]any)["error"].(map[string]any)["code"] != "method_not_allowed" {
			t.Fatalf("405 %s %s: %s, %v", tc.method, tc.path, rec.Header().Get("Allow"), result)
		}
		if err := doc.Components.Schemas["ErrorBody"].Value.VisitJSON(result); err != nil {
			t.Fatalf("405 body not ErrorBody: %v", err)
		}
	}
}

func TestArchive_ResponsesMatchContractAndMethod405(t *testing.T) {
	handler, _, cookie := badgeTestHandler(t)
	router, err := legacy.NewRouter(loadContract(t))
	if err != nil {
		t.Fatal(err)
	}
	created, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets", `{"title":"archive contract"}`, http.StatusCreated)
	path := "/api/tickets/" + created.(map[string]any)["id"].(string) + "/archive"
	_, rec, req := badgeRequest(t, handler, cookie, http.MethodPost, path, "", http.StatusOK)
	validateAgainstContract(t, router, req, rec)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodPost, path, "", http.StatusBadRequest)
	validateAgainstContract(t, router, req, rec)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets/"+uuid.NewString()+"/archive", "", http.StatusNotFound)
	validateAgainstContract(t, router, req, rec)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets/"+created.(map[string]any)["id"].(string), "", http.StatusOK)
	validateAgainstContract(t, router, req, rec)
	_, rec, req = badgeRequest(t, handler, cookie, http.MethodGet, "/api/tickets", "", http.StatusOK)
	validateAgainstContract(t, router, req, rec)
	_, rec, _ = badgeRequest(t, handler, cookie, http.MethodDelete, path, "", http.StatusMethodNotAllowed)
	if rec.Header().Get("Allow") != "POST" {
		t.Fatalf("archive Allow = %q, want POST", rec.Header().Get("Allow"))
	}
}

func TestTicketAcceptAvailability_ResponseContractRejectsInvalidCombinations(t *testing.T) {
	pool := postgres.NewTestPool(t)
	router, err := legacy.NewRouter(loadContract(t))
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), pool, testLogger(&bytes.Buffer{}))
	cookie := mintTestSessionCookie(t, pool)
	create := httptest.NewRequest(http.MethodPost, "/api/tickets", strings.NewReader(`{"title":"accept availability contract"}`))
	create.Header.Set("Content-Type", "application/json")
	create.AddCookie(cookie)
	created := httptest.NewRecorder()
	handler.ServeHTTP(created, create)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d; body=%s", created.Code, created.Body.String())
	}
	var ticket Ticket
	if err := json.Unmarshal(created.Body.Bytes(), &ticket); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/tickets/"+ticket.Id, nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status=%d; body=%s", rec.Code, rec.Body.String())
	}
	validateAgainstContract(t, router, req, rec)
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	actions := body["allowedActions"].(map[string]any)
	reason := actions["accept"].(map[string]any)["reason"]
	route, pathParams, err := router.FindRoute(req)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		accept  map[string]any
		invalid bool
	}{
		{"unavailable with reason", map[string]any{"available": false, "reason": reason}, false},
		{"available without reason", map[string]any{"available": true}, false},
		{"unavailable without reason", map[string]any{"available": false}, true},
		{"available with reason", map[string]any{"available": true, "reason": reason}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			actions["accept"] = tc.accept
			data, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			rec.Body.Reset()
			if _, err := rec.Body.Write(data); err != nil {
				t.Fatal(err)
			}
			input := &openapi3filter.ResponseValidationInput{
				RequestValidationInput: &openapi3filter.RequestValidationInput{Request: req, PathParams: pathParams, Route: route},
				Status:                 rec.Code,
				Header:                 rec.Header(),
			}
			input.SetBodyBytes(data)
			schemaErr := openapi3filter.ValidateResponse(context.Background(), input)
			if (schemaErr != nil) != tc.invalid {
				t.Errorf("kin-openapi ValidateResponse(%s) error=%v, want invalid=%t", data, schemaErr, tc.invalid)
			}
		})
	}
}

// TestGetSession_ResponseMatchesContract validates issue #54's
// SessionResponse shape (the 200 case) the same way the other
// operations above are validated.
func TestGetSession_ResponseMatchesContract(t *testing.T) {
	pool := postgres.NewTestPool(t)
	doc := loadContract(t)

	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("failed to build a router from %s: %v", contractPath, err)
	}

	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))
	sessionCookie := mintTestSessionCookie(t, pool)

	req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	req.AddCookie(sessionCookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/session status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	validateAgainstContract(t, router, req, rec)
}

// mintTestSessionCookie bootstraps (or reuses -- see
// githubfake.TestOwnerIdentity's doc comment) the one Owner directly
// via internal/auth and returns a ready-to-attach session cookie for
// it, for tests that need a valid session but are not themselves
// testing the OAuth flow.
func mintTestSessionCookie(t *testing.T, pool *pgxpool.Pool) *http.Cookie {
	t.Helper()
	ctx := context.Background()
	identity := githubfake.TestOwnerIdentity
	ownerID, _, err := auth.ResolveOwner(ctx, pool, identity.Login, auth.ProviderIdentity{ID: identity.ID, Login: identity.Login})
	if err != nil {
		t.Fatalf("failed to resolve the test owner: %v", err)
	}
	raw, _, err := auth.CreateSession(ctx, pool, ownerID, config.DefaultSessionTTL)
	if err != nil {
		t.Fatalf("failed to create a test session: %v", err)
	}
	return &http.Cookie{Name: SessionCookieName, Value: raw}
}

func validateAgainstContract(t *testing.T, router routers.Router, req *http.Request, rec *httptest.ResponseRecorder) {
	t.Helper()
	route, pathParams, err := router.FindRoute(req)
	if err != nil {
		t.Fatalf("contract %s has no route for %s %s: %v", contractPath, req.Method, req.URL.Path, err)
	}

	input := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: &openapi3filter.RequestValidationInput{
			Request:    req,
			PathParams: pathParams,
			Route:      route,
		},
		Status: rec.Code,
		Header: rec.Header(),
	}
	input.SetBodyBytes(rec.Body.Bytes())

	if err := openapi3filter.ValidateResponse(context.Background(), input); err != nil {
		t.Fatalf("%s %s response %s does not validate against %s: %v",
			req.Method, req.URL.Path, rec.Body.String(), contractPath, err)
	}
}

// TestErrorResponses_MatchContract validates the 404 and 405 bodies
// against the ErrorBody schema directly, since neither has an
// operation the response validator above could bind to.
func TestErrorResponses_MatchContract(t *testing.T) {
	doc := loadContract(t)
	errorSchema := doc.Components.Schemas["ErrorBody"]
	if errorSchema == nil {
		t.Fatalf("contract %s has no components.schemas.ErrorBody", contractPath)
	}

	pool := postgres.NewTestPool(t)
	handler := NewHandler(
		config.Config{Environment: config.EnvDevelopment, Version: "dev"},
		time.Now(),
		pool,
		testLogger(&bytes.Buffer{}),
	)

	cases := []struct {
		name   string
		method string
		path   string
	}{
		{"not found", http.MethodGet, "/does-not-exist"},
		{"method not allowed", http.MethodPost, "/api/status"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			var body any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("response body %q is not JSON: %v", rec.Body.String(), err)
			}

			if err := errorSchema.Value.VisitJSON(body); err != nil {
				t.Fatalf("response body %s does not validate against contract's ErrorBody schema: %v",
					rec.Body.String(), err)
			}
		})
	}
}

// TestAuthErrorResponses_MatchContract validates issue #54's new error
// paths (unauthenticated, invalid_oauth_state, owner_mismatch) against
// their bound operation's "default" response, the same way
// TestGetStatus_ResponseMatchesContract validates a success response --
// unlike TestErrorResponses_MatchContract above, each of these does
// have an operation the router can bind to.
func TestAuthErrorResponses_MatchContract(t *testing.T) {
	pool := postgres.NewTestPool(t)
	doc := loadContract(t)

	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("failed to build a router from %s: %v", contractPath, err)
	}

	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))

	t.Run("unauthenticated", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
		}
		validateAgainstContract(t, router, req, rec)
	})

	t.Run("invalid_oauth_state", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=x&state=never-issued", nil)
		req.AddCookie(&http.Cookie{Name: StateCookieName, Value: "never-issued"})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
		}
		validateAgainstContract(t, router, req, rec)
	})
}

func loadContract(t *testing.T) *openapi3.T {
	t.Helper()
	doc, err := openapi3.NewLoader().LoadFromFile(contractPath)
	if err != nil {
		t.Fatalf("failed to load contract %s: %v", contractPath, err)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("contract %s is not a valid OpenAPI document: %v", contractPath, err)
	}
	return doc
}
