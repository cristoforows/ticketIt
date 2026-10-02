package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

const stopEvidence = "Stopped before step 2 of 3 on Stop command 0b5f3c6e-5d1b-4d7a-9a50-1f2d4c0d9a11"

func stopConfirmedEvent(t *testing.T, key string, epoch int, evidence string) string {
	t.Helper()
	return stopConfirmedEventWith(t, key, epoch, map[string]any{"evidence": evidence})
}

func stopConfirmedEventWith(t *testing.T, key string, epoch int, data any) string {
	t.Helper()
	return jsonText(t, map[string]any{"type": "stop_confirmed", "idempotencyKey": key, "claimEpoch": epoch, "occurredAt": eventOccurredAt, "data": data})
}

func (f *claimFixture) confirmStop(t *testing.T, claim RunnerClaim) *httptest.ResponseRecorder {
	t.Helper()
	return f.reportEvent(t, claim.RoundId, stopConfirmedEvent(t, claim.RoundId+":stop", claim.ClaimEpoch, stopEvidence))
}

func (f *claimFixture) mustConfirmStop(t *testing.T, claim RunnerClaim) *httptest.ResponseRecorder {
	t.Helper()
	return f.mustReport(t, claim.RoundId, stopConfirmedEvent(t, claim.RoundId+":stop", claim.ClaimEpoch, stopEvidence))
}

func wantStoppedResult(roundID string, startedAt *time.Time, endedAt time.Time) string {
	started := "null"
	if startedAt != nil {
		started = fmt.Sprintf("%q", startedAt.UTC().Format(time.RFC3339Nano))
	}
	return fmt.Sprintf(`{"endedAt":%q,"roundId":%q,"startedAt":%s,"state":"stopped","type":"stop_confirmed"}`,
		endedAt.UTC().Format(time.RFC3339Nano), roundID, started)
}

func (f *claimFixture) changeStatus(t *testing.T, id string, status TicketStatus) Ticket {
	t.Helper()
	body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+id+"/status", fmt.Sprintf(`{"status":%q}`, status), http.StatusOK)
	return decodeAs[Ticket](t, body)
}

type badgeRow struct {
	publicID, name string
	systemKey      *string
}

