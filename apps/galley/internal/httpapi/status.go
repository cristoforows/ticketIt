package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

// StatusResponse is generated from contracts/openapi.yaml (see
// api.gen.go). Swiftlet treats a missing field as an error, so this
// payload is additive-only: add the field to the contract first,
// regenerate, then implement. Never rename or remove one.
//
// MarshalJSON holds the JSON field order issue #49 shipped. oapi-codegen
// emits struct fields alphabetically by property name and encoding/json
// serializes in declaration order, so without this the response bytes
// would silently reorder. A new field belongs at the end of both this
// struct and the contract.
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

// server implements the generated ServerInterface: GET /api/status only.
type server struct {
	status StatusResponse
}

// newServer computes the fixed status payload once. startedAt is
// captured at process start (cmd/galley/main.go).
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

func (s *server) GetStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.status)
}
