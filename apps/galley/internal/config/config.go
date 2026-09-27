// Package config reads Galley's process configuration from the
// environment. It is deliberately small and dependency-free: optional
// settings have defaults, and any value that is present but
// invalid fails loudly with an actionable error rather than starting
// the process in an unknown state.
package config

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Environment names accepted by GALLEY_ENVIRONMENT. Keep this list in
// sync with the values documented in apps/galley/README.md.
const (
	EnvDevelopment = "development"
	EnvProduction  = "production"
)

// Default values used when the corresponding environment variable is
// unset or empty.
const (
	DefaultHost        = ""     // empty host binds to all interfaces, matching net.Listen's usual default.
	DefaultPort        = "8080" // keeps Galley aligned with Swiftlet's dev proxy default (issue #50).
	DefaultEnvironment = EnvDevelopment
	DefaultVersion     = "dev"
	// DefaultBaseURL matches DefaultPort, so a bare local `go run
	// ./cmd/galley` gets a working OAuth redirect_uri with no extra
	// configuration. Production must set GALLEY_BASE_URL explicitly to
	// its real, externally reachable origin -- see "Owner
	// configuration" in apps/galley/README.md.
	DefaultBaseURL = "http://localhost:8080"
	// DefaultOAuthGitHubBaseURL and DefaultOAuthGitHubAPIBaseURL are
	// real GitHub's own two hosts for the OAuth authorize/token
	// endpoints and the REST identity endpoint, respectively -- issue
	// #54's substitute provider overrides both to a local fixture
	// server in every test.
	DefaultOAuthGitHubBaseURL    = "https://github.com"
	DefaultOAuthGitHubAPIBaseURL = "https://api.github.com"
	DefaultSessionTTL            = 30 * 24 * time.Hour
)

// Config is Galley's fully validated runtime configuration.
type Config struct {
	// Host is the interface to listen on. Empty means all interfaces.
	Host string
	// Port is the TCP port to listen on, already validated as an
	// integer in [0, 65535]. Kept as a string because it is only ever
	// used to build a listen address.
	Port string
	// Environment is either "development" or "production".
	Environment string
	// Version is an arbitrary, non-empty version string reported by
	// GET /api/status.
	Version string
	// DatabaseURL is the PostgreSQL connection string (issue #52). It
	// has no default -- unlike every other setting here, an unset
	// DATABASE_URL is a configuration error, not a value with a
	// sensible fallback. Never logged or otherwise echoed back: see
	// Load's validation below and internal/postgres's package doc.
	DatabaseURL string

	// OwnerGitHubLogin is the expected GitHub login of ticketIt's one
	// configured Owner (issue #54). It has no default: sign-in cannot
	// be "restricted to the configured owner" without it. Used only to
	// bootstrap the Owner link on the very first successful sign-in --
	// see internal/auth.ResolveOwner and "Owner configuration" in
	// apps/galley/README.md for why every sign-in after that verifies
	// the immutable provider account id instead, not this login.
	OwnerGitHubLogin string
	// OAuthClientID and OAuthClientSecret identify Galley to the OAuth
	// provider (issue #54). Neither has a default: there is no real
	// GitHub OAuth app in this repository (AGENTS.md, "Paid
	// resources"), so these always name either a local fixture
	// provider's fake credentials (tests) or an Owner-provisioned real
	// GitHub OAuth app (production, out of this slice's scope -- see
	// the evidence record). OAuthClientSecret is never logged.
	OAuthClientID     string
	OAuthClientSecret string
	// OAuthGitHubBaseURL is the provider host for the browser-facing
	// authorize redirect and the server-to-server code exchange
	// (".../login/oauth/..."). OAuthGitHubAPIBaseURL is the provider
	// host for the identity fetch (".../user") -- real GitHub splits
	// these across github.com and api.github.com, so this slice keeps
	// them as two independently configurable values rather than one.
	// Both default to real GitHub; every test substitutes a local
	// fixture server for both.
	OAuthGitHubBaseURL    string
	OAuthGitHubAPIBaseURL string
	// BaseURL is the externally-visible origin the *browser* is on
	// when it reaches Galley -- Galley's own directly, or Swiftlet's
	// dev-server proxy origin (contracts/openapi.yaml's "servers"
	// note) -- used to build the fixed `redirect_uri` sent to the
	// OAuth provider. Deliberately not derived from the request's Host
	// header: that header is client-supplied and an OAuth app's
	// redirect_uri must be one fixed, pre-registered value, not
	// whatever a caller claims.
	BaseURL    string
	SessionTTL time.Duration
}

