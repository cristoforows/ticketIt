package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

// StatusResponse (defined in api.gen.go, generated from
// contracts/openapi.yaml) is the fixed GET /api/status payload. Its
// field set is frozen by issue #49 because Swiftlet's client (issue
// #50, and issue #51's generated client) validates all five fields as
// non-empty strings and treats a missing one as an error. Later
// slices (e.g. #52's database health) extend this additively: add the
// field to contracts/openapi.yaml first, regenerate, then implement.
// Never rename or remove a field here.
//
// MarshalJSON fixes the JSON field order to the order established by
// issue #49, before StatusResponse was generated. oapi-codegen emits
// Go struct fields in alphabetical order by JSON property name
// (Application, Environment, StartedAt, Status, Version), and
// encoding/json serializes struct fields in declaration order, so
// left alone the response's byte layout would silently change on
// this refactor. This keeps GET /api/status's response bytes
// unchanged, per issue #51's requirement that this remain a refactor
// behind a contract, not a behavior change.
func (s StatusResponse) MarshalJSON() ([]byte, error) {
	type ordered struct {
		Application StatusResponseApplication `json:"application"`
		Status      StatusResponseStatus      `json:"status"`
		Version     string                    `json:"version"`
		Environment StatusResponseEnvironment `json:"environment"`
		StartedAt   string                    `json:"startedAt"`
	}
	return json.Marshal(ordered{
		Application: s.Application,
		Status:      s.Status,
		Version:     s.Version,
		Environment: s.Environment,
		StartedAt:   s.StartedAt,
	})
}

// server implements the generated ServerInterface (api.gen.go) for
// Galley's current API surface: GET /api/status only.
type server struct {
	status StatusResponse
}

// newServer builds the server with its fixed status payload computed
// once. startedAt is captured once at process start (see
// cmd/galley/main.go) and formatted as RFC3339 UTC on every request.
func newServer(cfg config.Config, startedAt time.Time) *server {
	return &server{
		status: StatusResponse{
			Application: Galley,
			Status:      Ok,
			Version:     cfg.Version,
			Environment: StatusResponseEnvironment(cfg.Environment),
			StartedAt:   startedAt.UTC().Format(time.RFC3339),
		},
	}
}

// GetStatus implements ServerInterface's "GET /api/status" handler.
func (s *server) GetStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.status)
}