func badgeRows(t *testing.T, f *claimFixture) []badgeRow {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT public_id::text, name, system_key FROM badges ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []badgeRow
	for rows.Next() {
		var row badgeRow
		if err := rows.Scan(&row.publicID, &row.name, &row.systemKey); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	return out
}

func (f *claimFixture) createBadge(t *testing.T, name string) Badge {
	t.Helper()
	body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/badges", fmt.Sprintf(`{"name":%q}`, name), http.StatusCreated)
	return decodeAs[Badge](t, body)
}

func assertStoppedTicket(t *testing.T, ticket Ticket, badge TicketBadge) {
	t.Helper()
	if ticket.Status != Backlog || ticket.OpenRound != nil || ticket.RequestingAgentWork || ticket.Delivery != nil {
		t.Fatalf("stopped Ticket: status=%s openRound=%+v requestingAgentWork=%t delivery=%+v, want Backlog with no open Round", ticket.Status, ticket.OpenRound, ticket.RequestingAgentWork, ticket.Delivery)
	}
	if !reflect.DeepEqual(ticket.Badges, []TicketBadge{badge}) {
		t.Fatalf("stopped Ticket badges = %+v, want [%+v]", ticket.Badges, badge)
	}
	if stop := ticket.AllowedActions.Stop; stop.Available || stop.Reason == nil || stop.Reason.Code != stopNotAvailableCode {
		t.Fatalf("allowedActions.stop = %+v, want unavailable with %s", stop, stopNotAvailableCode)
	}
}

func stoppedBadgeOf(t *testing.T, f *claimFixture) TicketBadge {
	t.Helper()
	var badge TicketBadge
	if err := f.pool.QueryRow(context.Background(), `SELECT public_id::text, name FROM badges WHERE system_key = 'stopped'`).Scan(&badge.Id, &badge.Name); err != nil {
		t.Fatal(err)
	}
	return badge
}

func TestStopConfirmed_EndsTheRoundAsStoppedMovesTheTicketToBacklogWithTheStoppedBadgeAndFreesTheSlot(t *testing.T) {
	for _, running := range []bool{false, true} {
		t.Run(map[bool]string{false: "claimed", true: "running"}[running], func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim, _ := f.stoppedRound(t, "Stop me", running)
			waiting := f.queue(t, "Waiting")
			before := readTicketRowFacts(t, f.pool, queued.Id)
			wantStatusBefore := map[bool]string{false: string(Ready), true: string(InProgress)}[running]
			if before.status != wantStatusBefore {
				t.Fatalf("Ticket before the confirmation is %s, want %s", before.status, wantStatusBefore)
			}
			var startedAt *time.Time
			if running {
				startedAt = &runnerEpoch
			}

			galleyNow := runnerEpoch.Add(42 * time.Second)
			f.clock.Set(galleyNow)
			rec := f.confirmStop(t, claim)
			if rec.Code != http.StatusCreated {
				t.Fatalf("status=%d, want 201; body=%s", rec.Code, rec.Body.String())
			}
			if got, want := rec.Body.String(), wantStoppedResult(claim.RoundId, startedAt, galleyNow); got != want {
				t.Fatalf("body = %s, want %s", got, want)
			}

			badge := stoppedBadgeOf(t, f)
			if badge.Name != stoppedBadgeName {
				t.Fatalf("Stopped Badge name = %q, want %q", badge.Name, stoppedBadgeName)
			}
			assertStoppedTicket(t, f.ticket(t, queued.Id), badge)
			after := readTicketRowFacts(t, f.pool, queued.Id)
			if after.status != string(Backlog) || !after.updatedAt.After(before.updatedAt) || after.rank != before.rank || !reflect.DeepEqual(after.agentID, before.agentID) || after.assigneeType != before.assigneeType {
				t.Fatalf("Ticket row before %+v, after %+v: want Backlog, a later updated_at, the same rank and assignment", before, after)
			}
			var state, note string
			var endedAt time.Time
			if err := f.pool.QueryRow(context.Background(), `SELECT state, outcome_note, ended_at FROM rounds WHERE public_id = $1::uuid`, claim.RoundId).Scan(&state, &note, &endedAt); err != nil {
				t.Fatal(err)
			}
			if state != string(RoundStopped) || note != stopEvidence || !endedAt.Equal(galleyNow) {
				t.Fatalf("Round row = %s %q %v, want stopped with the evidence at %v", state, note, endedAt, galleyNow)
			}
			round := f.roundOf(t, queued.Id)
			if round.State != RoundStopped || round.OutcomeNote == nil || *round.OutcomeNote != stopEvidence || round.EndedAt == nil || !round.EndedAt.Equal(galleyNow) ||
				round.Deliverable != nil || !reflect.DeepEqual(round.StartedAt, utcOrNil(startedAt)) {
				t.Fatalf("listed Round = %+v, want stopped at %v with outcomeNote %q and no deliverable", round, galleyNow, stopEvidence)
			}
			var eventType string
			if err := f.pool.QueryRow(context.Background(), `SELECT type FROM round_events WHERE idempotency_key = $1`, claim.RoundId+":stop").Scan(&eventType); err != nil || eventType != "stop_confirmed" {
				t.Fatalf("stored event type = %q (%v)", eventType, err)
			}

			badgeRequest(t, f.handler, f.cookie, http.MethodPatch, "/api/tickets/"+queued.Id, `{"title":"Edited once stopped"}`, http.StatusOK)
			f.heartbeat(t, f.token, http.StatusOK)
			next := f.mustClaim(t)
			if next.Ticket.Id != waiting.Id {
				t.Fatalf("the freed slot claimed %s, want the waiting Ticket %s", next.Ticket.Id, waiting.Id)
			}
		})
	}
}

func TestStopConfirmed_EndedAtNeverPrecedesTheRoundsStart(t *testing.T) {
	for _, running := range []bool{false, true} {
		f := newClaimFixture(t)
		_, claim, _ := f.stoppedRound(t, "Clock stepped back", running)
		f.clock.Set(runnerEpoch.Add(-time.Hour))
		var startedAt *time.Time
		if running {
			startedAt = &runnerEpoch
		}
		if got, want := f.mustConfirmStop(t, claim).Body.String(), wantStoppedResult(claim.RoundId, startedAt, runnerEpoch); got != want {
			t.Fatalf("running=%t: body = %s, want %s", running, got, want)
		}
	}
}

