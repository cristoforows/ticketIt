package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

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

// server also implements the generated ServerInterface's Ticket
// operations (issue #56): title-only capture into Backlog and listing
// the signed-in Owner's Tickets. Hand-rolled against the pool, no
// repository layer, matching diagnostic.go's rationale -- this slice
// adds exactly one domain table.
//
// Both methods call requireSession first: every Ticket is scoped to
// the Owner it resolves (owner_id), and a request without a valid
// session is rejected before either query runs (apps/galley/README.md,
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

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	// Backlog (api.gen.go, generated from CreateTicketRequest's sibling
	// TicketStatus enum) is the only Status this slice ever produces --
	// docs/ticket-creation.md, "Quick capture": a title alone captures a
	// Ticket in Backlog. No transition exists yet (#60).
	ticket, err := insertTicket(ctx, s.pool, owner.ID, title)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to create the ticket")
		return
	}
	writeJSON(w, http.StatusCreated, ticket)
}

func insertTicket(ctx context.Context, pool *pgxpool.Pool, ownerID int64, title string) (Ticket, error) {
	var (
		result               Ticket
		status               string
		createdAt, updatedAt time.Time
	)
	err := pool.QueryRow(ctx,
		`INSERT INTO tickets (owner_id, title, status) VALUES ($1, $2, $3)
		 RETURNING id, title, status, created_at, updated_at`,
		ownerID, title, string(Backlog),
	).Scan(&result.Id, &result.Title, &status, &createdAt, &updatedAt)
	if err != nil {
		return Ticket{}, err
	}
	result.Status = TicketStatus(status)
	result.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	result.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return result, nil
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
		`SELECT id, title, status, created_at, updated_at
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
		var (
			ticket               Ticket
			status               string
			createdAt, updatedAt time.Time
		)
		if err := rows.Scan(&ticket.Id, &ticket.Title, &status, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		ticket.Status = TicketStatus(status)
		ticket.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		ticket.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
		tickets = append(tickets, ticket)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tickets, nil
}
