// Package githubfake is issue #54's required test substitute for
// GitHub's OAuth/identity endpoints: a local HTTP server, from
// fixtures, that no test ever needs a real GitHub OAuth app or a
// network call to github.com to exercise. It is a committed,
// non-"_test.go" helper (like internal/postgres/testsupport.go) so it
// can be imported from every package's tests that need it
// (internal/httpapi and cmd/galley alike), not just its own package.
//
// It implements the three calls internal/auth.GitHubClient makes:
// GET /login/oauth/authorize, POST /login/oauth/access_token, and
// GET /user -- shaped the same way real GitHub's are (form-encoded
// authorize/token request, JSON token/identity responses), so
// internal/auth's client code is exercised exactly as it would be
// against the real provider.
//
// Test/development substitute only, never real GitHub. New's
// constructor requires a testing.TB and so only works inside a Go test
// binary; issue #55's cmd/githubfake wraps Start (below) instead, to
// serve these same fixtures on a real port a browser can navigate to
// for the e2e suite. cmd/githubfake is its own standalone command --
// this package is never imported by cmd/galley.
package githubfake

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// Identity is the fixture account a Server hands back from /user after
// a completed exchange.
type Identity struct {
	ID    int64
	Login string
}

// TestOwnerIdentity is the one fixture identity every package's tests
// that need "the configured owner" should sign in as, rather than
// picking their own. Every Go test package runs as its own process,
// but they all share the same real, persistent ticketit_test database
// (apps/galley/README.md, "Testing against real PostgreSQL") -- and
// issue #54's Owner is a database-enforced singleton
// (owners_singleton_uq). Using one common identity means whichever
// test process bootstraps the Owner first, every other test's sign-in
// as this same identity still succeeds by matching that link, instead
// of every package racing to bootstrap a different "owner" and losing.
var TestOwnerIdentity = Identity{ID: 900000001, Login: "ticketit-test-owner"}

// NonOwnerIdentity is a fixture identity that never matches
// TestOwnerIdentity, for tests exercising the non-owner rejection
// path.
var NonOwnerIdentity = Identity{ID: 900000002, Login: "ticketit-test-non-owner"}

// Server is a fake GitHub OAuth/identity provider bound to an
// OS-assigned loopback port, reachable by both the test process itself
// and, since it is a real net.Listener (httptest.NewServer), a
// separate OS process a test spawns (cmd/galley's restart-durability
// tests) -- an in-memory http.Handler alone could not be reached from
// there.
type Server struct {
	URL          string
	ClientID     string
	ClientSecret string

	srv *httptest.Server

	mu           sync.Mutex
	identity     Identity
	pendingCodes map[string]Identity
	issuedTokens map[string]Identity
}

// Start starts a fake provider that will hand back identity as the
// signed-in account once a full authorize -> exchange -> identity round
// trip completes, independent of any testing.TB -- unlike New below,
// this can be called from a plain standalone process (cmd/githubfake),
// which is what lets a real browser (e2e/run.sh) reach one at all. New
// is a thin wrapper adding Go-test cleanup; every existing Go-test
// caller keeps using New unchanged. Fixed, non-secret fake credentials
// -- there is no real GitHub OAuth app anywhere in this repository
// (AGENTS.md, "Paid resources").
func Start(identity Identity) *Server {
	s := &Server{
		ClientID:     "githubfake-client-id",
		ClientSecret: "githubfake-client-secret",
		identity:     identity,
		pendingCodes: make(map[string]Identity),
		issuedTokens: make(map[string]Identity),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /login/oauth/authorize", s.handleAuthorize)
	mux.HandleFunc("POST /login/oauth/access_token", s.handleAccessToken)
	mux.HandleFunc("GET /user", s.handleUser)
	// /_fake/* is this substitute's own control surface, not part of
	// real GitHub's API: a browser-driven e2e spec has no way to call
	// SetIdentity directly (it isn't Go code), so it switches between
	// the shared fake-provider process's fixture identities over HTTP
	// instead -- e.g. to exercise non-owner rejection after an owner
	// sign-in already happened against the same running process.
	mux.HandleFunc("GET /_fake/healthz", s.handleHealthz)
	mux.HandleFunc("POST /_fake/identity", s.handleSetIdentity)

	s.srv = httptest.NewServer(mux)
	s.URL = s.srv.URL
	return s
}

// New starts a fake provider for use inside a Go test: identical to
// Start, but registers tb.Cleanup so callers never call Close
// themselves. Every pre-existing caller of New keeps working unchanged.
func New(tb testing.TB, identity Identity) *Server {
	tb.Helper()
	s := Start(identity)
	tb.Cleanup(s.Close)
	return s
}

// Close stops the server. Only needed by a caller that used Start
// directly rather than New's testing.TB-based cleanup -- currently just
// cmd/githubfake.
func (s *Server) Close() {
	s.srv.Close()
}

// SetIdentity changes the account New's caller configured, for a test
// that signs in more than once against the same fake server (e.g. an
// owner sign-in followed by a different, non-owner one).
func (s *Server) SetIdentity(identity Identity) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.identity = identity
}

