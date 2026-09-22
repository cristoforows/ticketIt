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

// invalidTransitionCode is the one stable, machine-readable reason
// code for every Status move this file rejects that D3 S2's table
// does not list -- including a plain status-set to Done, which this
// file always treats as "not on the table" regardless of the current
// Status (see decidePlainStatusChange). Callers match on this code,
// not on message text.
const invalidTransitionCode = "invalid_transition"

// reviewedPrMergeNotImplementedCode is Accept's own, more specific
// reason code for a Ticket whose retained completion condition is
// reviewedPrMerge: an explicit current-implementation limitation
// (D2 unresolved, shared mechanism owned by M8), never folded into
// invalidTransitionCode -- a caller needs to tell "wrong state" apart
// from "right state, but this condition cannot complete yet."
const reviewedPrMergeNotImplementedCode = "reviewed_pr_merge_not_implemented"

// allowedSourceStatusesForTarget is D3 S2's human-assigned workflow
// table (docs/decisions/d3-agent-template-compatibility.md),
// inverted: for a given requested target Status, the set of current
// Statuses a plain POST /api/tickets/{id}/status may move from. This
// is the literal table, not an inferred generalisation -- every
// absence here is deliberate:
//
//   - Done has no entry at all: it is reachable only through explicit
//     Accept (acceptTransition below), never this map.
//   - Backlog's only source is Ready (Ready -> Backlog). Backlog is
//     never a *target* from InProgress or Done.
//   - Ready's sources are Backlog, InProgress, and Done -- but
//     deliberately NOT Blocked: D3 permits only Blocked -> InProgress,
//     not a shortcut straight back to Ready.
//   - InProgress's sources are Ready, Blocked, and InReview.
//   - Blocked's only source is InProgress.
//   - InReview's only source is InProgress.
var allowedSourceStatusesForTarget = map[TicketStatus][]TicketStatus{
	Backlog:    {Ready},
	Ready:      {Backlog, InProgress, Done},
	InProgress: {Ready, Blocked, InReview},
	Blocked:    {InProgress},
	InReview:   {InProgress},
}

// transitionRejection carries a rejected transition's stable reason
// code and human-readable explanation. A nil *transitionRejection
// from decidePlainStatusChange/decideAccept means the transition is
// permitted.
type transitionRejection struct {
	code    string
	message string
}

// decidePlainStatusChange implements POST /api/tickets/{id}/status's
// rule against a Ticket's persisted current Status: allowed only when
// (current, target) is literally D3 S2's table (via
// allowedSourceStatusesForTarget). Done is rejected unconditionally --
// this function never returns Done as its accepted next value -- so
// completion can never happen by accident through a plain status
// write, whatever the current Status.
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
// Ticket. A reviewedPrMerge Ticket cannot be completed in M2 at all
// (D2 unresolved, shared mechanism owned by M8) -- rejected with its
// own reason code, never silently downgraded to humanAcceptance and
// never silently completed.
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
// against a Ticket's PERSISTED current Status inside a single
// transaction: SELECT ... FOR UPDATE takes a row lock for the whole
// transaction, so a second, concurrent call on the same Ticket blocks
// on that lock until the first commits (or rolls back), then reads
// the now-current row -- never the value this call started with. This
// is what makes two concurrent conflicting requests unable to both
// apply: whichever commits first wins, and the second necessarily
// re-evaluates decide against the already-changed Status.
//
// decide receives the row's current Status and completion condition
// and returns nil to permit the requested transition (see
// decidePlainStatusChange/decideAccept for the two callers' rules) or
// a non-nil rejection to deny it -- either way, decide alone chooses
// the destination Status via the closure's own captured target
// (decidePlainStatusChange) or fixed Done (decideAccept); this
// function only ever writes the Status the closure already decided
// on, via nextStatus.
//
// This never creates a Round, work request, or queue entry, and
// starts nothing beyond this one UPDATE -- see
// TestManualLifecycleActionsCreateNoExecutionRecords for the proof and
// exactly what would make it fail.
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

// writeTransitionRejection reports a rejected transition in the
// shared error shape, at 400 -- the request was well-formed, but this
// specific move is not permitted from the ticket's current state.
func writeTransitionRejection(w http.ResponseWriter, rejection *transitionRejection) {
	writeError(w, http.StatusBadRequest, rejection.code, rejection.message)
}

// ChangeTicketStatus is POST /api/tickets/{id}/status (issue #60): a
// human-assigned lifecycle transition, implementing D3 S2's table
// exactly. See decidePlainStatusChange and applyTicketTransition for
// the validation/concurrency rules.
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

// AcceptTicket is POST /api/tickets/{id}/accept (issue #60): the one
// path to Done, kept as its own command rather than a Status write
// per docs/contracts/execution-interface.md's Swiftlet -> Galley
// owner-command boundary. See decideAccept for the completion-condition
// rule and applyTicketTransition for the concurrency guarantee.
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

// setTicketAssigneeForOwner unconditionally sets assignee_type,
// scoped to ownerID exactly like every other ticket query in this
// package. assigneeType nil binds SQL NULL (unassigned); a non-nil
// pointer binds that value ("owner" today -- see AssignTicketOwner).
// No current-Status precondition applies: D3 places none on human
// assignment, since M2 never has an open Round to lock the Assignee
// field, so this needs no transaction of its own the way
// applyTicketTransition does -- there is no persisted state this
// write could conflict with.
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

// assigneeTypeOwnerValue is the one non-empty assignee_type value M2
// ever writes -- see internal/migrations/000007_....sql's own comment
// on why this is a plain string column rather than a closed CHECK.
const assigneeTypeOwnerValue = "owner"

// AssignTicketOwner is PUT /api/tickets/{id}/assignee (issue #60):
// the only assignable Assignee in M2 is the Owner. Idempotent, and
// creates no Round, work request, or queue entry.
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

// UnassignTicket is DELETE /api/tickets/{id}/assignee (issue #60):
// clears the Assignee back to unassigned. Idempotent, and creates no
// Round, work request, or queue entry.
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
