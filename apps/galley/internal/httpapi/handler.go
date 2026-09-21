// Package httpapi builds Galley's HTTP handler: routing bound to the
// ServerInterface generated from contracts/openapi.yaml (api.gen.go),
// the shared JSON error shape for unknown routes and method mismatches,
// and structured request logging.
//
// Routing is net/http's ServeMux alone (Go 1.22+ method- and
// wildcard-aware patterns) — enough for a handful of fixed routes with
// per-method dispatch. See README.md ("Router choice").
package httpapi

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

// NewHandler builds Galley's complete HTTP handler.
//
// HandlerFromMux (generated) registers "GET /api/status" and dispatches
// it to server.GetStatus — the compile-time link between contract and
// implementation. The two routes below it cover what the contract
// cannot express as an operation, using ServeMux pattern specificity: a
// method-qualified exact pattern always beats a bare exact pattern,
// which beats the "/" subtree. So GET /api/status -> 200; any other
// method on that path -> 405; anything else -> 404.
func NewHandler(cfg config.Config, startedAt time.Time, logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	HandlerFromMux(newServer(cfg, startedAt), mux)
	mux.HandleFunc("/api/status", methodNotAllowedHandler("GET"))
	mux.HandleFunc("/", notFoundHandler)

	return withLogging(logger, mux)
}

func notFoundHandler(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotFound, "not_found",
		fmt.Sprintf("no route for %s %s", r.Method, r.URL.Path))
}

func methodNotAllowedHandler(allowed ...string) http.HandlerFunc {
	allowHeader := allowed[0]
	for _, m := range allowed[1:] {
		allowHeader += ", " + m
	}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", allowHeader)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			fmt.Sprintf("method %s not allowed for %s; use %s", r.Method, r.URL.Path, allowHeader))
	}
}
