package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ticketTimeout bounds every ticket query, matching diagnosticTimeout's
// and authTimeout's rationale: fail the request promptly when the
// database is unreachable rather than hang it.
const ticketTimeout = 5 * time.Second

// ticketTitleMaxLength is this slice's documented maximum title
// length, applied after trimming: comfortably longer than a real
// one-line title, while staying under the limits GitHub (256) and
// Jira (255) use for the same kind of field. See
// docs/evidence/m2/56-ticket-capture-list.md for the full reasoning.
const ticketTitleMaxLength = 200

// Manual refinement fields' documented maximum lengths (issue #58,
// applied after trimming, in characters -- utf8.RuneCountInString,
// exactly like ticketTitleMaxLength -- not bytes). goal/successCriteria/
// constraints are kept comfortably shorter than context, which is
// meant to hold links, reproduction steps, and pasted background text
// rather than a one- or two-sentence statement. See
// docs/evidence/m2/58-refinement-fields.md for the full reasoning.
const (
	ticketGoalMaxLength            = 2000
	ticketContextMaxLength         = 10000
	ticketSuccessCriteriaMaxLength = 2000
	ticketConstraintsMaxLength     = 2000
)

// ticketRepositoryMaxLength is the one Ticket repository reference's
// documented maximum length (issue #59, D3 S1 check 3), applied after
// trimming, in characters -- comfortably longer than an "owner/repo"
// name or a full repository URL.
const ticketRepositoryMaxLength = 500

// server also implements the generated ServerInterface's Ticket
// operations: title-only capture into Backlog and listing the
// signed-in Owner's Tickets (issue #56), and getting one Ticket by its
// public identifier (issue #57). Hand-rolled against the pool, no
// repository layer, matching diagnostic.go's rationale -- one domain
// table does not yet justify one.
//
// Every method calls requireSession first: every Ticket is scoped to
// the Owner it resolves (owner_id), and a request without a valid
// session is rejected before any query runs (apps/galley/README.md,
// "Authenticated routes").

func (s *server) ListTickets(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	tickets, err := listTicketsForOwner(ctx, s.pool, owner.ID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to read tickets")
		return
	}
	writeJSON(w, http.StatusOK, TicketList{Tickets: tickets})
}

// GetTicket returns one Ticket addressed by its public identifier
// (issue #57), scoped to the signed-in Owner. A malformed identifier
// is rejected before ever reaching the database -- both to avoid a
// Postgres syntax error on an invalid ::uuid cast (see
// getTicketForOwner) and, more importantly, because this endpoint's
// own contract promises a malformed value, an unknown one, and one
// belonging to another Owner are all indistinguishable: the same
// 404 not_found, never revealing which case occurred.
func (s *server) GetTicket(w http.ResponseWriter, r *http.Request, id string) {
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

	ticket, found, err := getTicketForOwner(ctx, s.pool, owner.ID, id)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to read the ticket")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

func writeTicketNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", "no ticket with that identifier")
}

// UpdateTicket partially updates a Ticket's title and/or its manual
// refinement fields (issue #58, docs/ticket-creation.md, "Manual
// guidance"). No AI of any kind is involved, and this triggers nothing
// else. Identifier handling mirrors GetTicket exactly: a malformed
// value is rejected before ever reaching the database, folded into the
// same 404 as "not found" or "belongs to another Owner" -- this
// endpoint makes the same promise GetTicket does, never revealing
// which case occurred.
//
// Concurrent-edit rule: last-write-wins. There is no optimistic
// concurrency check (no version token, no ETag/If-Match) -- two PATCH
// requests naming the same field apply in whichever order Galley
// processes them, and the later one's value silently overwrites the
// earlier one's. This is an explicit, documented choice (issue #58
// permits it), not an oversight -- see apps/galley/README.md, "Manual
// refinement fields," and contracts/openapi.yaml's updateTicket
// description.
func (s *server) UpdateTicket(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}

	if _, err := uuid.Parse(id); err != nil {
		writeTicketNotFound(w)
		return
	}

	var req UpdateTicketRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request",
			`request body must be JSON matching {"title"?, "goal"?, "context"?, "successCriteria"?, "constraints"?, "repository"?}`)
		return
	}

	// D3/D4: changing a Ticket's Template after creation is out of
	// scope for M2 -- post-delivery Template/repository change belongs
	// to D4, owned by M8. This request schema carries `template` only
	// so this rejection can be explicit rather than the field being
	// silently ignored; naming it at all, any value included, is
	// rejected before any other validation or the database is touched.
	if req.Template != nil {
		writeError(w, http.StatusBadRequest, "invalid_request",
			`"template" cannot be changed after creation in M2 -- see D4 (docs/decisions), owned by M8`)
		return
	}

	title, ok := validateOptionalTitle(w, req.Title)
	if !ok {
		return
	}
	goal, ok := validateRefinementField(w, "goal", req.Goal, ticketGoalMaxLength)
	if !ok {
		return
	}
	ticketContext, ok := validateRefinementField(w, "context", req.Context, ticketContextMaxLength)
	if !ok {
		return
	}
	successCriteria, ok := validateRefinementField(w, "successCriteria", req.SuccessCriteria, ticketSuccessCriteriaMaxLength)
	if !ok {
		return
	}
	constraints, ok := validateRefinementField(w, "constraints", req.Constraints, ticketConstraintsMaxLength)
	if !ok {
		return
	}
	repository, ok := validateRefinementField(w, "repository", req.Repository, ticketRepositoryMaxLength)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	// Note what is absent here: no template or completionCondition
	// field. completion_condition has no write path at all beyond
	// insertTicket -- this update never includes it, which is what
	// makes "retained independently of later edits" true by
	// construction rather than by a check that could be bypassed here.
	ticket, found, err := updateTicketForOwner(ctx, s.pool, owner.ID, id, ticketUpdate{
		title:           title,
		goal:            goal,
		context:         ticketContext,
		successCriteria: successCriteria,
		constraints:     constraints,
		repository:      repository,
	})
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to update the ticket")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

