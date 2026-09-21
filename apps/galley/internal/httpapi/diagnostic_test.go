package httpapi

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
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

func TestDiagnosticNotes_WriteThenRead(t *testing.T) {
	handler := devHandler(t)
	note := uniqueNote(t)

	createReq := httptest.NewRequest(http.MethodPost, "/api/dev/diagnostic-notes",
		strings.NewReader(`{"note":"`+note+`"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want %d; body=%s", createRec.Code, http.StatusCreated, createRec.Body.String())
	}
	var created DiagnosticNote
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode create response %q: %v", createRec.Body.String(), err)
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

	listReq := httptest.NewRequest(http.MethodGet, "/api/dev/diagnostic-notes", nil)
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)

	if listRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want %d; body=%s", listRec.Code, http.StatusOK, listRec.Body.String())
	}
	var list DiagnosticNoteList
	if err := json.Unmarshal(listRec.Body.Bytes(), &list); err != nil {
		t.Fatalf("failed to decode list response %q: %v", listRec.Body.String(), err)
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
	handler := devHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/api/dev/diagnostic-notes", strings.NewReader(`{"note":""}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
	}
	if body.Error.Code != "invalid_request" {
		t.Errorf("Error.Code = %q, want %q", body.Error.Code, "invalid_request")
	}
}

func TestCreateDiagnosticNote_RejectsMalformedJSON(t *testing.T) {
	handler := devHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/api/dev/diagnostic-notes", strings.NewReader(`not json`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
	}
	if body.Error.Code != "invalid_request" {
		t.Errorf("Error.Code = %q, want %q", body.Error.Code, "invalid_request")
	}
}

// TestDiagnosticNotes_DatabaseUnavailable proves the diagnostic
// endpoints fail clearly (the shared error shape, not a hang or a
// panic) when the database is unreachable, same as GET /api/status.
func TestDiagnosticNotes_DatabaseUnavailable(t *testing.T) {
	pool := unreachablePool(t)
	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))

	t.Run("list", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/dev/diagnostic-notes", nil)
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
		req := httptest.NewRequest(http.MethodPost, "/api/dev/diagnostic-notes", strings.NewReader(`{"note":"x"}`))
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
