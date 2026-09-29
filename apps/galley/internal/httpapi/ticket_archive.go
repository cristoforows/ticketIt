package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const archivedTicketCode = "archived_ticket"
const archivedTicketMessage = "archived tickets are read-only"

var errArchivedTicket = errors.New(archivedTicketMessage)

func lockTicketForMutation(ctx context.Context, tx pgx.Tx, ownerID int64, id string, restoring bool) (bool, error) {
	var archived bool
	err := tx.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid FOR UPDATE`, ownerID, id).Scan(&archived)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if archived && !restoring {
		return true, errArchivedTicket
	}
	return true, nil
}

func writeMutationError(w http.ResponseWriter, err error, databaseMessage string) {
	if errors.Is(err, errArchivedTicket) {
		writeError(w, http.StatusBadRequest, archivedTicketCode, archivedTicketMessage)
		return
	}
	writeError(w, http.StatusServiceUnavailable, "database_unavailable", databaseMessage)
}

func (s *server) ArchiveTicket(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, ok = canonicalTicketID(id)
	if !ok {
		writeTicketNotFound(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	ticket, found, err := archiveTicketForOwner(ctx, s.pool, owner.ID, id)
	if err != nil {
		writeMutationError(w, err, "failed to archive the ticket")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

func archiveTicketForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, id string) (Ticket, bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	found, err := lockTicketForMutation(ctx, tx, ownerID, id, false)
	if err != nil || !found {
		return Ticket{}, found, err
	}
	row := tx.QueryRow(ctx, `UPDATE tickets SET archived_at = now(), updated_at = now()
		WHERE owner_id = $1 AND public_id = $2::uuid RETURNING `+ticketSelectColumns, ownerID, id)
	ticket, err := scanTicketRow(row)
	if err != nil {
		return Ticket{}, true, err
	}
	if err := loadTicketBadges(ctx, tx, ownerID, &ticket); err != nil {
		return Ticket{}, true, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Ticket{}, true, err
	}
	return ticket, true, nil
}

var errTicketNotArchived = errors.New("ticket is not archived")

func (s *server) RestoreTicket(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, ok = canonicalTicketID(id)
	if !ok {
		writeTicketNotFound(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	ticket, found, err := restoreTicketForOwner(ctx, s.pool, owner.ID, id)
	if errors.Is(err, errTicketNotArchived) {
		writeError(w, http.StatusBadRequest, "not_archived", errTicketNotArchived.Error())
		return
	}
	if err != nil {
		writeMutationError(w, err, "failed to restore the ticket")
		return
	}
	if !found {
		writeTicketNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

func restoreTicketForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, id string) (Ticket, bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	found, err := lockTicketForMutation(ctx, tx, ownerID, id, true)
	if err != nil || !found {
		return Ticket{}, found, err
	}
	var current TicketStatus
	var archived bool
	if err := tx.QueryRow(ctx, `SELECT status, archived_at IS NOT NULL FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid`, ownerID, id).Scan(&current, &archived); err != nil {
		return Ticket{}, true, err
	}
	if !archived {
		return Ticket{}, true, errTicketNotArchived
	}
	next := current
	if current == Ready {
		next = Backlog
	}
	ticket, err := scanTicketRow(tx.QueryRow(ctx, `UPDATE tickets SET status = $3, archived_at = NULL, updated_at = now()
		WHERE owner_id = $1 AND public_id = $2::uuid RETURNING `+ticketSelectColumns, ownerID, id, next))
	if err != nil {
		return Ticket{}, true, err
	}
	if err := loadTicketBadges(ctx, tx, ownerID, &ticket); err != nil {
		return Ticket{}, true, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Ticket{}, true, err
	}
	return ticket, true, nil
}
