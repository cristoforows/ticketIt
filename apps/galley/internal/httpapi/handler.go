// Package httpapi builds Galley's HTTP handler: routing bound to
// contracts/openapi.yaml's generated ServerInterface (api.gen.go),
// the shared JSON error shape for unknown routes and method
// mismatches, and structured request logging.
//
// Routing uses only net/http's standard library ServeMux (Go 1.22+),
// which added method- and wildcard-aware patterns such as
// "GET /api/status". That covers everything this slice needs — a
// handful of fixed routes with per-method dispatch — without pulling
// in a third-party router. See apps/galley/README.md ("Router choice")
// for the full rationale.
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
// HandlerFromMux (generated in api.gen.go from contracts/openapi.yaml)
// registers "GET /api/status" on mux, dispatching to *server's
// GetStatus method — the compile-time link between the contract and
// the implementation described in contracts/README.md. This slice
// then layers its own routes onto the same mux for behavior the
// contract's schema doesn't (and can't) describe as an operation:
//
// Route precedence relies on net/http.ServeMux's pattern specificity
// rules: "GET /api/status" (a method-qualified, exact pattern,
// registered by HandlerFromMux) matches only GET requests to that
// exact path; "/api/status" (no method, exact pattern) matches every
// other method on that same path, since a method-qualified pattern is
// strictly more specific and always wins when both could match; and
// "/" (a pattern ending in "/") is a subtree match that catches every
// path neither of the above claims. Together they give: GET
// /api/status -> 200 status payload; any other method on /api/status
// -> 405 with the shared error shape; anything else -> 404 with the
// shared error shape.
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
