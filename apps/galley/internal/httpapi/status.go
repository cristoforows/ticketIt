package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/auth"
	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
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
// struct and the contract -- issue #52's "database" is the first such
// addition, appended after startedAt.
func (s StatusResponse) MarshalJSON() ([]byte, error) {
	type ordered struct {
		Application StatusResponseApplication `json:"application"`
		Status      StatusResponseStatus      `json:"status"`
		Version     string                    `json:"version"`
		Environment StatusResponseEnvironment `json:"environment"`
		StartedAt   string                    `json:"startedAt"`
		Database    DatabaseStatus            `json:"database"`
	}
	return json.Marshal(ordered{
		Application: s.Application,
		Status:      s.Status,
		Version:     s.Version,
		Environment: s.Environment,
		StartedAt:   s.StartedAt,
		Database:    s.Database,
	})
}

// databaseUnreachableMessage is the fixed, generic, non-secret message
// GET /api/status reports when the configured database could not be
// reached or queried. It is deliberately not derived from the
// underlying driver error: see internal/postgres's package doc for why
// nothing here ever surfaces raw driver text or connection details.
const databaseUnreachableMessage = "database unreachable"

// server implements the generated ServerInterface: the fixed status
// fields (computed once, like issue #49) plus a live database check on
// every request, the development-only diagnostic-note operations
// (only when registered, see NewHandler's gating), and issue #54's
// OAuth sign-in/session operations (auth.go).
type server struct {
	fixed        StatusResponse
	pool         *pgxpool.Pool
	cfg          config.Config
	githubClient *auth.GitHubClient
}

// newServer computes the fixed status fields once. startedAt is
// captured at process start (cmd/galley/main.go). pool is used live,
// per request, by GetStatus, the diagnostic operations (diagnostic.go),
// and the auth operations (auth.go) -- never cached here.
func newServer(cfg config.Config, startedAt time.Time, pool *pgxpool.Pool) *server {
	return &server{
		fixed: StatusResponse{
			Application: Galley,
			Status:      StatusResponseStatusOk,
			Version:     cfg.Version,
			Environment: StatusResponseEnvironment(cfg.Environment),
			StartedAt:   startedAt.UTC().Format(time.RFC3339),
		},
		pool: pool,
		cfg:  cfg,
		githubClient: &auth.GitHubClient{
			BaseURL:      cfg.OAuthGitHubBaseURL,
			APIBaseURL:   cfg.OAuthGitHubAPIBaseURL,
			ClientID:     cfg.OAuthClientID,
			ClientSecret: cfg.OAuthClientSecret,
		},
	}
}

func (s *server) GetStatus(w http.ResponseWriter, r *http.Request) {
	resp := s.fixed
	resp.Database = s.databaseStatus(r.Context())
	writeJSON(w, http.StatusOK, resp)
}

// databaseStatus performs a live reachability + migration-version
// check (internal/postgres.CheckHealth) on every call -- issue #52
// requires this never be a boot-time snapshot, and requires a database
// failure to be visible here, never reported as "ok".
func (s *server) databaseStatus(ctx context.Context) DatabaseStatus {
	health := postgres.CheckHealth(ctx, s.pool)
	if !health.Reachable {
		msg := databaseUnreachableMessage
		return DatabaseStatus{Status: DatabaseStatusStatusError, MigrationVersion: nil, Error: &msg}
	}
	return DatabaseStatus{Status: DatabaseStatusStatusOk, MigrationVersion: health.MigrationVersion}
}
