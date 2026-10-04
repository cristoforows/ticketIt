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
	approvePermissionRequestShape       = `request body must be JSON matching {"form": "ticket"}`
	permissionRequestDecisionFailureMsg = "failed to record the Permission decision"
)

const permissionRequestJSON = `json_build_object('id', p.request_id, 'account', p.account, 'action', p.action, 'resource', p.resource,
	'substituteAccount', false, 'requestedAt', p.requested_at, 'decision', p.decision, 'decidedAt', p.decided_at,
	'grantId', (SELECT g.public_id FROM permission_grants g WHERE g.owner_id = p.owner_id AND g.request_id = p.id))`

const permissionGrantsJSON = `COALESCE((SELECT json_agg(json_build_object('id', g.public_id,
	          'agent', json_build_object('id', a.public_id, 'name', a.name, 'kind', a.kind),
	          'account', g.account, 'action', g.action, 'resource', g.resource, 'substituteAccount', false,
	          'form', g.form, 'state', g.state, 'roundId', r.public_id, 'createdAt', g.created_at, 'approvedAt', g.approved_at) ORDER BY g.id)
	   FROM permission_grants g
	   JOIN agents a ON a.owner_id = g.owner_id AND a.id = g.agent_id
	   JOIN permission_requests p ON p.owner_id = g.owner_id AND p.id = g.request_id
	   JOIN rounds r ON r.owner_id = p.owner_id AND r.id = p.round_id
	  WHERE g.owner_id = tickets.owner_id AND g.ticket_id = tickets.id), '[]')`

type requestedPermission struct {
	id    string
	scope permissionScope
}

func validatePermissionRequestedData(raw []byte) (requestedPermission, string) {
	const shape = `"data" must be an object with exactly "requestId", "account", "action" and "resource"`
	fields, ok := exactObject(raw, "requestId", "account", "action", "resource")
	if !ok {
		return requestedPermission{}, shape
	}
	var request requestedPermission
	if json.Unmarshal(fields["requestId"], &request.id) != nil || json.Unmarshal(fields["account"], &request.scope.account) != nil ||
		json.Unmarshal(fields["action"], &request.scope.action) != nil || json.Unmarshal(fields["resource"], &request.scope.resource) != nil {
		return requestedPermission{}, shape
	}
	if !canonicalRunnerUUID(request.id) {
		return requestedPermission{}, `"requestId" must be a non-nil UUID in lowercase canonical form`
	}
	return request, validateScopeFields(request.scope)
}

func raisePermissionRequest(ctx context.Context, tx pgx.Tx, ownerID int64, ticketID string, roundID int64, request requestedPermission, now time.Time) error {
	var requestRowID int64
	if err := tx.QueryRow(ctx, `INSERT INTO permission_requests (owner_id, ticket_id, agent_id, round_id, request_id, account, action, resource, requested_at)
		SELECT owner_id, ticket_id, agent_id, id, $3::uuid, $4, $5, $6, $7 FROM rounds WHERE owner_id = $1 AND id = $2
		RETURNING id`, ownerID, roundID, request.id, request.scope.account, request.scope.action, request.scope.resource, now).Scan(&requestRowID); err != nil {
		return err
	}
	return moveRoundAndTicket(ctx, tx, ownerID, ticketID, roundID, RoundRunning, RoundWaitingForInput, roundAsk{permissionRequestID: &requestRowID})
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

func normalisePermissionGrants(grants []PermissionGrant) {
	for i := range grants {
		grants[i].SubstituteAccount = isSubstituteAccount(grants[i].Account)
		grants[i].CreatedAt = grants[i].CreatedAt.UTC()
		grants[i].ApprovedAt = grants[i].ApprovedAt.UTC()
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
	if !req.Form.Valid() {
		writeError(w, http.StatusBadRequest, "invalid_request", approvePermissionRequestShape)
		return
	}
	s.decidePermissionRequest(w, r, owner.ID, ticketID, roundID, requestID, PermissionApproved, req.Form)
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
	s.decidePermissionRequest(w, r, owner.ID, ticketID, roundID, requestID, PermissionDeclined, "")
}

func permissionRequestPath(id, roundId, requestId string) (string, string, string, bool) {
	ticketID, ticketOK := canonicalPublicID(id)
	roundID, roundOK := canonicalPublicID(roundId)
	requestID, requestOK := canonicalPublicID(requestId)
	return ticketID, roundID, requestID, ticketOK && roundOK && requestOK
}

func (s *server) decidePermissionRequest(w http.ResponseWriter, r *http.Request, ownerID int64, ticketID, roundID, requestID string, decision PermissionRequestDecision, form PermissionGrantForm) {
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	ticket, found, rejection, err := decidePermissionForOwner(ctx, s.pool, ownerID, ticketID, roundID, requestID, decision, form, s.clockNow())
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
func decidePermissionForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, ticketID, roundID, requestID string, decision PermissionRequestDecision, form PermissionGrantForm, now time.Time) (Ticket, bool, *transitionRejection, error) {
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
	err = tx.QueryRow(ctx, `SELECT r.id, r.state, r.claim_epoch, p.id, p.decision IS NOT NULL
		FROM rounds r
		JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		JOIN permission_requests p ON p.owner_id = r.owner_id AND p.round_id = r.id
		WHERE t.owner_id = $1 AND t.public_id = $2::uuid AND r.public_id = $3::uuid AND p.request_id = $4::uuid
		FOR UPDATE OF p`, ownerID, ticketID, roundID, requestID).Scan(&roundRowID, &target.roundState, &epoch, &requestRowID, &target.decided)
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
	if _, err := tx.Exec(ctx, `UPDATE permission_requests SET decision = $2, decided_at = GREATEST($3::timestamptz, requested_at) WHERE id = $1`,
		requestRowID, string(decision), now); err != nil {
		return Ticket{}, true, nil, err
	}
	if decision == PermissionApproved {
		if _, err := tx.Exec(ctx, `INSERT INTO permission_grants (owner_id, public_id, ticket_id, agent_id, request_id, account, action, resource, form, state, created_at, approved_at)
			SELECT owner_id, $2::uuid, ticket_id, agent_id, id, account, action, resource, $3, $4, decided_at, decided_at FROM permission_requests WHERE id = $1`,
			requestRowID, uuid.NewString(), string(form), string(PermissionGrantActive)); err != nil {
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
