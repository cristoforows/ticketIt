package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

const (
	testMaxActive  = 20 * time.Second
	testMaxDenials = 3
)

func newLimitFixture(t *testing.T, maxActive time.Duration, maxDenials int) *claimFixture {
	t.Helper()
	return newClaimFixtureWith(t, config.Config{Environment: config.EnvDevelopment, Version: "dev",
		RoundMaxActiveDuration: maxActive, RoundMaxConsecutiveDenials: maxDenials})
}

func (f *claimFixture) advance(d time.Duration) {
	f.clock.Set(f.clock.Now().Add(d))
}

type breachRow struct {
	roundID         string
	kind            string
	limit, measured int64
	breachedAt      time.Time
}

func breachRows(t *testing.T, f *claimFixture) []breachRow {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT r.public_id::text, b.kind, b."limit", b.measured, b.breached_at
		FROM round_limit_breaches b JOIN rounds r ON r.id = b.round_id ORDER BY b.id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []breachRow
	for rows.Next() {
		var b breachRow
		if err := rows.Scan(&b.roundID, &b.kind, &b.limit, &b.measured, &b.breachedAt); err != nil {
			t.Fatal(err)
		}
		b.breachedAt = b.breachedAt.UTC()
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func stopCommandCount(t *testing.T, f *claimFixture, roundID string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM round_commands c JOIN rounds r ON r.id = c.round_id
		WHERE r.public_id = $1::uuid AND c.type = 'stop'`, roundID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func assertOneBreach(t *testing.T, f *claimFixture, claim RunnerClaim, want breachRow) {
	t.Helper()
	want.roundID = claim.RoundId
	got := breachRows(t, f)
	if len(got) != 1 || got[0] != want {
		t.Fatalf("breaches = %+v, want exactly [%+v]", got, want)
	}
	if n := stopCommandCount(t, f, claim.RoundId); n != 1 {
		t.Fatalf("stop commands = %d, want 1", n)
	}
}

func assertNoBreach(t *testing.T, f *claimFixture, claim RunnerClaim) {
	t.Helper()
	if got := breachRows(t, f); len(got) != 0 {
		t.Fatalf("breaches = %+v, want none", got)
	}
	if n := stopCommandCount(t, f, claim.RoundId); n != 0 {
		t.Fatalf("stop commands = %d, want none", n)
	}
}

type activeTime struct {
	ms    int64
	since *time.Time
}

func roundActiveTime(t *testing.T, f *claimFixture, roundID string) activeTime {
	t.Helper()
	var a activeTime
	if err := f.pool.QueryRow(context.Background(), `SELECT active_ms, active_since FROM rounds WHERE public_id = $1::uuid`, roundID).Scan(&a.ms, &a.since); err != nil {
		t.Fatal(err)
	}
	if a.since != nil {
		utc := a.since.UTC()
		a.since = &utc
	}
	return a
}

func assertActiveTime(t *testing.T, f *claimFixture, roundID string, ms int64, since *time.Time) {
	t.Helper()
	got := roundActiveTime(t, f, roundID)
	if got.ms != ms || (got.since == nil) != (since == nil) || (since != nil && !got.since.Equal(*since)) {
		t.Fatalf("active time = %d ms since %v, want %d ms since %v", got.ms, got.since, ms, since)
	}
}

func timePtr(t time.Time) *time.Time { return &t }

func (f *claimFixture) progress(t *testing.T, claim RunnerClaim, note string) {
	t.Helper()
	f.mustReport(t, claim.RoundId, progressEvent(t, uuid.NewString(), claim.ClaimEpoch, eventOccurredAt, note))
}

var otherScope = permissionScope{controlledAccount, "read_note", writeReport.resource}

func TestDecideLimitBreach_AtEachBoundary(t *testing.T) {
	limits := roundLimits{maxActive: 4 * time.Hour, maxDenials: 10}
	running := func(active time.Duration, denials int) roundMeasure {
		return roundMeasure{state: RoundRunning, active: active, denials: denials}
	}
	for _, tc := range []struct {
		name   string
		limits roundLimits
		m      roundMeasure
		want   *limitBreach
	}{
		{"nothing measured", limits, running(0, 0), nil},
		{"active just under the limit", limits, running(4*time.Hour-time.Nanosecond, 0), nil},
		{"active at the limit", limits, running(4*time.Hour, 0), &limitBreach{LimitWallClock, 14400, 14400}},
		{"active past the limit, measured in whole seconds", limits, running(4*time.Hour+1999*time.Millisecond, 0), &limitBreach{LimitWallClock, 14400, 14401}},
		{"one denial under the limit", limits, running(0, 9), nil},
		{"the limit-th denial", limits, running(0, 10), &limitBreach{LimitDenialLoop, 10, 10}},
		{"past the denial limit", limits, running(0, 11), &limitBreach{LimitDenialLoop, 10, 11}},
		{"a denial limit of one", roundLimits{maxActive: time.Hour, maxDenials: 1}, running(0, 1), &limitBreach{LimitDenialLoop, 1, 1}},
		{"both reached names the wall clock", limits, running(5*time.Hour, 10), &limitBreach{LimitWallClock, 14400, 18000}},
		{"Stop already requested", limits, roundMeasure{state: RoundRunning, stopRequested: true, active: 5 * time.Hour, denials: 20}, nil},
		{"claimed", limits, roundMeasure{state: RoundClaimed, active: 5 * time.Hour, denials: 20}, nil},
		{"waiting for input", limits, roundMeasure{state: RoundWaitingForInput, active: 5 * time.Hour, denials: 20}, nil},
		{"ended", limits, roundMeasure{state: RoundStopped, active: 5 * time.Hour, denials: 20}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := decideLimitBreach(tc.limits, tc.m)
			if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
				t.Fatalf("decideLimitBreach = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestLimitBreachExplanation_IsGalleysExactWording(t *testing.T) {
	for _, tc := range []struct {
		breach RoundLimitBreach
		want   string
	}{
		{RoundLimitBreach{Kind: LimitWallClock, Limit: 14400, Measured: 14401}, "Technical limit reached: active time 4h0m1s exceeded the 4h0m0s limit."},
		{RoundLimitBreach{Kind: LimitWallClock, Limit: 20, Measured: 20}, "Technical limit reached: active time 20s exceeded the 20s limit."},
		{RoundLimitBreach{Kind: LimitWallClock, Limit: 604800, Measured: 604800}, "Technical limit reached: active time 168h0m0s exceeded the 168h0m0s limit."},
		{RoundLimitBreach{Kind: LimitDenialLoop, Limit: 10, Measured: 10}, "Technical limit reached: 10 consecutive denied authority checks (limit 10)."},
		{RoundLimitBreach{Kind: LimitDenialLoop, Limit: 1000, Measured: 1000}, "Technical limit reached: 1000 consecutive denied authority checks (limit 1000)."},
	} {
		if got := limitBreachExplanation(tc.breach); got != tc.want || len(got) > outcomeNoteMaxLength {
			t.Errorf("limitBreachExplanation(%+v) = %q, want %q", tc.breach, got, tc.want)
		}
	}
}

func TestRoundLimitsOf_DefaultsOnlyUnsetLimits(t *testing.T) {
	if got := roundLimitsOf(config.Config{}); got != (roundLimits{maxActive: 4 * time.Hour, maxDenials: 10}) {
		t.Fatalf("roundLimitsOf(zero) = %+v, want the defaults", got)
	}
	if got := roundLimitsOf(config.Config{RoundMaxActiveDuration: time.Second, RoundMaxConsecutiveDenials: 1}); got != (roundLimits{maxActive: time.Second, maxDenials: 1}) {
		t.Fatalf("roundLimitsOf = %+v, want the configured limits", got)
	}
}

func TestActiveTime_CountsRunningOnly(t *testing.T) {
	f := newLimitFixture(t, time.Hour, 100)
	queued, claim := f.claimTicket(t, "Active time")
	f.advance(10 * time.Minute)
	assertActiveTime(t, f, claim.RoundId, 0, nil)

	f.startRound(t, claim, claim.RoundId+":0")
	start := f.clock.Now()
	assertActiveTime(t, f, claim.RoundId, 0, &start)

	f.advance(10 * time.Second)
	if rec := f.raise(t, claim, questionA); rec.Code != http.StatusCreated {
		t.Fatalf("question_raised: %d %s", rec.Code, rec.Body.String())
	}
	assertActiveTime(t, f, claim.RoundId, 10_000, nil)

	f.advance(2 * time.Hour)
	f.mustHeartbeat(t)
	f.mustAnswer(t, queued.Id, claim.RoundId, questionA)
	assertActiveTime(t, f, claim.RoundId, 10_000, nil)
	if rec := f.resume(t, claim, questionA); rec.Code != http.StatusCreated {
		t.Fatalf("resumed: %d %s", rec.Code, rec.Body.String())
	}
	resumed := f.clock.Now()
	assertActiveTime(t, f, claim.RoundId, 10_000, &resumed)

	f.advance(5 * time.Second)
	f.mustRequestPermission(t, claim, requestA, writeReport)
	assertActiveTime(t, f, claim.RoundId, 15_000, nil)
	f.advance(time.Hour)
	f.mustHeartbeat(t)
	f.mustApprove(t, queued.Id, claim.RoundId, requestA)
	f.mustResumeApproval(t, claim, requestA)
	approved := f.clock.Now()
	assertActiveTime(t, f, claim.RoundId, 15_000, &approved)

	f.advance(7*time.Second + 250*time.Millisecond)
	f.deliver(t, claim)
	assertActiveTime(t, f, claim.RoundId, 22_250, nil)
	assertNoBreach(t, f, claim)
}

func TestActiveTime_FoldsOnEveryEnding(t *testing.T) {
	for _, tc := range []struct {
		name   string
		ending func(f *claimFixture, t *testing.T, queued Ticket, claim RunnerClaim)
	}{
		{"failed", func(f *claimFixture, t *testing.T, _ Ticket, claim RunnerClaim) {
			f.mustEndAs(t, blockedEndings[0], claim)
		}},
		{"interrupted", func(f *claimFixture, t *testing.T, _ Ticket, claim RunnerClaim) {
			f.mustEndAs(t, blockedEndings[1], claim)
		}},
		{"stopped", func(f *claimFixture, t *testing.T, queued Ticket, claim RunnerClaim) {
			f.mustStop(t, queued.Id)
			f.mustConfirmStop(t, claim)
		}},
		{"attested", func(f *claimFixture, t *testing.T, queued Ticket, claim RunnerClaim) {
			f.lapse()
			f.mustAttest(t, queued.Id, claim.RoundId)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newLimitFixture(t, time.Hour, 100)
			queued, claim := f.runningRound(t, "Ending "+tc.name)
			f.advance(3 * time.Second)
			before := f.clock.Now()
			tc.ending(f, t, queued, claim)
			want := before.Sub(runnerEpoch).Milliseconds()
			if tc.name == "attested" {
				want += runnerHealthWindow.Milliseconds()
			}
			assertActiveTime(t, f, claim.RoundId, want, nil)
		})
	}
}

func TestActiveTime_CountsTimeWithTheRunnerDisconnected(t *testing.T) {
	f := newLimitFixture(t, time.Minute, 100)
	_, claim := f.runningRound(t, "Disconnected")
	f.advance(time.Minute)
	if f.health(t).State != RunnerDisconnected {
		t.Fatal("the runner should look disconnected a minute after its last heartbeat")
	}
	f.progress(t, claim, "Still working while unseen")
	assertOneBreach(t, f, claim, breachRow{kind: "wall_clock", limit: 60, measured: 60, breachedAt: f.clock.Now()})
}

func TestWallClockLimit_BreachesOnHeartbeat(t *testing.T) {
	f := newLimitFixture(t, testMaxActive, 100)
	queued, claim := f.runningRound(t, "Heartbeat")
	f.advance(testMaxActive - time.Microsecond)
	f.mustHeartbeat(t)
	assertNoBreach(t, f, claim)

	f.advance(time.Microsecond)
	f.mustHeartbeat(t)
	breachedAt := f.clock.Now()
	assertOneBreach(t, f, claim, breachRow{kind: "wall_clock", limit: 20, measured: 20, breachedAt: breachedAt})
	ticket := f.ticket(t, queued.Id)
	want := RoundLimitBreach{Kind: LimitWallClock, Limit: 20, Measured: 20, BreachedAt: breachedAt}
	if ticket.OpenRound == nil || ticket.OpenRound.LimitBreach == nil || *ticket.OpenRound.LimitBreach != want ||
		ticket.OpenRound.StopRequestedAt == nil || !ticket.OpenRound.StopRequestedAt.Equal(breachedAt) || ticket.Status != InProgress {
		t.Fatalf("Ticket = %s %+v, want In Progress with Stop requested at %s by %+v", ticket.Status, ticket.OpenRound, breachedAt, want)
	}
	f.assertWaitingReason(t, queued.Id, WaitingStopping)
	if round := f.roundOf(t, queued.Id); round.LimitBreach == nil || *round.LimitBreach != want || round.State != RoundRunning {
		t.Fatalf("Round = %+v, want running with %+v", round, want)
	}
	if commands := f.mustCommands(t, claim.RoundId); len(commands) != 1 || commands[0].Type != RunnerCommandStop || commands[0].ClaimEpoch != claim.ClaimEpoch {
		t.Fatalf("commands = %+v, want the one Stop", commands)
	}

	f.advance(time.Hour)
	f.mustHeartbeat(t)
	f.progress(t, claim, "Again")
	assertOneBreach(t, f, claim, breachRow{kind: "wall_clock", limit: 20, measured: 20, breachedAt: breachedAt})
}

func TestWallClockLimit_BreachesOnEvent(t *testing.T) {
	f := newLimitFixture(t, testMaxActive, 100)
	_, claim := f.runningRound(t, "Event")
	f.advance(testMaxActive - time.Microsecond)
	f.progress(t, claim, "Under the limit")
	assertNoBreach(t, f, claim)
	f.advance(time.Microsecond)
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, claim.ClaimEpoch, usageData(observationA)))
	assertOneBreach(t, f, claim, breachRow{kind: "wall_clock", limit: 20, measured: 20, breachedAt: f.clock.Now()})
}

func TestWallClockLimit_BreachesOnAuthorityCheck(t *testing.T) {
	f := newLimitFixture(t, testMaxActive, 100)
	_, claim := f.runningRound(t, "Check")
	f.advance(testMaxActive - time.Microsecond)
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	assertNoBreach(t, f, claim)
	f.advance(time.Microsecond)
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	assertOneBreach(t, f, claim, breachRow{kind: "wall_clock", limit: 20, measured: 20, breachedAt: f.clock.Now()})
}

func TestWallClockLimit_ExcludesClaimedAndWaitingTime(t *testing.T) {
	f := newLimitFixture(t, testMaxActive, 100)
	queued, claim := f.claimTicket(t, "Excluded")
	f.advance(time.Hour)
	f.mustHeartbeat(t)
	f.startRound(t, claim, claim.RoundId+":0")
	f.advance(10 * time.Second)
	if rec := f.raise(t, claim, questionA); rec.Code != http.StatusCreated {
		t.Fatalf("question_raised: %d %s", rec.Code, rec.Body.String())
	}
	f.advance(time.Hour)
	f.mustHeartbeat(t)
	f.mustAnswer(t, queued.Id, claim.RoundId, questionA)
	if rec := f.resume(t, claim, questionA); rec.Code != http.StatusCreated {
		t.Fatalf("resumed: %d %s", rec.Code, rec.Body.String())
	}
	f.advance(10*time.Second - time.Millisecond)
	f.mustHeartbeat(t)
	assertNoBreach(t, f, claim)
	f.advance(time.Millisecond)
	f.mustHeartbeat(t)
	assertOneBreach(t, f, claim, breachRow{kind: "wall_clock", limit: 20, measured: 20, breachedAt: f.clock.Now()})
}

func TestWallClockLimit_ReportedUsageNeitherCausesNorPreventsABreach(t *testing.T) {
	f := newLimitFixture(t, testMaxActive, 100)
	_, claim := f.runningRound(t, "Huge usage")
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, claim.ClaimEpoch, usageWith(observationA, map[string]any{"activeMs": 9007199254740991})))
	f.mustHeartbeat(t)
	assertNoBreach(t, f, claim)
	f.deliver(t, claim)

	_, second := f.runningRound(t, "No usage")
	f.advance(testMaxActive)
	f.mustReport(t, second.RoundId, usageEvent(t, observationB, second.ClaimEpoch, usageWith(observationB, map[string]any{"activeMs": 0})))
	assertOneBreach(t, f, second, breachRow{kind: "wall_clock", limit: 20, measured: 20, breachedAt: f.clock.Now()})
}

func TestDenialLimit_TheLimitThDenialBreachesAndStillDenies(t *testing.T) {
	f := newLimitFixture(t, time.Hour, testMaxDenials)
	_, claim := f.runningRound(t, "Denials")
	for range testMaxDenials - 1 {
		assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	}
	assertNoBreach(t, f, claim)
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	breachedAt := f.clock.Now()
	assertOneBreach(t, f, claim, breachRow{kind: "denial_loop", limit: testMaxDenials, measured: testMaxDenials, breachedAt: breachedAt})

	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	f.mustHeartbeat(t)
	assertOneBreach(t, f, claim, breachRow{kind: "denial_loop", limit: testMaxDenials, measured: testMaxDenials, breachedAt: breachedAt})
	if got := f.roundOf(t, claim.Ticket.Id).AuthorityCheckCount; got != testMaxDenials+1 {
		t.Fatalf("authority checks recorded = %d, want %d", got, testMaxDenials+1)
	}
}

func TestDenialLimit_OfOneBreachesOnTheFirstDenial(t *testing.T) {
	f := newLimitFixture(t, time.Hour, 1)
	_, claim := f.runningRound(t, "One")
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	assertOneBreach(t, f, claim, breachRow{kind: "denial_loop", limit: 1, measured: 1, breachedAt: f.clock.Now()})
}

func TestDenialLimit_AnAllowResetsTheStreak(t *testing.T) {
	f := newLimitFixture(t, time.Hour, testMaxDenials)
	queued, claim := f.runningRound(t, "Reset")
	for range testMaxDenials - 1 {
		assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	}
	f.mustRequestPermission(t, claim, requestA, writeReport)
	grantID := f.mustApprove(t, queued.Id, claim.RoundId, requestA).PermissionGrants[0].Id
	f.mustResumeApproval(t, claim, requestA)
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)
	for range testMaxDenials - 1 {
		assertDecision(t, f.mustCheck(t, claim, otherScope), AuthorityDeny, "")
	}
	assertNoBreach(t, f, claim)
	assertDecision(t, f.mustCheck(t, claim, otherScope), AuthorityDeny, "")
	assertOneBreach(t, f, claim, breachRow{kind: "denial_loop", limit: testMaxDenials, measured: testMaxDenials, breachedAt: f.clock.Now()})
}

func TestDenialLimit_TheStreakDoesNotCarryAcrossRounds(t *testing.T) {
	f := newLimitFixture(t, time.Hour, testMaxDenials)
	_, first := f.runningRound(t, "First")
	for range testMaxDenials - 1 {
		assertDecision(t, f.mustCheck(t, first, writeReport), AuthorityDeny, "")
	}
	f.deliver(t, first)
	_, second := f.runningRound(t, "Second")
	for range testMaxDenials - 1 {
		assertDecision(t, f.mustCheck(t, second, writeReport), AuthorityDeny, "")
	}
	assertNoBreach(t, f, second)
	assertDecision(t, f.mustCheck(t, second, writeReport), AuthorityDeny, "")
	assertOneBreach(t, f, second, breachRow{kind: "denial_loop", limit: testMaxDenials, measured: testMaxDenials, breachedAt: f.clock.Now()})
}

func TestDenialLimit_RefusedChecksDoNotCount(t *testing.T) {
	f := newLimitFixture(t, time.Hour, 2)
	_, claim := f.runningRound(t, "Refused")
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	f.lapse()
	for range 5 {
		assertErrorCode(t, f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport), runnerDisconnectedCode)
	}
	f.mustHeartbeat(t)
	for range 5 {
		assertErrorCode(t, f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport), reconcileRequiredCode)
	}
	assertNoBreach(t, f, claim)
	f.reconnect(t, claim)
	assertNoBreach(t, f, claim)
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	assertOneBreach(t, f, claim, breachRow{kind: "denial_loop", limit: 2, measured: 2, breachedAt: f.clock.Now()})
}

func TestLimits_AStopAlreadyRequestedRecordsNoBreach(t *testing.T) {
	f := newLimitFixture(t, testMaxActive, 1)
	queued, claim := f.runningRound(t, "Owner first")
	f.mustStop(t, queued.Id)
	f.advance(testMaxActive)
	f.mustHeartbeat(t)
	f.progress(t, claim, "After the Owner's Stop")
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	if got := breachRows(t, f); len(got) != 0 {
		t.Fatalf("breaches = %+v, want none: the Owner's Stop came first", got)
	}
	if n := stopCommandCount(t, f, claim.RoundId); n != 1 {
		t.Fatalf("stop commands = %d, want the Owner's one", n)
	}
	if got := f.ticket(t, queued.Id).OpenRound; got == nil || got.LimitBreach != nil {
		t.Fatalf("openRound = %+v, want no limit breach", got)
	}
	f.mustConfirmStop(t, claim)
	if round := f.roundOf(t, queued.Id); round.State != RoundStopped || round.LimitBreach != nil {
		t.Fatalf("Round = %s %+v, want stopped without a breach", round.State, round.LimitBreach)
	}
}

func TestLimits_ABreachSharesTheOwnersStopAndARevocationsStop(t *testing.T) {
	f := newLimitFixture(t, time.Hour, 1)
	queued, claim := f.runningRound(t, "Shared")
	f.mustRequestPermission(t, claim, requestA, writeReport)
	grantID := f.mustApprove(t, queued.Id, claim.RoundId, requestA).PermissionGrants[0].Id
	f.mustResumeApproval(t, claim, requestA)
	assertDecision(t, f.mustCheck(t, claim, otherScope), AuthorityDeny, "")
	breach := breachRow{kind: "denial_loop", limit: 1, measured: 1, breachedAt: f.clock.Now()}
	assertOneBreach(t, f, claim, breach)

	f.advance(time.Second)
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)
	if ticket := f.mustStop(t, queued.Id); ticket.OpenRound == nil || ticket.OpenRound.StopRequestedAt == nil || !ticket.OpenRound.StopRequestedAt.Equal(breach.breachedAt) {
		t.Fatalf("Owner's Stop after the breach = %+v, want the breach's Stop unchanged", ticket.OpenRound)
	}
	f.mustRevoke(t, grantID)
	assertOneBreach(t, f, claim, breach)
	var revoked bool
	for _, c := range f.mustCommands(t, claim.RoundId) {
		revoked = revoked || (c.Type == RunnerCommandAuthorityChanged && c.IssuedAt.Equal(f.clock.Now()))
	}
	if !revoked {
		t.Fatal("the revocation issued no authority_changed beside the breach's Stop")
	}
}

func TestLimits_StopConfirmedOnABreachedRoundEndsItFailed(t *testing.T) {
	f := newLimitFixture(t, testMaxActive, 100)
	queued, claim := f.runningRound(t, "Breached")
	f.progress(t, claim, "Partial work")
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, claim.ClaimEpoch, usageData(observationA)))
	f.advance(testMaxActive + 1500*time.Millisecond)
	f.mustHeartbeat(t)
	f.reconnect(t, claim)
	f.progress(t, claim, "Dispatched before the Stop was pulled")

	rec := f.mustConfirmStop(t, claim)
	var result RoundEventResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || result.State != RoundFailed || result.Type != RoundEventStopConfirmed {
		t.Fatalf("stop_confirmed result = %s, want state failed", rec.Body.String())
	}
	explanation := "Technical limit reached: active time 21s exceeded the 20s limit."
	round := f.roundOf(t, queued.Id)
	if round.State != RoundFailed || round.OutcomeNote == nil || *round.OutcomeNote != explanation || round.LimitBreach == nil || round.LimitBreach.Measured != 21 {
		t.Fatalf("Round = %s note %v breach %+v, want failed with %q", round.State, round.OutcomeNote, round.LimitBreach, explanation)
	}
	if round.Usage.Observations != 1 || len(round.Activity) != 2 || round.Activity[1].Note != "Dispatched before the Stop was pulled" {
		t.Fatalf("Round usage %+v activity %+v, want the partial work, both notes and the observation retained", round.Usage, round.Activity)
	}
	ticket := f.ticket(t, queued.Id)
	if ticket.Status != Blocked || len(ticket.Badges) != 0 || ticket.OpenRound != nil {
		t.Fatalf("Ticket = %s badges %+v open %+v, want Blocked with no Stopped Badge and no open Round", ticket.Status, ticket.Badges, ticket.OpenRound)
	}
	if rec := f.claim(t); rec.Code != http.StatusNoContent {
		t.Fatalf("claim after the Failed Round: status=%d body=%s, want 204", rec.Code, rec.Body.String())
	}
	f.changeStatus(t, queued.Id, Ready)
	if next := f.mustClaim(t); next.Ticket.Id != queued.Id {
		t.Fatalf("the Owner's Ready claims %s, want %s", next.Ticket.Id, queued.Id)
	}
}

func TestLimits_StopConfirmedWithoutABreachStillEndsStopped(t *testing.T) {
	f := newLimitFixture(t, testMaxActive, 100)
	queued, claim := f.runningRound(t, "Plain Stop")
	f.mustStop(t, queued.Id)
	rec := f.mustConfirmStop(t, claim)
	var result RoundEventResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || result.State != RoundStopped {
		t.Fatalf("stop_confirmed result = %s, want stopped", rec.Body.String())
	}
	round := f.roundOf(t, queued.Id)
	if round.State != RoundStopped || round.OutcomeNote == nil || *round.OutcomeNote != stopEvidence || round.LimitBreach != nil {
		t.Fatalf("Round = %s %v %+v, want stopped with the runner's evidence", round.State, round.OutcomeNote, round.LimitBreach)
	}
	if ticket := f.ticket(t, queued.Id); ticket.Status != Backlog || len(ticket.Badges) != 1 {
		t.Fatalf("Ticket = %s %+v, want Backlog with the Stopped Badge", ticket.Status, ticket.Badges)
	}
}

func TestLimits_StopConfirmedWhileWaitingAfterABreachEndsFailed(t *testing.T) {
	f := newLimitFixture(t, time.Hour, 1)
	queued, claim := f.runningRound(t, "Waiting")
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	f.mustRequestPermission(t, claim, requestA, writeReport)
	f.mustConfirmStop(t, claim)
	round := f.roundOf(t, queued.Id)
	want := "Technical limit reached: 1 consecutive denied authority checks (limit 1)."
	if round.State != RoundFailed || round.OutcomeNote == nil || *round.OutcomeNote != want {
		t.Fatalf("Round = %s %v, want failed with %q", round.State, round.OutcomeNote, want)
	}
	if ticket := f.ticket(t, queued.Id); ticket.Status != Blocked || len(ticket.Badges) != 0 {
		t.Fatalf("Ticket = %s %+v, want Blocked without a Badge", ticket.Status, ticket.Badges)
	}
}

func TestLimits_LateRunnerEndingsFollowTheLadder(t *testing.T) {
	t.Run("delivered while the Stop is pending", func(t *testing.T) {
		f := newLimitFixture(t, time.Hour, 1)
		queued, claim := f.runningRound(t, "Delivered")
		assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
		f.deliver(t, claim)
		round := f.roundOf(t, queued.Id)
		if round.State != RoundDelivered || round.LimitBreach == nil || f.ticket(t, queued.Id).Status != InReview {
			t.Fatalf("Round = %s %+v, want delivered with its breach still recorded", round.State, round.LimitBreach)
		}
	})
	t.Run("failed while the Stop is pending", func(t *testing.T) {
		f := newLimitFixture(t, time.Hour, 1)
		queued, claim := f.runningRound(t, "Failed")
		assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
		f.mustEndAs(t, blockedEndings[0], claim)
		round := f.roundOf(t, queued.Id)
		if round.State != RoundFailed || round.OutcomeNote == nil || *round.OutcomeNote != failedExplanation || round.LimitBreach == nil {
			t.Fatalf("Round = %s %v %+v, want failed with the runner's explanation", round.State, round.OutcomeNote, round.LimitBreach)
		}
	})
}

func TestLimits_ARunnerThatNeverConfirmsStaysStoppingUntilAttested(t *testing.T) {
	f := newLimitFixture(t, testMaxActive, 100)
	queued, claim := f.runningRound(t, "Never confirms")
	f.advance(testMaxActive)
	f.mustHeartbeat(t)
	breach := breachRows(t, f)
	f.advance(time.Hour)
	if got := f.ticket(t, queued.Id); got.OpenRound == nil || got.OpenRound.StopRequestedAt == nil || got.Status != InProgress {
		t.Fatalf("Ticket = %s %+v, want still Stopping", got.Status, got.OpenRound)
	}
	round := f.mustAttest(t, queued.Id, claim.RoundId)
	if round.State != RoundInterrupted || round.LimitBreach == nil {
		t.Fatalf("attested Round = %s %+v, want interrupted with its breach", round.State, round.LimitBreach)
	}
	if after := breachRows(t, f); len(after) != 1 || after[0] != breach[0] {
		t.Fatalf("breaches after the attestation = %+v, want %+v", after, breach)
	}
}

func TestLimits_ConcurrentEvaluationsRecordOneBreachAndOneStop(t *testing.T) {
	for _, withOwnerStop := range []bool{false, true} {
		t.Run(fmt.Sprintf("Owner Stop racing: %v", withOwnerStop), func(t *testing.T) {
			f := newLimitFixture(t, testMaxActive, 1)
			for i := range 5 {
				queued, claim := f.runningRound(t, fmt.Sprintf("Race %d", i))
				f.advance(testMaxActive)
				var wg sync.WaitGroup
				calls := []func(){
					func() { f.heartbeat(t, f.token, http.StatusOK) },
					func() { f.heartbeat(t, f.token, http.StatusOK) },
					func() {
						f.reportEvent(t, claim.RoundId, progressEvent(t, uuid.NewString(), claim.ClaimEpoch, eventOccurredAt, "racing"))
					},
					func() {
						f.reportEvent(t, claim.RoundId, progressEvent(t, uuid.NewString(), claim.ClaimEpoch, eventOccurredAt, "racing"))
					},
					func() { f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport) },
					func() { f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport) },
				}
				if withOwnerStop {
					calls = append(calls, func() { f.stop(t, queued.Id) }, func() { f.stop(t, queued.Id) })
				}
				for _, call := range calls {
					wg.Go(call)
				}
				wg.Wait()
				if n := stopCommandCount(t, f, claim.RoundId); n != 1 {
					t.Fatalf("race %d: stop commands = %d, want 1", i, n)
				}
				var breaches int
				var sameTransaction bool
				if err := f.pool.QueryRow(context.Background(), `SELECT count(b.id), COALESCE(bool_and(b.xmin = c.xmin), false)
					FROM rounds r LEFT JOIN round_limit_breaches b ON b.round_id = r.id LEFT JOIN round_commands c ON c.round_id = r.id AND c.type = 'stop'
					WHERE r.public_id = $1::uuid`, claim.RoundId).Scan(&breaches, &sameTransaction); err != nil {
					t.Fatal(err)
				}
				switch {
				case !withOwnerStop && breaches != 1:
					t.Fatalf("race %d: breaches = %d, want 1", i, breaches)
				case breaches > 1:
					t.Fatalf("race %d: breaches = %d, want at most 1", i, breaches)
				case breaches == 1 && !sameTransaction:
					t.Fatalf("race %d: the breach was recorded beside a Stop it did not request", i)
				}
				f.mustConfirmStop(t, claim)
				want := RoundStopped
				if breaches == 1 {
					want = RoundFailed
				}
				if round := f.roundOf(t, queued.Id); round.State != want {
					t.Fatalf("race %d: Round = %s, want %s", i, round.State, want)
				}
				f.mustHeartbeat(t)
			}
		})
	}
}

func TestLimits_ADirectAPIBreachIsOwnerScoped(t *testing.T) {
	f := newLimitFixture(t, testMaxActive, 100)
	_, claim := f.runningRound(t, "Mine")
	foreign := f.foreignOwner(t)
	f.advance(testMaxActive)
	foreign.mustHeartbeat(t)
	assertNoBreach(t, f, claim)
	f.mustHeartbeat(t)
	assertOneBreach(t, f, claim, breachRow{kind: "wall_clock", limit: 20, measured: 20, breachedAt: f.clock.Now()})
}
