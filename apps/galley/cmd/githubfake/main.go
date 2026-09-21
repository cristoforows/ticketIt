// Command githubfake is a standalone, real-port substitute for GitHub's
// OAuth/identity endpoints, built on internal/githubfake's fixtures.
//
// Test/development substitute only -- it is never wired into cmd/galley,
// never reachable from a production build, and never talks to real
// github.com or holds any real credential. internal/githubfake.New's
// constructor takes a testing.TB and so only works inside a Go test
// binary; a real browser (e2e/run.sh's suite) needs something it can
// actually navigate to, which is the one thing this command exists to
// provide. See apps/galley/README.md, "Owner configuration and GitHub
// OAuth sign-in," and e2e/README.md, "Signing in."
//
// Usage:
//
//	go run ./cmd/githubfake
//	GITHUBFAKE_ADDR_FILE=/tmp/githubfake.env go run ./cmd/githubfake
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/cristoforows/ticketIt/apps/galley/internal/githubfake"
)

func main() {
	if err := run(context.Background(), os.Getenv, os.Stdout, nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run starts the fake provider and blocks until ctx is canceled (a real
// SIGINT/SIGTERM, or a test canceling ctx directly) -- mirroring
// cmd/galley's own run() so this command is testable the same way,
// without sending itself a real OS signal.
//
// If ready is non-nil, run sends the running server's URL on it once
// serving has started (and, if configured, the address file has been
// written) and before it blocks -- a test's way of learning the
// OS-assigned port without polling a file.
func run(ctx context.Context, getenv func(string) string, stdout io.Writer, ready chan<- string) error {
	// Always the one fixture identity Go's own test suite already
	// treats as "the configured owner" (internal/githubfake.TestOwnerIdentity)
	// -- one source of truth for "the fake owner," rather than this
	// command inventing a second, e2e-only identity. Browser specs that
	// need a different identity switch it at runtime via POST
	// /_fake/identity (see internal/githubfake.Start).
	identity := githubfake.TestOwnerIdentity

	server := githubfake.Start(identity)
	defer server.Close()

	logger := slog.New(slog.NewJSONHandler(stdout, nil))
	logger.Info("githubfake serving -- test/development substitute, never real GitHub",
		"url", server.URL,
		"ownerLogin", identity.Login,
	)

	if addrFile := getenv("GITHUBFAKE_ADDR_FILE"); addrFile != "" {
		if err := writeAddrFile(addrFile, server, identity); err != nil {
			return fmt.Errorf("failed to write address file: %w", err)
		}
	}

	if ready != nil {
		ready <- server.URL
	}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	logger.Info("githubfake stopped")
	return nil
}

// writeAddrFile records this process's real address and fixed fake
// credentials as shell-sourceable KEY=VALUE lines -- e2e/run.sh's way of
// learning an OS-assigned port and the fixed-but-not-hardcoded-in-bash
// client id/secret/owner login without parsing log output.
func writeAddrFile(path string, server *githubfake.Server, identity githubfake.Identity) error {
	content := fmt.Sprintf(
		"GITHUBFAKE_URL=%s\nGITHUBFAKE_CLIENT_ID=%s\nGITHUBFAKE_CLIENT_SECRET=%s\nGITHUBFAKE_OWNER_LOGIN=%s\n",
		server.URL, server.ClientID, server.ClientSecret, identity.Login,
	)
	return os.WriteFile(path, []byte(content), 0o600)
}