// Addr returns the "host:port" address to pass to net.Listen.
func (c Config) Addr() string {
	return net.JoinHostPort(c.Host, c.Port)
}

// Load reads configuration from the environment via getenv (normally
// os.Getenv, replaced with a fake in tests). It returns a descriptive,
// actionable error for any value that is present but cannot be used,
// rather than silently falling back to a default.
func Load(getenv func(string) string) (Config, error) {
	host := getenv("GALLEY_HOST")

	port := getenv("GALLEY_PORT")
	if port == "" {
		port = DefaultPort
	}
	portNum, err := strconv.Atoi(port)
	if err != nil || portNum < 0 || portNum > 65535 {
		return Config{}, fmt.Errorf(
			"invalid GALLEY_PORT %q: must be an integer between 0 and 65535 (0 selects an OS-assigned port, useful for tests)",
			port,
		)
	}

	environment := getenv("GALLEY_ENVIRONMENT")
	if environment == "" {
		environment = DefaultEnvironment
	}
	if environment != EnvDevelopment && environment != EnvProduction {
		return Config{}, fmt.Errorf(
			"invalid GALLEY_ENVIRONMENT %q: must be %q or %q",
			environment, EnvDevelopment, EnvProduction,
		)
	}

	version := getenv("GALLEY_VERSION")
	if version == "" {
		version = DefaultVersion
	}

	// DATABASE_URL has no default: unlike the settings above, there is
	// no sensible fallback for "which database." Checked last so an
	// invalid value for one of the settings above is still reported
	// first, unchanged from before this field existed.
	databaseURL := getenv("DATABASE_URL")
	if databaseURL == "" {
		return Config{}, fmt.Errorf(
			"DATABASE_URL is not set: a PostgreSQL connection string is required " +
				"(postgres://user:password@host:port/dbname) -- see apps/galley/README.md, \"Database configuration\"",
		)
	}
	// Validated for shape only (parses, and uses a postgres(ql):// scheme).
	// The value itself is never included in this or any other error:
	// some URL-parse failures echo back the offending input, which
	// would leak credentials into whatever captures this error.
	parsedDatabaseURL, err := url.Parse(databaseURL)
	if err != nil || (parsedDatabaseURL.Scheme != "postgres" && parsedDatabaseURL.Scheme != "postgresql") {
		return Config{}, fmt.Errorf(
			"invalid DATABASE_URL: must be a postgres:// or postgresql:// connection string " +
				"(value withheld to avoid logging credentials)",
		)
	}

	// Owner/OAuth settings (issue #54), checked last, same reasoning as
	// DATABASE_URL above: no sensible fallback, so unset fails loudly
	// rather than silently accepting sign-in from anyone.
	ownerGitHubLogin := getenv("GALLEY_OWNER_GITHUB_LOGIN")
	if ownerGitHubLogin == "" {
		return Config{}, fmt.Errorf(
			"GALLEY_OWNER_GITHUB_LOGIN is not set: the configured owner's GitHub login is required " +
				"to restrict sign-in -- see apps/galley/README.md, \"Owner configuration\"",
		)
	}

	oauthClientID := getenv("GALLEY_OAUTH_GITHUB_CLIENT_ID")
	if oauthClientID == "" {
		return Config{}, fmt.Errorf(
			"GALLEY_OAUTH_GITHUB_CLIENT_ID is not set -- see apps/galley/README.md, \"Owner configuration\"",
		)
	}
	oauthClientSecret := getenv("GALLEY_OAUTH_GITHUB_CLIENT_SECRET")
	if oauthClientSecret == "" {
		return Config{}, fmt.Errorf(
			"GALLEY_OAUTH_GITHUB_CLIENT_SECRET is not set -- see apps/galley/README.md, \"Owner configuration\"",
		)
	}

	oauthGitHubBaseURL := getenv("GALLEY_OAUTH_GITHUB_BASE_URL")
	if oauthGitHubBaseURL == "" {
		oauthGitHubBaseURL = DefaultOAuthGitHubBaseURL
	}
	if _, err := url.ParseRequestURI(oauthGitHubBaseURL); err != nil {
		return Config{}, fmt.Errorf("invalid GALLEY_OAUTH_GITHUB_BASE_URL %q: must be an absolute URL", oauthGitHubBaseURL)
	}

	oauthGitHubAPIBaseURL := getenv("GALLEY_OAUTH_GITHUB_API_BASE_URL")
	if oauthGitHubAPIBaseURL == "" {
		oauthGitHubAPIBaseURL = DefaultOAuthGitHubAPIBaseURL
	}
	if _, err := url.ParseRequestURI(oauthGitHubAPIBaseURL); err != nil {
		return Config{}, fmt.Errorf("invalid GALLEY_OAUTH_GITHUB_API_BASE_URL %q: must be an absolute URL", oauthGitHubAPIBaseURL)
	}

	baseURL := getenv("GALLEY_BASE_URL")
	if baseURL == "" {
		if environment == EnvProduction {
			return Config{}, fmt.Errorf("GALLEY_BASE_URL is required in production: set the browser-facing origin")
		}
		baseURL = DefaultBaseURL
	}
	parsedBaseURL, err := url.Parse(baseURL)
	if err != nil || (parsedBaseURL.Scheme != "http" && parsedBaseURL.Scheme != "https") ||
		parsedBaseURL.Hostname() == "" || strings.HasSuffix(parsedBaseURL.Host, ":") ||
		parsedBaseURL.User != nil || parsedBaseURL.Opaque != "" || parsedBaseURL.Path != "" ||
		parsedBaseURL.RawQuery != "" || parsedBaseURL.ForceQuery || strings.Contains(baseURL, "#") {
		return Config{}, fmt.Errorf("invalid GALLEY_BASE_URL %q: must be an http(s) origin with a host and no path, query, or fragment", baseURL)
	}
	if port := parsedBaseURL.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n > 65535 {
			return Config{}, fmt.Errorf("invalid GALLEY_BASE_URL %q: port must be between 0 and 65535", baseURL)
		}
	}

	sessionTTL := DefaultSessionTTL
	if raw := getenv("GALLEY_SESSION_TTL"); raw != "" {
		sessionTTL, err = time.ParseDuration(raw)
		if err != nil || sessionTTL <= 0 {
			return Config{}, fmt.Errorf("invalid GALLEY_SESSION_TTL %q: must be a positive Go duration such as \"720h\"", raw)
		}
	}

	return Config{
		Host:                  host,
		Port:                  port,
		Environment:           environment,
		Version:               version,
		DatabaseURL:           databaseURL,
		OwnerGitHubLogin:      ownerGitHubLogin,
		OAuthClientID:         oauthClientID,
		OAuthClientSecret:     oauthClientSecret,
		OAuthGitHubBaseURL:    oauthGitHubBaseURL,
		OAuthGitHubAPIBaseURL: oauthGitHubAPIBaseURL,
		BaseURL:               baseURL,
		SessionTTL:            sessionTTL,
	}, nil
}
