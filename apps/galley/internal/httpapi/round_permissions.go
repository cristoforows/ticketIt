package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	permissionAlreadyDecidedCode        = "permission_already_decided"
	permissionAlreadyDecidedMessage     = "this Permission request is already decided"
	permissionDecisionNotAvailableCode  = "permission_decision_not_available"
	permissionDecisionNotAvailableMsg   = "a Permission decision needs a request the Round waits on"
	permissionStopRequestedMessage      = "Stop is already requested for this Round; a Permission decision cannot resume it"
	approvalNotSuppliedCode             = "approval_not_supplied"
	approvalNotSuppliedMessage          = "resumed needs the Owner's approval of the Permission request this Round waits on"
	permissionRequestNotFoundMessage    = "no ticket, round or Permission request with that identifier"
	approvePermissionRequestShape       = `request body must be JSON matching {"form": "ticket"} or {"form": "time", "expiresAt": RFC3339}`
	permissionRequestDecisionFailureMsg = "failed to record the Permission decision"
	grantFormConflictCode               = "grant_form_conflict"
	grantFormConflictMessage            = `"expiresAt" is for the time form; a ticket grant is bound to its Ticket and has no expiry`
	timeGrantExpiryRequiredMessage      = `the time form needs "expiresAt"`
	invalidGrantExpiryCode              = "invalid_grant_expiry"
	grantExpiryNotFutureMessage         = `"expiresAt" must be after the approval time`
	grantExpiryTooFarMessage            = `"expiresAt" must be at most 30 days after the approval time`
	invalidRenewalCode                  = "invalid_renewal"
	invalidRenewalMessage               = `"renewsGrantId" must name an expired time grant of this Round's Agent for the same scope`

	timeGrantMaxDuration  = 30 * 24 * time.Hour
	permissionGrantsShown = 50
)

const permissionRequestJSON = `json_build_object('id', p.request_id, 'account', p.account, 'action', p.action, 'resource', p.resource,
	'substituteAccount', false, 'requestedAt', p.requested_at, 'decision', p.decision, 'decidedAt', p.decided_at,
	'grantId', (SELECT g.public_id FROM permission_grants g WHERE g.owner_id = p.owner_id AND g.request_id = p.id),
	'renewsGrantId', (SELECT g.public_id FROM permission_grants g WHERE g.owner_id = p.owner_id AND g.id = p.renews_grant_id))`

const applicablePermissionGrantsSQL = `FROM permission_grants g
	  WHERE g.owner_id = tickets.owner_id AND (g.ticket_id = tickets.id OR (g.form = 'time' AND g.agent_id = tickets.assignee_agent_id))`

// The LIMIT is permissionGrantsShown.
const permissionGrantsJSON = `COALESCE((SELECT json_agg(json_build_object('id', g.public_id,
	          'agent', json_build_object('id', a.public_id, 'name', a.name, 'kind', a.kind),
	          'account', g.account, 'action', g.action, 'resource', g.resource, 'substituteAccount', false,
	          'form', g.form, 'state', g.state, 'expiresAt', g.expires_at, 'remainingSeconds', NULL,
	          'roundId', r.public_id, 'createdAt', g.created_at, 'approvedAt', g.approved_at) ORDER BY g.id)
	   FROM (SELECT g.* ` + applicablePermissionGrantsSQL + ` ORDER BY g.id DESC LIMIT 50) g
	   JOIN agents a ON a.owner_id = g.owner_id AND a.id = g.agent_id
	   JOIN permission_requests p ON p.owner_id = g.owner_id AND p.id = g.request_id
	   JOIN rounds r ON r.owner_id = p.owner_id AND r.id = p.round_id), '[]'),
	(SELECT count(*) ` + applicablePermissionGrantsSQL + `)`

type requestedPermission struct {
	id            string
	scope         permissionScope
	renewsGrantID string
}

