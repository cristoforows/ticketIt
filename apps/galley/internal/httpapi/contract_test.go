package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
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
func TestDiagnosticNotes_ResponseMatchesContract(t *testing.T) {
	pool := postgres.NewTestPool(t)
	doc := loadContract(t)

	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("failed to build a router from %s: %v", contractPath, err)
	}

	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))

	createReq := httptest.NewRequest(http.MethodPost, "/api/dev/diagnostic-notes",
		strings.NewReader(`{"note":"contract test note"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want %d; body=%s", createRec.Code, http.StatusCreated, createRec.Body.String())
	}
	validateAgainstContract(t, router, createReq, createRec)

	listReq := httptest.NewRequest(http.MethodGet, "/api/dev/diagnostic-notes", nil)
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want %d; body=%s", listRec.Code, http.StatusOK, listRec.Body.String())
	}
	validateAgainstContract(t, router, listReq, listRec)
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
