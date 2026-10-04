package httpapi

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Called inside the transaction of every Status write that can produce Done; TestEveryTicketStatusWriteIsAccountedFor.
func endTicketGrantsAtDone(ctx context.Context, tx pgx.Tx, ownerID int64, ticketID string, now time.Time) error {
	_, err := tx.Exec(ctx, `UPDATE permission_grants SET state = $3, ended_at = GREATEST($4::timestamptz, approved_at)
		WHERE owner_id = $1 AND form = $5 AND state = $6
		  AND ticket_id = (SELECT id FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid)`,
		ownerID, ticketID, string(PermissionGrantEndedAtDone), now, string(PermissionGrantFormTicket), string(PermissionGrantActive))
	return err
}
