package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrOwnerMismatch is returned by ResolveOwner for any identity that
// is not ticketIt's configured Owner. Callers must translate it to the
// explicit, stable rejection code the API contract promises
// ("owner_mismatch") and must not create or modify anything on this
// path -- see ResolveOwner's doc for exactly which two cases return it.
var ErrOwnerMismatch = errors.New("github identity does not match the configured owner")

// ProviderIdentity is the minimal identity a GitHub OAuth provider
// hands back after a successful code exchange: an immutable numeric
// account id and the account's current login.
type ProviderIdentity struct {
	ID    int64
	Login string
}

const githubProvider = "github"

// afterEmptyOwnerLookup lets TestResolveOwner_ConcurrentBootstrapRace
// hold both sign-ins between the empty lookup and bootstrapOwner.
var afterEmptyOwnerLookup func()

// ResolveOwner implements issue #54's Owner-matching rule for a single
// successful provider identity fetch:
//
//   - No Owner exists yet (first sign-in ever): identity.Login must
//     equal configuredLogin (case-insensitively -- GitHub logins are
//     case-insensitive but case-preserving). On a match, this
//     bootstraps the one Owner and its identity link, keyed from here
//     on by identity.ID, never configuredLogin again. On a mismatch,
//     returns ErrOwnerMismatch and creates nothing.
//   - An Owner already exists: identity.ID must equal the linked
//     identity's stored provider account id -- configuredLogin is not
//     consulted at all past bootstrap, which is what lets the Owner
//     rename their GitHub login later without being locked out, and
//     is exactly "prefer matching the immutable GitHub numeric account
//     id" from issue #54. On a mismatch, returns ErrOwnerMismatch and
//     leaves the existing link completely untouched -- no update, no
//     new row, regardless of how close a match the login is.
//
// Every non-mismatch, non-error return commits (bootstrap) or updates
// only the login/updated_at of the one legitimate link (see the SQL
// below); nothing else is ever created or modified by this function.
func ResolveOwner(ctx context.Context, pool *pgxpool.Pool, configuredLogin string, identity ProviderIdentity) (ownerID int64, bootstrapped bool, err error) {
	return resolveOwner(ctx, pool, configuredLogin, identity, true)
}

// resolveOwner is ResolveOwner's implementation, with allowRetry
// controlling exactly one retry after a concurrent-bootstrap race (see
// the comment at its one call site below). Production sign-ins are
// effectively never concurrent (one browser, one Owner), but this
// module's own test suite runs many packages against the same shared
// database at once, each capable of being the first to bootstrap the
// one singleton Owner -- without this, whichever loses that race would
// fail outright instead of correctly recognizing the Owner the winner
// just created.
func resolveOwner(ctx context.Context, pool *pgxpool.Pool, configuredLogin string, identity ProviderIdentity, allowRetry bool) (ownerID int64, bootstrapped bool, err error) {
	var (
		existingOwnerID   int64
		existingAccountID int64
	)
	err = pool.QueryRow(ctx,
		`SELECT owner_id, provider_account_id FROM owner_identities WHERE provider = $1 LIMIT 1`,
		githubProvider,
	).Scan(&existingOwnerID, &existingAccountID)

	switch {
	case err == nil:
		if existingAccountID != identity.ID {
			return 0, false, ErrOwnerMismatch
		}
		// The verified Owner's own login may have changed on GitHub
		// since the last sign-in; refresh the display value, but this
		// is the *matching* account already, not a re-verification.
		if _, updateErr := pool.Exec(ctx,
			`UPDATE owner_identities SET login = $1, updated_at = now() WHERE owner_id = $2 AND provider = $3`,
			identity.Login, existingOwnerID, githubProvider,
		); updateErr != nil {
			return 0, false, fmt.Errorf("failed to refresh the linked identity's login: %w", updateErr)
		}
		return existingOwnerID, false, nil

	case errors.Is(err, pgx.ErrNoRows):
		if !strings.EqualFold(identity.Login, configuredLogin) {
			return 0, false, ErrOwnerMismatch
		}
		if afterEmptyOwnerLookup != nil {
			afterEmptyOwnerLookup()
		}
		newOwnerID, bootstrapErr := bootstrapOwner(ctx, pool, identity)
		if bootstrapErr != nil {
			if allowRetry && isUniqueViolation(bootstrapErr) {
				// A concurrent sign-in bootstrapped the singleton Owner
				// between our SELECT and INSERT. The row exists now --
				// re-resolve against it exactly as the "Owner already
				// exists" branch above would.
				return resolveOwner(ctx, pool, configuredLogin, identity, false)
			}
			return 0, false, bootstrapErr
		}
		return newOwnerID, true, nil

	default:
		return 0, false, fmt.Errorf("failed to look up the owner identity: %w", err)
	}
}

// bootstrapOwner creates the one Owner row and its identity link in a
// single transaction, so the two invariants "at most one Owner" and
// "the Owner always has exactly one link" are never observably
// violated even by a failure partway through.
func bootstrapOwner(ctx context.Context, pool *pgxpool.Pool, identity ProviderIdentity) (ownerID int64, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to start the owner-bootstrap transaction: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed

	if err := tx.QueryRow(ctx, `INSERT INTO owners DEFAULT VALUES RETURNING id`).Scan(&ownerID); err != nil {
		return 0, fmt.Errorf("failed to create the owner: %w", err)
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO owner_identities (owner_id, provider, provider_account_id, login) VALUES ($1, $2, $3, $4)`,
		ownerID, githubProvider, identity.ID, identity.Login,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to link the owner identity: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("failed to commit the owner bootstrap: %w", err)
	}
	return ownerID, nil
}

// isUniqueViolation reports whether err is (or wraps) a PostgreSQL
// unique-constraint violation -- specifically owners_singleton_uq,
// though it isn't narrowed to that one constraint by name since
// bootstrapOwner has no other unique constraint it could hit.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == pgerrcode.UniqueViolation
}
