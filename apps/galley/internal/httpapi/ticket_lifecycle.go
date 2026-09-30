package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// invalidTransitionCode is the one stable reason code for every move
// D3 S2's table does not list, including a plain status-set to Done.
// Callers match on this code, not on message text.
const invalidTransitionCode = "invalid_transition"

// reviewedPrMergeNotImplementedCode stays distinct from
// invalidTransitionCode so a caller can tell "wrong state" apart from
// "right state, but this condition cannot complete yet" -- a
// current-implementation limit (D2 unresolved, mechanism owned by M8).
const reviewedPrMergeNotImplementedCode = "reviewed_pr_merge_not_implemented"

// D3 S2's table, including the Owner-approved Backlog -> Blocked correction (#87).
// Done is reached through Accept; Blocked -> Ready remains disallowed.
var allowedSourceStatusesForTarget = map[TicketStatus][]TicketStatus{
	Backlog:    {Ready},
	Ready:      {Backlog, InProgress, Done},
	InProgress: {Ready, Blocked, InReview},
	Blocked:    {Backlog, InProgress},
	InReview:   {InProgress},
}

// A nil *transitionRejection means the transition is permitted.
type transitionRejection struct {
	code    string
	message string
}

// decidePlainStatusChange implements POST /api/tickets/{id}/status's
// rule against a Ticket's persisted current Status. Done is rejected
// unconditionally, whatever the current Status, so completion can
// never happen by accident through a plain status write.
func decidePlainStatusChange(current, target TicketStatus) *transitionRejection {
	if target == Done {
		return &transitionRejection{
			code: invalidTransitionCode,
			message: fmt.Sprintf(
				"%q is reachable only through explicit Accept (POST /api/tickets/{id}/accept), never a plain status change (attempted %s -> Done)",
				Done, current,
			),
		}
	}
	sources, known := allowedSourceStatusesForTarget[target]
	if known && containsStatus(sources, current) {
		return nil
	}
	return &transitionRejection{
		code:    invalidTransitionCode,
		message: fmt.Sprintf("the transition %s -> %s is not permitted", current, target),
	}
}

// decideAccept implements POST /api/tickets/{id}/accept's rule: D3 S2
// permits Done only from InReview, and only for a humanAcceptance
// Ticket. A reviewedPrMerge Ticket is rejected outright, never
// silently downgraded to humanAcceptance.
func decideAccept(current TicketStatus, condition TicketCompletionCondition) *transitionRejection {
	if current != InReview {
		return &transitionRejection{
			code:    invalidTransitionCode,
			message: fmt.Sprintf("Accept requires the ticket to be In Review (current status %s)", current),
		}
	}
	if condition == ReviewedPrMerge {
		return &transitionRejection{
			code: reviewedPrMergeNotImplementedCode,
			message: "this ticket's retained completion condition is reviewed PR merge, which cannot be completed in M2: " +
				"D2 (review/merge evidence) is unresolved and the shared mechanism it selects is owned by M8 " +
				"(docs/decisions/d3-agent-template-compatibility.md, \"Completing human work that requires a reviewed PR merge\"); " +
				"this is a current-implementation limitation, not a permanent rule -- the condition is never downgraded to human acceptance",
		}
	}
	return nil
}

func containsStatus(statuses []TicketStatus, target TicketStatus) bool {
	for _, s := range statuses {
		if s == target {
			return true
		}
	}
	return false
}

var statusTargets = []TicketStatus{Backlog, Ready, InProgress, Blocked, InReview, Done}

func allowedActionsForTicket(status TicketStatus, condition TicketCompletionCondition, archived bool) TicketAllowedActions {
	actions := TicketAllowedActions{StatusChanges: []TicketStatus{}}
	if archived {
		actions.Accept.Reason = &ErrorDetail{Code: archivedTicketCode, Message: archivedTicketMessage}
		return actions
	}
	for _, target := range statusTargets {
		if decidePlainStatusChange(status, target) == nil {
			actions.StatusChanges = append(actions.StatusChanges, target)
		}
	}
	if rejection := decideAccept(status, condition); rejection != nil {
		actions.Accept.Reason = &ErrorDetail{Code: rejection.code, Message: rejection.message}
	} else {
		actions.Accept.Available = true
	}
	return actions
}

