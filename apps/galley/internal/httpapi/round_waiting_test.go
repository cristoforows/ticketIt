package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestDecideWaitingReason(t *testing.T) {
	for _, tc := range []struct {
		state           OpenRoundState
		stopRequested   bool
		runnerConnected bool
		want            RoundWaitingReason
	}{
		{OpenRoundClaimed, false, true, WaitingStarting},
		{OpenRoundRunning, false, true, WaitingWorking},
		{OpenRoundClaimed, true, true, WaitingStopping},
		{OpenRoundRunning, true, true, WaitingStopping},
		{OpenRoundClaimed, false, false, WaitingRunnerDisconnected},
		{OpenRoundRunning, false, false, WaitingRunnerDisconnected},
		{OpenRoundClaimed, true, false, WaitingRunnerDisconnected},
		{OpenRoundRunning, true, false, WaitingRunnerDisconnected},
	} {
		if got := decideWaitingReason(tc.state, tc.stopRequested, tc.runnerConnected); got != tc.want {
			t.Errorf("decideWaitingReason(%s, stopRequested=%t, connected=%t) = %s, want %s", tc.state, tc.stopRequested, tc.runnerConnected, got, tc.want)
		}
	}
}

func (f *claimFixture) assertWaitingReason(t *testing.T, ticketID string, want RoundWaitingReason) {
	t.Helper()
	if got := f.ticket(t, ticketID).OpenRound; got == nil || got.WaitingReason != want {
		t.Fatalf("GET openRound = %+v, want waitingReason %s", got, want)
	}
	body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodGet, "/api/tickets", "", http.StatusOK)
	for _, listed := range decodeAs[TicketList](t, body).Tickets {
		if listed.Id != ticketID {
			continue
		}
		if listed.OpenRound == nil || listed.OpenRound.WaitingReason != want {
			t.Fatalf("listed openRound = %+v, want waitingReason %s", listed.OpenRound, want)
		}
		return
	}
	t.Fatalf("Ticket %s missing from the list", ticketID)
}

func TestWaitingReason_FollowsTheRoundThroughStartingWorkingAndStopping(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Waiting reasons")
	f.assertWaitingReason(t, queued.Id, WaitingStarting)

	f.startRound(t, claim, "start")
	f.assertWaitingReason(t, queued.Id, WaitingWorking)

	if stopped := f.mustStop(t, queued.Id); stopped.OpenRound == nil || stopped.OpenRound.WaitingReason != WaitingStopping {
		t.Fatalf("stop response openRound = %+v, want waitingReason stopping", stopped.OpenRound)
	}
	f.assertWaitingReason(t, queued.Id, WaitingStopping)
}

func TestWaitingReason_AClaimedRoundStopRequestedIsStopping(t *testing.T) {
	f := newClaimFixture(t)
	queued, _ := f.claimTicket(t, "Stop before start")
	f.mustStop(t, queued.Id)
	f.assertWaitingReason(t, queued.Id, WaitingStopping)
}

func TestWaitingReason_RunnerDisconnectedFollowsRunnerHealthExactly(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Lost contact")
	f.startRound(t, claim, "start")

	for _, tc := range []struct {
		after  time.Duration
		health RunnerHealthState
		want   RoundWaitingReason
	}{
		{runnerHealthWindow - time.Microsecond, RunnerConnected, WaitingWorking},
		{runnerHealthWindow, RunnerDisconnected, WaitingRunnerDisconnected},
		{24 * time.Hour, RunnerDisconnected, WaitingRunnerDisconnected},
	} {
		f.clock.Set(runnerEpoch.Add(tc.after))
		if got := f.health(t).State; got != tc.health {
			t.Fatalf("after %s: health = %s, want %s", tc.after, got, tc.health)
		}
		f.assertWaitingReason(t, queued.Id, tc.want)
	}

	f.mustStop(t, queued.Id)
	f.assertWaitingReason(t, queued.Id, WaitingRunnerDisconnected)
	f.heartbeat(t, f.token, http.StatusOK)
	f.assertWaitingReason(t, queued.Id, WaitingStopping)
}

func TestWaitingReason_AClaimedRoundLosingItsRunnerIsRunnerDisconnected(t *testing.T) {
	f := newClaimFixture(t)
	queued, _ := f.claimTicket(t, "Never started")
	f.clock.Set(runnerEpoch.Add(runnerHealthWindow))
	f.assertWaitingReason(t, queued.Id, WaitingRunnerDisconnected)
	f.heartbeat(t, f.token, http.StatusOK)
	f.assertWaitingReason(t, queued.Id, WaitingStarting)
}

func TestWaitingReason_NoPairedRunnerIsRunnerDisconnected(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Revoked")
	f.startRound(t, claim, "start")
	f.expect(t, runnerCall{method: http.MethodDelete, path: "/api/runner-credential", cookie: f.cookie}, http.StatusNoContent)
	if got := f.health(t).State; got != RunnerNotPaired {
		t.Fatalf("health = %s, want not_paired", got)
	}
	f.assertWaitingReason(t, queued.Id, WaitingRunnerDisconnected)

	repaired := f.pair(t).Token
	f.assertWaitingReason(t, queued.Id, WaitingRunnerDisconnected)
	f.register(t, repaired, http.StatusOK)
	f.assertWaitingReason(t, queued.Id, WaitingWorking)
}

func TestWaitingReason_ReadsOnlyTheOwnersRunner(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Mine")
	f.startRound(t, claim, "start")

	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)

	f.clock.Set(runnerEpoch.Add(runnerHealthWindow))
	foreign.heartbeat(t, foreign.token, http.StatusOK)
	f.assertWaitingReason(t, queued.Id, WaitingRunnerDisconnected)
}

func TestWaitingReason_ChangesNoStoredState(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Read only")
	f.startRound(t, claim, "start")
	before := databaseSnapshot(t, f.pool)
	f.clock.Set(runnerEpoch.Add(time.Hour))
	f.assertWaitingReason(t, queued.Id, WaitingRunnerDisconnected)
	if after := databaseSnapshot(t, f.pool); after != before {
		t.Fatalf("reading the waiting reason changed the database:\nbefore %s\nafter  %s", before, after)
	}
	var state string
	if err := f.pool.QueryRow(context.Background(), `SELECT state FROM rounds WHERE public_id = $1::uuid`, claim.RoundId).Scan(&state); err != nil || state != "running" {
		t.Fatalf("round state = %q (%v), want running", state, err)
	}
}
