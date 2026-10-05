package httpapi

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

type roundLimits struct {
	maxActive  time.Duration
	maxDenials int
}

// A Config built in code rather than by config.Load leaves the limits zero, which would breach every running Round.
func roundLimitsOf(cfg config.Config) roundLimits {
	limits := roundLimits{maxActive: cfg.RoundMaxActiveDuration, maxDenials: cfg.RoundMaxConsecutiveDenials}
	if limits.maxActive <= 0 {
		limits.maxActive = config.DefaultRoundMaxActiveDuration
	}
	if limits.maxDenials <= 0 {
		limits.maxDenials = config.DefaultRoundMaxConsecutiveDenials
	}
	return limits
}

// Every UPDATE that moves a Round into running sets enterRunningSQL, and every one that moves it out of running, or ends
// it from any open state, sets leaveRunningSQL. nowParam is the statement's placeholder for Galley's clock.
func enterRunningSQL(nowParam string) string {
	return `active_since = ` + nowParam + `::timestamptz`
}

func leaveRunningSQL(nowParam string) string {
	return `active_ms = active_ms + COALESCE(GREATEST(0, floor(extract(epoch FROM ` + nowParam + `::timestamptz - active_since) * 1000))::bigint, 0), active_since = NULL`
}

type roundMeasure struct {
	state         RoundState
	stopRequested bool
	active        time.Duration
	denials       int
}

type limitBreach struct {
	kind     RoundLimitBreachKind
	limit    int64
	measured int64
}

// The first cause of a Stop wins, so a Round whose Stop is already requested is never breached. When both limits are
// reached at once, the wall clock is named.
func decideLimitBreach(limits roundLimits, m roundMeasure) *limitBreach {
	if m.state != RoundRunning || m.stopRequested {
		return nil
	}
	switch {
	case m.active >= limits.maxActive:
		return &limitBreach{kind: LimitWallClock, limit: int64(limits.maxActive / time.Second), measured: int64(m.active / time.Second)}
	case m.denials >= limits.maxDenials:
		return &limitBreach{kind: LimitDenialLoop, limit: int64(limits.maxDenials), measured: int64(m.denials)}
	}
	return nil
}

func limitBreachExplanation(breach RoundLimitBreach) string {
	if breach.Kind == LimitWallClock {
		return fmt.Sprintf("Technical limit reached: active time %s exceeded the %s limit.", time.Duration(breach.Measured)*time.Second, time.Duration(breach.Limit)*time.Second)
	}
	return fmt.Sprintf("Technical limit reached: %d consecutive denied authority checks (limit %d).", breach.Measured, breach.Limit)
}

// A refused check is never recorded, so only recorded decisions make the streak.
const denialStreakSQL = `(SELECT count(*) FROM round_authority_checks d WHERE d.owner_id = r.owner_id AND d.round_id = r.id AND d.decision = 'deny'
	AND d.id > COALESCE((SELECT max(a.id) FROM round_authority_checks a WHERE a.owner_id = r.owner_id AND a.round_id = r.id AND a.decision = 'allow'), 0))`

func measureRound(ctx context.Context, tx pgx.Tx, ownerID, roundRowID int64, now time.Time) (roundMeasure, error) {
	var m roundMeasure
	var state string
	var activeMs int64
	var activeSince *time.Time
	err := tx.QueryRow(ctx, `SELECT r.state, r.active_ms, r.active_since,
			EXISTS (SELECT 1 FROM round_commands c WHERE c.owner_id = r.owner_id AND c.round_id = r.id AND c.type = 'stop'), `+denialStreakSQL+`
		FROM rounds r WHERE r.owner_id = $1 AND r.id = $2`, ownerID, roundRowID).Scan(&state, &activeMs, &activeSince, &m.stopRequested, &m.denials)
	if err != nil {
		return roundMeasure{}, err
	}
	m.state = RoundState(state)
	m.active = time.Duration(activeMs) * time.Millisecond
	if activeSince != nil {
		m.active += max(0, now.Sub(*activeSince))
	}
	return m, nil
}

// Lock order is the event path's: the caller holds the Owner's priority lock, then the Ticket row lock that lock was
// read under, then the Round row. The Stop goes through requestStop, so a breach shares the Owner's one Stop per Round.
func enforceRoundLimits(ctx context.Context, tx pgx.Tx, ownerID, roundRowID int64, lock ticketLock, limits roundLimits, now time.Time) error {
	m, err := measureRound(ctx, tx, ownerID, roundRowID, now)
	if err != nil {
		return err
	}
	breach := decideLimitBreach(limits, m)
	if breach == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `INSERT INTO round_limit_breaches (owner_id, round_id, kind, "limit", measured, breached_at) VALUES ($1, $2, $3, $4, $5, $6)`,
		ownerID, roundRowID, string(breach.kind), breach.limit, breach.measured, now); err != nil {
		return err
	}
	rejection, err := requestStop(ctx, tx, ownerID, lock, now)
	if err != nil {
		return err
	}
	if rejection != nil {
		return fmt.Errorf("stop for the limit breach of round %s: %s", lock.openRoundID, rejection.code)
	}
	return nil
}

// Read under the caller's Round row lock, so the outcome agrees with the breach that requested the Stop.
func roundLimitBreach(ctx context.Context, tx pgx.Tx, ownerID, roundRowID int64) (*RoundLimitBreach, error) {
	breaches, err := roundLimitBreaches(ctx, tx, ownerID, []int64{roundRowID})
	return breaches[roundRowID], err
}

func roundLimitBreaches(ctx context.Context, tx pgx.Tx, ownerID int64, roundIDs []int64) (map[int64]*RoundLimitBreach, error) {
	rows, err := tx.Query(ctx, `SELECT round_id, kind, "limit", measured, breached_at FROM round_limit_breaches WHERE owner_id = $1 AND round_id = ANY($2)`, ownerID, roundIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	breaches := map[int64]*RoundLimitBreach{}
	for rows.Next() {
		var roundID int64
		var b RoundLimitBreach
		var kind string
		if err := rows.Scan(&roundID, &kind, &b.Limit, &b.Measured, &b.BreachedAt); err != nil {
			return nil, err
		}
		b.Kind, b.BreachedAt = RoundLimitBreachKind(kind), b.BreachedAt.UTC()
		breaches[roundID] = &b
	}
	return breaches, rows.Err()
}

type ownerOpenRound struct {
	lock       ticketLock
	roundRowID int64
}

// The caller holds the Owner's priority lock. Takes the open Round's Ticket row, then its Round row.
func lockOwnerOpenRound(ctx context.Context, tx pgx.Tx, ownerID int64) (*ownerOpenRound, error) {
	var ticketID string
	err := tx.QueryRow(ctx, `SELECT t.public_id::text FROM rounds r JOIN tickets t ON t.owner_id = r.owner_id AND t.id = r.ticket_id
		WHERE r.owner_id = $1 AND r.state IN `+openRoundStatesSQL, ownerID).Scan(&ticketID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	lock, found, err := lockTicketForMutation(ctx, tx, ownerID, ticketID)
	if err != nil || !found || lock.openRoundID == "" {
		return nil, err
	}
	open := ownerOpenRound{lock: lock}
	if err := tx.QueryRow(ctx, `SELECT id FROM rounds WHERE owner_id = $1 AND public_id = $2::uuid FOR UPDATE`, ownerID, lock.openRoundID).Scan(&open.roundRowID); err != nil {
		return nil, err
	}
	return &open, nil
}
