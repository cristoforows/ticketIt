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
	missing []AgentReadinessInput
}

func (r *transitionRejection) detail() ErrorDetail {
	detail := ErrorDetail{Code: r.code, Message: r.message}
	if len(r.missing) > 0 {
		missing := r.missing
		detail.Missing = &missing
	}
	return detail
}

// decidePlainStatusChange implements POST /api/tickets/{id}/status's
// rule against a Ticket's persisted state. Done is rejected
// unconditionally, whatever the current Status, so completion can
// never happen by accident through a plain status write.
func decidePlainStatusChange(state ticketWorkflowState, target TicketStatus) *transitionRejection {
	current := state.status
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
	if !known || !containsStatus(sources, current) {
		return &transitionRejection{
			code:    invalidTransitionCode,
			message: fmt.Sprintf("the transition %s -> %s is not permitted", current, target),
		}
	}
	if _, owned := agentOwnedTargets[target]; state.agentAssigned() && owned {
		return &transitionRejection{
			code:    agentOwnedTransitionCode,
			message: fmt.Sprintf("Execution sets %s on an Agent-assigned Ticket", agentOwnedTargets[target]),
		}
	}
	if target == Ready {
		state.status = Ready
		return decideAgentReadiness(state)
	}
	return nil
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

func allowedActionsForTicket(state ticketWorkflowState, condition TicketCompletionCondition) TicketAllowedActions {
	actions := TicketAllowedActions{StatusChanges: []TicketStatus{}, StatusChangeRejections: []TicketStatusChangeRejection{}}
	if state.archived {
		actions.Accept.Reason = &ErrorDetail{Code: archivedTicketCode, Message: archivedTicketMessage}
		return actions
	}
	for _, target := range statusTargets {
		rejection := decidePlainStatusChange(state, target)
		switch {
		case rejection == nil:
			actions.StatusChanges = append(actions.StatusChanges, target)
		case rejection.code != invalidTransitionCode:
			actions.StatusChangeRejections = append(actions.StatusChangeRejections, TicketStatusChangeRejection{Status: target, Reason: rejection.detail()})
		}
	}
	if rejection := decideAccept(state.status, condition); rejection != nil {
		detail := rejection.detail()
		actions.Accept.Reason = &detail
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
	decide func(state ticketWorkflowState, condition TicketCompletionCondition) (nextStatus TicketStatus, rejection *transitionRejection),
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
	locked, err := readLockedTicket(ctx, tx, ownerID, publicID)
	if err != nil {
		return Ticket{}, false, nil, fmt.Errorf("failed to read the ticket's current status: %w", err)
	}

	nextStatus, rej := decide(workflowStateOf(locked), locked.CompletionCondition)
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
	writeJSON(w, http.StatusBadRequest, ErrorBody{Error: rejection.detail()})
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
		func(state ticketWorkflowState, _ TicketCompletionCondition) (TicketStatus, *transitionRejection) {
			if rej := decidePlainStatusChange(state, req.Status); rej != nil {
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
		func(state ticketWorkflowState, condition TicketCompletionCondition) (TicketStatus, *transitionRejection) {
			if rej := decideAccept(state.status, condition); rej != nil {
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

// D3 places no Template precondition on assignment, and no Round
// exists yet to lock the field.
func setTicketAssigneeForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, publicID string, assignee ticketAssignee) (Ticket, bool, *transitionRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	found, err := lockTicketForMutation(ctx, tx, ownerID, publicID, false)
	if err != nil || !found {
		return Ticket{}, found, nil, err
	}
	var agentRowID *int64
	var agentKind AgentKind
	if assignee.kind == TicketAssigneeTypeAgent {
		id, kind, found, err := agentForOwner(ctx, tx, ownerID, assignee.agentID)
		if err != nil || !found {
			return Ticket{}, found, nil, err
		}
		agentRowID, agentKind = &id, kind
	}
	locked, err := readLockedTicket(ctx, tx, ownerID, publicID)
	if err != nil {
		return Ticket{}, false, nil, err
	}
	if rejection := decideAssignment(workflowStateOf(locked), agentKind); rejection != nil {
		return Ticket{}, true, rejection, nil
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
		return Ticket{}, false, nil, nil
	}
	if err != nil {
		return Ticket{}, false, nil, err
	}
	if err := loadTicketBadges(ctx, tx, ownerID, &ticket); err != nil {
		return Ticket{}, false, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Ticket{}, false, nil, err
	}
	return ticket, true, nil, nil
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

	ticket, found, rejection, err := setTicketAssigneeForOwner(ctx, s.pool, owner.ID, id, assignee)
	if err != nil {
		writeMutationError(w, err, "failed to assign the ticket")
		return
	}
	if !found {
		writeNotFound(w)
		return
	}
	if rejection != nil {
		writeTransitionRejection(w, rejection)
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

	ticket, found, _, err := setTicketAssigneeForOwner(ctx, s.pool, owner.ID, id, ticketAssignee{})
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
