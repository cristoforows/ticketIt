// Package config reads Galley's process configuration from the
// environment. It is deliberately small and dependency-free: every
// setting has an explicit default, and any value that is present but
// invalid fails loudly with an actionable error rather than starting
// the process in an unknown state.
package config

import (
	"fmt"
	"net"
	"strconv"
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

	return Config{
		Host:        host,
		Port:        port,
		Environment: environment,
		Version:     version,
	}, nil
}
