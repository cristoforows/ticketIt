package httpapi

import (
	"net/http"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

// StatusResponse is the fixed GET /api/status payload. Its field set is
// frozen by issue #49 because Swiftlet's client (issue #50) validates
// all five fields as non-empty strings and treats a missing one as an
// error. Later slices (e.g. #52's database health) extend this
// additively; never rename or remove a field here.
type StatusResponse struct {
	Application string `json:"application"`
	Status      string `json:"status"`
	Version     string `json:"version"`
	Environment string `json:"environment"`
	StartedAt   string `json:"startedAt"`
}

// statusHandler returns the fixed application-status payload. startedAt
// is captured once at process start (see cmd/galley/main.go) and
// formatted as RFC3339 UTC on every request.
func statusHandler(cfg config.Config, startedAt time.Time) http.HandlerFunc {
	resp := StatusResponse{
		Application: "galley",
		Status:      "ok",
		Version:     cfg.Version,
		Environment: cfg.Environment,
		StartedAt:   startedAt.UTC().Format(time.RFC3339),
	}
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, resp)
	}
}