// validateOptionalTitle applies CreateTicketRequest.title's own rule
// (trimmed, non-empty, at most ticketTitleMaxLength characters) to a
// PATCH request's optional title -- except a value that trims to empty
// is rejected outright rather than accepted as "clear the title":
// every Ticket must keep one (contracts/openapi.yaml's
// UpdateTicketRequest.title). A nil value (the property was absent
// from the request body) passes through unchanged so
// updateTicketForOwner's COALESCE-based update leaves the stored title
// untouched.
func validateOptionalTitle(w http.ResponseWriter, value *string) (*string, bool) {
	if value == nil {
		return nil, true
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		writeError(w, http.StatusBadRequest, "invalid_request",
			`"title" cannot be cleared -- every ticket must have a title`)
		return nil, false
	}
	if utf8.RuneCountInString(trimmed) > ticketTitleMaxLength {
		writeError(w, http.StatusBadRequest, "invalid_request",
			fmt.Sprintf(`"title" must be at most %d characters after trimming`, ticketTitleMaxLength))
		return nil, false
	}
	return &trimmed, true
}

// validateRefinementField applies the manual refinement fields' shared
// rule (issue #58, contracts/openapi.yaml's UpdateTicketRequest):
// absent (a nil pointer -- the property was not present in the request
// body at all) leaves the field untouched; present, trimmed to empty
// -- including a whitespace-only value -- clears it; present with text
// trims and enforces maxLen, counted in characters
// (utf8.RuneCountInString), not bytes, matching ticketTitleMaxLength's
// own rationale (docs/evidence/m2/56-ticket-capture-list.md). Unlike
// title, an empty trimmed result is a valid value here: it is this
// field's own "clear" signal, not rejected.
func validateRefinementField(w http.ResponseWriter, name string, value *string, maxLen int) (*string, bool) {
	if value == nil {
		return nil, true
	}
	trimmed := strings.TrimSpace(*value)
	if utf8.RuneCountInString(trimmed) > maxLen {
		writeError(w, http.StatusBadRequest, "invalid_request",
			fmt.Sprintf("%q must be at most %d characters after trimming", name, maxLen))
		return nil, false
	}
	return &trimmed, true
}

func (s *server) CreateTicket(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}

	var req CreateTicketRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", `request body must be JSON matching {"title": "..."}`)
		return
	}

	// Trimmed, required, non-empty, length-bounded -- contracts/openapi.yaml's
	// CreateTicketRequest documents the same rule; enforced here since a
	// contract's minLength/maxLength are documentation, not runtime
	// validation, for a hand-rolled (non-oapi-codegen-validated) handler.
	title := strings.TrimSpace(req.Title)
	if title == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", `"title" must be a non-empty string`)
		return
	}
	// Code points, not bytes: contracts/openapi.yaml's maxLength is a
	// JSON Schema constraint, which counts characters. len() would
	// reject a contract-valid CJK or emoji title at a third of the
	// documented limit.
	if utf8.RuneCountInString(title) > ticketTitleMaxLength {
		writeError(w, http.StatusBadRequest, "invalid_request",
			fmt.Sprintf(`"title" must be at most %d characters after trimming`, ticketTitleMaxLength))
		return
	}

	// Template (issue #59, docs/ticket-creation.md): chosen at capture,
	// defaulting to Basic when absent. A title alone remains sufficient
	// to capture a Ticket of either Template -- no other field is
	// required here regardless of which Template is chosen.
	template := Basic
	if req.Template != nil {
		template = *req.Template
	}
	if !template.Valid() {
		writeError(w, http.StatusBadRequest, "invalid_request",
			fmt.Sprintf(`"template" must be one of %q or %q`, Basic, Coding))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	// Backlog (api.gen.go, generated from CreateTicketRequest's sibling
	// TicketStatus enum) is the only Status this slice ever produces --
	// docs/ticket-creation.md, "Quick capture": a title alone captures a
	// Ticket in Backlog. No transition exists yet (#60).
	ticket, err := insertTicket(ctx, s.pool, owner.ID, title, template)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to create the ticket")
		return
	}
	writeJSON(w, http.StatusCreated, ticket)
}

