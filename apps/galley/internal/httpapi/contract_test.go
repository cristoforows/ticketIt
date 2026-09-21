package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers/legacy"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

// contractPath is the single source of truth both sides generate
// from (see contracts/README.md). Path is relative to this package
// directory (apps/galley/internal/httpapi).
const contractPath = "../../../../contracts/openapi.yaml"

// TestGetStatus_ResponseMatchesContract is Galley's drift check: it
// sends a real request through the real, fully-wired handler (the
// same NewHandler used by cmd/galley) and validates the actual
// response bytes against contracts/openapi.yaml's schema for that
// operation — the same document both oapi-codegen (this package's
// api.gen.go) and Swiftlet's generated client are built from.
//
// A generated type mismatch would usually surface as a compile
// error. This test catches the drift a compiler cannot: the contract
// and the implementation compiling fine but disagreeing about actual
// values (e.g. a field's enum/const, or a required field silently
// becoming absent). See docs/evidence/m2/51-api-contract.md for this
// test caught failing on a deliberate mismatch, and passing again
// once reverted.
func TestGetStatus_ResponseMatchesContract(t *testing.T) {
	doc := loadContract(t)

	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("failed to build a router from %s: %v", contractPath, err)
	}

	startedAt := time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, startedAt, testLogger(&bytes.Buffer{}))

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

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
		t.Fatalf("GET /api/status response %s does not validate against %s: %v",
			rec.Body.String(), contractPath, err)
	}
}

// TestErrorResponses_MatchContract validates the 404 and 405 shared
// error responses — which have no operation of their own in the
// contract — against the contract's ErrorBody schema directly,
// complementing the operation-bound check above.
func TestErrorResponses_MatchContract(t *testing.T) {
	doc := loadContract(t)
	errorSchema := doc.Components.Schemas["ErrorBody"]
	if errorSchema == nil {
		t.Fatalf("contract %s has no components.schemas.ErrorBody", contractPath)
	}

	handler := NewHandler(
		config.Config{Environment: config.EnvDevelopment, Version: "dev"},
		time.Now(),
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
