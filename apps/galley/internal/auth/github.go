package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// githubScope is the minimal GitHub OAuth scope needed to read the
// authenticated account's public identity (id, login) -- deployment.md
// ("Ownership and sign-in"): "Request only the access needed to
// establish identity." Nothing this slice does needs any broader
// scope; connected-account authorization for actual GitHub actions is
// M8's separate, later concern.
const githubScope = "read:user"

// providerHTTPTimeout bounds every outbound call to the OAuth provider
// (real or fixture), matching this codebase's existing convention of
// never letting an external dependency hang a request indefinitely
// (internal/postgres.HealthTimeout).
const providerHTTPTimeout = 5 * time.Second

// GitHubClient is a minimal GitHub OAuth authorization-code client:
// only the three calls issue #54 needs (authorize URL, code exchange,
// identity fetch). It deliberately does not become a general GitHub
// API client -- that is explicitly out of this slice's scope (see
// docs/evidence/m2/54-oauth-session.md, "Login is not account-action
// authorization").
type GitHubClient struct {
	// BaseURL serves the authorize and token endpoints
	// (".../login/oauth/..."); APIBaseURL serves the identity endpoint
	// (".../user") -- real GitHub splits these across github.com and
	// api.github.com, and every test points both at one local fixture
	// server instead.
	BaseURL      string
	APIBaseURL   string
	ClientID     string
	ClientSecret string
	// HTTPClient defaults to a client bounded by providerHTTPTimeout
	// when nil.
	HTTPClient *http.Client
}

func (c *GitHubClient) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: providerHTTPTimeout}
}

// AuthorizeURL builds the browser-facing redirect target for a fresh
// sign-in attempt: state is this attempt's anti-replay value (see
// state.go) and redirectURI is Galley's own callback, matching what
// Exchange below sends back to the provider.
func (c *GitHubClient) AuthorizeURL(state, redirectURI string) string {
	q := url.Values{
		"client_id":    {c.ClientID},
		"redirect_uri": {redirectURI},
		"state":        {state},
		"scope":        {githubScope},
	}
	return strings.TrimSuffix(c.BaseURL, "/") + "/login/oauth/authorize?" + q.Encode()
}

// oauthProviderError wraps any failure talking to the OAuth provider
// (network failure, non-2xx, or a well-formed provider-reported
// error), so callers can map every case to the one generic
// "oauth_provider_error" without ever surfacing the provider's raw
// response text.
type oauthProviderError struct {
	reason string
}

func (e *oauthProviderError) Error() string { return "oauth provider error: " + e.reason }

// Exchange trades an authorization code for an access token. The
// returned token is meant to be used exactly once, by FetchIdentity,
// and then discarded -- Exchange itself never persists or logs it.
func (c *GitHubClient) Exchange(ctx context.Context, code, redirectURI string) (accessToken string, err error) {
	form := url.Values{
		"client_id":     {c.ClientID},
		"client_secret": {c.ClientSecret},
		"code":          {code},
		"redirect_uri":  {redirectURI},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimSuffix(c.BaseURL, "/")+"/login/oauth/access_token",
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", &oauthProviderError{reason: "failed to build the token request"}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	// Asks the provider for a JSON response body; GitHub's endpoint
	// otherwise defaults to form-encoding it.
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", &oauthProviderError{reason: "failed to reach the token endpoint"}
	}
	defer resp.Body.Close()

	var body struct {
		AccessToken      string `json:"access_token"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body); err != nil {
		return "", &oauthProviderError{reason: "failed to decode the token response"}
	}
	if resp.StatusCode != http.StatusOK || body.Error != "" || body.AccessToken == "" {
		return "", &oauthProviderError{reason: "the provider rejected the authorization code"}
	}
	return body.AccessToken, nil
}

// FetchIdentity fetches the authenticated account's identity using
// accessToken. Callers must discard accessToken immediately after this
// call returns -- see the package doc and docs/evidence/m2/54-oauth-session.md.
func (c *GitHubClient) FetchIdentity(ctx context.Context, accessToken string) (ProviderIdentity, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimSuffix(c.APIBaseURL, "/")+"/user", nil)
	if err != nil {
		return ProviderIdentity{}, &oauthProviderError{reason: "failed to build the identity request"}
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return ProviderIdentity{}, &oauthProviderError{reason: "failed to reach the identity endpoint"}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ProviderIdentity{}, &oauthProviderError{reason: fmt.Sprintf("identity endpoint returned status %d", resp.StatusCode)}
	}

	var body struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body); err != nil {
		return ProviderIdentity{}, &oauthProviderError{reason: "failed to decode the identity response"}
	}
	if body.ID == 0 || body.Login == "" {
		return ProviderIdentity{}, &oauthProviderError{reason: "identity response missing id or login"}
	}
	return ProviderIdentity{ID: body.ID, Login: body.Login}, nil
}

// IsProviderError reports whether err originates from a call to the
// OAuth provider (network failure, non-2xx, or malformed response) --
// httpapi uses this to map any such failure to the fixed
// "oauth_provider_error" code without depending on this package's
// unexported error type.
func IsProviderError(err error) bool {
	var provErr *oauthProviderError
	return errors.As(err, &provErr)
}
