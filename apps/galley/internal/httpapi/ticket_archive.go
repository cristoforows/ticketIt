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

const notArchivedCode = "not_archived"
const notArchivedMessage = "ticket is not archived"

type ticketLock struct {
	archived      bool
	openRoundID   string
	stopRequested bool
}

// The open Round is read in a second statement so it sees a Round
// committed by a claim that held the row lock first.
func lockTicketForMutation(ctx context.Context, tx pgx.Tx, ownerID int64, id string) (ticketLock, bool, error) {
	var lock ticketLock
	err := tx.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid FOR UPDATE`, ownerID, id).Scan(&lock.archived)
	if errors.Is(err, pgx.ErrNoRows) {
		return ticketLock{}, false, nil
	}
	if err != nil {
		return ticketLock{}, false, err
	}
	err = tx.QueryRow(ctx, `SELECT r.public_id::text, EXISTS (SELECT 1 FROM round_commands c WHERE c.owner_id = r.owner_id AND c.round_id = r.id AND c.type = 'stop')
		FROM rounds r JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		WHERE t.owner_id = $1 AND t.public_id = $2::uuid AND r.state IN `+openRoundStatesSQL, ownerID, id).Scan(&lock.openRoundID, &lock.stopRequested)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ticketLock{}, false, err
	}
	return lock, true, nil
}

func decideTicketMutation(lock ticketLock, restoring bool) *transitionRejection {
	if lock.archived && !restoring {
		return &transitionRejection{code: archivedTicketCode, message: archivedTicketMessage}
	}
	if lock.openRoundID != "" {
		return &transitionRejection{code: roundOpenCode, message: roundOpenMessage, roundID: lock.openRoundID}
	}
	return nil
}

func lockMutableTicket(ctx context.Context, tx pgx.Tx, ownerID int64, id string) (bool, *transitionRejection, error) {
	lock, found, err := lockTicketForMutation(ctx, tx, ownerID, id)
	if err != nil || !found {
		return found, nil, err
	}
	return true, decideTicketMutation(lock, false), nil
}

func (s *server) ArchiveTicket(w http.ResponseWriter, r *http.Request, id string) {
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
	ticket, found, rejection, err := archiveTicketForOwner(ctx, s.pool, owner.ID, id)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to archive the ticket")
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

func archiveTicketForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, id string) (Ticket, bool, *transitionRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	found, rejection, err := lockMutableTicket(ctx, tx, ownerID, id)
	if err != nil || !found || rejection != nil {
		return Ticket{}, found, rejection, err
	}
	row := tx.QueryRow(ctx, `UPDATE tickets SET archived_at = now(), updated_at = now()
		WHERE owner_id = $1 AND public_id = $2::uuid RETURNING `+ticketSelectColumns, ownerID, id)
	ticket, err := scanTicketRow(row)
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

func (s *server) RestoreTicket(w http.ResponseWriter, r *http.Request, id string) {
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
	ticket, found, rejection, err := restoreTicketForOwner(ctx, s.pool, owner.ID, id)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to restore the ticket")
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

func restoreTicketForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, id string) (Ticket, bool, *transitionRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	lock, found, err := lockTicketForMutation(ctx, tx, ownerID, id)
	if err != nil || !found {
		return Ticket{}, found, nil, err
	}
	if !lock.archived {
		return Ticket{}, true, &transitionRejection{code: notArchivedCode, message: notArchivedMessage}, nil
	}
	if rejection := decideTicketMutation(lock, true); rejection != nil {
		return Ticket{}, true, rejection, nil
	}
	var current TicketStatus
	if err := tx.QueryRow(ctx, `SELECT status FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid`, ownerID, id).Scan(&current); err != nil {
		return Ticket{}, true, nil, err
	}
	next := current
	if current == Ready {
		next = Backlog
	}
	ticket, err := scanTicketRow(tx.QueryRow(ctx, `UPDATE tickets SET status = $3, archived_at = NULL, updated_at = now()
		WHERE owner_id = $1 AND public_id = $2::uuid RETURNING `+ticketSelectColumns, ownerID, id, next))
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
