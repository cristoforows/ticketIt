package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const badgeNameMaxLength = 80

type ticketDB interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (s *server) ListBadges(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	badges, err := listBadgesForOwner(ctx, s.pool, owner.ID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to read badges")
		return
	}
	writeJSON(w, http.StatusOK, BadgeList{Badges: badges})
}

func listBadgesForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64) ([]Badge, error) {
	rows, err := pool.Query(ctx, `SELECT public_id::text, name, created_at FROM badges
		WHERE owner_id = $1 ORDER BY lower(name), public_id`, ownerID)
	if err != nil {
		return nil, err
	}
	badges := []Badge{}
	for rows.Next() {
		var badge Badge
		var created time.Time
		if err = rows.Scan(&badge.Id, &badge.Name, &created); err != nil {
			break
		}
		badge.CreatedAt = created.UTC().Format(time.RFC3339)
		badges = append(badges, badge)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, err
	}
	return badges, nil
}

func (s *server) CreateBadge(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	var req CreateBadgeRequest
	if !decodeStrictJSON(w, r, &req, `request body must be JSON matching {"name": "..."}`) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || utf8.RuneCountInString(name) > badgeNameMaxLength {
		writeError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf(`"name" must be non-empty and at most %d characters after trimming`, badgeNameMaxLength))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	var badge Badge
	var created time.Time
	err := s.pool.QueryRow(ctx, `INSERT INTO badges (owner_id, public_id, name) VALUES ($1, $2::uuid, $3)
		RETURNING public_id::text, name, created_at`, owner.ID, uuid.NewString(), name).Scan(&badge.Id, &badge.Name, &created)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "badges_owner_name_ci_unique" {
			writeError(w, http.StatusConflict, "duplicate_badge_name", "a badge with that name already exists")
			return
		}
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to create the badge")
		return
	}
	badge.CreatedAt = created.UTC().Format(time.RFC3339)
	writeJSON(w, http.StatusCreated, badge)
}

func writeBadgeNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", "no ticket or badge with that identifier")
}

func (s *server) AttachTicketBadge(w http.ResponseWriter, r *http.Request, id, badgeId string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, ok = canonicalTicketID(id)
	if !ok {
		writeBadgeNotFound(w)
		return
	}
	badgeId, ok = canonicalTicketID(badgeId)
	if !ok {
		writeBadgeNotFound(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to attach the badge")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	found, err := attachBadgeForOwner(ctx, tx, owner.ID, id, badgeId)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to attach the badge")
		return
	}
	if !found {
		writeBadgeNotFound(w)
		return
	}
	ticket, found, err := getTicketForOwner(ctx, tx, owner.ID, id)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to read the ticket")
		return
	}
	if !found {
		writeBadgeNotFound(w)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to attach the badge")
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

func attachBadgeForOwner(ctx context.Context, db ticketDB, ownerID int64, ticketID, badgeID string) (bool, error) {
	var linked int64
	err := db.QueryRow(ctx, `INSERT INTO ticket_badges (owner_id, ticket_id, badge_id)
		SELECT $1, t.id, b.id FROM tickets t CROSS JOIN badges b
		WHERE t.owner_id = $1 AND b.owner_id = $1 AND t.public_id = $2::uuid AND b.public_id = $3::uuid
		ON CONFLICT (ticket_id, badge_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
		RETURNING ticket_id`, ownerID, ticketID, badgeID).Scan(&linked)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func loadTicketBadges(ctx context.Context, db ticketDB, ownerID int64, tickets ...*Ticket) error {
	byID := make(map[string]*Ticket, len(tickets))
	ids := make([]string, 0, len(tickets))
	for _, ticket := range tickets {
		ticket.Badges = []TicketBadge{}
		byID[ticket.Id] = ticket
		ids = append(ids, ticket.Id)
	}
	if len(tickets) == 0 {
		return nil
	}
	rows, err := db.Query(ctx, `SELECT t.public_id::text, b.public_id::text, b.name
		FROM ticket_badges tb JOIN tickets t ON t.id = tb.ticket_id AND t.owner_id = tb.owner_id
		JOIN badges b ON b.id = tb.badge_id AND b.owner_id = tb.owner_id
		WHERE tb.owner_id = $1 AND t.public_id::text = ANY($2::text[])
		ORDER BY lower(b.name), b.public_id`, ownerID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var ticketID string
		var badge TicketBadge
		if err := rows.Scan(&ticketID, &badge.Id, &badge.Name); err != nil {
			return err
		}
		if ticket := byID[ticketID]; ticket != nil {
			ticket.Badges = append(ticket.Badges, badge)
		}
	}
	return rows.Err()
}
