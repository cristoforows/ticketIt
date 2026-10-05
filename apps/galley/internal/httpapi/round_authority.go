package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	authorityChecksShown = 50

	roundNotRunningCode    = "round_not_running"
	roundNotRunningMessage = "authority is checked only while the Round is running"
	authorityCheckShape    = `request body must be JSON matching {"account", "action", "resource", "epoch"}`
)

type checkedRound struct {
	id, ticketID, agentID int64
	state                 RoundState
	epoch                 int
	callerHolds           bool
	runnerConnected       bool
	reconcileRequired     bool
}

func (s *server) CheckRoundAuthority(w http.ResponseWriter, r *http.Request, roundId string) {
	runner, ok := s.requireRunner(w, r)
	if !ok {
		return
	}
	roundID, ok := canonicalPublicID(roundId)
	if !ok {
		writeRoundNotFound(w)
		return
	}
	var req AuthorityCheckRequest
	if !decodeStrictJSON(w, r, &req, authorityCheckShape) {
		return
	}
	scope := permissionScope{account: req.Account, action: req.Action, resource: req.Resource}
	if problem := validateScopeFields(scope); problem != "" {
		writeError(w, http.StatusBadRequest, "invalid_request", problem)
		return
	}
	if req.Epoch < 1 || req.Epoch > claimEpochMax {
		writeError(w, http.StatusBadRequest, "invalid_request", `"epoch" must be a positive integer`)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	result, found, rejection, err := checkAuthority(ctx, s.pool, runner.ownerID, runner.id, roundID, scope, req.Epoch, s.clockNow())
	switch {
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to check authority")
	case !found:
		writeRoundNotFound(w)
	case rejection != nil:
		if rejection.code == runnerDisconnectedCode || rejection.code == reconcileRequiredCode {
			s.logger.Warn("authority check refused", "roundId", roundID, "code", rejection.code)
		}
		writeError(w, rejection.status, rejection.code, rejection.message)
	default:
		writeJSON(w, http.StatusOK, result)
	}
}

// Neither a disconnected runner nor an unreconciled Round may be answered: an allow would vouch for execution Galley cannot see (#170).
func decideAuthorityCheck(round checkedRound, epoch int) *roundEventRejection {
	switch {
	case !round.callerHolds:
		return runnerNotHolderRejection()
	case epoch != round.epoch:
		return &roundEventRejection{http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage}
	case !OpenRoundState(round.state).Valid():
		return &roundEventRejection{http.StatusConflict, roundNotOpenCode, roundNotOpenMessage}
	case !round.runnerConnected:
		return &roundEventRejection{http.StatusConflict, runnerDisconnectedCode, runnerDisconnectedMessage}
	case round.reconcileRequired:
		return &roundEventRejection{http.StatusConflict, reconcileRequiredCode, reconcileRequiredMessage}
	case round.state != RoundRunning:
		return &roundEventRejection{http.StatusConflict, roundNotRunningCode, roundNotRunningMessage}
	}
	return nil
}

// The grant is read in the check's own transaction, never from the claim: a grant committed before the check is honoured.
// The Round row is share-locked so it cannot end or change epoch between the decision and its record. The allowing grant
// row is share-locked too, so a revoke waits for this check to commit and a check queued behind a revoke skips the
// revoked row: no allow commits after its grant's revocation.
// A full-access grant matches any scope of its account, so the scope must be declared before any grant is read.
func checkAuthority(ctx context.Context, pool *pgxpool.Pool, ownerID, runnerID int64, roundID string, scope permissionScope, epoch int, now time.Time) (AuthorityCheckResult, bool, *roundEventRejection, error) {
	if reason := undeclaredCapability(scope); reason != "" {
		return AuthorityCheckResult{}, true, &roundEventRejection{http.StatusBadRequest, capabilityNotSupportedCode, reason}, nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return AuthorityCheckResult{}, false, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var round checkedRound
	var lastSeenAt *time.Time
	var holderID *int64
	err = tx.QueryRow(ctx, `SELECT id, ticket_id, agent_id, runner_id, state, claim_epoch, reconcile_required, (SELECT last_seen_at FROM runners WHERE owner_id = rounds.owner_id)
		FROM rounds WHERE owner_id = $1 AND public_id = $2::uuid FOR SHARE OF rounds`,
		ownerID, roundID).Scan(&round.id, &round.ticketID, &round.agentID, &holderID, &round.state, &round.epoch, &round.reconcileRequired, &lastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthorityCheckResult{}, false, nil, nil
	}
	if err != nil {
		return AuthorityCheckResult{}, false, nil, err
	}
	round.callerHolds = runnerHolds(holderID, runnerID)
	round.runnerConnected = runnerConnected(now, lastSeenAt)
	if rejection := decideAuthorityCheck(round, epoch); rejection != nil {
		return AuthorityCheckResult{}, true, rejection, nil
	}
	var grantRowID, expiredRowID *int64
	var grantID, expiredID *string
	err = tx.QueryRow(ctx, `SELECT id, public_id::text FROM permission_grants
		WHERE owner_id = $1 AND agent_id = $2 AND account = $4 AND (full_access OR (action = $5 AND resource = $6)) AND state = $7
		  AND ((form = $8 AND ticket_id = $3) OR (form = $9 AND expires_at > $10))
		ORDER BY full_access, id LIMIT 1 FOR SHARE`, ownerID, round.agentID, round.ticketID, scope.account, scope.action, scope.resource, string(PermissionGrantActive),
		string(PermissionGrantFormTicket), string(PermissionGrantFormTime), now).
		Scan(&grantRowID, &grantID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return AuthorityCheckResult{}, true, nil, err
	}
	result := AuthorityCheckResult{Decision: AuthorityAllow, GrantId: grantID}
	if grantID == nil {
		err = tx.QueryRow(ctx, `SELECT id, public_id::text FROM permission_grants
			WHERE owner_id = $1 AND agent_id = $2 AND account = $3 AND (full_access OR (action = $4 AND resource = $5)) AND form = $6 AND NOT expires_at > $7 AND state = $8
			ORDER BY id DESC LIMIT 1`, ownerID, round.agentID, scope.account, scope.action, scope.resource, string(PermissionGrantFormTime), now, string(PermissionGrantActive)).
			Scan(&expiredRowID, &expiredID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return AuthorityCheckResult{}, true, nil, err
		}
		result = AuthorityCheckResult{Decision: AuthorityDeny, ExpiredGrantId: expiredID}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO round_authority_checks (owner_id, round_id, account, action, resource, claim_epoch, decision, grant_id, expired_grant_id, checked_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		ownerID, round.id, scope.account, scope.action, scope.resource, epoch, string(result.Decision), grantRowID, expiredRowID, now); err != nil {
		return AuthorityCheckResult{}, true, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AuthorityCheckResult{}, true, nil, err
	}
	return result, true, nil, nil
}

type roundAuthorityHistory struct {
	checks []RoundAuthorityCheck
	count  int
}

func roundAuthorityChecks(ctx context.Context, tx pgx.Tx, ownerID int64, roundIDs []int64) (map[int64]roundAuthorityHistory, error) {
	rows, err := tx.Query(ctx, `SELECT c.round_id, c.account, c.action, c.resource, c.decision, g.public_id::text, e.public_id::text, c.checked_at, c.total
		FROM (SELECT *, row_number() OVER (PARTITION BY round_id ORDER BY id DESC) AS newest, count(*) OVER (PARTITION BY round_id) AS total
			FROM round_authority_checks WHERE owner_id = $1 AND round_id = ANY($2)) c
		LEFT JOIN permission_grants g ON g.owner_id = c.owner_id AND g.id = c.grant_id
		LEFT JOIN permission_grants e ON e.owner_id = c.owner_id AND e.id = c.expired_grant_id
		WHERE c.newest <= $3 ORDER BY c.round_id, c.id`, ownerID, roundIDs, authorityChecksShown)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	history := map[int64]roundAuthorityHistory{}
	for rows.Next() {
		var roundID int64
		var check RoundAuthorityCheck
		var decision string
		var total int
		if err := rows.Scan(&roundID, &check.Account, &check.Action, &check.Resource, &decision, &check.GrantId, &check.ExpiredGrantId, &check.CheckedAt, &total); err != nil {
			return nil, err
		}
		check.Decision = AuthorityDecision(decision)
		check.CheckedAt = check.CheckedAt.UTC()
		entry := history[roundID]
		entry.checks = append(entry.checks, check)
		entry.count = total
		history[roundID] = entry
	}
	return history, rows.Err()
}
