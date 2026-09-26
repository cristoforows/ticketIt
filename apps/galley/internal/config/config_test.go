package config

import (
	"strings"
	"testing"
	"time"
)

// fakeGetenv builds a getenv func backed by a fixed map, so tests never
// touch the real process environment.
func fakeGetenv(values map[string]string) func(string) string {
	return func(key string) string {
		return values[key]
	}
}

// validDatabaseURL is a syntactically valid PostgreSQL connection
// string used to satisfy Load's now-required DATABASE_URL in tests
// that are not themselves exercising DATABASE_URL validation. Load
// only checks its shape (parses, postgres(ql):// scheme); it never
// connects, so this never needs to name a real, reachable database.
const validDatabaseURL = "postgres://localhost:5432/ticketit_dev?sslmode=disable"

// validAuthEnv holds the three settings issue #54 requires with no
// default (mirroring DATABASE_URL's own pattern) -- merged into every
// test below that expects Load to succeed but is not itself exercising
// owner/OAuth validation.
var validAuthEnv = map[string]string{
	"GALLEY_OWNER_GITHUB_LOGIN":         "cristoforows",
	"GALLEY_OAUTH_GITHUB_CLIENT_ID":     "test-client-id",
	"GALLEY_OAUTH_GITHUB_CLIENT_SECRET": "test-client-secret",
}

// withValidAuthEnv returns a copy of env with validAuthEnv's keys added
// (without overwriting any key env already sets).
func withValidAuthEnv(env map[string]string) map[string]string {
	merged := map[string]string{}
	for k, v := range validAuthEnv {
		merged[k] = v
	}
	for k, v := range env {
		merged[k] = v
	}
	return merged
}

func TestLoad_Defaults(t *testing.T) {
	cfg, err := Load(fakeGetenv(withValidAuthEnv(map[string]string{"DATABASE_URL": validDatabaseURL})))
	if err != nil {
		t.Fatalf("Load() returned unexpected error: %v", err)
	}
	if cfg.Host != DefaultHost {
		t.Errorf("Host = %q, want %q", cfg.Host, DefaultHost)
	}
	if cfg.Port != DefaultPort {
		t.Errorf("Port = %q, want %q", cfg.Port, DefaultPort)
	}
	if cfg.Environment != EnvDevelopment {
		t.Errorf("Environment = %q, want %q", cfg.Environment, EnvDevelopment)
	}
	if cfg.Version != DefaultVersion {
		t.Errorf("Version = %q, want %q", cfg.Version, DefaultVersion)
	}
	if cfg.DatabaseURL != validDatabaseURL {
		t.Errorf("DatabaseURL = %q, want %q", cfg.DatabaseURL, validDatabaseURL)
	}
	if cfg.OwnerGitHubLogin != validAuthEnv["GALLEY_OWNER_GITHUB_LOGIN"] {
		t.Errorf("OwnerGitHubLogin = %q, want %q", cfg.OwnerGitHubLogin, validAuthEnv["GALLEY_OWNER_GITHUB_LOGIN"])
	}
	if cfg.BaseURL != DefaultBaseURL {
		t.Errorf("BaseURL = %q, want %q", cfg.BaseURL, DefaultBaseURL)
	}
	if cfg.OAuthGitHubBaseURL != DefaultOAuthGitHubBaseURL {
		t.Errorf("OAuthGitHubBaseURL = %q, want %q", cfg.OAuthGitHubBaseURL, DefaultOAuthGitHubBaseURL)
	}
	if cfg.OAuthGitHubAPIBaseURL != DefaultOAuthGitHubAPIBaseURL {
		t.Errorf("OAuthGitHubAPIBaseURL = %q, want %q", cfg.OAuthGitHubAPIBaseURL, DefaultOAuthGitHubAPIBaseURL)
	}
	if cfg.SessionTTL != 720*time.Hour {
		t.Errorf("SessionTTL = %v, want %v", cfg.SessionTTL, 720*time.Hour)
	}
	if got, want := cfg.Addr(), ":8080"; got != want {
		t.Errorf("Addr() = %q, want %q", got, want)
	}
}

