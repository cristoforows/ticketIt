// Command galley is the ticketIt backend application: it reads
// configuration from the environment, serves GET /api/status, and
// shuts down cleanly on SIGINT/SIGTERM. See apps/galley/README.md for
// build, test, run, and configuration details.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/httpapi"
)

func main() {
	if err := run(context.Background(), os.Getenv, os.Stdout, nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run wires configuration, the HTTP handler, and graceful shutdown. It
// is factored out of main so tests can exercise the whole lifecycle
// directly: they supply a fake getenv, capture logs written to stdout,
// and trigger shutdown by canceling ctx instead of sending a real OS
// signal (signal.NotifyContext's derived context is also canceled when
// its parent is, so this exercises the same shutdown path).
//
// If ready is non-nil, run sends the bound listener's address on it
// once the socket is open and before it starts serving, so a test can
// learn the OS-assigned port when GALLEY_PORT=0.
func run(ctx context.Context, getenv func(string) string, stdout io.Writer, ready chan<- net.Addr) error {
	cfg, err := config.Load(getenv)
	if err != nil {
		return fmt.Errorf("configuration error: %w", err)
	}

	logger := slog.New(slog.NewJSONHandler(stdout, nil))
	startedAt := time.Now().UTC()
	handler := httpapi.NewHandler(cfg, startedAt, logger)

	listener, err := net.Listen("tcp", cfg.Addr())
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", cfg.Addr(), err)
	}

	if ready != nil {
		ready <- listener.Addr()
	}

	httpServer := &http.Server{Handler: handler}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- httpServer.Serve(listener)
	}()

	logger.Info("galley listening",
		"addr", listener.Addr().String(),
		"environment", cfg.Environment,
		"version", cfg.Version,
	)

	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("server error: %w", err)
	case <-ctx.Done():
		logger.Info("shutdown signal received, draining connections")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown failed: %w", err)
	}

	if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server error during shutdown: %w", err)
	}

	logger.Info("galley stopped")
	return nil
}
