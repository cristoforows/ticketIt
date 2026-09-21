package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

func testLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(buf, nil))
}

func TestStatusHandler_Development(t *testing.T) {
	startedAt := time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	var logs bytes.Buffer
	handler := NewHandler(cfg, startedAt, testLogger(&logs))

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want application/json; charset=utf-8", ct)
	}

	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("failed to decode response body %q: %v", rec.Body.String(), err)
	}

	want := map[string]any{
		"application": "galley",
		"status":      "ok",
		"version":     "dev",
		"environment": "development",
		"startedAt":   "2026-09-21T10:00:00Z",
	}
	if len(got) != len(want) {
		t.Fatalf("response has %d fields, want exactly %d: %v", len(got), len(want), got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("field %q = %v, want %v", k, got[k], v)
		}
	}
	if logs.Len() == 0 {
		t.Error("expected a structured access log line, got none")
	}
}

func TestStatusHandler_Production(t *testing.T) {
	startedAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	cfg := config.Config{Environment: config.EnvProduction, Version: "1.4.2"}
	handler := NewHandler(cfg, startedAt, testLogger(&bytes.Buffer{}))

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var got StatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	want := StatusResponse{
		Application: "galley",
		Status:      "ok",
		Version:     "1.4.2",
		Environment: "production",
		StartedAt:   "2026-01-02T03:04:05Z",
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestUnknownRoute_ReturnsSharedErrorShape(t *testing.T) {
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), testLogger(&bytes.Buffer{}))

	req := httptest.NewRequest(http.MethodGet, "/does-not-exist", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}

	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
	}
	if body.Error.Code != "not_found" {
		t.Errorf("Error.Code = %q, want %q", body.Error.Code, "not_found")
	}
	if body.Error.Message == "" {
		t.Error("Error.Message is empty, want an actionable message")
	}
}

func TestMethodNotAllowed_ReturnsSharedErrorShape(t *testing.T) {
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), testLogger(&bytes.Buffer{}))

	for _, method := range []string{http.MethodPost, http.MethodDelete, http.MethodPut} {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/api/status", nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusMethodNotAllowed, rec.Body.String())
			}
			if allow := rec.Header().Get("Allow"); allow != "GET" {
				t.Errorf("Allow header = %q, want %q", allow, "GET")
			}

			var body ErrorBody
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
			}
			if body.Error.Code != "method_not_allowed" {
				t.Errorf("Error.Code = %q, want %q", body.Error.Code, "method_not_allowed")
			}
		})
	}
}
