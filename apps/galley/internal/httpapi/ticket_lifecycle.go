package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/google/uuid"
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

// allowedSourceStatusesForTarget is D3 S2's workflow table
// (docs/decisions/d3-agent-template-compatibility.md) inverted: per
// requested target Status, the current Statuses a plain
// POST /api/tickets/{id}/status may move from. Transcribed literally,
// so every absence is deliberate -- notably Done, which has no entry
// because only Accept reaches it, and Blocked -> Ready, which D3
// omits in favour of Blocked -> InProgress alone.
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

	var statusStr, conditionStr string
	err = tx.QueryRow(ctx,
		`SELECT status, completion_condition FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid FOR UPDATE`,
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
	if _, err := uuid.Parse(id); err != nil {
		writeTicketNotFound(w)
		return
	}

	var req ChangeTicketStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", `request body must be JSON matching {"status": "..."}`)
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
	if _, err := uuid.Parse(id); err != nil {
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

// setTicketAssigneeForOwner unconditionally sets assignee_type; nil
// binds SQL NULL (unassigned). D3 places no current-Status
// precondition on human assignment, and M2 never has an open Round to
// lock the field, so unlike applyTicketTransition this needs no
// transaction -- there is no persisted state it could conflict with.
func setTicketAssigneeForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, publicID string, assigneeType *string) (Ticket, bool, error) {
	row := pool.QueryRow(ctx,
		`UPDATE tickets SET assignee_type = $3, updated_at = now()
		  WHERE owner_id = $1 AND public_id = $2::uuid
		  RETURNING `+ticketSelectColumns,
		ownerID, publicID, assigneeType,
	)
	ticket, err := scanTicketRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, false, nil
	}
	if err != nil {
		return Ticket{}, false, err
	}
	return ticket, true, nil
}

// The only non-empty assignee_type M2 writes; migration 000007 says
// why the column is not a closed CHECK.
const assigneeTypeOwnerValue = "owner"

// The Owner is the only assignable Assignee in M2, so this takes no
// assignee in its body.
func (s *server) AssignTicketOwner(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if _, err := uuid.Parse(id); err != nil {
		writeTicketNotFound(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	assigneeType := assigneeTypeOwnerValue
	ticket, found, err := setTicketAssigneeForOwner(ctx, s.pool, owner.ID, id, &assigneeType)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to assign the ticket")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

func (s *server) UnassignTicket(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if _, err := uuid.Parse(id); err != nil {
		writeTicketNotFound(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	ticket, found, err := setTicketAssigneeForOwner(ctx, s.pool, owner.ID, id, nil)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to unassign the ticket")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}
