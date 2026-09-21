package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

func fakeGetenv(values map[string]string) func(string) string {
	return func(key string) string {
		return values[key]
	}
}

// TestRun_ConfigurationFailure verifies that an invalid environment
// setting fails startup immediately with an actionable message, and
// never attempts to bind a socket.
func TestRun_ConfigurationFailure(t *testing.T) {
	getenv := fakeGetenv(map[string]string{"GALLEY_ENVIRONMENT": "staging"})
	var stdout bytes.Buffer

	err := run(context.Background(), getenv, &stdout, nil)
	if err == nil {
		t.Fatal("run() returned nil error for an invalid GALLEY_ENVIRONMENT, want an error")
	}
	if !strings.Contains(err.Error(), "GALLEY_ENVIRONMENT") {
		t.Errorf("error %q does not name the offending setting", err.Error())
	}
}

// TestRun_ServesStatusThenShutsDownCleanly boots the real server on an
// OS-assigned port, confirms GET /api/status actually serves over a
// real socket, requests shutdown by canceling ctx (the same path
// SIGINT/SIGTERM take via signal.NotifyContext), and then proves the
// socket was released by successfully re-binding the exact same
// address.
func TestRun_ServesStatusThenShutsDownCleanly(t *testing.T) {
	postgres.NewTestPool(t) // ensures the real test database exists and is migrated

	getenv := fakeGetenv(map[string]string{
		"GALLEY_HOST":                       "127.0.0.1",
		"GALLEY_PORT":                       "0",
		"DATABASE_URL":                      postgres.TestingURL(),
		"GALLEY_OWNER_GITHUB_LOGIN":         "test-owner",
		"GALLEY_OAUTH_GITHUB_CLIENT_ID":     "test-client-id",
		"GALLEY_OAUTH_GITHUB_CLIENT_SECRET": "test-client-secret",
	})
	var stdout bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())

	ready := make(chan net.Addr, 1)
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, getenv, &stdout, ready)
	}()

	var addr net.Addr
	select {
	case addr = <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the server to start listening")
	}

	resp, err := http.Get(fmt.Sprintf("http://%s/api/status", addr.String()))
	if err != nil {
		t.Fatalf("GET /api/status failed: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}

	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run() returned error after shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for graceful shutdown to complete")
	}

	// Proof that the listening socket was actually released: a new
	// listener can bind the exact same address right away.
	ln, err := net.Listen("tcp", addr.String())
	if err != nil {
		t.Fatalf("expected listening socket %s to be released after shutdown, got: %v", addr, err)
	}
	ln.Close()

	if !strings.Contains(stdout.String(), "galley stopped") {
		t.Errorf("expected a shutdown log line, stdout was: %s", stdout.String())
	}
}