// applyTicketTransition validates and applies a Status transition
// against a Ticket's PERSISTED current Status. The FOR UPDATE row
// lock is what stops two concurrent conflicting requests both
// applying: the second blocks until the first commits, then
// re-evaluates decide against the already-changed Status rather than
// the value it started with.
//
// decide alone chooses the destination Status; this function only
// writes what the closure returned. It creates no Round, work
// request, or queue entry -- see
// TestManualLifecycleActionsCreateNoExecutionRecords.
func applyTicketTransition(
	ctx context.Context,
	pool *pgxpool.Pool,
	ownerID int64,
	publicID string,
	decide func(current TicketStatus, condition TicketCompletionCondition) (nextStatus TicketStatus, rejection *transitionRejection),
) (ticket Ticket, found bool, rejection *transitionRejection, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, nil, fmt.Errorf("failed to start the transition transaction: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed

	found, err = lockTicketForMutation(ctx, tx, ownerID, publicID, false)
	if errors.Is(err, errArchivedTicket) {
		return Ticket{}, true, &transitionRejection{code: archivedTicketCode, message: archivedTicketMessage}, nil
	}
	if err != nil || !found {
		return Ticket{}, found, nil, err
	}
	var statusStr, conditionStr string
	err = tx.QueryRow(ctx,
		`SELECT status, completion_condition FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid`,
		ownerID, publicID,
	).Scan(&statusStr, &conditionStr)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, false, nil, nil
	}
	if err != nil {
		return Ticket{}, false, nil, fmt.Errorf("failed to read the ticket's current status: %w", err)
	}

	current := TicketStatus(statusStr)
	condition := TicketCompletionCondition(conditionStr)
	nextStatus, rej := decide(current, condition)
	if rej != nil {
		return Ticket{}, true, rej, nil
	}

	row := tx.QueryRow(ctx,
		`UPDATE tickets SET status = $3, updated_at = now()
		  WHERE owner_id = $1 AND public_id = $2::uuid
		  RETURNING `+ticketSelectColumns,
		ownerID, publicID, string(nextStatus),
	)
	ticket, err = scanTicketRow(row)
	if err != nil {
		return Ticket{}, true, nil, fmt.Errorf("failed to apply the ticket's new status: %w", err)
	}
	if err := loadTicketBadges(ctx, tx, ownerID, &ticket); err != nil {
		return Ticket{}, true, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Ticket{}, true, nil, fmt.Errorf("failed to commit the transition: %w", err)
	}
	return ticket, true, nil, nil
}

// 400: the request is well-formed, the move is not permitted from the
// ticket's current state.
func writeTransitionRejection(w http.ResponseWriter, rejection *transitionRejection) {
	writeError(w, http.StatusBadRequest, rejection.code, rejection.message)
}