func validatePermissionRequestedData(raw []byte) (requestedPermission, string) {
	const shape = `"data" must be an object with exactly "requestId", "account", "action" and "resource", and optionally "renewsGrantId"`
	fields, ok := exactObject(raw, "requestId", "account", "action", "resource")
	renewal := false
	if !ok {
		if fields, ok = exactObject(raw, "requestId", "account", "action", "resource", "renewsGrantId"); !ok {
			return requestedPermission{}, shape
		}
		renewal = true
	}
	var request requestedPermission
	if json.Unmarshal(fields["requestId"], &request.id) != nil || json.Unmarshal(fields["account"], &request.scope.account) != nil ||
		json.Unmarshal(fields["action"], &request.scope.action) != nil || json.Unmarshal(fields["resource"], &request.scope.resource) != nil {
		return requestedPermission{}, shape
	}
	if !canonicalRunnerUUID(request.id) {
		return requestedPermission{}, `"requestId" must be a non-nil UUID in lowercase canonical form`
	}
	if renewal && (json.Unmarshal(fields["renewsGrantId"], &request.renewsGrantID) != nil || !canonicalRunnerUUID(request.renewsGrantID)) {
		return requestedPermission{}, `"renewsGrantId" must be a non-nil UUID in lowercase canonical form`
	}
	return request, validateScopeFields(request.scope)
}

func renewedGrant(ctx context.Context, tx pgx.Tx, ownerID, roundID int64, request requestedPermission, now time.Time) (*int64, *roundEventRejection, error) {
	if request.renewsGrantID == "" {
		return nil, nil, nil
	}
	var grantRowID int64
	err := tx.QueryRow(ctx, `SELECT g.id FROM permission_grants g JOIN rounds r ON r.owner_id = g.owner_id AND r.id = $2
		WHERE g.owner_id = $1 AND g.public_id = $3::uuid AND g.agent_id = r.agent_id AND g.account = $4 AND g.action = $5 AND g.resource = $6
		  AND g.form = $7 AND NOT g.expires_at > $8`,
		ownerID, roundID, request.renewsGrantID, request.scope.account, request.scope.action, request.scope.resource, string(PermissionGrantFormTime), now).Scan(&grantRowID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &roundEventRejection{http.StatusBadRequest, invalidRenewalCode, invalidRenewalMessage}, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return &grantRowID, nil, nil
}

func raisePermissionRequest(ctx context.Context, tx pgx.Tx, ownerID int64, ticketID string, roundID int64, request requestedPermission, renewsGrantRowID *int64, now time.Time) error {
	var requestRowID int64
	if err := tx.QueryRow(ctx, `INSERT INTO permission_requests (owner_id, ticket_id, agent_id, round_id, request_id, account, action, resource, requested_at, renews_grant_id)
		SELECT owner_id, ticket_id, agent_id, id, $3::uuid, $4, $5, $6, $7, $8 FROM rounds WHERE owner_id = $1 AND id = $2
		RETURNING id`, ownerID, roundID, request.id, request.scope.account, request.scope.action, request.scope.resource, now, renewsGrantRowID).Scan(&requestRowID); err != nil {
		return err
	}
	return moveRoundAndTicket(ctx, tx, ownerID, ticketID, roundID, RoundRunning, RoundWaitingForInput, roundAsk{permissionRequestID: &requestRowID})
}

type grantTerms struct {
	form      PermissionGrantForm
	expiresAt *time.Time
}

func decideGrantForm(req ApprovePermissionRequest) (grantTerms, *transitionRejection) {
	switch {
	case !req.Form.Valid():
		return grantTerms{}, &transitionRejection{code: "invalid_request", message: approvePermissionRequestShape}
	case req.Form == PermissionGrantFormTicket && req.ExpiresAt != nil:
		return grantTerms{}, &transitionRejection{code: grantFormConflictCode, message: grantFormConflictMessage}
	case req.Form == PermissionGrantFormTime && req.ExpiresAt == nil:
		return grantTerms{}, &transitionRejection{code: "invalid_request", message: timeGrantExpiryRequiredMessage}
	case req.Form == PermissionGrantFormTime:
		expiresAt := req.ExpiresAt.UTC().Truncate(time.Microsecond)
		return grantTerms{form: req.Form, expiresAt: &expiresAt}, nil
	}
	return grantTerms{form: req.Form}, nil
}

func decideGrantExpiry(terms grantTerms, approvedAt time.Time) *transitionRejection {
	switch {
	case terms.expiresAt == nil:
		return nil
	case !timeGrantLive(*terms.expiresAt, approvedAt):
		return &transitionRejection{code: invalidGrantExpiryCode, message: grantExpiryNotFutureMessage}
	case terms.expiresAt.After(approvedAt.Add(timeGrantMaxDuration)):
		return &transitionRejection{code: invalidGrantExpiryCode, message: grantExpiryTooFarMessage}
	}
	return nil
}

// The authority check's SQL "expires_at > checked_at" is the same rule.
func timeGrantLive(expiresAt, at time.Time) bool {
	return expiresAt.After(at)
}

type permissionDecisionTarget struct {
	roundState    RoundState
	decided       bool
	stopRequested bool
}

// Stop is delivered before an approval and ends the Round, so a decision given after Stop could never resume it.
func decidePermission(target permissionDecisionTarget) *transitionRejection {
	switch {
	case target.decided:
		return &transitionRejection{code: permissionAlreadyDecidedCode, message: permissionAlreadyDecidedMessage}
	case !OpenRoundState(target.roundState).Valid():
		return &transitionRejection{code: roundNotOpenCode, message: roundNotOpenMessage}
	case target.roundState != RoundWaitingForInput:
		return &transitionRejection{code: permissionDecisionNotAvailableCode, message: permissionDecisionNotAvailableMsg}
	case target.stopRequested:
		return &transitionRejection{code: stopAlreadyRequestedCode, message: permissionStopRequestedMessage}
	}
	return nil
}

func decideWaitingPermission(state ticketWorkflowState) *transitionRejection {
	if state.waitingPermissionRequest == nil {
		return &transitionRejection{code: permissionDecisionNotAvailableCode, message: permissionDecisionNotAvailableMsg}
	}
	return decidePermission(permissionDecisionTarget{roundState: RoundWaitingForInput, decided: state.waitingPermissionRequest.Decision != nil, stopRequested: state.stopRequested})
}

func normalisePermissionRequest(request *PermissionRequest) {
	request.SubstituteAccount = isSubstituteAccount(request.Account)
	request.RequestedAt = request.RequestedAt.UTC()
	request.DecidedAt = utcOrNil(request.DecidedAt)
}

func normalisePermissionGrants(grants []PermissionGrant, now time.Time) {
	for i := range grants {
		grant := &grants[i]
		grant.SubstituteAccount = isSubstituteAccount(grant.Account)
		grant.CreatedAt = grant.CreatedAt.UTC()
		grant.ApprovedAt = grant.ApprovedAt.UTC()
		grant.ExpiresAt = utcOrNil(grant.ExpiresAt)
		grant.RemainingSeconds = nil
		if grant.ExpiresAt == nil {
			continue
		}
		remaining := 0
		if timeGrantLive(*grant.ExpiresAt, now) {
			remaining = int((grant.ExpiresAt.Sub(now) + time.Second - 1) / time.Second)
		} else {
			grant.State = PermissionGrantExpired
		}
		grant.RemainingSeconds = &remaining
	}
}

func writePermissionRequestNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", permissionRequestNotFoundMessage)
}