func TestStopConfirmed_WithoutAStopRequestIsStopNotRequestedAndChangesNothing(t *testing.T) {
	for _, running := range []bool{false, true} {
		f := newClaimFixture(t)
		queued, claim := f.claimTicket(t, "Not stopped")
		if running {
			f.startRound(t, claim, claim.RoundId+":0")
		}
		before := databaseSnapshot(t, f.pool)
		assertErrorBody(t, f.confirmStop(t, claim), http.StatusConflict, stopNotRequestedCode, stopNotRequestedMessage)
		assertSnapshotUnchanged(t, f.pool, before, "a stop_confirmed without a Stop request")
		if got := f.ticket(t, queued.Id); got.OpenRound == nil || len(got.Badges) != 0 {
			t.Fatalf("running=%t: Ticket = %+v, want its Round still open and no Badge", running, got)
		}
		assertNoWork(t, f.claim(t))
	}
}

func TestStopConfirmed_AnUnacknowledgedStopIsEnough(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, command := f.stoppedRound(t, "Unacknowledged", true)
	f.mustConfirmStop(t, claim)
	assertStoppedTicket(t, f.ticket(t, queued.Id), stoppedBadgeOf(t, f))
	if rows := roundCommandRows(t, f); len(rows) != 1 || rows[0].commandID != command.Id || rows[0].acknowledgedAt != nil {
		t.Fatalf("commands = %+v, want the one Stop, still unacknowledged", rows)
	}
	if commands := f.mustCommands(t, claim.RoundId); len(commands) != 0 {
		t.Fatalf("commands of the stopped Round = %+v, want none", commands)
	}
	if ack := decodeAck(t, f.ack(t, claim.RoundId, command.Id, RunnerCommandApplied)); ack.Outcome != RunnerCommandApplied {
		t.Fatalf("late ack = %+v", ack)
	}
	if round := f.roundOf(t, queued.Id); round.State != RoundStopped {
		t.Fatalf("Round after the late ack = %s, want stopped", round.State)
	}
}

