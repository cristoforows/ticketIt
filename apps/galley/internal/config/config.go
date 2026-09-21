// Package config reads Galley's process configuration from the
// environment. It is deliberately small and dependency-free: every
// setting has an explicit default, and any value that is present but
// invalid fails loudly with an actionable error rather than starting
// the process in an unknown state.
package config

import (
	"fmt"
	"net"
	"net/url"
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
	// DatabaseURL is the PostgreSQL connection string (issue #52). It
	// has no default -- unlike every other setting here, an unset
	// DATABASE_URL is a configuration error, not a value with a
	// sensible fallback. Never logged or otherwise echoed back: see
	// Load's validation below and internal/postgres's package doc.
	DatabaseURL string
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

	return Config{
		Host:        host,
		Port:        port,
		Environment: environment,
		Version:     version,
		DatabaseURL: databaseURL,
	}, nil
}