func TestLoad_ExplicitProductionSettings(t *testing.T) {
	cfg, err := Load(fakeGetenv(withValidAuthEnv(map[string]string{
		"GALLEY_HOST":                      "127.0.0.1",
		"GALLEY_PORT":                      "9090",
		"GALLEY_ENVIRONMENT":               "production",
		"GALLEY_VERSION":                   "1.2.3",
		"DATABASE_URL":                     validDatabaseURL,
		"GALLEY_BASE_URL":                  "https://ticketit.example.com",
		"GALLEY_OAUTH_GITHUB_BASE_URL":     "https://github.example.com",
		"GALLEY_OAUTH_GITHUB_API_BASE_URL": "https://api.github.example.com",
		"GALLEY_SESSION_TTL":               "12h30m",
	})))
	if err != nil {
		t.Fatalf("Load() returned unexpected error: %v", err)
	}
	want := Config{
		Host:                  "127.0.0.1",
		Port:                  "9090",
		Environment:           "production",
		Version:               "1.2.3",
		DatabaseURL:           validDatabaseURL,
		OwnerGitHubLogin:      "cristoforows",
		OAuthClientID:         "test-client-id",
		OAuthClientSecret:     "test-client-secret",
		OAuthGitHubBaseURL:    "https://github.example.com",
		OAuthGitHubAPIBaseURL: "https://api.github.example.com",
		BaseURL:               "https://ticketit.example.com",
		SessionTTL:            12*time.Hour + 30*time.Minute,
	}
	if cfg != want {
		t.Errorf("Load() = %+v, want %+v", cfg, want)
	}
	if got, want := cfg.Addr(), "127.0.0.1:9090"; got != want {
		t.Errorf("Addr() = %q, want %q", got, want)
	}
}

func TestLoad_InvalidPort(t *testing.T) {
	cases := []string{"not-a-number", "-1", "65536", "8080.5", " "}
	for _, port := range cases {
		t.Run(port, func(t *testing.T) {
			_, err := Load(fakeGetenv(withValidAuthEnv(map[string]string{"GALLEY_PORT": port, "DATABASE_URL": validDatabaseURL})))
			if err == nil {
				t.Fatalf("Load() with GALLEY_PORT=%q: expected error, got nil", port)
			}
			if !strings.Contains(err.Error(), "GALLEY_PORT") {
				t.Errorf("error %q does not mention GALLEY_PORT", err.Error())
			}
		})
	}
}

func TestLoad_PortZeroIsValid(t *testing.T) {
	// Port 0 asks the OS for an ephemeral port; used by tests that need
	// a real, collision-free listening socket.
	cfg, err := Load(fakeGetenv(withValidAuthEnv(map[string]string{"GALLEY_PORT": "0", "DATABASE_URL": validDatabaseURL})))
	if err != nil {
		t.Fatalf("Load() returned unexpected error: %v", err)
	}
	if cfg.Port != "0" {
		t.Errorf("Port = %q, want %q", cfg.Port, "0")
	}
}

func TestLoad_InvalidEnvironment(t *testing.T) {
	cases := []string{"prod", "Development", "staging", "PRODUCTION"}
	for _, env := range cases {
		t.Run(env, func(t *testing.T) {
			_, err := Load(fakeGetenv(map[string]string{"GALLEY_ENVIRONMENT": env, "DATABASE_URL": validDatabaseURL}))
			if err == nil {
				t.Fatalf("Load() with GALLEY_ENVIRONMENT=%q: expected error, got nil", env)
			}
			if !strings.Contains(err.Error(), "GALLEY_ENVIRONMENT") {
				t.Errorf("error %q does not mention GALLEY_ENVIRONMENT", err.Error())
			}
		})
	}
}

func TestLoad_DatabaseURLUnset(t *testing.T) {
	_, err := Load(fakeGetenv(nil))
	if err == nil {
		t.Fatal("Load() with no DATABASE_URL: expected error, got nil")
	}
	if !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("error %q does not mention DATABASE_URL", err.Error())
	}
}

func TestLoad_InvalidDatabaseURL(t *testing.T) {
	cases := []string{
		"not-a-url at all :://",
		"mysql://localhost:3306/ticketit", // wrong scheme
		"localhost:5432/ticketit",         // no scheme
	}
	for _, dbURL := range cases {
		t.Run(dbURL, func(t *testing.T) {
			_, err := Load(fakeGetenv(map[string]string{"DATABASE_URL": dbURL}))
			if err == nil {
				t.Fatalf("Load() with DATABASE_URL=%q: expected error, got nil", dbURL)
			}
			if !strings.Contains(err.Error(), "DATABASE_URL") {
				t.Errorf("error %q does not mention DATABASE_URL", err.Error())
			}
			// The invalid value itself must never appear in the error
			// (it could carry credentials in a real misconfiguration).
			if strings.Contains(err.Error(), dbURL) {
				t.Errorf("error %q echoes back the invalid DATABASE_URL value", err.Error())
			}
		})
	}
}

func TestLoad_OwnerGitHubLoginUnset(t *testing.T) {
	env := withValidAuthEnv(map[string]string{"DATABASE_URL": validDatabaseURL})
	delete(env, "GALLEY_OWNER_GITHUB_LOGIN")
	_, err := Load(fakeGetenv(env))
	if err == nil {
		t.Fatal("Load() with no GALLEY_OWNER_GITHUB_LOGIN: expected error, got nil")
	}
	if !strings.Contains(err.Error(), "GALLEY_OWNER_GITHUB_LOGIN") {
		t.Errorf("error %q does not mention GALLEY_OWNER_GITHUB_LOGIN", err.Error())
	}
}