func (s *server) ChangeTicketStatus(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, ok = canonicalPublicID(id)
	if !ok {
		writeTicketNotFound(w)
		return
	}

	var req ChangeTicketStatusRequest
	if !decodeStrictJSON(w, r, &req, `request body must be JSON matching {"status": "..."}`) {
		return
	}
	if !req.Status.Valid() {
		writeError(w, http.StatusBadRequest, "invalid_request",
			fmt.Sprintf("%q is not a recognized status", req.Status))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	ticket, found, rejection, err := applyTicketTransition(ctx, s.pool, owner.ID, id,
		func(current TicketStatus, _ TicketCompletionCondition) (TicketStatus, *transitionRejection) {
			if rej := decidePlainStatusChange(current, req.Status); rej != nil {
				return "", rej
			}
			return req.Status, nil
		},
	)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to change the ticket's status")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	if rejection != nil {
		writeTransitionRejection(w, rejection)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

// The one path to Done, kept as its own command rather than a Status
// write to respect the Swiftlet -> Galley owner-command boundary
// (docs/contracts/execution-interface.md).
func (s *server) AcceptTicket(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, ok = canonicalPublicID(id)
	if !ok {
		writeTicketNotFound(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	ticket, found, rejection, err := applyTicketTransition(ctx, s.pool, owner.ID, id,
		func(current TicketStatus, condition TicketCompletionCondition) (TicketStatus, *transitionRejection) {
			if rej := decideAccept(current, condition); rej != nil {
				return "", rej
			}
			return Done, nil
		},
	)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to accept the ticket")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	if rejection != nil {
		writeTransitionRejection(w, rejection)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

type ticketAssignee struct {
	kind    TicketAssigneeType
	agentID string
}

// D3 places no current-Status or Template precondition on assignment,
// and no Round exists yet to lock the field.
func setTicketAssigneeForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, publicID string, assignee ticketAssignee) (Ticket, bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	found, err := lockTicketForMutation(ctx, tx, ownerID, publicID, false)
	if err != nil || !found {
		return Ticket{}, found, err
	}
	var agentRowID *int64
	if assignee.kind == TicketAssigneeTypeAgent {
		id, found, err := agentRowIDForOwner(ctx, tx, ownerID, assignee.agentID)
		if err != nil || !found {
			return Ticket{}, found, err
		}
		agentRowID = &id
	}
	var assigneeType *string
	if assignee.kind != TicketAssigneeTypeEmpty {
		value := string(assignee.kind)
		assigneeType = &value
	}
	row := tx.QueryRow(ctx,
		`UPDATE tickets SET assignee_type = $3, assignee_agent_id = $4, updated_at = now()
		  WHERE owner_id = $1 AND public_id = $2::uuid
		  RETURNING `+ticketSelectColumns,
		ownerID, publicID, assigneeType, agentRowID,
	)
	ticket, err := scanTicketRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, false, nil
	}
	if err != nil {
		return Ticket{}, false, err
	}
	if err := loadTicketBadges(ctx, tx, ownerID, &ticket); err != nil {
		return Ticket{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Ticket{}, false, err
	}
	return ticket, true, nil
}

func writeTicketOrAgentNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", "no ticket or agent with that identifier")
}

func (s *server) AssignTicket(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, ok = canonicalPublicID(id)
	if !ok {
		writeTicketNotFound(w)
		return
	}
	var req AssignTicketRequest
	if !decodeStrictJSON(w, r, &req, `request body must be JSON matching {"type": "owner"} or {"type": "agent", "agentId": "<uuid>"}`) {
		return
	}
	assignee := ticketAssignee{kind: TicketAssigneeTypeOwner}
	writeNotFound := writeTicketNotFound
	switch req.Type {
	case AssignTicketRequestTypeOwner:
		if req.AgentId != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", `"agentId" is accepted only when "type" is "agent"`)
			return
		}
	case AssignTicketRequestTypeAgent:
		if req.AgentId == nil {
			writeError(w, http.StatusBadRequest, "invalid_request", `"agentId" is required when "type" is "agent"`)
			return
		}
		agentID, valid := canonicalPublicID(*req.AgentId)
		if !valid {
			writeTicketOrAgentNotFound(w)
			return
		}
		assignee = ticketAssignee{kind: TicketAssigneeTypeAgent, agentID: agentID}
		writeNotFound = writeTicketOrAgentNotFound
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf(`"type" must be %q or %q`, AssignTicketRequestTypeOwner, AssignTicketRequestTypeAgent))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	ticket, found, err := setTicketAssigneeForOwner(ctx, s.pool, owner.ID, id, assignee)
	if err != nil {
		writeMutationError(w, err, "failed to assign the ticket")
		return
	}
	if !found {
		writeNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

func (s *server) UnassignTicket(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, ok = canonicalPublicID(id)
	if !ok {
		writeTicketNotFound(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	ticket, found, err := setTicketAssigneeForOwner(ctx, s.pool, owner.ID, id, ticketAssignee{})
	if err != nil {
		writeMutationError(w, err, "failed to unassign the ticket")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}
