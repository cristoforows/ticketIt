package httpapi

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/authtest"
	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/githubfake"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

// uniqueNote returns a note text unlikely to collide with any other
// test's or developer's rows in the shared, real, persistent
// ticketit_test database -- so these tests never need to truncate
// diagnostic_notes and never interfere with each other or with the
// restart-durability test in cmd/galley.
func uniqueNote(t *testing.T) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("failed to generate a unique note: %v", err)
	}
	return "diagnostic_test-" + t.Name() + "-" + hex.EncodeToString(b[:])
}

func devHandler(t *testing.T) http.Handler {
	t.Helper()
	pool := postgres.NewTestPool(t)
	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	return NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))
}

// devServerWithSession starts a real Galley server (development
// environment) against the real test database and signs in as the
// configured owner against a local fake provider, returning the
// server's base URL and a cookie-jar-backed client already carrying a
// valid session -- since issue #54, diagnostic-notes is itself a
// non-public route (see diagnostic.go's requireSession retrofit).
func devServerWithSession(t *testing.T) (baseURL string, client *http.Client) {
	t.Helper()
	pool := postgres.NewTestPool(t)
	fake := githubfake.New(t, githubfake.TestOwnerIdentity)
	srv, _ := startTestGalley(t, pool, config.EnvDevelopment, fake)
	client = authtest.NewClient()
	authtest.SignIn(t, client, srv.URL)
	return srv.URL, client
}

func TestDiagnosticNotes_WriteThenRead(t *testing.T) {
	baseURL, client := devServerWithSession(t)
	note := uniqueNote(t)

	createReq, err := http.NewRequest(http.MethodPost, baseURL+"/api/dev/diagnostic-notes",
		strings.NewReader(`{"note":"`+note+`"}`))
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	createReq.Header.Set("Content-Type", "application/json")
	createResp, err := client.Do(createReq)
	if err != nil {
		t.Fatalf("POST /api/dev/diagnostic-notes failed: %v", err)
	}
	defer createResp.Body.Close()
	createBody, _ := io.ReadAll(createResp.Body)

	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("POST status = %d, want %d; body=%s", createResp.StatusCode, http.StatusCreated, createBody)
	}
	var created DiagnosticNote
	if err := json.Unmarshal(createBody, &created); err != nil {
		t.Fatalf("failed to decode create response %q: %v", createBody, err)
	}
	if created.Note != note {
		t.Errorf("created.Note = %q, want %q", created.Note, note)
	}
	if created.Id == 0 {
		t.Error("created.Id is zero, want an assigned id")
	}
	if created.CreatedAt == "" {
		t.Error("created.CreatedAt is empty")
	}

	listResp, err := client.Get(baseURL + "/api/dev/diagnostic-notes")
	if err != nil {
		t.Fatalf("GET /api/dev/diagnostic-notes failed: %v", err)
	}
	defer listResp.Body.Close()
	listBody, _ := io.ReadAll(listResp.Body)

	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d, want %d; body=%s", listResp.StatusCode, http.StatusOK, listBody)
	}
	var list DiagnosticNoteList
	if err := json.Unmarshal(listBody, &list); err != nil {
		t.Fatalf("failed to decode list response %q: %v", listBody, err)
	}

	found := false
	for _, n := range list.Notes {
		if n.Id == created.Id && n.Note == note {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("GET /api/dev/diagnostic-notes did not include the note just created (id=%d, note=%q); got %d notes", created.Id, note, len(list.Notes))
	}
}

func TestCreateDiagnosticNote_RejectsEmptyNote(t *testing.T) {
	baseURL, client := devServerWithSession(t)

	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/dev/diagnostic-notes", strings.NewReader(`{"note":""}`))
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", resp.StatusCode, http.StatusBadRequest, data)
	}
	var body ErrorBody
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatalf("failed to decode error body %q: %v", data, err)
	}
	if body.Error.Code != "invalid_request" {
		t.Errorf("Error.Code = %q, want %q", body.Error.Code, "invalid_request")
	}
}

func TestCreateDiagnosticNote_RejectsMalformedJSON(t *testing.T) {
	baseURL, client := devServerWithSession(t)

	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/dev/diagnostic-notes", strings.NewReader(`not json`))
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", resp.StatusCode, http.StatusBadRequest, data)
	}
	var body ErrorBody
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatalf("failed to decode error body %q: %v", data, err)
	}
	if body.Error.Code != "invalid_request" {
		t.Errorf("Error.Code = %q, want %q", body.Error.Code, "invalid_request")
	}
}

// TestDiagnosticNotes_DatabaseUnavailable proves the diagnostic
// endpoints fail clearly (the shared error shape, not a hang or a
// panic) when the database is unreachable, same as GET /api/status.
// requireSession's own lookup hits the same unreachable pool first
// (issue #54's session check is itself a database read), which is why
// this needs a session cookie attached at all -- with none, the
// request would instead get 401 unauthenticated without ever reaching
// the database.
func TestDiagnosticNotes_DatabaseUnavailable(t *testing.T) {
	pool := unreachablePool(t)
	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))

	withCookie := func(req *http.Request) *http.Request {
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "irrelevant-the-lookup-itself-fails"})
		return req
	}

	t.Run("list", func(t *testing.T) {
		req := withCookie(httptest.NewRequest(http.MethodGet, "/api/dev/diagnostic-notes", nil))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
		}
		var body ErrorBody
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
		}
		if body.Error.Code != "database_unavailable" {
			t.Errorf("Error.Code = %q, want %q", body.Error.Code, "database_unavailable")
		}
	})

	t.Run("create", func(t *testing.T) {
		req := withCookie(httptest.NewRequest(http.MethodPost, "/api/dev/diagnostic-notes", strings.NewReader(`{"note":"x"}`)))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
		}
		var body ErrorBody
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
		}
		if body.Error.Code != "database_unavailable" {
			t.Errorf("Error.Code = %q, want %q", body.Error.Code, "database_unavailable")
		}
	})
}

func TestDiagnosticNotes_MethodNotAllowed(t *testing.T) {
	handler := devHandler(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/dev/diagnostic-notes", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusMethodNotAllowed, rec.Body.String())
	}
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
	}
	if body.Error.Code != "method_not_allowed" {
		t.Errorf("Error.Code = %q, want %q", body.Error.Code, "method_not_allowed")
	}
}
