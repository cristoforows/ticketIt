package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

// TestDevDiagnosticRoutes_AbsentInProduction is issue #52's required
// production-absence test. It proves the development-only diagnostic
// routes are gated at *registration*: a request to either one in
// production gets the exact same shared 404 not_found shape as a
// request to a path that was never described anywhere, not a
// distinguishable "forbidden" or "not found, but for a reason" — the
// route was never added to the mux at all. See handler.go's gatedMux.
func TestDevDiagnosticRoutes_AbsentInProduction(t *testing.T) {
	pool := postgres.NewTestPool(t)
	cfg := config.Config{Environment: config.EnvProduction, Version: "1.0.0"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))

	// The same request, made against a genuinely unknown path, to
	// compare against byte-for-byte (modulo the path named in the
	// message).
	baselineReq := httptest.NewRequest(http.MethodGet, "/this-path-was-never-registered-either", nil)
	baselineRec := httptest.NewRecorder()
	handler.ServeHTTP(baselineRec, baselineReq)
	if baselineRec.Code != http.StatusNotFound {
		t.Fatalf("baseline unknown-path status = %d, want %d", baselineRec.Code, http.StatusNotFound)
	}

	cases := []struct {
		name   string
		method string
	}{
		{"GET", http.MethodGet},
		{"POST", http.MethodPost},
		{"DELETE (not even a valid method on this route in development)", http.MethodDelete},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var body *strings.Reader
			if tc.method == http.MethodPost {
				body = strings.NewReader(`{"note":"should never be reachable"}`)
			} else {
				body = strings.NewReader("")
			}
			req := httptest.NewRequest(tc.method, "/api/dev/diagnostic-notes", body)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want %d (route must not exist in production); body=%s", rec.Code, http.StatusNotFound, rec.Body.String())
			}
			// In particular: never 405. A 405 would mean the mux knows
			// the path but not this method, which would mean the route
			// (or at least its path) was registered after all.
			if allow := rec.Header().Get("Allow"); allow != "" {
				t.Errorf("Allow header = %q, want absent -- the path itself must be unknown, not just this method", allow)
			}

			var got ErrorBody
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
			}
			if got.Error.Code != "not_found" {
				t.Errorf("Error.Code = %q, want %q", got.Error.Code, "not_found")
			}

			var baseline ErrorBody
			if err := json.Unmarshal(baselineRec.Body.Bytes(), &baseline); err != nil {
				t.Fatalf("failed to decode baseline error body: %v", err)
			}
			if got.Error.Code != baseline.Error.Code {
				t.Errorf("Error.Code = %q, want the same %q a genuinely unknown route gets", got.Error.Code, baseline.Error.Code)
			}
		})
	}
}

// TestDevDiagnosticRoutes_PresentOutsideProduction is the converse
// check: the same routes exist (respond, rather than 404) in every
// non-production environment this module defines.
func TestDevDiagnosticRoutes_PresentOutsideProduction(t *testing.T) {
	pool := postgres.NewTestPool(t)
	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))

	req := httptest.NewRequest(http.MethodGet, "/api/dev/diagnostic-notes", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code == http.StatusNotFound {
		t.Fatalf("status = %d, want the route to exist in development (not 404)", rec.Code)
	}
}