func TestLoad_OAuthClientCredentialsUnset(t *testing.T) {
	cases := []string{"GALLEY_OAUTH_GITHUB_CLIENT_ID", "GALLEY_OAUTH_GITHUB_CLIENT_SECRET"}
	for _, missing := range cases {
		t.Run(missing, func(t *testing.T) {
			env := withValidAuthEnv(map[string]string{"DATABASE_URL": validDatabaseURL})
			delete(env, missing)
			_, err := Load(fakeGetenv(env))
			if err == nil {
				t.Fatalf("Load() with no %s: expected error, got nil", missing)
			}
			if !strings.Contains(err.Error(), missing) {
				t.Errorf("error %q does not mention %s", err.Error(), missing)
			}
		})
	}
}

func TestLoad_InvalidProviderURLs(t *testing.T) {
	cases := []string{"GALLEY_OAUTH_GITHUB_BASE_URL", "GALLEY_OAUTH_GITHUB_API_BASE_URL", "GALLEY_BASE_URL"}
	for _, key := range cases {
		t.Run(key, func(t *testing.T) {
			env := withValidAuthEnv(map[string]string{"DATABASE_URL": validDatabaseURL, key: "not-a-url"})
			_, err := Load(fakeGetenv(env))
			if err == nil {
				t.Fatalf("Load() with %s=%q: expected error, got nil", key, "not-a-url")
			}
			if !strings.Contains(err.Error(), key) {
				t.Errorf("error %q does not mention %s", err.Error(), key)
			}
		})
	}
}

func TestLoad_BaseURLMustBeOrigin(t *testing.T) {
	for _, value := range []string{
		"ftp://ticketit.example.com",
		"https://",
		"https://ticketit.example.com/path",
		"https://ticketit.example.com/",
		"https://ticketit.example.com?key=value",
		"https://ticketit.example.com?",
		"https://ticketit.example.com#fragment",
		"https://ticketit.example.com#",
		"https://ticketit.example.com:",
		"https://ticketit.example.com:99999",
		"https://user@ticketit.example.com",
		"//ticketit.example.com",
	} {
		t.Run(value, func(t *testing.T) {
			_, err := Load(fakeGetenv(withValidAuthEnv(map[string]string{
				"DATABASE_URL": validDatabaseURL, "GALLEY_BASE_URL": value,
			})))
			if err == nil || !strings.Contains(err.Error(), "GALLEY_BASE_URL") {
				t.Fatalf("Load() with GALLEY_BASE_URL=%q: error = %v, want GALLEY_BASE_URL error", value, err)
			}
		})
	}
	for _, value := range []string{"http://localhost:8080", "https://ticketit.example.com", "https://[::1]:8443"} {
		t.Run(value, func(t *testing.T) {
			cfg, err := Load(fakeGetenv(withValidAuthEnv(map[string]string{
				"DATABASE_URL": validDatabaseURL, "GALLEY_BASE_URL": value,
			})))
			if err != nil || cfg.BaseURL != value {
				t.Fatalf("Load() with GALLEY_BASE_URL=%q: config = %+v, error = %v", value, cfg, err)
			}
		})
	}
}

func TestLoad_ProductionRequiresExplicitBaseURL(t *testing.T) {
	for _, value := range []string{"", "https://ticketit.example.com"} {
		t.Run(value, func(t *testing.T) {
			cfg, err := Load(fakeGetenv(withValidAuthEnv(map[string]string{
				"DATABASE_URL": validDatabaseURL, "GALLEY_ENVIRONMENT": EnvProduction, "GALLEY_BASE_URL": value,
			})))
			if value == "" {
				if err == nil || !strings.Contains(err.Error(), "GALLEY_BASE_URL") {
					t.Fatalf("production without base URL: error = %v, want GALLEY_BASE_URL error", err)
				}
			} else if err != nil || cfg.BaseURL != value {
				t.Fatalf("production with base URL: config = %+v, error = %v", cfg, err)
			}
		})
	}
}

func TestLoad_InvalidSessionTTL(t *testing.T) {
	cases := []string{"30", "thirty days", "30d", "0", "0s", "-1h"}
	for _, ttl := range cases {
		t.Run(ttl, func(t *testing.T) {
			env := withValidAuthEnv(map[string]string{"DATABASE_URL": validDatabaseURL, "GALLEY_SESSION_TTL": ttl})
			_, err := Load(fakeGetenv(env))
			if err == nil {
				t.Fatalf("Load() with GALLEY_SESSION_TTL=%q: expected error, got nil", ttl)
			}
			if !strings.Contains(err.Error(), "GALLEY_SESSION_TTL") {
				t.Errorf("error %q does not mention GALLEY_SESSION_TTL", err.Error())
			}
		})
	}
}
