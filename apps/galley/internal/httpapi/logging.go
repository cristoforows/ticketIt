package httpapi

import (
	"log/slog"
	"net/http"
	"time"
)

// statusRecorder captures the status code a handler writes so the
// logging middleware can log it after the handler returns.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// withLogging wraps next with structured, per-request access logging.
// It never sets a status itself; if a handler never calls WriteHeader
// (e.g. it panics before responding), the recorded status defaults to
// 200 to match net/http's own default.
func withLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"remote_addr", r.RemoteAddr,
		)
	})
}