func (s *server) ApprovePermissionRequest(w http.ResponseWriter, r *http.Request, id string, roundId string, requestId string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	ticketID, roundID, requestID, ok := permissionRequestPath(id, roundId, requestId)
	if !ok {
		writePermissionRequestNotFound(w)
		return
	}
	var req ApprovePermissionRequest
	if !decodeStrictJSON(w, r, &req, approvePermissionRequestShape) {
		return
	}
	terms, rejection := decideGrantForm(req)
	if rejection != nil {
		writeTransitionRejection(w, rejection)
		return
	}
	s.decidePermissionRequest(w, r, owner.ID, ticketID, roundID, requestID, PermissionApproved, terms)
}

func (s *server) DeclinePermissionRequest(w http.ResponseWriter, r *http.Request, id string, roundId string, requestId string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	ticketID, roundID, requestID, ok := permissionRequestPath(id, roundId, requestId)
	if !ok {
		writePermissionRequestNotFound(w)
		return
	}
	s.decidePermissionRequest(w, r, owner.ID, ticketID, roundID, requestID, PermissionDeclined, grantTerms{})
}

func permissionRequestPath(id, roundId, requestId string) (string, string, string, bool) {
	ticketID, ticketOK := canonicalPublicID(id)
	roundID, roundOK := canonicalPublicID(roundId)
	requestID, requestOK := canonicalPublicID(requestId)
	return ticketID, roundID, requestID, ticketOK && roundOK && requestOK
}