func TestStopConfirmed_AtAStaleEpochIsStaleClaimEpochAndChangesNothing(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, _ := f.stoppedRound(t, "Stale", true)
	before := databaseSnapshot(t, f.pool)
	for _, epoch := range []int{claim.ClaimEpoch + 1, claim.ClaimEpoch + 5} {
		rec := f.reportEvent(t, claim.RoundId, stopConfirmedEvent(t, fmt.Sprintf("stale-%d", epoch), epoch, stopEvidence))
		assertErrorBody(t, rec, http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
	}
	assertSnapshotUnchanged(t, f.pool, before, "a stop_confirmed at a stale epoch")
}

func TestStopConfirmed_OnAnEndedRoundIsRoundNotOpenAndChangesNothing(t *testing.T) {
	t.Run("delivered after the Stop was requested", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim, _ := f.stoppedRound(t, "Delivered first", true)
		f.deliver(t, claim)
		before := databaseSnapshot(t, f.pool)
		assertErrorBody(t, f.confirmStop(t, claim), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
		assertSnapshotUnchanged(t, f.pool, before, "a stop_confirmed for a delivered Round")
		if got := f.ticket(t, queued.Id); got.Status != InReview || len(got.Badges) != 0 {
			t.Fatalf("Ticket = %s %+v, want In Review with no Badge", got.Status, got.Badges)
		}
	})
	t.Run("already stopped", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim, _ := f.stoppedRound(t, "Stopped twice", true)
		f.mustConfirmStop(t, claim)
		before := databaseSnapshot(t, f.pool)
		rec := f.reportEvent(t, claim.RoundId, stopConfirmedEvent(t, "another key", claim.ClaimEpoch, stopEvidence))
		assertErrorBody(t, rec, http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
		assertSnapshotUnchanged(t, f.pool, before, "a second stop_confirmed")
	})
}

func TestStopConfirmed_ReplayReturnsTheStoredResultAndChangesNothing(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, _ := f.stoppedRound(t, "Replay", true)
	first := f.mustConfirmStop(t, claim)
	before := databaseSnapshot(t, f.pool)
	f.clock.Set(runnerEpoch.Add(time.Hour))
	rec := f.confirmStop(t, claim)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replay: status=%d body=%s, want 200 %s", rec.Code, rec.Body.String(), first.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, before, "a replayed stop_confirmed")
	rec = f.reportEvent(t, claim.RoundId, stopConfirmedEvent(t, claim.RoundId+":stop", claim.ClaimEpoch, "Different evidence"))
	assertErrorBody(t, rec, http.StatusConflict, idempotencyKeyConflictCode, idempotencyKeyConflictMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a stop_confirmed key reused with other evidence")
}

func TestStopConfirmed_ConcurrentIdenticalConfirmationsApplyExactlyOnce(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, _ := f.stoppedRound(t, "Concurrent", true)
	body := stopConfirmedEvent(t, claim.RoundId+":stop", claim.ClaimEpoch, stopEvidence)
	codes, bodies := sendConcurrently(8, func(int) *httptest.ResponseRecorder { return f.reportEvent(t, claim.RoundId, body) })
	created := 0
	for i, code := range codes {
		switch code {
		case http.StatusCreated:
			created++
		case http.StatusOK:
		default:
			t.Fatalf("response %d: status=%d body=%s", i, code, bodies[i])
		}
		if bodies[i] != bodies[0] {
			t.Fatalf("bodies differ: %s vs %s", bodies[i], bodies[0])
		}
	}
	if created != 1 || tableRowCount(t, f.pool, "round_events") != 2 || len(badgeRows(t, f)) != 1 || tableRowCount(t, f.pool, "ticket_badges") != 1 {
		t.Fatalf("created=%d events=%d badges=%+v links=%d, want one confirmation, one Badge, one link",
			created, tableRowCount(t, f.pool, "round_events"), badgeRows(t, f), tableRowCount(t, f.pool, "ticket_badges"))
	}
	assertStoppedTicket(t, f.ticket(t, queued.Id), stoppedBadgeOf(t, f))
}

func TestStopped_IsTerminal(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, _ := f.stoppedRound(t, "Terminal", true)
	f.mustConfirmStop(t, claim)
	before := databaseSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"execution_started": startedEvent("late-start", claim.ClaimEpoch, eventOccurredAt, "controlled:late"),
		"progress":          progressEvent(t, "late-progress", claim.ClaimEpoch, eventOccurredAt, "Still going"),
		"usage_observed":    usageEvent(t, observationB, claim.ClaimEpoch, usageData(observationB)),
		"delivered":         deliveredEvent(t, "late-deliver", claim.ClaimEpoch, standardDeliverable()),
		"stop_confirmed":    stopConfirmedEvent(t, "late-stop", claim.ClaimEpoch, stopEvidence),
	} {
		t.Run(name, func(t *testing.T) {
			assertErrorBody(t, f.reportEvent(t, claim.RoundId, body), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
		})
	}
	rec := f.stop(t, queued.Id)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("Stop on a stopped Ticket: status=%d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec, stopNotAvailableCode)
	assertSnapshotUnchanged(t, f.pool, before, "events and a Stop after the Round stopped")
	if commands := f.mustCommands(t, claim.RoundId); len(commands) != 0 {
		t.Fatalf("commands of a stopped Round = %+v, want none", commands)
	}
}

func TestStopped_TheRoundsActivityAndUsageStayListedUnderIt(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Keep the record")
	f.mustReport(t, claim.RoundId, progressEvent(t, "p1", claim.ClaimEpoch, eventOccurredAt, "Reading the Ticket"))
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, claim.ClaimEpoch, usageData(observationA)))
	open := f.roundOf(t, queued.Id)
	f.mustStop(t, queued.Id)
	f.mustConfirmStop(t, claim)
	stopped := f.roundOf(t, queued.Id)
	if stopped.State != RoundStopped || !reflect.DeepEqual(stopped.Activity, open.Activity) || !reflect.DeepEqual(stopped.Usage, open.Usage) || len(stopped.Activity) != 1 || stopped.Usage.Observations != 1 {
		t.Fatalf("stopped Round = %+v, want stopped with the open Round's activity %+v and usage %+v", stopped, open.Activity, open.Usage)
	}
}

func TestStopped_OnlyAnExplicitReadyStartsANewRoundWithANewIdentityAndEpoch(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, _ := f.stoppedRound(t, "Again", true)
	f.mustConfirmStop(t, claim)
	stoppedRound := roundSnapshot(t, f.pool, claim.RoundId)
	assertNoWork(t, f.claim(t))
	f.changeStatus(t, queued.Id, Ready)
	next := f.mustClaim(t)
	if next.RoundId == claim.RoundId || next.Ticket.Id != queued.Id || next.Sequence != claim.Sequence+1 || next.ClaimEpoch != claim.ClaimEpoch+1 {
		t.Fatalf("next claim = %+v, want a new Round of %s with sequence %d and epoch %d", next, queued.Id, claim.Sequence+1, claim.ClaimEpoch+1)
	}
	if got := roundSnapshot(t, f.pool, claim.RoundId); got != stoppedRound {
		t.Fatalf("the stopped Round changed:\nbefore %s\nafter %s", stoppedRound, got)
	}
	rounds := decodeRounds(t, f.listRounds(t, queued.Id))
	if len(rounds) != 2 || rounds[0].Id != next.RoundId || rounds[0].State != RoundClaimed || rounds[0].OutcomeNote != nil || rounds[1].Id != claim.RoundId || rounds[1].State != RoundStopped {
		t.Fatalf("rounds = %+v, want the new claimed Round above the stopped one", rounds)
	}
}

func TestStoppedBadge_DetachingLeavesTheRoundStoppedAndTheNextStopReusesIt(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, _ := f.stoppedRound(t, "Detach", true)
	f.mustConfirmStop(t, claim)
	badge := stoppedBadgeOf(t, f)
	stoppedRound := roundSnapshot(t, f.pool, claim.RoundId)

	body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodDelete, "/api/tickets/"+queued.Id+"/badges/"+badge.Id, "", http.StatusOK)
	if detached := decodeAs[Ticket](t, body); len(detached.Badges) != 0 || detached.Status != Backlog {
		t.Fatalf("detached Ticket = %s %+v, want Backlog with no Badge", detached.Status, detached.Badges)
	}
	if got := roundSnapshot(t, f.pool, claim.RoundId); got != stoppedRound {
		t.Fatalf("detaching the Badge changed the Round:\nbefore %s\nafter %s", stoppedRound, got)
	}
	if round := f.roundOf(t, queued.Id); round.State != RoundStopped || round.OutcomeNote == nil || *round.OutcomeNote != stopEvidence {
		t.Fatalf("Round after detaching = %+v, want stopped with its outcomeNote", round)
	}
	listed, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodGet, "/api/badges", "", http.StatusOK)
	if got := decodeAs[BadgeList](t, listed).Badges; len(got) != 1 || got[0].Id != badge.Id || got[0].Name != stoppedBadgeName {
		t.Fatalf("badges = %+v, want the Stopped Badge listed like any other", got)
	}

	f.changeStatus(t, queued.Id, Ready)
	second := f.mustClaim(t)
	f.startRound(t, second, second.RoundId+":0")
	f.mustStop(t, queued.Id)
	f.mustConfirmStop(t, second)
	assertStoppedTicket(t, f.ticket(t, queued.Id), badge)
	if rows := badgeRows(t, f); len(rows) != 1 {
		t.Fatalf("badges after a second Stop = %+v, want the one Stopped Badge", rows)
	}
}

