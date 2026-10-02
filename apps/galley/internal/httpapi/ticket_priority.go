package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const reorderAnchorInvalidCode = "reorder_anchor_invalid"

const priorityRankSpacing int64 = 1024

// ownerPriorityLockNamespace is the first key of pg_advisory_xact_lock's
// two-int4 form, a key space golang-migrate's single-bigint lock cannot
// collide with.
const ownerPriorityLockNamespace int32 = 0x7072696f

// lockOwnerPriority serializes every write to ownerID's priority ranks.
// Take it before any Ticket row lock in the same transaction; the reverse
// order can deadlock against a reorder. Owners whose ids share the low 32
// bits share the lock, which only serializes them.
func lockOwnerPriority(ctx context.Context, tx pgx.Tx, ownerID int64) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, $2)`, ownerPriorityLockNamespace, int32(uint32(ownerID)))
	return err
}

const topPriorityRankSQL = `(SELECT COALESCE(min(priority_rank) - 1024, 1024) FROM tickets WHERE owner_id = $1)`

const bottomPriorityRankSQL = `(SELECT COALESCE(max(priority_rank) + 1024, 1024) FROM tickets WHERE owner_id = $1)`

func moveTicketToBottom(ctx context.Context, tx pgx.Tx, ownerID int64, publicID string) error {
	_, err := tx.Exec(ctx,
		`UPDATE tickets SET priority_rank = `+bottomPriorityRankSQL+` WHERE owner_id = $1 AND public_id = $2::uuid`,
		ownerID, publicID)
	return err
}

func renumberOwnerPriority(ctx context.Context, tx pgx.Tx, ownerID int64) error {
	_, err := tx.Exec(ctx,
		`UPDATE tickets SET priority_rank = ranked.position * 1024
		   FROM (SELECT id, row_number() OVER (ORDER BY priority_rank, id) AS position
		           FROM tickets WHERE owner_id = $1) AS ranked
		  WHERE tickets.owner_id = $1 AND tickets.id = ranked.id`,
		ownerID)
	return err
}

type reorderPlacement int

const (
	placeBefore reorderPlacement = iota
	placeAfter
)

// priorityGap is the open interval a moved Ticket must land in. A nil
// bound means the anchor has no neighbour on that side.
type priorityGap struct {
	lower, upper *int64
}

func (g priorityGap) contains(rank int64) bool {
	return (g.lower == nil || *g.lower < rank) && (g.upper == nil || rank < *g.upper)
}

func (g priorityGap) midpoint() (int64, bool) {
	switch {
	case g.lower == nil:
		return *g.upper - priorityRankSpacing, true
	case g.upper == nil:
		return *g.lower + priorityRankSpacing, true
	case *g.upper-*g.lower < 2:
		return 0, false
	default:
		return *g.lower + (*g.upper-*g.lower)/2, true
	}
}

// gapBeside uses the anchor's neighbour in the Owner's whole order, not
// only its stage: nothing sits between the two, so the moved Ticket ends
// up beside the anchor within the stage too.
func gapBeside(ctx context.Context, tx pgx.Tx, ownerID, movedRowID, anchorRank int64, placement reorderPlacement) (priorityGap, error) {
	query := `SELECT max(priority_rank) FROM tickets WHERE owner_id = $1 AND id <> $2 AND priority_rank < $3`
	if placement == placeAfter {
		query = `SELECT min(priority_rank) FROM tickets WHERE owner_id = $1 AND id <> $2 AND priority_rank > $3`
	}
	var neighbour *int64
	if err := tx.QueryRow(ctx, query, ownerID, movedRowID, anchorRank).Scan(&neighbour); err != nil {
		return priorityGap{}, err
	}
	anchor := anchorRank
	if placement == placeAfter {
		return priorityGap{lower: &anchor, upper: neighbour}, nil
	}
	return priorityGap{lower: neighbour, upper: &anchor}, nil
}

type priorityRow struct {
	rowID    int64
	status   TicketStatus
	archived bool
}

func readPriorityRow(ctx context.Context, tx pgx.Tx, ownerID int64, publicID string, lock bool) (priorityRow, bool, error) {
	query := `SELECT id, status, archived_at IS NOT NULL FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid`
	if lock {
		query += ` FOR UPDATE`
	}
	var row priorityRow
	err := tx.QueryRow(ctx, query, ownerID, publicID).Scan(&row.rowID, &row.status, &row.archived)
	if errors.Is(err, pgx.ErrNoRows) {
		return priorityRow{}, false, nil
	}
	return row, err == nil, err
}

func anchorRejection(message string) *transitionRejection {
	return &transitionRejection{code: reorderAnchorInvalidCode, message: message}
}

// decideReorderAnchor takes the anchor as found (nil when unknown,
// malformed or another Owner's), so those cases stay indistinguishable.
func decideReorderAnchor(moved priorityRow, anchor *priorityRow) *transitionRejection {
	switch {
	case anchor == nil:
		return anchorRejection("the anchor must identify one of your Tickets")
	case anchor.rowID == moved.rowID:
		return anchorRejection("a Ticket cannot be placed relative to itself")
	case anchor.archived:
		return anchorRejection("the anchor must not be archived")
	case anchor.status != moved.status:
		return anchorRejection(fmt.Sprintf("the anchor must be in the same Status (%s), not %s", moved.status, anchor.status))
	}
	return nil
}

// anchorID is "" when the request named a malformed identifier.
func reorderTicketForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, publicID, anchorID string, placement reorderPlacement, now time.Time) (Ticket, bool, *transitionRejection, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Ticket{}, false, nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed
	if err := lockOwnerPriority(ctx, tx, ownerID); err != nil {
		return Ticket{}, false, nil, err
	}
	found, rejection, err := lockMutableTicket(ctx, tx, ownerID, publicID)
	if err != nil || !found || rejection != nil {
		return Ticket{}, found, rejection, err
	}
	moved, _, err := readPriorityRow(ctx, tx, ownerID, publicID, false)
	if err != nil {
		return Ticket{}, true, nil, err
	}
	var anchor *priorityRow
	if anchorID != "" {
		row, found, err := readPriorityRow(ctx, tx, ownerID, anchorID, true)
		if err != nil {
			return Ticket{}, true, nil, err
		}
		if found {
			anchor = &row
		}
	}
	if rejection := decideReorderAnchor(moved, anchor); rejection != nil {
		return Ticket{}, true, rejection, nil
	}
	if err := placeBesideAnchor(ctx, tx, ownerID, moved.rowID, anchor.rowID, placement); err != nil {
		return Ticket{}, true, nil, err
	}

	ticket, err := readLockedTicket(ctx, tx, ownerID, publicID, now)
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

// A Ticket already beside its anchor keeps its rank, so repeating a move
// consumes no gap.
func placeBesideAnchor(ctx context.Context, tx pgx.Tx, ownerID, movedRowID, anchorRowID int64, placement reorderPlacement) error {
	for renumbered := false; ; renumbered = true {
		var movedRank, anchorRank int64
		if err := tx.QueryRow(ctx,
			`SELECT (SELECT priority_rank FROM tickets WHERE owner_id = $1 AND id = $2),
			        (SELECT priority_rank FROM tickets WHERE owner_id = $1 AND id = $3)`,
			ownerID, movedRowID, anchorRowID).Scan(&movedRank, &anchorRank); err != nil {
			return err
		}
		gap, err := gapBeside(ctx, tx, ownerID, movedRowID, anchorRank, placement)
		if err != nil {
			return err
		}
		if gap.contains(movedRank) {
			return nil
		}
		if rank, ok := gap.midpoint(); ok {
			_, err := tx.Exec(ctx,
				`UPDATE tickets SET priority_rank = $3, updated_at = now() WHERE owner_id = $1 AND id = $2`,
				ownerID, movedRowID, rank)
			return err
		}
		if renumbered {
			return fmt.Errorf("no priority gap beside ticket row %d after renumbering", anchorRowID)
		}
		if err := renumberOwnerPriority(ctx, tx, ownerID); err != nil {
			return err
		}
	}
}

func (s *server) ReorderTicket(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, ok = canonicalPublicID(id)
	if !ok {
		writeTicketNotFound(w)
		return
	}
	var req ReorderTicketRequest
	const shape = `request body must be JSON matching {"before": "<ticketId>"} or {"after": "<ticketId>"}`
	if !decodeStrictJSON(w, r, &req, shape) {
		return
	}
	if (req.Before == nil) == (req.After == nil) {
		writeError(w, http.StatusBadRequest, "invalid_request", shape)
		return
	}
	anchor, placement := req.Before, placeBefore
	if req.After != nil {
		anchor, placement = req.After, placeAfter
	}
	anchorID, _ := canonicalPublicID(*anchor)

	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()

	ticket, found, rejection, err := reorderTicketForOwner(ctx, s.pool, owner.ID, id, anchorID, placement, s.clockNow())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to reorder the ticket")
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
