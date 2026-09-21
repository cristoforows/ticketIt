package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/auth"
)

// authTimeout bounds every database call this file makes, matching
// diagnosticTimeout's rationale (diagnostic.go): fail the request
// promptly rather than hang it. It does not bound calls to the OAuth
// provider itself -- internal/auth.GitHubClient has its own timeout
// for that.
const authTimeout = 5 * time.Second

// StartGithubOAuth begins a sign-in attempt: see
// contracts/openapi.yaml's operation doc and
// docs/evidence/m2/54-oauth-session.md for the full state/cookie
// design this implements.
func (s *server) StartGithubOAuth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), authTimeout)
	defer cancel()

	rawState, err := auth.CreateState(ctx, s.pool)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to start sign-in")
		return
	}

	http.SetCookie(w, newStateCookie(s.cfg, rawState))
	redirectURI := s.cfg.BaseURL + githubCallbackPath
	http.Redirect(w, r, s.githubClient.AuthorizeURL(rawState, redirectURI), http.StatusFound)
}

// CompleteGithubOAuth validates state, exchanges code, resolves the
// Owner, and either issues a session or rejects a non-owner identity.
// State is validated and consumed before anything else -- including
// before looking at params.Error or params.Code -- so a request
// carrying a stale, mismatched, or replayed state never reaches the
// provider or the Owner-matching logic at all.
func (s *server) CompleteGithubOAuth(w http.ResponseWriter, r *http.Request, params CompleteGithubOAuthParams) {
	ctx, cancel := context.WithTimeout(r.Context(), authTimeout)
	defer cancel()

	cookieState := ""
	if c, err := r.Cookie(StateCookieName); err == nil {
		cookieState = c.Value
	}
	queryState := ""
	if params.State != nil {
		queryState = *params.State
	}

	// state is single-use regardless of outcome: clear the cookie on
	// every path from here on, success or failure.
	http.SetCookie(w, expiredStateCookie(s.cfg))

	if cookieState == "" || queryState == "" || cookieState != queryState {
		writeError(w, http.StatusBadRequest, "invalid_oauth_state", "state is missing or does not match this browser")
		return
	}
	consumed, err := auth.ConsumeState(ctx, s.pool, cookieState)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to verify state")
		return
	}
	if !consumed {
		writeError(w, http.StatusBadRequest, "invalid_oauth_state", "state is invalid, expired, or already used")
		return
	}

	if params.Error != nil && *params.Error != "" {
		writeError(w, http.StatusBadRequest, "oauth_provider_error", "the provider reported an error: "+*params.Error)
		return
	}
	if params.Code == nil || *params.Code == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "missing code")
		return
	}

	redirectURI := s.cfg.BaseURL + githubCallbackPath
	accessToken, err := s.githubClient.Exchange(ctx, *params.Code, redirectURI)
	if err != nil {
		writeError(w, http.StatusBadGateway, "oauth_provider_error", "failed to exchange the authorization code")
		return
	}

	// accessToken is used exactly once, right here, and then never
	// referenced again -- not stored, not logged, not reused for any
	// further provider call. See docs/evidence/m2/54-oauth-session.md,
	// "Login is not account-action authorization."
	identity, err := s.githubClient.FetchIdentity(ctx, accessToken)
	if err != nil {
		writeError(w, http.StatusBadGateway, "oauth_provider_error", "failed to fetch the account identity")
		return
	}

	ownerID, _, err := auth.ResolveOwner(ctx, s.pool, s.cfg.OwnerGitHubLogin, auth.ProviderIdentity{
		ID:    identity.ID,
		Login: identity.Login,
	})
	if errors.Is(err, auth.ErrOwnerMismatch) {
		writeError(w, http.StatusForbidden, "owner_mismatch", "this GitHub account is not the configured owner")
		return
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to resolve the owner")
		return
	}

	rawSession, expiresAt, err := auth.CreateSession(ctx, s.pool, ownerID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to create the session")
		return
	}

	http.SetCookie(w, newSessionCookie(s.cfg, rawSession, expiresAt))
	http.Redirect(w, r, "/", http.StatusFound)
}

// GetSession returns the signed-in Owner. Unlike GET /api/status, this
// route is never public -- requireSession below is the whole point of
// it, not an add-on.
func (s *server) GetSession(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, SessionResponse{Owner: Owner{Id: int(owner.ID), Login: owner.Login}})
}

// SignOut revokes the current session and clears the cookie.
func (s *server) SignOut(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireSession(w, r); !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), authTimeout)
	defer cancel()

	if c, err := r.Cookie(SessionCookieName); err == nil {
		if err := auth.DeleteSession(ctx, s.pool, c.Value); err != nil {
			writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to sign out")
			return
		}
	}
	http.SetCookie(w, expiredSessionCookie(s.cfg))
	w.WriteHeader(http.StatusNoContent)
}

// requireSession is issue #54's authenticated-route convention: every
// handler for a non-public route calls this first and returns
// immediately if ok is false (the 401 response has already been
// written). See apps/galley/README.md, "Authenticated routes," for why
// this is a plain per-handler check rather than a global middleware --
// GetStatus must stay public, so a blanket middleware over every
// generated operation is the wrong shape here.
func (s *server) requireSession(w http.ResponseWriter, r *http.Request) (auth.OwnerView, bool) {
	c, err := r.Cookie(SessionCookieName)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
		return auth.OwnerView{}, false
	}

	ctx, cancel := context.WithTimeout(r.Context(), authTimeout)
	defer cancel()

	owner, ok, err := auth.LookupSession(ctx, s.pool, c.Value)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to verify session")
		return auth.OwnerView{}, false
	}
	if !ok {
		http.SetCookie(w, expiredSessionCookie(s.cfg))
		writeError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
		return auth.OwnerView{}, false
	}
	return owner, true
}
