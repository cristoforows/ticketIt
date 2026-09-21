package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

func testLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(buf, nil))
}

// unreachablePool builds a real *pgxpool.Pool that will never connect
// (port 1 refuses immediately on this machine): used to exercise the
// "database is down" path without any flaky network timeout. It is a
// real pgxpool.Pool, not a fake/mock database -- pgxpool.New never
// dials until a query is attempted (see internal/postgres.NewPool),
// so constructing it needs no real listener at all.
func unreachablePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := postgres.NewPool(context.Background(), "postgres://localhost:1/ticketit_test?sslmode=disable")
	if err != nil {
		t.Fatalf("postgres.NewPool() returned unexpected error: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestStatusHandler_Development(t *testing.T) {
	pool := postgres.NewTestPool(t)
	startedAt := time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	var logs bytes.Buffer
	handler := NewHandler(cfg, startedAt, pool, testLogger(&logs))

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

	// The five fields issue #49 shipped: unchanged names and values,
	// still exactly these five plus "database" (issue #52's only
	// additive field so far).
	want := map[string]any{
		"application": "galley",
		"status":      "ok",
		"version":     "dev",
		"environment": "development",
		"startedAt":   "2026-09-21T10:00:00Z",
	}
	if len(got) != len(want)+1 {
		t.Fatalf("response has %d fields, want exactly %d (five original + database): %v", len(got), len(want)+1, got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("field %q = %v, want %v", k, got[k], v)
		}
	}

	db, ok := got["database"].(map[string]any)
	if !ok {
		t.Fatalf("field %q = %v, want a JSON object", "database", got["database"])
	}
	if db["status"] != "ok" {
		t.Errorf(`database.status = %v, want "ok" (real test database, migrated)`, db["status"])
	}
	if v, ok := db["migrationVersion"].(float64); !ok || v < 1 {
		t.Errorf("database.migrationVersion = %v, want a number >= 1", db["migrationVersion"])
	}
	if _, present := db["error"]; present {
		t.Errorf(`database.error = %v, want absent when status is "ok"`, db["error"])
	}

	if logs.Len() == 0 {
		t.Error("expected a structured access log line, got none")
	}
}

func TestStatusHandler_Production(t *testing.T) {
	pool := postgres.NewTestPool(t)
	startedAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	cfg := config.Config{Environment: config.EnvProduction, Version: "1.4.2"}
	handler := NewHandler(cfg, startedAt, pool, testLogger(&bytes.Buffer{}))

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
	if got.Application != "galley" || got.Status != "ok" || got.Version != "1.4.2" ||
		got.Environment != "production" || got.StartedAt != "2026-01-02T03:04:05Z" {
		t.Errorf("got %+v, want the five original fields unchanged", got)
	}
	if got.Database.Status != DatabaseStatusStatusOk {
		t.Errorf("Database.Status = %q, want %q", got.Database.Status, DatabaseStatusStatusOk)
	}
}

// TestGetStatus_DatabaseUnreachable is issue #52's required
// unreachable-database test: GET /api/status must report the failure
// honestly, never as "ok", and must never hang or crash the request.
func TestGetStatus_DatabaseUnreachable(t *testing.T) {
	pool := unreachablePool(t)
	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (the process itself is fine; only database is down); body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var got StatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("failed to decode response %q: %v", rec.Body.String(), err)
	}

	// The five original fields must stay exactly as issue #49 defined
	// them, even while the database is down.
	if got.Application != "galley" || got.Status != "ok" {
		t.Errorf("top-level application/status changed while the database was down: %+v", got)
	}

	if got.Database.Status != DatabaseStatusStatusError {
		t.Fatalf(`Database.Status = %q, want %q -- an unreachable database must never be reported as "ok"`, got.Database.Status, DatabaseStatusStatusOk)
	}
	if got.Database.MigrationVersion != nil {
		t.Errorf("Database.MigrationVersion = %v, want nil when the database is unreachable", *got.Database.MigrationVersion)
	}
	if got.Database.Error == nil || *got.Database.Error == "" {
		t.Error("Database.Error is empty, want a non-secret explanation")
	}
}

func TestUnknownRoute_ReturnsSharedErrorShape(t *testing.T) {
	pool := postgres.NewTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), pool, testLogger(&bytes.Buffer{}))

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
	pool := postgres.NewTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), pool, testLogger(&bytes.Buffer{}))

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
