package config

import (
	"strings"
	"testing"
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

func TestLoad_Defaults(t *testing.T) {
	cfg, err := Load(fakeGetenv(map[string]string{"DATABASE_URL": validDatabaseURL}))
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
	if got, want := cfg.Addr(), ":8080"; got != want {
		t.Errorf("Addr() = %q, want %q", got, want)
	}
}

func TestLoad_ExplicitProductionSettings(t *testing.T) {
	cfg, err := Load(fakeGetenv(map[string]string{
		"GALLEY_HOST":        "127.0.0.1",
		"GALLEY_PORT":        "9090",
		"GALLEY_ENVIRONMENT": "production",
		"GALLEY_VERSION":     "1.2.3",
		"DATABASE_URL":       validDatabaseURL,
	}))
	if err != nil {
		t.Fatalf("Load() returned unexpected error: %v", err)
	}
	want := Config{
		Host:        "127.0.0.1",
		Port:        "9090",
		Environment: "production",
		Version:     "1.2.3",
		DatabaseURL: validDatabaseURL,
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
			_, err := Load(fakeGetenv(map[string]string{"GALLEY_PORT": port, "DATABASE_URL": validDatabaseURL}))
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
	cfg, err := Load(fakeGetenv(map[string]string{"GALLEY_PORT": "0", "DATABASE_URL": validDatabaseURL}))
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
