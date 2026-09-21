package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRun_ServesFakeProviderUntilContextCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	done := make(chan error, 1)

	go func() {
		done <- run(ctx, func(string) string { return "" }, io.Discard, ready)
	}()

	url := waitForReady(t, ready)

	resp, err := http.Get(url + "/_fake/healthz")
	if err != nil {
		t.Fatalf("healthz request failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz: got status %d, want 200", resp.StatusCode)
	}

	cancel()
	waitForDone(t, done)
}

func TestRun_WritesAddrFileWhenConfigured(t *testing.T) {
	dir := t.TempDir()
	addrFile := filepath.Join(dir, "githubfake.env")

	ctx, cancel := context.WithCancel(context.Background())
	getenv := func(key string) string {
		if key == "GITHUBFAKE_ADDR_FILE" {
			return addrFile
		}
		return ""
	}
	ready := make(chan string, 1)
	done := make(chan error, 1)

	go func() {
		done <- run(ctx, getenv, io.Discard, ready)
	}()

	waitForReady(t, ready)

	content, err := os.ReadFile(addrFile)
	if err != nil {
		t.Fatalf("failed to read address file: %v", err)
	}
	for _, want := range []string{
		"GITHUBFAKE_URL=http",
		"GITHUBFAKE_CLIENT_ID=githubfake-client-id",
		"GITHUBFAKE_CLIENT_SECRET=githubfake-client-secret",
		"GITHUBFAKE_OWNER_LOGIN=ticketit-test-owner",
	} {
		if !strings.Contains(string(content), want) {
			t.Errorf("address file missing %q, got:\n%s", want, content)
		}
	}

	cancel()
	waitForDone(t, done)
}

func waitForReady(t *testing.T, ready <-chan string) string {
	t.Helper()
	select {
	case url := <-ready:
		return url
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for githubfake to start")
		return ""
	}
}

func waitForDone(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run returned an error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for run to stop")
	}
}
