package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/auth"
	"github.com/cristoforows/ticketIt/apps/galley/internal/authtest"
	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/githubfake"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

// TestOAuthSignIn_HappyPath is issue #54's required happy-path test:
// the configured Owner completes the full authorize -> exchange ->
// identity round trip against the substitute provider and ends up
// with a persisted session and a linked identity keyed by the
// immutable provider account id.
func TestOAuthSignIn_HappyPath(t *testing.T) {
	pool := postgres.NewTestPool(t)
	fake := githubfake.New(t, githubfake.TestOwnerIdentity)
	srv, _ := startTestGalley(t, pool, config.EnvDevelopment, fake)
	client := authtest.NewClient()

	authtest.SignIn(t, client, srv.URL)

	resp, err := client.Get(srv.URL + "/api/session")
	if err != nil {
		t.Fatalf("GET /api/session failed: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/session status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, data)
	}
	var session SessionResponse
	if err := json.Unmarshal(data, &session); err != nil {
		t.Fatalf("failed to decode session response %q: %v", data, err)
	}
	if session.Owner.Login != githubfake.TestOwnerIdentity.Login {
		t.Errorf("session.Owner.Login = %q, want %q", session.Owner.Login, githubfake.TestOwnerIdentity.Login)
	}

	link := queryOwnerIdentity(t, pool)
	if !link.exists {
		t.Fatal("no owner_identities row exists after a successful sign-in")
	}
	if link.providerAccountID != githubfake.TestOwnerIdentity.ID {
		t.Errorf("linked provider_account_id = %d, want the immutable id %d (not derived from login)", link.providerAccountID, githubfake.TestOwnerIdentity.ID)
	}

	var ownerCount int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM owners`).Scan(&ownerCount); err != nil {
		t.Fatalf("failed to count owners: %v", err)
	}
	if ownerCount != 1 {
		t.Errorf("owners row count = %d, want exactly 1 (one Owner per deployment)", ownerCount)
	}
}

// TestOAuthSignIn_NonOwnerRejected is issue #54's required non-owner
// rejection test: a real, successful provider round trip for an
// identity that is not the configured Owner must still end in
// rejection with the stable "owner_mismatch" code, no session, and no
// mutation of whatever Owner link already exists (there may already be
// one, bootstrapped by another test sharing this database -- see
// githubfake.TestOwnerIdentity's doc comment). This is true whether or
// not the Owner has been bootstrapped yet: an unmatched login at
// bootstrap time and a mismatched id against an existing link are both
// "owner_mismatch," never a silent difference.
func TestOAuthSignIn_NonOwnerRejected(t *testing.T) {
	pool := postgres.NewTestPool(t)
	// cfg.OwnerGitHubLogin (baked into startTestGalley) is
	// githubfake.TestOwnerIdentity's login; this fake server always
	// answers with a different identity.
	fake := githubfake.New(t, githubfake.NonOwnerIdentity)
	srv, _ := startTestGalley(t, pool, config.EnvDevelopment, fake)
	client := authtest.NewClient()

	before := queryOwnerIdentity(t, pool)

	resp := performOAuthCallback(t, client, srv.URL)
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("callback status = %d, want %d; body=%s", resp.StatusCode, http.StatusForbidden, data)
	}
	var body ErrorBody
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatalf("failed to decode error body %q: %v", data, err)
	}
	if body.Error.Code != "owner_mismatch" {
		t.Errorf("Error.Code = %q, want %q", body.Error.Code, "owner_mismatch")
	}

	if v := authtest.SessionCookieValue(client, srv.URL); v != "" {
		t.Error("a session cookie was set for a rejected non-owner sign-in")
	}

	after := queryOwnerIdentity(t, pool)
	if before != after {
		t.Errorf("the owner identity link changed after a rejected non-owner sign-in: before=%+v after=%+v", before, after)
	}
}

// performOAuthCallback drives the full authorize -> fake-provider ->
// callback redirect chain manually (not following the final redirect
// automatically), so the caller can inspect the callback's own
// response directly regardless of whether it is a success redirect or
// an error body.
func performOAuthCallback(t *testing.T, client *http.Client, baseURL string) *http.Response {
	t.Helper()
	noFollow := &http.Client{
		Jar: client.Jar,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	resp1, err := noFollow.Get(baseURL + "/api/auth/github/start")
	if err != nil {
		t.Fatalf("GET /api/auth/github/start failed: %v", err)
	}
	loc1 := resp1.Header.Get("Location")
	resp1.Body.Close()
	if resp1.StatusCode != http.StatusFound || loc1 == "" {
		t.Fatalf("start status = %d, Location = %q; want %d with a redirect target", resp1.StatusCode, loc1, http.StatusFound)
	}

	resp2, err := noFollow.Get(loc1)
	if err != nil {
		t.Fatalf("GET the provider's authorize endpoint (%s) failed: %v", loc1, err)
	}
	loc2 := resp2.Header.Get("Location")
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusFound || loc2 == "" {
		t.Fatalf("provider authorize status = %d, Location = %q; want %d with a redirect target", resp2.StatusCode, loc2, http.StatusFound)
	}

	resp3, err := noFollow.Get(loc2)
	if err != nil {
		t.Fatalf("GET the callback (%s) failed: %v", loc2, err)
	}
	return resp3
}

// ownerIdentitySnapshot is a comparable projection of the one
// owner_identities row (issue #54's "one Owner per deployment"), used
// to assert nothing changed across a rejected sign-in attempt.
type ownerIdentitySnapshot struct {
	exists            bool
	providerAccountID int64
	login             string
}

func queryOwnerIdentity(t *testing.T, pool *pgxpool.Pool) ownerIdentitySnapshot {
	t.Helper()
	var snap ownerIdentitySnapshot
	row := pool.QueryRow(context.Background(),
		`SELECT provider_account_id, login FROM owner_identities WHERE provider = 'github' LIMIT 1`)
	switch err := row.Scan(&snap.providerAccountID, &snap.login); {
	case err == nil:
		snap.exists = true
		return snap
	case errors.Is(err, pgx.ErrNoRows):
		return ownerIdentitySnapshot{}
	default:
		t.Fatalf("failed to query owner_identities: %v", err)
		return ownerIdentitySnapshot{}
	}
}

// TestOAuthCallback_MissingOrInvalidState is issue #54's required
// missing/invalid `state` coverage. Every case here is checked before
// the handler would ever call the provider, so none of them need a
// fake provider server at all.
func TestOAuthCallback_MissingOrInvalidState(t *testing.T) {
	pool := postgres.NewTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), pool, testLogger(&bytes.Buffer{}))

	cases := []struct {
		name   string
		query  string
		cookie *http.Cookie
	}{
		{"missing_cookie_and_param", "code=abc", nil},
		{"missing_cookie_only", "code=abc&state=some-state", nil},
		{"missing_param_only", "code=abc", &http.Cookie{Name: StateCookieName, Value: "some-state"}},
		{"mismatched_cookie_and_param", "code=abc&state=different-value", &http.Cookie{Name: StateCookieName, Value: "some-state"}},
		{"well_formed_but_never_issued", "code=abc&state=never-issued-value", &http.Cookie{Name: StateCookieName, Value: "never-issued-value"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?"+tc.query, nil)
			if tc.cookie != nil {
				req.AddCookie(tc.cookie)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
			var body ErrorBody
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
			}
			if body.Error.Code != "invalid_oauth_state" {
				t.Errorf("Error.Code = %q, want %q", body.Error.Code, "invalid_oauth_state")
			}
		})
	}
}

// TestOAuthCallback_ReplayedState is issue #54's required replay
// coverage: a state value already consumed by one callback request
// must be rejected by a second request presenting the exact same
// value and cookie, even within its normal expiry window. The first
// request here is deliberately left to fail for an unrelated reason
// (a missing `code`) after state validation succeeds -- what matters
// is only that the state itself was consumed, proven by the second,
// otherwise-identical request being rejected specifically for its
// state.
func TestOAuthCallback_ReplayedState(t *testing.T) {
	pool := postgres.NewTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), pool, testLogger(&bytes.Buffer{}))

	rawState, err := auth.CreateState(context.Background(), pool)
	if err != nil {
		t.Fatalf("failed to create a real oauth state: %v", err)
	}

	makeRequest := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?state="+url.QueryEscape(rawState), nil)
		req.AddCookie(&http.Cookie{Name: StateCookieName, Value: rawState})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	first := makeRequest()
	var firstBody ErrorBody
	if err := json.Unmarshal(first.Body.Bytes(), &firstBody); err != nil {
		t.Fatalf("failed to decode first response %q: %v", first.Body.String(), err)
	}
	if firstBody.Error.Code == "invalid_oauth_state" {
		t.Fatalf("first use of a fresh state was itself rejected as invalid_oauth_state; body=%s", first.Body.String())
	}

	second := makeRequest()
	if second.Code != http.StatusBadRequest {
		t.Fatalf("replayed request status = %d, want %d; body=%s", second.Code, http.StatusBadRequest, second.Body.String())
	}
	var secondBody ErrorBody
	if err := json.Unmarshal(second.Body.Bytes(), &secondBody); err != nil {
		t.Fatalf("failed to decode second response %q: %v", second.Body.String(), err)
	}
	if secondBody.Error.Code != "invalid_oauth_state" {
		t.Errorf("replayed request Error.Code = %q, want %q", secondBody.Error.Code, "invalid_oauth_state")
	}
}

// TestSession_Expired is issue #54's required expired-session test.
// The session is manufactured directly via internal/auth with an
// already-past expiry -- production never takes this path, only
// CreateSession's fixed SessionTTL does -- so the test does not need
// to wait out a real TTL.
func TestSession_Expired(t *testing.T) {
	pool := postgres.NewTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), pool, testLogger(&bytes.Buffer{}))

	identity := githubfake.TestOwnerIdentity
	ownerID, _, err := auth.ResolveOwner(context.Background(), pool, identity.Login, auth.ProviderIdentity{ID: identity.ID, Login: identity.Login})
	if err != nil {
		t.Fatalf("failed to resolve the test owner: %v", err)
	}
	rawSession, _, err := auth.CreateSessionWithExpiry(context.Background(), pool, ownerID, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatalf("failed to create an expired session: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: rawSession})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
	}
	if body.Error.Code != "unauthenticated" {
		t.Errorf("Error.Code = %q, want %q", body.Error.Code, "unauthenticated")
	}
}

// TestSession_SignOutRevokes is issue #54's required sign-out test:
// after DELETE /api/session, the same token no longer authenticates.
func TestSession_SignOutRevokes(t *testing.T) {
	pool := postgres.NewTestPool(t)
	fake := githubfake.New(t, githubfake.TestOwnerIdentity)
	srv, _ := startTestGalley(t, pool, config.EnvDevelopment, fake)
	client := authtest.NewClient()
	authtest.SignIn(t, client, srv.URL)

	getResp, err := client.Get(srv.URL + "/api/session")
	if err != nil {
		t.Fatalf("GET /api/session failed: %v", err)
	}
	getResp.Body.Close()
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/session before sign-out = %d, want %d", getResp.StatusCode, http.StatusOK)
	}

	signOutReq, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/session", nil)
	if err != nil {
		t.Fatalf("failed to build sign-out request: %v", err)
	}
	signOutResp, err := client.Do(signOutReq)
	if err != nil {
		t.Fatalf("DELETE /api/session failed: %v", err)
	}
	signOutResp.Body.Close()
	if signOutResp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /api/session status = %d, want %d", signOutResp.StatusCode, http.StatusNoContent)
	}

	afterResp, err := client.Get(srv.URL + "/api/session")
	if err != nil {
		t.Fatalf("GET /api/session after sign-out failed: %v", err)
	}
	defer afterResp.Body.Close()
	if afterResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET /api/session after sign-out = %d, want %d", afterResp.StatusCode, http.StatusUnauthorized)
	}
}

// TestProtectedRoute_NoSession is issue #54's required
// protected-route-without-a-session test, covering every non-public
// route this slice adds or retrofits.
func TestProtectedRoute_NoSession(t *testing.T) {
	pool := postgres.NewTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), pool, testLogger(&bytes.Buffer{}))

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/session"},
		{http.MethodDelete, "/api/session"},
		{http.MethodGet, "/api/dev/diagnostic-notes"},
		{http.MethodPost, "/api/dev/diagnostic-notes"},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
			}
			var body ErrorBody
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
			}
			if body.Error.Code != "unauthenticated" {
				t.Errorf("Error.Code = %q, want %q", body.Error.Code, "unauthenticated")
			}
		})
	}
}

// TestGetStatus_PublicNoSessionRequired proves /api/status stays
// public (no session required) and leaks no Owner/session detail, the
// two things issue #54 requires of it explicitly.
func TestGetStatus_PublicNoSessionRequired(t *testing.T) {
	pool := postgres.NewTestPool(t)
	handler := NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), pool, testLogger(&bytes.Buffer{}))

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil) // deliberately no cookie
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (no session required); body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	body := rec.Body.String()
	for _, leak := range []string{"owner", "login", "session"} {
		if strings.Contains(strings.ToLower(body), leak) {
			t.Errorf("GET /api/status response contains %q, want no Owner/session detail: %s", leak, body)
		}
	}
}
