// Package authtest drives Galley's GitHub OAuth sign-in flow the way a
// browser would -- following every redirect and carrying cookies --
// against any running Galley instance: an in-process httptest.Server
// wrapping the real handler, or a genuinely separate OS process (see
// cmd/galley's restart-durability tests). It is a committed,
// non-"_test.go" helper for the same reason
// internal/postgres/testsupport.go is: it needs to be importable from
// more than one package's own tests.
package authtest

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"testing"
)

// SessionCookieName must match internal/httpapi's own session cookie
// name. Duplicated here (rather than importing internal/httpapi,
// which would need to export it) because internal/httpapi itself
// imports internal/authtest's sibling package internal/githubfake in
// its tests -- an import back from here would risk a cycle as this
// package grows. Covered indirectly: SignIn fails loudly if no cookie
// by this name ever appears.
const SessionCookieName = "ticketit_session"

// NewClient returns an http.Client with a fresh, empty cookie jar --
// the minimum a caller needs to look like one continuous browser
// session across every call in this package and any calls the test
// makes afterward.
func NewClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar}
}

// SignIn drives baseURL's GET /api/auth/github/start through to
// completion using client, which must carry a cookie jar (NewClient
// above). It follows Galley's redirect to the configured fake provider
// and the provider's redirect back to Galley's callback, exactly as a
// browser would, and fails the test if the flow does not end with a
// session cookie set for baseURL's host. The final response itself
// (Galley's own post-sign-in redirect target, "/", which this slice
// does not otherwise handle) is deliberately not asserted on -- only
// that the cookie was set, which is the one contract this slice owes
// #55's Swiftlet sign-in UI.
func SignIn(tb testing.TB, client *http.Client, baseURL string) {
	tb.Helper()

	resp, err := client.Get(baseURL + "/api/auth/github/start")
	if err != nil {
		tb.Fatalf("sign-in flow failed: %v", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	u, err := url.Parse(baseURL)
	if err != nil {
		tb.Fatalf("invalid baseURL %q: %v", baseURL, err)
	}
	for _, c := range client.Jar.Cookies(u) {
		if c.Name == SessionCookieName {
			return
		}
	}
	tb.Fatalf("sign-in flow completed (final status %d) but no %q cookie was set", resp.StatusCode, SessionCookieName)
}

// SessionCookieValue returns the raw session cookie value client holds
// for baseURL's host, or "" if none. Used by tests that need the raw
// token directly (e.g. to present it across a process restart where a
// *fresh* client/jar is used deliberately, to prove the token itself
// -- not any in-memory client state -- is what makes the session
// valid).
func SessionCookieValue(client *http.Client, baseURL string) string {
	u, err := url.Parse(baseURL)
	if err != nil {
		return ""
	}
	for _, c := range client.Jar.Cookies(u) {
		if c.Name == SessionCookieName {
			return c.Value
		}
	}
	return ""
}
