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
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

// devOnlyPathPrefix is the fixed path prefix every development-only
// diagnostic route (issue #52, diagnostic.go) uses. NewHandler uses it
// to gate those routes out of production at *registration*, and to
// register their own shared-shape 405 in development. Keeping this as
// one prefix, checked once, is what makes "gate at registration" true
// for every current and future route under it, not just the two this
// slice adds.
const devOnlyPathPrefix = "/api/dev/"

// NewHandler builds Galley's complete HTTP handler.
//
// HandlerFromMux (generated) registers every contract operation and
// dispatches each to a server method — the compile-time link between
// contract and implementation. In development that includes the
// development-only diagnostic routes (diagnostic.go); in any other
// environment, registrar is a gatedMux that silently drops registration
// for those routes instead of forwarding it to the real mux, so they
// are never present at all — not merely unauthorized or hidden inside
// a handler, but genuinely never registered, which is what makes an
// unmatched request to one of them fall through to the same shared 404
// as any other unknown path. See gatedMux below and
// docs/evidence/m2/52-postgresql-persistence.md for why this is done
// at registration rather than as a check inside the handlers.
//
// The remaining routes below cover what the contract cannot express as
// an operation, using ServeMux pattern specificity: a method-qualified
// exact pattern always beats a bare exact pattern, which beats the "/"
// subtree. So GET /api/status -> 200; any other method on that path ->
// 405; anything else -> 404. The same technique gives the diagnostic
// routes their own 405 in development only.
func NewHandler(cfg config.Config, startedAt time.Time, pool *pgxpool.Pool, logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()

	var registrar ServeMux = mux
	if cfg.Environment != config.EnvDevelopment {
		registrar = &gatedMux{mux: mux}
	}
	HandlerFromMux(newServer(cfg, startedAt, pool), registrar)

	mux.HandleFunc("/api/status", methodNotAllowedHandler("GET"))
	if cfg.Environment == config.EnvDevelopment {
		mux.HandleFunc(devOnlyPathPrefix+"diagnostic-notes", methodNotAllowedHandler("GET", "POST"))
	}
	mux.HandleFunc("/", notFoundHandler)

	return withLogging(logger, mux)
}

// gatedMux wraps the real *http.ServeMux and drops HandleFunc calls
// for any pattern under devOnlyPathPrefix instead of forwarding them.
// It satisfies the same ServeMux interface api.gen.go's HandlerFromMux
// takes, so no generated code changes: registration itself is
// intercepted at the one place it happens, which is what "gated at
// route registration, not inside the handler" means concretely here.
type gatedMux struct {
	mux *http.ServeMux
}

func (m *gatedMux) HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request)) {
	if isDevOnlyPattern(pattern) {
		return
	}
	m.mux.HandleFunc(pattern, handler)
}

func (m *gatedMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mux.ServeHTTP(w, r)
}

// isDevOnlyPattern reports whether pattern (as passed to ServeMux's
// HandleFunc, e.g. "GET /api/dev/diagnostic-notes" or a bare
// "/api/dev/diagnostic-notes") registers a route under
// devOnlyPathPrefix.
func isDevOnlyPattern(pattern string) bool {
	_, path, found := strings.Cut(pattern, " ")
	if !found {
		path = pattern
	}
	return strings.HasPrefix(path, devOnlyPathPrefix)
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