func TestStoppedBadge_IsAdoptedFromAnOwnersBadgeNamedStoppedInAnyCase(t *testing.T) {
	for _, name := range []string{"stopped", "STOPPED", "sToPpEd"} {
		t.Run(name, func(t *testing.T) {
			f := newClaimFixture(t)
			theirs := f.createBadge(t, name)
			foreignCookie, _ := secondOwnerSession(t, f.pool)
			badgeRequest(t, f.handler, foreignCookie, http.MethodPost, "/api/badges", `{"name":"Stopped"}`, http.StatusCreated)
			queued, claim, _ := f.stoppedRound(t, "Adopt", true)
			f.mustConfirmStop(t, claim)
			assertStoppedTicket(t, f.ticket(t, queued.Id), TicketBadge{Id: theirs.Id, Name: name})
			var systemKeys []*string
			for _, row := range badgeRows(t, f) {
				systemKeys = append(systemKeys, row.systemKey)
			}
			if len(systemKeys) != 2 || systemKeys[0] == nil || *systemKeys[0] != stoppedBadgeKey || systemKeys[1] != nil {
				t.Fatalf("badge system keys = %v, want the Owner's adopted and the other Owner's untouched", systemKeys)
			}
		})
	}
}

func TestEnsureStoppedBadge_ReusesAdoptsOrCreatesWithinTheOwner(t *testing.T) {
	f := newClaimFixture(t)
	ctx := context.Background()
	ownerID := resolveTestOwner(t, f.pool)
	ensure := func() int64 {
		t.Helper()
		tx, err := f.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		id, err := ensureStoppedBadge(ctx, tx, ownerID)
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return id
	}
	created := ensure()
	if rows := badgeRows(t, f); len(rows) != 1 || rows[0].name != stoppedBadgeName || rows[0].systemKey == nil || *rows[0].systemKey != stoppedBadgeKey {
		t.Fatalf("created badges = %+v, want one Stopped system Badge", rows)
	}
	if reused := ensure(); reused != created || len(badgeRows(t, f)) != 1 {
		t.Fatalf("second ensure = %d, want %d and no new Badge", reused, created)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE badges SET system_key = NULL`); err != nil {
		t.Fatal(err)
	}
	if adopted := ensure(); adopted != created || len(badgeRows(t, f)) != 1 {
		t.Fatalf("ensure after the key was cleared = %d, want the same-named Badge %d adopted", adopted, created)
	}
}

func TestStoppedBadge_AdoptsABadgeTheOwnerCommitsWhileTheConfirmationWaits(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, _ := f.stoppedRound(t, "Race", true)
	ctx := context.Background()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var created string
	if err := tx.QueryRow(ctx, `INSERT INTO badges (owner_id, public_id, name) VALUES ($1, gen_random_uuid(), 'stopped') RETURNING public_id::text`, resolveTestOwner(t, f.pool)).Scan(&created); err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- f.confirmStop(t, claim) }()
	waitForLockWaiter(t, f.pool, "INSERT INTO badges")
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if rec := <-done; rec.Code != http.StatusCreated {
		t.Fatalf("confirmation racing a Badge insert: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
	assertStoppedTicket(t, f.ticket(t, queued.Id), TicketBadge{Id: created, Name: "stopped"})
	if rows := badgeRows(t, f); len(rows) != 1 {
		t.Fatalf("badges = %+v, want the Owner's one, adopted", rows)
	}
}

func TestStoppedBadge_ConcurrentBadgeCreationAndConfirmationLeaveOneStoppedBadge(t *testing.T) {
	for i := range 5 {
		f := newClaimFixture(t)
		queued, claim, _ := f.stoppedRound(t, fmt.Sprintf("Race %d", i), true)
		var wg sync.WaitGroup
		var confirmation, creation *httptest.ResponseRecorder
		wg.Add(2)
		go func() { defer wg.Done(); confirmation = f.confirmStop(t, claim) }()
		go func() {
			defer wg.Done()
			creation = f.do(t, runnerCall{method: http.MethodPost, path: "/api/badges", body: `{"name":"Stopped"}`, cookie: f.cookie})
		}()
		wg.Wait()
		if confirmation.Code != http.StatusCreated {
			t.Fatalf("confirmation: status=%d body=%s, want 201", confirmation.Code, confirmation.Body.String())
		}
		if creation.Code != http.StatusCreated && creation.Code != http.StatusConflict {
			t.Fatalf("badge creation: status=%d body=%s, want 201 or 409", creation.Code, creation.Body.String())
		}
		rows := badgeRows(t, f)
		if len(rows) != 1 || rows[0].systemKey == nil {
			t.Fatalf("badges = %+v, want one Stopped system Badge", rows)
		}
		assertStoppedTicket(t, f.ticket(t, queued.Id), TicketBadge{Id: rows[0].publicID, Name: rows[0].name})
	}
}

func TestStopConfirmed_ATicketNeitherReadyNorInProgressRollsBackAndAnswers500(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, _ := f.stoppedRound(t, "Broken invariant", true)
	var logs bytes.Buffer
	handler := NewHandlerWithClock(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), f.pool, testLogger(&logs), f.clock.Now)
	if _, err := f.pool.Exec(context.Background(), `UPDATE tickets SET status = 'Blocked' WHERE public_id = $1::uuid`, queued.Id); err != nil {
		t.Fatal(err)
	}
	before := databaseSnapshot(t, f.pool)
	req := httptest.NewRequest(http.MethodPost, "/api/runner/rounds/"+claim.RoundId+"/events", strings.NewReader(stopConfirmedEvent(t, "stop", claim.ClaimEpoch, stopEvidence)))
	req.Header.Set("Authorization", "Bearer "+f.token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertErrorBody(t, rec, http.StatusInternalServerError, "internal_error", roundEventFailedMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a stop_confirmed whose Ticket guard failed")
	if out := logs.String(); !strings.Contains(out, claim.RoundId) || !strings.Contains(out, "ERROR") || !strings.Contains(out, errEndingTicketNotActive.Error()) {
		t.Fatalf("the broken invariant was not logged with the Round id:\n%s", out)
	}
}

func TestStopConfirmed_AFailureAtTheLastWriteRollsBackEveryChange(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, _ := f.stoppedRound(t, "Rollback", true)
	f.queue(t, "Waiting")
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `CREATE FUNCTION refuse_stops() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
		CREATE TRIGGER refuse_stops BEFORE INSERT ON round_events FOR EACH ROW WHEN (NEW.type = 'stop_confirmed') EXECUTE FUNCTION refuse_stops()`); err != nil {
		t.Fatal(err)
	}
	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.confirmStop(t, claim), http.StatusServiceUnavailable, "database_unavailable", roundEventFailedMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a stop_confirmed whose last write failed")
	if got := f.ticket(t, queued.Id); got.Status != InProgress || got.OpenRound == nil || len(got.Badges) != 0 {
		t.Fatalf("Ticket = %s %+v %+v, want In Progress, still open, no Badge", got.Status, got.OpenRound, got.Badges)
	}
	assertNoWork(t, f.claim(t))
}

func TestStopConfirmed_EvidenceLimitsAtTheAPI(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, _ := f.stoppedRound(t, "Limits", true)
	before := databaseSnapshot(t, f.pool)
	shape := `"data" must be an object with exactly "evidence"`
	limits := `"evidence" must be 1 to 2000 characters, not blank, without control characters other than tab and line feed`
	for name, tc := range map[string]struct {
		data    any
		message string
	}{
		"no evidence":          {map[string]any{}, shape},
		"another field":        {map[string]any{"evidence": "e", "note": "n"}, shape},
		"evidence is a number": {map[string]any{"evidence": 1}, shape},
		"evidence is null":     {map[string]any{"evidence": nil}, limits},
		"data is an array":     {[]any{"e"}, shape},
		"empty evidence":       {map[string]any{"evidence": ""}, limits},
		"blank evidence":       {map[string]any{"evidence": " \t\n "}, limits},
		"2001 characters":      {map[string]any{"evidence": strings.Repeat("界", 2001)}, limits},
		"a carriage return":    {map[string]any{"evidence": "a\rb"}, limits},
		"a NUL":                {map[string]any{"evidence": "a\x00b"}, limits},
	} {
		t.Run(name, func(t *testing.T) {
			rec := f.reportEvent(t, claim.RoundId, stopConfirmedEventWith(t, "bad", claim.ClaimEpoch, tc.data))
			assertErrorBody(t, rec, http.StatusBadRequest, "invalid_request", tc.message)
		})
	}
	assertSnapshotUnchanged(t, f.pool, before, "invalid stop_confirmed bodies")
	longest := strings.Repeat("界", 1998) + "\t\n"
	f.mustReport(t, claim.RoundId, stopConfirmedEvent(t, "ok", claim.ClaimEpoch, longest))
	if round := f.roundOf(t, claim.Ticket.Id); round.OutcomeNote == nil || *round.OutcomeNote != longest {
		t.Fatalf("outcomeNote = %v, want the 2000-character evidence verbatim", round.OutcomeNote)
	}
}

// Disconnect, an unacknowledged Stop, an applied ack and the passing of time are not confirmed cessation (execution-interface.md).
func TestStopped_NoSignalButStopConfirmedEndsARound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, command := f.stoppedRound(t, "Only confirmation", true)
	f.queue(t, "Waiting")
	for range 3 {
		f.mustCommands(t, claim.RoundId)
	}
	f.clock.Set(runnerEpoch.Add(24 * time.Hour))
	assertNoWork(t, f.claim(t))
	f.heartbeat(t, f.token, http.StatusOK)
	decodeAck(t, f.ack(t, claim.RoundId, command.Id, RunnerCommandApplied))
	assertNoWork(t, f.claim(t))
	if got := f.ticket(t, queued.Id); got.Status != InProgress || got.OpenRound == nil || got.OpenRound.StopRequestedAt == nil || len(got.Badges) != 0 {
		t.Fatalf("Ticket = %s %+v %+v, want In Progress, Stopping, no Badge", got.Status, got.OpenRound, got.Badges)
	}
	f.mustConfirmStop(t, claim)
	assertStoppedTicket(t, f.ticket(t, queued.Id), stoppedBadgeOf(t, f))
	f.mustClaim(t)
}

func TestRoundEndings_OnlyTheEndingCodeNamesTheEndedStates(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []RoundState{RoundStopped, RoundFailed, RoundInterrupted} {
		constant := map[RoundState]string{RoundStopped: "RoundStopped", RoundFailed: "RoundFailed", RoundInterrupted: "RoundInterrupted"}[state]
		var writers []string
		for _, file := range files {
			if strings.HasSuffix(file, "_test.go") || file == "api.gen.go" {
				continue
			}
			source, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(source, []byte(constant)) || bytes.Contains(source, []byte("'"+string(state)+"'")) {
				writers = append(writers, file)
			}
		}
		if !reflect.DeepEqual(writers, []string{"round_endings.go"}) {
			t.Errorf("files naming the %s state = %v, want only round_endings.go", state, writers)
		}
	}
}

func TestRounds_TheDatabaseEnforcesTheStoppedOutcome(t *testing.T) {
	f := newClaimFixture(t)
	a := f.queue(t, "A")
	ctx := context.Background()
	insert := func(sequence int, state, started, ended string, note any) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO rounds (owner_id, public_id, ticket_id, agent_id, sequence, state, claim_epoch, claimed_at, started_at, ended_at, outcome_note)
			SELECT t.owner_id, gen_random_uuid(), t.id, t.assignee_agent_id, $2, $3, 1, now(), `+started+`, `+ended+`, $4
			  FROM tickets t WHERE t.public_id = $1::uuid`, a.Id, sequence, state, note)
		return err
	}
	for _, tc := range []struct {
		name, state, started, ended string
		note                        any
		constraint                  string
	}{
		{"stopped without a note", "stopped", "now()", "now()", nil, "rounds_outcome_note_follows_state"},
		{"delivered with a note", "delivered", "now()", "now()", "n", "rounds_outcome_note_follows_state"},
		{"running with a note", "running", "now()", "NULL", "n", "rounds_outcome_note_follows_state"},
		{"stopped without an end", "stopped", "now()", "NULL", "n", "rounds_timestamps_follow_state"},
		{"an empty note", "stopped", "now()", "now()", "", "rounds_outcome_note_length"},
		{"a note over 2000 characters", "stopped", "now()", "now()", strings.Repeat("界", 2001), "rounds_outcome_note_length"},
		{"stopped before claimed", "stopped", "NULL", "now() - interval '1 hour'", "n", "rounds_timestamps_ordered"},
	} {
		assertViolates(t, insert(9, tc.state, tc.started, tc.ended, tc.note), tc.constraint)
	}
	if err := insert(2, "stopped", "NULL", "now()", "Stopped while claimed"); err != nil {
		t.Fatalf("a Round stopped while claimed: %v", err)
	}
	if err := insert(3, "stopped", "now()", "now()", strings.Repeat("界", 2000)); err != nil {
		t.Fatalf("a Round stopped while running, with a 2000-character note: %v", err)
	}
	if err := insert(4, "stopped", "now()", "now()", "beside the open Round"); err != nil {
		t.Fatalf("stopped Rounds hold no slot: %v", err)
	}
}

func TestBadges_TheDatabaseEnforcesOneSystemBadgePerOwner(t *testing.T) {
	f := newClaimFixture(t)
	ctx := context.Background()
	ownerID := resolveTestOwner(t, f.pool)
	_, otherOwnerID := secondOwnerSession(t, f.pool)
	insert := func(owner int64, name string, key any) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO badges (owner_id, public_id, name, system_key) VALUES ($1, gen_random_uuid(), $2, $3)`, owner, name, key)
		return err
	}
	assertViolates(t, insert(ownerID, "Paused", "paused"), "badges_system_key")
	if err := insert(ownerID, "Stopped", "stopped"); err != nil {
		t.Fatal(err)
	}
	assertViolates(t, insert(ownerID, "Halted", "stopped"), "badges_owner_system_key_unique")
	if err := insert(otherOwnerID, "Stopped", "stopped"); err != nil {
		t.Fatalf("another Owner's Stopped Badge: %v", err)
	}
	if err := insert(ownerID, "Plain", nil); err != nil {
		t.Fatalf("an ordinary Badge: %v", err)
	}
}