func (s *server) decidePermissionRequest(w http.ResponseWriter, r *http.Request, ownerID int64, ticketID, roundID, requestID string, decision PermissionRequestDecision, terms grantTerms) {
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	ticket, found, rejection, err := decidePermissionForOwner(ctx, s.pool, ownerID, ticketID, roundID, requestID, decision, terms, s.clockNow())
	switch {
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", permissionRequestDecisionFailureMsg)
	case !found:
		writePermissionRequestNotFound(w)
	case rejection != nil:
		writeTransitionRejection(w, rejection)
	default:
		writeJSON(w, http.StatusOK, ticket)
	}
}

// Lock order: the Ticket row, then the request row, as for an answer. The grant and the approval command are written
// with the decision, so an approval never exists without both.
func decidePermissionForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, ticketID, roundID, requestID string, decision PermissionRequestDecision, terms grantTerms, now time.Time) (Ticket, bool, *transitionRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	lock, found, err := lockTicketForMutation(ctx, tx, ownerID, ticketID)
	if err != nil || !found {
		return Ticket{}, found, nil, err
	}
	var roundRowID, requestRowID int64
	var epoch int
	var target permissionDecisionTarget
	var requestedAt time.Time
	err = tx.QueryRow(ctx, `SELECT r.id, r.state, r.claim_epoch, p.id, p.decision IS NOT NULL, p.requested_at
		FROM rounds r
		JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		JOIN permission_requests p ON p.owner_id = r.owner_id AND p.round_id = r.id
		WHERE t.owner_id = $1 AND t.public_id = $2::uuid AND r.public_id = $3::uuid AND p.request_id = $4::uuid
		FOR UPDATE OF p`, ownerID, ticketID, roundID, requestID).Scan(&roundRowID, &target.roundState, &epoch, &requestRowID, &target.decided, &requestedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, false, nil, nil
	}
	if err != nil {
		return Ticket{}, false, nil, err
	}
	target.stopRequested = lock.openRoundID == roundID && lock.stopRequested
	if rejection := decidePermission(target); rejection != nil {
		return Ticket{}, true, rejection, nil
	}
	decidedAt := now.Truncate(time.Microsecond)
	if requestedAt.After(decidedAt) {
		decidedAt = requestedAt
	}
	if rejection := decideGrantExpiry(terms, decidedAt); rejection != nil {
		return Ticket{}, true, rejection, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE permission_requests SET decision = $2, decided_at = $3 WHERE id = $1`,
		requestRowID, string(decision), decidedAt); err != nil {
		return Ticket{}, true, nil, err
	}
	if decision == PermissionApproved {
		if _, err := tx.Exec(ctx, `INSERT INTO permission_grants (owner_id, public_id, ticket_id, agent_id, request_id, account, action, resource, form, state, created_at, approved_at, expires_at)
			SELECT owner_id, $2::uuid, ticket_id, agent_id, id, account, action, resource, $3, $4, decided_at, decided_at, $5 FROM permission_requests WHERE id = $1`,
			requestRowID, uuid.NewString(), string(terms.form), string(PermissionGrantActive), terms.expiresAt); err != nil {
			return Ticket{}, true, nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO round_commands (owner_id, round_id, public_id, type, claim_epoch, issued_at, permission_request_id)
			VALUES ($1, $2, $3::uuid, $4, $5, $6, $7)`, ownerID, roundRowID, uuid.NewString(), string(RunnerCommandApproval), epoch, now, requestRowID); err != nil {
			return Ticket{}, true, nil, err
		}
	}
	ticket, err := readLockedTicket(ctx, tx, ownerID, ticketID, now)
	if err != nil {
		return Ticket{}, true, nil, err
	}
	if err := loadTicketBadges(ctx, tx, ownerID, &ticket); err != nil {
		return Ticket{}, true, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Ticket{}, true, nil, err
	}
	return ticket, true, nil, nil
}

func roundPermissionRequests(ctx context.Context, tx pgx.Tx, ownerID int64, roundIDs []int64) (map[int64][]PermissionRequest, error) {
	rows, err := tx.Query(ctx, `SELECT p.round_id, `+permissionRequestJSON+` FROM permission_requests p
		WHERE p.owner_id = $1 AND p.round_id = ANY($2) ORDER BY p.round_id, p.id`, ownerID, roundIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	requests := map[int64][]PermissionRequest{}
	for rows.Next() {
		var roundID int64
		var request PermissionRequest
		if err := rows.Scan(&roundID, &request); err != nil {
			return nil, err
		}
		normalisePermissionRequest(&request)
		requests[roundID] = append(requests[roundID], request)
	}
	return requests, rows.Err()
}