// defaultCompletionCondition derives a newly captured Ticket's
// completion condition from its chosen Template's default -- the ONE
// place in this codebase that maps a Template to anything, and it runs
// only here, at creation (insertTicket). D3 (docs/decisions/d3-agent-template-compatibility.md)
// requires this derivation to happen exactly once: no later operation
// (UpdateTicket, or any future assignment/reassignment endpoint) may
// call this function or otherwise recompute the stored value.
func defaultCompletionCondition(template TicketTemplate) TicketCompletionCondition {
	if template == Coding {
		return ReviewedPrMerge
	}
	return HumanAcceptance
}

// ticketSelectColumns is shared by every query in this file that
// returns a full Ticket row -- insertTicket's RETURNING,
// getTicketForOwner's and listTicketsForOwner's SELECT, and
// updateTicketForOwner's RETURNING -- so the column list and
// scanTicketRow's scan targets can never drift against each other.
const ticketSelectColumns = `public_id::text, title, status, template, completion_condition, assignee_type, goal, context, success_criteria, constraints, repository, created_at, updated_at`

// ticketRowScanner is satisfied by both pgx.Row (QueryRow) and pgx.Rows
// (Query) -- both expose Scan(dest ...any) error with this signature,
// so scanTicketRow serves every ticket query in this file.
type ticketRowScanner interface {
	Scan(dest ...any) error
}

// scanTicketRow scans one row shaped by ticketSelectColumns into a
// Ticket. goal/context/success_criteria/constraints are nullable at
// the storage layer (internal/migrations/000005_...sql) -- a Ticket
// whose manual refinement was never touched has NULL there -- but
// never null on the wire: sql.NullString's zero value is "" when the
// column is NULL, which is exactly this endpoint's documented "unset
// reads as empty string" rule (contracts/openapi.yaml's Ticket.goal
// description).
func scanTicketRow(row ticketRowScanner) (Ticket, error) {
	var (
		ticket                                                   Ticket
		status, template, completionCondition                    string
		assigneeType                                             sql.NullString
		goal, ctxField, successCriteria, constraints, repository sql.NullString
		createdAt, updatedAt                                     time.Time
	)
	if err := row.Scan(
		&ticket.Id, &ticket.Title, &status, &template, &completionCondition, &assigneeType,
		&goal, &ctxField, &successCriteria, &constraints, &repository,
		&createdAt, &updatedAt,
	); err != nil {
		return Ticket{}, err
	}
	ticket.Status = TicketStatus(status)
	ticket.Template = TicketTemplate(template)
	ticket.CompletionCondition = TicketCompletionCondition(completionCondition)
	// NULL means "never assigned", surfaced as "" on the wire -- the
	// same convention goal/context already use.
	ticket.AssigneeType = TicketAssigneeType(assigneeType.String)
	ticket.Goal = goal.String
	ticket.Context = ctxField.String
	ticket.SuccessCriteria = successCriteria.String
	ticket.Constraints = constraints.String
	ticket.Repository = repository.String
	ticket.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	ticket.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return ticket, nil
}

// insertTicket persists a new Ticket. template must already be
// validated (CreateTicket's template.Valid() check) -- this is the only
// call site of defaultCompletionCondition in the entire codebase, which
// is what makes completion_condition "derived from the Template's
// default exactly once, at creation" (D3, issue #59) true by
// construction: no other function ever computes or assigns this value.
func insertTicket(ctx context.Context, pool *pgxpool.Pool, ownerID int64, title string, template TicketTemplate) (Ticket, error) {
	// public_id is generated here, in Go, rather than left to the
	// column's DEFAULT -- matching how every other identifier in this
	// codebase (session tokens, OAuth state) is generated in
	// application code. See internal/migrations/000004_....sql.
	publicID := uuid.NewString()
	completionCondition := defaultCompletionCondition(template)
	// goal/context/success_criteria/constraints/repository are left out
	// of the INSERT entirely -- they have no DEFAULT (see
	// internal/migrations/000005_.../000006_...sql), so they start
	// NULL, i.e. "never set," exactly like a title-only quick capture
	// that has not yet been through manual refinement (issue #58,
	// docs/ticket-creation.md, "Quick capture").
	row := pool.QueryRow(ctx,
		`INSERT INTO tickets (owner_id, title, status, public_id, template, completion_condition)
		 VALUES ($1, $2, $3, $4::uuid, $5, $6)
		 RETURNING `+ticketSelectColumns,
		ownerID, title, string(Backlog), publicID, string(template), string(completionCondition),
	)
	return scanTicketRow(row)
}

