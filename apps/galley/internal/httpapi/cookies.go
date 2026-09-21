package httpapi

import (
	"net/http"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/auth"
	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

// SessionCookieName and StateCookieName are exported so any later
// slice (starting with #55's Swiftlet sign-in UI, and internal/authtest's
// browser-simulation helper) can name them without duplicating the
// literal. Neither cookie's value is ever anything but the opaque
// token itself -- see internal/auth's package doc.
const (
	SessionCookieName = "ticketit_session"
	StateCookieName   = "ticketit_oauth_state"
)

// githubCallbackPath is registered in contracts/openapi.yaml and used
// both to build the redirect_uri sent to the provider (start) and, via
// StateCookiePath below, to scope the state cookie to exactly the two
// routes that ever read it.
const githubCallbackPath = "/api/auth/github/callback"

// stateCookiePath scopes the state cookie to the OAuth routes only --
// it has no reason to be sent on every request the way the session
// cookie does.
const stateCookiePath = "/api/auth/github"

// secureCookie reports whether cookies should carry the Secure
// attribute: only in production, so plain-HTTP local development still
// works, matching issue #54's explicit "Secure in production" rule.
func secureCookie(cfg config.Config) bool {
	return cfg.Environment == config.EnvProduction
}

func newSessionCookie(cfg config.Config, raw string, expiresAt time.Time) *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    raw,
		Path:     "/",
		Expires:  expiresAt,
		HttpOnly: true,
		Secure:   secureCookie(cfg),
		SameSite: http.SameSiteLaxMode,
	}
}

// expiredSessionCookie clears the session cookie client-side. Used on
// sign-out and whenever a session is found to be invalid/expired, so a
// stale cookie is never left behind for a browser to keep resending.
func expiredSessionCookie(cfg config.Config) *http.Cookie {
	c := newSessionCookie(cfg, "", time.Unix(0, 0))
	c.MaxAge = -1
	return c
}

func newStateCookie(cfg config.Config, raw string) *http.Cookie {
	return &http.Cookie{
		Name:     StateCookieName,
		Value:    raw,
		Path:     stateCookiePath,
		MaxAge:   int(auth.StateTTL.Seconds()),
		HttpOnly: true,
		Secure:   secureCookie(cfg),
		SameSite: http.SameSiteLaxMode,
	}
}

// expiredStateCookie clears the state cookie. The callback clears it
// unconditionally on every attempt (success, failure, or replay) --
// state is single-use by design, so there is never a reason to keep it
// around past one callback request.
func expiredStateCookie(cfg config.Config) *http.Cookie {
	c := newStateCookie(cfg, "")
	c.MaxAge = -1
	return c
}