// handleAuthorize stands in for GitHub's own consent screen: a real
// user would see and approve a prompt here. This fixture skips that
// interaction entirely and immediately redirects back to redirect_uri
// with a single-use code, as if consent had just been granted.
func (s *Server) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("client_id") != s.ClientID {
		http.Error(w, "unknown client_id", http.StatusBadRequest)
		return
	}
	redirectURI := q.Get("redirect_uri")
	if redirectURI == "" {
		http.Error(w, "missing redirect_uri", http.StatusBadRequest)
		return
	}

	code, err := generateOpaqueToken()
	if err != nil {
		http.Error(w, "failed to generate a code", http.StatusInternalServerError)
		return
	}
	s.mu.Lock()
	s.pendingCodes[code] = s.identity
	s.mu.Unlock()

	loc, err := url.Parse(redirectURI)
	if err != nil {
		http.Error(w, "invalid redirect_uri", http.StatusBadRequest)
		return
	}
	dest := loc.Query()
	dest.Set("code", code)
	dest.Set("state", q.Get("state"))
	loc.RawQuery = dest.Encode()

	http.Redirect(w, r, loc.String(), http.StatusFound)
}

// handleAccessToken exchanges a code minted by handleAuthorize for a
// fresh access token. The code is single-use: a second exchange
// attempt with the same code (there being no pending code left to
// match) is rejected, the same shape real GitHub uses
// (bad_verification_code).
func (s *Server) handleAccessToken(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form body", http.StatusBadRequest)
		return
	}
	if r.PostForm.Get("client_id") != s.ClientID || r.PostForm.Get("client_secret") != s.ClientSecret {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "incorrect_client_credentials"})
		return
	}

	s.mu.Lock()
	code := r.PostForm.Get("code")
	identity, valid := s.pendingCodes[code]
	if valid {
		delete(s.pendingCodes, code)
	}
	s.mu.Unlock()

	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_verification_code"})
		return
	}

	token, err := generateOpaqueToken()
	if err != nil {
		http.Error(w, "failed to generate a token", http.StatusInternalServerError)
		return
	}
	s.mu.Lock()
	s.issuedTokens[token] = identity
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]string{
		"access_token": token,
		"token_type":   "bearer",
		"scope":        "read:user",
	})
}

// handleUser returns the identity captured when the code was issued.
func (s *Server) handleUser(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	token, bearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	identity, valid := s.issuedTokens[token]
	s.mu.Unlock()

	if !bearer || !valid {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "Bad credentials"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":    identity.ID,
		"login": identity.Login,
	})
}

// handleHealthz lets a caller that only knows this process's address
// (not any Go API) confirm the fake provider is actually accepting
// connections before it navigates a browser at it -- e2e/run.sh's
// startup gate for every process it starts.
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// handleSetIdentity lets a caller outside this Go process choose which
// fixture identity subsequent authorizations use, by name rather than
// by numeric id/login -- e2e/run.sh's one shared fake-provider process
// serves every browser spec, and specs needing a different identity
// (e.g. non-owner rejection, after an owner sign-in already happened
// against the same process) select it explicitly through this endpoint
// instead of assuming whatever the process started with.
func (s *Server) handleSetIdentity(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Preset string `json:"preset"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	var identity Identity
	switch body.Preset {
	case "owner":
		identity = TestOwnerIdentity
	case "non-owner":
		identity = NonOwnerIdentity
	default:
		http.Error(w, fmt.Sprintf(`invalid "preset" %q: must be "owner" or "non-owner"`, body.Preset), http.StatusBadRequest)
		return
	}

	s.SetIdentity(identity)
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// generateOpaqueToken mints a fixture code/token. It does not need to
// be cryptographically significant -- this is a fake provider, not a
// security boundary -- only unpredictable enough that two calls never
// collide within a test run.
func generateOpaqueToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
