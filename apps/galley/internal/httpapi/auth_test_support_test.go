package httpapi

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/githubfake"
)

// testOwnerLogin is GALLEY_OWNER_GITHUB_LOGIN for every test below:
// kept equal to githubfake.TestOwnerIdentity.Login (see that
// identity's own doc comment for why every package's tests share one
// fixture identity rather than each inventing its own).
var testOwnerLogin = githubfake.TestOwnerIdentity.Login

// startTestGalley wraps a real NewHandler in a real httptest.Server
// bound to a pre-known address, so cfg.BaseURL (baked into the OAuth
// redirect_uri) can be set correctly *before* the handler is
// constructed -- the same problem and solution as
// cmd/galley/restart_durability_test.go's reserveLocalAddr, needed
// here because a full sign-in flow must actually round-trip through a
// real listener (start -> fake provider -> callback), which
// httptest.NewRecorder cannot follow.
func startTestGalley(t *testing.T, pool *pgxpool.Pool, environment string, fake *githubfake.Server) (*httptest.Server, config.Config) {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to reserve a local address: %v", err)
	}

	cfg := config.Config{
		Environment:           environment,
		Version:               "dev",
		OwnerGitHubLogin:      testOwnerLogin,
		OAuthClientID:         fake.ClientID,
		OAuthClientSecret:     fake.ClientSecret,
		OAuthGitHubBaseURL:    fake.URL,
		OAuthGitHubAPIBaseURL: fake.URL,
		BaseURL:               "http://" + ln.Addr().String(),
	}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))

	srv := &httptest.Server{Listener: ln, Config: &http.Server{Handler: handler}}
	srv.Start()
	t.Cleanup(srv.Close)
	return srv, cfg
}
