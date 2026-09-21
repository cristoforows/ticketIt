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

func TestLoad_Defaults(t *testing.T) {
	cfg, err := Load(fakeGetenv(nil))
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
	}))
	if err != nil {
		t.Fatalf("Load() returned unexpected error: %v", err)
	}
	want := Config{
		Host:        "127.0.0.1",
		Port:        "9090",
		Environment: "production",
		Version:     "1.2.3",
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
			_, err := Load(fakeGetenv(map[string]string{"GALLEY_PORT": port}))
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
	cfg, err := Load(fakeGetenv(map[string]string{"GALLEY_PORT": "0"}))
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
			_, err := Load(fakeGetenv(map[string]string{"GALLEY_ENVIRONMENT": env}))
			if err == nil {
				t.Fatalf("Load() with GALLEY_ENVIRONMENT=%q: expected error, got nil", env)
			}
			if !strings.Contains(err.Error(), "GALLEY_ENVIRONMENT") {
				t.Errorf("error %q does not mention GALLEY_ENVIRONMENT", err.Error())
			}
		})
	}
}
