package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	grantAlreadyRevokedCode    = "grant_already_revoked"
	grantAlreadyRevokedMessage = "this grant is already revoked"
	grantEndedCode             = "grant_ended"
	grantEndedMessage          = "this grant ended when its Ticket reached Done and authorizes nothing, so there is nothing to revoke"
	grantExpiredCode           = "grant_expired"
	grantExpiredMessage        = "this grant has expired and authorizes nothing, so there is nothing to revoke"
	grantNotFoundMessage       = "no grant with that identifier"
)

// A form not bound to a Ticket covers every open Round of its Agent. Aliases: g, a grant; cr, a Round.
const grantCoversOpenRoundSQL = `cr.owner_id = g.owner_id AND cr.agent_id = g.agent_id AND cr.state IN ` + openRoundStatesSQL + `
	AND (g.form <> 'ticket' OR cr.ticket_id = g.ticket_id)`

type revocationTarget struct {
	state     PermissionGrantState
	expiresAt *time.Time
}

func decideRevoke(target revocationTarget, now time.Time) *transitionRejection {
	switch {
	case target.state == PermissionGrantRevoked:
		return &transitionRejection{code: grantAlreadyRevokedCode, message: grantAlreadyRevokedMessage}
	case target.state == PermissionGrantEndedAtDone:
		return &transitionRejection{code: grantEndedCode, message: grantEndedMessage}
	case target.expiresAt != nil && !timeGrantLive(*target.expiresAt, now):
		return &transitionRejection{code: grantExpiredCode, message: grantExpiredMessage}
	}
	return nil
}

type coveredRound struct {
	roundRowID int64
	roundID    string
	ticketID   string
}

func coveredOpenRounds(ctx context.Context, tx pgx.Tx, ownerID, grantRowID int64) ([]coveredRound, error) {
	rows, err := tx.Query(ctx, `SELECT cr.id, cr.public_id::text, t.public_id::text
		FROM permission_grants g JOIN rounds cr ON `+grantCoversOpenRoundSQL+`
		JOIN tickets t ON t.owner_id = cr.owner_id AND t.id = cr.ticket_id
		WHERE g.owner_id = $1 AND g.id = $2 ORDER BY t.id`, ownerID, grantRowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var covered []coveredRound
	for rows.Next() {
		var round coveredRound
		if err := rows.Scan(&round.roundRowID, &round.roundID, &round.ticketID); err != nil {
			return nil, err
		}
		covered = append(covered, round)
	}
	return covered, rows.Err()
}

func issueAuthorityChanged(ctx context.Context, tx pgx.Tx, ownerID int64, rounds []coveredRound, now time.Time) error {
	for _, round := range rounds {
		if _, err := tx.Exec(ctx, `INSERT INTO round_commands (owner_id, round_id, public_id, type, claim_epoch, issued_at)
			SELECT owner_id, id, $3::uuid, $4, claim_epoch, $5 FROM rounds WHERE owner_id = $1 AND id = $2`,
			ownerID, round.roundRowID, uuid.NewString(), string(RunnerCommandAuthorityChanged), now); err != nil {
			return err
		}
	}
	return nil
}

func writeGrantNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", grantNotFoundMessage)
}

func (s *server) RevokePermissionGrant(w http.ResponseWriter, r *http.Request, grantId string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	grantID, ok := canonicalPublicID(grantId)
	if !ok {
		writeGrantNotFound(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	grant, found, rejection, err := revokeGrantForOwner(ctx, s.pool, owner.ID, grantID, s.clockNow())
	switch {
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to revoke the grant")
	case !found:
		writeGrantNotFound(w)
	case rejection != nil:
		writeTransitionRejection(w, rejection)
	default:
		writeJSON(w, http.StatusOK, grant)
	}
}

// Lock order: the Owner's priority lock, each covered Ticket row, then the grant row. The priority lock keeps the covered
// Rounds from being claimed or ending before the commit, and serialises the revoke with every authority check.
func revokeGrantForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, grantID string, now time.Time) (PermissionGrant, bool, *transitionRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return PermissionGrant{}, false, nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	var grantRowID int64
	err = tx.QueryRow(ctx, `SELECT id FROM permission_grants WHERE owner_id = $1 AND public_id = $2::uuid`, ownerID, grantID).Scan(&grantRowID)
	if errors.Is(err, pgx.ErrNoRows) {
		return PermissionGrant{}, false, nil, nil
	}
	if err != nil {
		return PermissionGrant{}, false, nil, err
	}
	if err := lockOwnerPriority(ctx, tx, ownerID); err != nil {
		return PermissionGrant{}, true, nil, err
	}
	covered, err := coveredOpenRounds(ctx, tx, ownerID, grantRowID)
	if err != nil {
		return PermissionGrant{}, true, nil, err
	}
	locks := make([]ticketLock, len(covered))
	for i, round := range covered {
		lock, found, err := lockTicketForMutation(ctx, tx, ownerID, round.ticketID)
		if err != nil {
			return PermissionGrant{}, true, nil, err
		}
		if !found || lock.openRoundID != round.roundID {
			return PermissionGrant{}, true, nil, fmt.Errorf("round %s left Ticket %s under the priority lock", round.roundID, round.ticketID)
		}
		locks[i] = lock
	}
	var target revocationTarget
	if err := tx.QueryRow(ctx, `SELECT state, expires_at FROM permission_grants WHERE id = $1 FOR NO KEY UPDATE`, grantRowID).
		Scan(&target.state, &target.expiresAt); err != nil {
		return PermissionGrant{}, true, nil, err
	}
	rejection := decideRevoke(target, now)
	if rejection != nil && rejection.code != grantAlreadyRevokedCode {
		return PermissionGrant{}, true, rejection, nil
	}
	if rejection == nil {
		if _, err := tx.Exec(ctx, `UPDATE permission_grants SET state = $2, revoked_at = GREATEST($3::timestamptz, approved_at) WHERE id = $1`,
			grantRowID, string(PermissionGrantRevoked), now); err != nil {
			return PermissionGrant{}, true, nil, err
		}
		for _, lock := range locks {
			stop, err := requestStop(ctx, tx, ownerID, lock, now)
			if err != nil {
				return PermissionGrant{}, true, nil, err
			}
			if stop != nil && stop.code != stopAlreadyRequestedCode {
				return PermissionGrant{}, true, nil, fmt.Errorf("stop of covered round %s: %s", lock.openRoundID, stop.code)
			}
		}
		if err := issueAuthorityChanged(ctx, tx, ownerID, covered, now); err != nil {
			return PermissionGrant{}, true, nil, err
		}
	}
	var grant PermissionGrant
	if err := tx.QueryRow(ctx, `SELECT `+permissionGrantJSON+` FROM permission_grants g `+permissionGrantJoins+` WHERE g.id = $1`, grantRowID).Scan(&grant); err != nil {
		return PermissionGrant{}, true, nil, err
	}
	normalisePermissionGrant(&grant, now)
	if err := tx.Commit(ctx); err != nil {
		return PermissionGrant{}, true, nil, err
	}
	return grant, true, nil, nil
}