// getTicketForOwner looks up one Ticket by its public identifier,
// scoped to ownerID exactly like listTicketsForOwner -- a publicID
// that exists but belongs to a different owner_id is indistinguishable
// from one that does not exist at all, which is what makes the 404
// this function's caller returns never reveal cross-owner existence.
// publicID must already be a validated UUID string (GetTicket checks
// this before calling in) -- an invalid one would fail the ::uuid cast
// as a query error, not a "no rows" miss.
func getTicketForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, publicID string) (Ticket, bool, error) {
	row := pool.QueryRow(ctx,
		`SELECT `+ticketSelectColumns+`
		   FROM tickets
		  WHERE owner_id = $1 AND public_id = $2::uuid`,
		ownerID, publicID,
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

// ticketUpdate holds the validated, trimmed value for each field a
// PATCH request may change -- a nil field means "absent from the
// request body, leave unchanged" (see validateOptionalTitle and
// validateRefinementField), matching updateTicketForOwner's
// COALESCE-based SQL exactly: a nil *string parameter binds as SQL
// NULL, and COALESCE(new, existing) keeps existing precisely when new
// is NULL.
type ticketUpdate struct {
	title, goal, context, successCriteria, constraints, repository *string
}

// updateTicketForOwner applies a partial update (issue #58), scoped to
// ownerID exactly like getTicketForOwner -- a publicID belonging to a
// different owner_id updates nothing and reports not-found, the same
// privacy property GetTicket already has. Each column's COALESCE($n,
// column) is what implements "absent leaves the value unchanged":
// ticketUpdate's nil fields bind as SQL NULL, which COALESCE passes
// through to the existing value; a non-nil field (even one holding "",
// the documented "clear this field" value for the refinement/repository
// columns) is a genuine SQL value that COALESCE prefers over the
// existing one. updated_at is bumped unconditionally, even for a PATCH
// whose body names no field at all -- a PATCH request is still an
// explicit Owner edit action (apps/galley/README.md, "Manual
// refinement fields").
//
// template and completion_condition are deliberately absent from this
// SET clause -- not merely left at their COALESCE-default, but never
// named here at all. This is D3's "retained independently" guarantee
// (issue #59) enforced structurally: there is no parameter this
// function could be passed that would change either column, so no
// caller of this function -- today or in the future -- can make it
// recompute or overwrite them.
func updateTicketForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, publicID string, update ticketUpdate) (Ticket, bool, error) {
	row := pool.QueryRow(ctx,
		`UPDATE tickets
		    SET title = COALESCE($3, title),
		        goal = COALESCE($4, goal),
		        context = COALESCE($5, context),
		        success_criteria = COALESCE($6, success_criteria),
		        constraints = COALESCE($7, constraints),
		        repository = COALESCE($8, repository),
		        updated_at = now()
		  WHERE owner_id = $1 AND public_id = $2::uuid
		  RETURNING `+ticketSelectColumns,
		ownerID, publicID, update.title, update.goal, update.context, update.successCriteria, update.constraints, update.repository,
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

// listTicketsForOwner returns ownerID's Tickets newest first: created_at
// descending, id descending as the deterministic tiebreak for rows
// sharing a created_at value. id (GENERATED ALWAYS AS IDENTITY) is
// monotonic in insertion order, so this tiebreak never itself ties --
// unlike created_at, which two requests can share at whatever
// resolution the database clock offers. See
// apps/galley/README.md, "Ticket ordering".
func listTicketsForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64) ([]Ticket, error) {
	rows, err := pool.Query(ctx,
		`SELECT `+ticketSelectColumns+`
		   FROM tickets
		  WHERE owner_id = $1
		  ORDER BY created_at DESC, id DESC`,
		ownerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tickets := []Ticket{}
	for rows.Next() {
		ticket, err := scanTicketRow(rows)
		if err != nil {
			return nil, err
		}
		tickets = append(tickets, ticket)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tickets, nil
}
