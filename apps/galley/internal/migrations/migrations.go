// Package migrations embeds Galley's versioned, forward-only SQL
// migration files so both the migrate command (cmd/migrate) and the
// test suite (internal/postgres's test helper) can apply them without
// depending on the process's working directory. See
// apps/galley/README.md, "Database migrations," for the command that
// applies these and the rule about whether they run at Galley's own
// startup (they do not).
//
// Each file is named "<version>_<title>.up.sql". There are
// deliberately no ".down.sql" files: migrations here are forward-only,
// matching issue #52's convention for this slice.
package migrations

import "embed"

// FS holds every migration file in this package directory.
//
//go:embed *.sql
var FS embed.FS
