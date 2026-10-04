package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

func revokePath(grantID string) string {
	return "/api/grants/" + grantID + "/revoke"
}

func (f *claimFixture) revoke(t *testing.T, grantID string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: revokePath(grantID), cookie: f.cookie})
}

func (f *claimFixture) mustRevoke(t *testing.T, grantID string) PermissionGrant {
	t.Helper()
	rec := f.revoke(t, grantID)
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke %s: status=%d body=%s, want 200", grantID, rec.Code, rec.Body.String())
	}
	var grant PermissionGrant
	if err := json.Unmarshal(rec.Body.Bytes(), &grant); err != nil {
		t.Fatal(err)
	}
	return grant
}

func assertApprovalCommands(t *testing.T, commands []RunnerCommand, grantID string) {
	t.Helper()
	if len(commands) != 2 || commands[0].Type != RunnerCommandAuthorityChanged || commands[0].Approval != nil || commands[0].Answer != nil ||
		commands[1].Type != RunnerCommandApproval || commands[1].Approval == nil || commands[1].Approval.GrantId != grantID {
		t.Fatalf("commands = %+v, want authority changed, then one approval naming %s", commands, grantID)
	}
}

func commandTypes(commands []RunnerCommand) []RunnerCommandType {
	types := []RunnerCommandType{}
	for _, command := range commands {
		types = append(types, command.Type)
	}
	return types
}

func (f *claimFixture) ackAll(t *testing.T, roundID string) {
	t.Helper()
	for _, command := range f.mustCommands(t, roundID) {
		decodeAck(t, f.ack(t, roundID, command.Id, RunnerCommandApplied))
	}
}

func commandCount(t *testing.T, f *claimFixture, commandType RunnerCommandType) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM round_commands WHERE type = $1`, string(commandType)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

var grantForms = []struct {
	name  string
	grant func(t *testing.T, f *claimFixture, title string) (Ticket, RunnerClaim, string)
}{
	{"ticket", func(t *testing.T, f *claimFixture, title string) (Ticket, RunnerClaim, string) {
		queued, claim := f.permissionRound(t, title)
		grantID := *f.mustApprove(t, queued.Id, claim.RoundId, requestA).OpenRound.PermissionRequest.GrantId
		f.mustResumeApproval(t, claim, requestA)
		return queued, claim, grantID
	}},
	{"time", func(t *testing.T, f *claimFixture, title string) (Ticket, RunnerClaim, string) {
		return f.timeGrantRound(t, title, writeReport, runnerEpoch.Add(time.Hour))
	}},
	{"full ticket", func(t *testing.T, f *claimFixture, title string) (Ticket, RunnerClaim, string) {
		return f.fullGrantRound(t, title, PermissionGrantFormTicket, time.Time{})
	}},
	{"full time", func(t *testing.T, f *claimFixture, title string) (Ticket, RunnerClaim, string) {
		return f.fullGrantRound(t, title, PermissionGrantFormTime, runnerEpoch.Add(time.Hour))
	}},
}

func TestRevoke_EndsAGrantOfEitherFormAtOnceAndTheNextCheckDenies(t *testing.T) {
	for _, form := range grantForms {
		t.Run(form.name, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim, grantID := form.grant(t, f, "Revoke "+form.name)
			assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)
			revokedAt := runnerEpoch.Add(7 * time.Second)
			f.clock.Set(revokedAt)

			revoked := f.mustRevoke(t, grantID)
			assertExpiredDeny(t, f.mustCheck(t, claim, writeReport), "")
			assertExpiredDeny(t, f.mustCheck(t, claim, writeReport), "")

			if revoked.Id != grantID || revoked.State != PermissionGrantRevoked || revoked.RevokedAt == nil || !revoked.RevokedAt.Equal(revokedAt) ||
				revoked.AllowedActions.Revoke.Available || revoked.AllowedActions.Revoke.Reason == nil || revoked.AllowedActions.Revoke.Reason.Code != grantAlreadyRevokedCode ||
				len(revoked.CoveredOpenRounds) != 0 {
				t.Fatalf("revoked grant = %+v, want revoked at %v with no further revoke", revoked, revokedAt)
			}
			if (revoked.Form == PermissionGrantFormTime) != (revoked.RemainingSeconds != nil && *revoked.RemainingSeconds == 0) {
				t.Fatalf("remainingSeconds = %v, want 0 for a revoked time grant and null for a ticket grant", revoked.RemainingSeconds)
			}
			read := f.ticket(t, queued.Id)
			if len(read.PermissionGrants) != 1 || !reflect.DeepEqual(read.PermissionGrants[0], revoked) {
				t.Fatalf("listed grants = %+v, want the revoked grant as the revoke returned it: %+v", read.PermissionGrants, revoked)
			}
		})
	}
}

func TestRevoke_AClockBehindTheApprovalRecordsTheRevocationAtTheApproval(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, grantID := grantForms[0].grant(t, f, "Clock behind")
	f.clock.Set(runnerEpoch.Add(-time.Hour))

	revoked := f.mustRevoke(t, grantID)
	if revoked.State != PermissionGrantRevoked || revoked.RevokedAt == nil || !revoked.RevokedAt.Equal(revoked.ApprovedAt) {
		t.Fatalf("revoked grant = %+v, want revoked at its approval %v", revoked, revoked.ApprovedAt)
	}
	assertExpiredDeny(t, f.mustCheck(t, claim, writeReport), "")
}

func TestRevoke_ACoveredOpenRoundGetsTheOwnersStopAndEndsOnlyOnStopConfirmed(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, grantID := grantForms[0].grant(t, f, "Covered")
	f.ackAll(t, claim.RoundId)
	revokedAt := runnerEpoch.Add(9 * time.Second)
	f.clock.Set(revokedAt)

	f.mustRevoke(t, grantID)
	rows := roundCommandRows(t, f)
	stop, changed := rows[len(rows)-2], rows[len(rows)-1]
	want := []RunnerCommand{
		{Id: stop.commandID, Type: RunnerCommandStop, ClaimEpoch: claim.ClaimEpoch, IssuedAt: revokedAt},
		{Id: changed.commandID, Type: RunnerCommandAuthorityChanged, ClaimEpoch: claim.ClaimEpoch, IssuedAt: revokedAt},
	}
	if commands := f.mustCommands(t, claim.RoundId); !reflect.DeepEqual(commands, want) {
		t.Fatalf("commands = %+v, want %+v", commands, want)
	}
	ticket := f.ticket(t, queued.Id)
	if ticket.Status != InProgress || ticket.OpenRound == nil || ticket.OpenRound.State != OpenRoundRunning || ticket.OpenRound.StopRequestedAt == nil ||
		!ticket.OpenRound.StopRequestedAt.Equal(revokedAt) || ticket.OpenRound.WaitingReason != WaitingStopping || ticket.AllowedActions.Stop.Available {
		t.Fatalf("Ticket = %s %+v, want the Round still running with Stop requested at %v", ticket.Status, ticket.OpenRound, revokedAt)
	}

	before := len(roundCommandRows(t, f))
	if got := f.mustStop(t, queued.Id); !reflect.DeepEqual(got, f.ticket(t, queued.Id)) || got.OpenRound.StopRequestedAt == nil {
		t.Fatalf("the Owner's Stop after the revoke = %+v, want the Ticket unchanged", got.OpenRound)
	}
	if after := len(roundCommandRows(t, f)); after != before {
		t.Fatalf("round_commands = %d after the Owner's Stop, want %d", after, before)
	}

	f.mustConfirmStop(t, claim)
	ended := f.ticket(t, queued.Id)
	if ended.Status != Backlog || ended.OpenRound != nil || len(ended.Badges) != 1 || ended.Badges[0].Id != stoppedBadgeOf(t, f).Id {
		t.Fatalf("Ticket after stop_confirmed = %s %+v %+v, want Backlog with the Stopped Badge", ended.Status, ended.OpenRound, ended.Badges)
	}
	if round := f.roundOf(t, queued.Id); round.State != RoundStopped {
		t.Fatalf("Round = %s, want stopped", round.State)
	}
}

func TestRevoke_AnActionAllowedBeforeItCompletesAndStaysRecordedAndNoLaterActionIsAllowed(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, grantID := grantForms[1].grant(t, f, "In flight")
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)
	checksBefore := tableJSON(t, f, "round_authority_checks")

	f.mustRevoke(t, grantID)
	performed := "Performed write_note on notes/weekly-report"
	f.mustReport(t, claim.RoundId, progressEvent(t, "performed", claim.ClaimEpoch, eventOccurredAt, performed))
	if got := tableJSON(t, f, "round_authority_checks"); got != checksBefore {
		t.Fatalf("the revoke changed the recorded checks:\nbefore %s\nafter  %s", checksBefore, got)
	}
	assertExpiredDeny(t, f.mustCheck(t, claim, writeReport), "")
	f.mustConfirmStop(t, claim)

	round := f.roundOf(t, queued.Id)
	checks := round.AuthorityChecks
	if len(checks) != 2 || checks[0].Decision != AuthorityAllow || checks[0].GrantId == nil || *checks[0].GrantId != grantID ||
		checks[1].Decision != AuthorityDeny || checks[1].GrantId != nil {
		t.Fatalf("checks = %+v, want the allow by the revoked grant, then a deny", checks)
	}
	var recorded int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM round_activity WHERE note = $1`, performed).Scan(&recorded); err != nil || recorded != 1 {
		t.Fatalf("the performed action's note is recorded %d times (%v), want once", recorded, err)
	}
}

func tableJSON(t *testing.T, f *claimFixture, table string) string {
	t.Helper()
	var rows string
	if err := f.pool.QueryRow(context.Background(), `SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.id), '[]')::text FROM `+table+` x`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

func TestGrantCoversOpenRound_IsItsAgentsOpenRoundsOnItsTicketForTheTicketForm(t *testing.T) {
	pool := postgres.NewTestPool(t)
	type side struct {
		owner, agent, ticket int
	}
	grant := side{1, 10, 100}
	for _, tc := range []struct {
		name  string
		form  string
		round side
		state string
		want  bool
	}{
		{"ticket form, its Agent and Ticket, running", "ticket", grant, "running", true},
		{"ticket form, claimed", "ticket", grant, "claimed", true},
		{"ticket form, waiting for input", "ticket", grant, "waiting_for_input", true},
		{"ticket form, another Ticket", "ticket", side{1, 10, 101}, "running", false},
		{"ticket form, another Agent", "ticket", side{1, 11, 100}, "running", false},
		{"ticket form, another Owner", "ticket", side{2, 10, 100}, "running", false},
		{"ticket form, delivered", "ticket", grant, "delivered", false},
		{"ticket form, stopped", "ticket", grant, "stopped", false},
		{"ticket form, failed", "ticket", grant, "failed", false},
		{"ticket form, interrupted", "ticket", grant, "interrupted", false},
		{"time form, its Ticket", "time", grant, "running", true},
		{"time form, another Ticket", "time", side{1, 10, 101}, "waiting_for_input", true},
		{"time form, another Agent", "time", side{1, 11, 100}, "running", false},
		{"time form, another Owner", "time", side{2, 10, 101}, "running", false},
		{"time form, stopped", "time", side{1, 10, 101}, "stopped", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var covered bool
			if err := pool.QueryRow(context.Background(), `SELECT `+grantCoversOpenRoundSQL+`
				FROM (SELECT $1::bigint AS owner_id, $2::bigint AS agent_id, $3::bigint AS ticket_id, $4::text AS form) g,
				     (SELECT $5::bigint AS owner_id, $6::bigint AS agent_id, $7::bigint AS ticket_id, $8::text AS state) cr`,
				grant.owner, grant.agent, grant.ticket, tc.form, tc.round.owner, tc.round.agent, tc.round.ticket, tc.state).Scan(&covered); err != nil {
				t.Fatal(err)
			}
			if covered != tc.want {
				t.Fatalf("covered = %t, want %t", covered, tc.want)
			}
		})
	}
}

func TestRevoke_StopsOnlyTheOpenRoundsTheGrantCovers(t *testing.T) {
	t.Run("a ticket grant whose Round ended", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim, grantID := grantForms[0].grant(t, f, "Ended")
		f.deliver(t, claim)
		before := tableJSON(t, f, "round_commands")
		ticketBefore := f.ticket(t, queued.Id)
		if g := ticketBefore.PermissionGrants[0]; !g.AllowedActions.Revoke.Available || len(g.CoveredOpenRounds) != 0 {
			t.Fatalf("grant = %+v, want revocable and covering no open Round", g)
		}
		f.mustRevoke(t, grantID)
		if got := tableJSON(t, f, "round_commands"); got != before {
			t.Fatalf("a revoke covering no open Round recorded commands: %s", got)
		}
		if after := f.ticket(t, queued.Id); after.Status != ticketBefore.Status || after.OpenRound != nil {
			t.Fatalf("Ticket = %s %+v, want unchanged", after.Status, after.OpenRound)
		}
	})
	t.Run("a ticket grant beside an open Round of its Agent on another Ticket", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim, grantID := grantForms[0].grant(t, f, "Granted here")
		f.deliver(t, claim)
		other, otherClaim := f.runningRound(t, "Elsewhere")
		before := tableJSON(t, f, "round_commands")
		f.mustRevoke(t, grantID)
		if got := tableJSON(t, f, "round_commands"); got != before {
			t.Fatalf("the revoke touched another Ticket's Round: %s", got)
		}
		if got := f.ticket(t, other.Id); got.OpenRound == nil || got.OpenRound.StopRequestedAt != nil || len(f.mustCommands(t, otherClaim.RoundId)) != 0 {
			t.Fatalf("other Ticket's Round = %+v, want no Stop", got.OpenRound)
		}
	})
	for _, form := range grantForms[1:] {
		if form.name == "full ticket" {
			continue
		}
		t.Run("a "+form.name+" grant covers its Agent's open Round on another Ticket", func(t *testing.T) {
			f := newClaimFixture(t)
			granted, claim, grantID := form.grant(t, f, "Granted here")
			f.deliver(t, claim)
			other, otherClaim := f.runningRound(t, "Elsewhere")
			listed := f.ticket(t, granted.Id).PermissionGrants[0]
			wantCovered := []PermissionGrantCoveredRound{{RoundId: otherClaim.RoundId, Sequence: 1, TicketId: other.Id, TicketTitle: "Elsewhere"}}
			if !reflect.DeepEqual(listed.CoveredOpenRounds, wantCovered) {
				t.Fatalf("coveredOpenRounds = %+v, want %+v", listed.CoveredOpenRounds, wantCovered)
			}
			f.mustRevoke(t, grantID)
			if got := commandTypes(f.mustCommands(t, otherClaim.RoundId)); !reflect.DeepEqual(got, []RunnerCommandType{RunnerCommandStop, RunnerCommandAuthorityChanged}) {
				t.Fatalf("other Round's commands = %v, want Stop then authority changed", got)
			}
			if got := f.ticket(t, other.Id); got.OpenRound == nil || got.OpenRound.StopRequestedAt == nil {
				t.Fatalf("other Ticket = %+v, want Stopping", got.OpenRound)
			}
		})
	}
	t.Run("a time grant beside an open Round of another Agent", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim, grantID := grantForms[1].grant(t, f, "Granted here")
		f.deliver(t, claim)
		writer := createAgentForTest(t, f.handler, f.cookie, "Writer", AgentKindResearch)
		queued := queueTicketAs(t, f.handler, f.cookie, writer, "Another Agent")
		otherClaim := f.mustClaim(t)
		if otherClaim.Ticket.Id != queued.Id {
			t.Fatalf("claim = %+v, want %s", otherClaim, queued.Id)
		}
		before := tableJSON(t, f, "round_commands")
		f.mustRevoke(t, grantID)
		if got := tableJSON(t, f, "round_commands"); got != before {
			t.Fatalf("the revoke touched another Agent's Round: %s", got)
		}
	})
}

func TestRevoke_ARepeatReturnsTheRevokedGrantAndRecordsNothing(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, grantID := grantForms[1].grant(t, f, "Twice")
	first := f.revoke(t, grantID)
	before := databaseSnapshot(t, f.pool)
	f.clock.Set(runnerEpoch.Add(time.Minute))
	second := f.revoke(t, grantID)
	if first.Code != http.StatusOK || second.Code != http.StatusOK || second.Body.String() != first.Body.String() {
		t.Fatalf("revoke twice: %d %s / %d %s, want the same 200", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, before, "a repeated revoke")
	f.mustConfirmStop(t, claim)
	before = databaseSnapshot(t, f.pool)
	if third := f.revoke(t, grantID); third.Code != http.StatusOK || third.Body.String() != first.Body.String() {
		t.Fatalf("revoke after the Round ended: %d %s", third.Code, third.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, before, "a revoke repeated after the Round ended")
}

func TestRevoke_UnknownMalformedAndForeignGrantsAreTheSameNotFoundAndUnauthenticatedIs401(t *testing.T) {
	f := newClaimFixture(t)
	_, _, mine := grantForms[0].grant(t, f, "Mine")
	foreign := f.foreignOwner(t)
	_, _, theirs := grantForms[1].grant(t, foreign, "Theirs")
	before := databaseSnapshot(t, f.pool)
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"unknown":          f.revoke(t, uuid.NewString()),
		"malformed":        f.revoke(t, "grant-1"),
		"another Owner's":  f.revoke(t, theirs),
		"mine, by another": foreign.revoke(t, mine),
	} {
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), grantNotFoundMessage) {
			t.Fatalf("%s: status=%d body=%s, want the shared 404", name, rec.Code, rec.Body.String())
		}
	}
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: revokePath(mine)}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: revokePath(mine), token: f.token}))
	assertSnapshotUnchanged(t, f.pool, before, "refused revokes")
}

func TestRevoke_AnExpiredGrantIsRefusedChangingNothingAndAdvertisedSo(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, grantID := grantForms[1].grant(t, f, "Expired")
	f.clock.Set(runnerEpoch.Add(time.Hour))
	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.revoke(t, grantID), http.StatusBadRequest, grantExpiredCode, grantExpiredMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a revoke of an expired grant")
	g := f.ticket(t, queued.Id).PermissionGrants[0]
	if g.State != PermissionGrantExpired || g.AllowedActions.Revoke.Available || g.AllowedActions.Revoke.Reason == nil ||
		g.AllowedActions.Revoke.Reason.Code != grantExpiredCode || len(g.CoveredOpenRounds) != 0 {
		t.Fatalf("grant = %+v, want expired and not revocable", g)
	}
	if commands := f.mustCommands(t, claim.RoundId); len(commands) != 2 {
		t.Fatalf("commands = %v, want only the approval's", commandTypes(commands))
	}
}

func TestRevoke_ARevokedTimeGrantIsNeverExpiredNamedForRenewalOrRenewed(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, grantID := grantForms[1].grant(t, f, "Revoked then past expiry")
	f.mustRevoke(t, grantID)
	f.mustConfirmStop(t, claim)
	f.clock.Set(runnerEpoch.Add(2 * time.Hour))
	f.heartbeat(t, f.token, http.StatusOK)

	g := f.ticket(t, queued.Id).PermissionGrants[0]
	if g.State != PermissionGrantRevoked || g.RemainingSeconds == nil || *g.RemainingSeconds != 0 || g.AllowedActions.Revoke.Reason == nil ||
		g.AllowedActions.Revoke.Reason.Code != grantAlreadyRevokedCode {
		t.Fatalf("grant past its expiry = %+v, want still revoked, never expired", g)
	}
	_, next := f.runningRound(t, "Next")
	assertExpiredDeny(t, f.mustCheck(t, next, writeReport), "")
	before := databaseSnapshot(t, f.pool)
	assertErrorCode(t, f.requestRenewal(t, next, requestB, writeReport, grantID), invalidRenewalCode)
	assertSnapshotUnchanged(t, f.pool, before, "a renewal naming a revoked grant")
}

func TestRevoke_ConcurrentRevokesRecordOneRevocationOneStopAndOneAuthorityChange(t *testing.T) {
	for trial := range 4 {
		f := newClaimFixture(t)
		_, claim, grantID := grantForms[trial%len(grantForms)].grant(t, f, fmt.Sprintf("Race %d", trial))
		f.ackAll(t, claim.RoundId)
		codes, bodies := sendConcurrently(6, func(int) *httptest.ResponseRecorder { return f.revoke(t, grantID) })
		for i, code := range codes {
			if code != http.StatusOK || bodies[i] != bodies[0] {
				t.Fatalf("trial %d response %d: %d %s, want the same 200 as %s", trial, i, code, bodies[i], bodies[0])
			}
		}
		if got := commandTypes(f.mustCommands(t, claim.RoundId)); !reflect.DeepEqual(got, []RunnerCommandType{RunnerCommandStop, RunnerCommandAuthorityChanged}) {
			t.Fatalf("trial %d: commands = %v, want one Stop and one authority change", trial, got)
		}
	}
}

func TestRevoke_RacingTheOwnersStopRecordsOneStop(t *testing.T) {
	for trial := range 6 {
		f := newClaimFixture(t)
		queued, claim, grantID := grantForms[trial%len(grantForms)].grant(t, f, fmt.Sprintf("Race %d", trial))
		codes, bodies := sendConcurrently(2, func(i int) *httptest.ResponseRecorder {
			if i == 0 {
				return f.stop(t, queued.Id)
			}
			return f.revoke(t, grantID)
		})
		if codes[0] != http.StatusOK || codes[1] != http.StatusOK {
			t.Fatalf("trial %d: stop %d %s; revoke %d %s", trial, codes[0], bodies[0], codes[1], bodies[1])
		}
		if stops, changes := commandCount(t, f, RunnerCommandStop), commandCount(t, f, RunnerCommandAuthorityChanged); stops != 1 || changes != 2 {
			t.Fatalf("trial %d: %d Stops and %d authority changes, want one Stop and the approval's and the revoke's changes", trial, stops, changes)
		}
		if commands := f.mustCommands(t, claim.RoundId); commands[0].Type != RunnerCommandStop {
			t.Fatalf("trial %d: commands = %v, want the Stop first", trial, commandTypes(commands))
		}
		f.mustConfirmStop(t, claim)
	}
}

func TestRevoke_RacingAnApprovalOnTheCoveredRoundLeavesTheStopFirstOrRefusesTheApproval(t *testing.T) {
	outcomes := map[string]int{}
	for trial := range 6 {
		f := newClaimFixture(t)
		queued, claim, grantID := f.timeGrantRound(t, fmt.Sprintf("Race %d", trial), readReport, runnerEpoch.Add(time.Hour))
		f.ackAll(t, claim.RoundId)
		f.mustRequestPermission(t, claim, requestB, writeReport)
		codes, bodies := sendConcurrently(2, func(i int) *httptest.ResponseRecorder {
			if i == 0 {
				return f.revoke(t, grantID)
			}
			return f.approve(t, queued.Id, claim.RoundId, requestB)
		})
		if codes[0] != http.StatusOK {
			t.Fatalf("trial %d: revoke %d %s", trial, codes[0], bodies[0])
		}
		got := commandTypes(f.mustCommands(t, claim.RoundId))
		switch {
		case codes[1] == http.StatusOK && reflect.DeepEqual(got, []RunnerCommandType{RunnerCommandStop, RunnerCommandAuthorityChanged, RunnerCommandAuthorityChanged, RunnerCommandApproval}):
			outcomes["approved first"]++
		case codes[1] == http.StatusBadRequest && strings.Contains(bodies[1], stopAlreadyRequestedCode) &&
			reflect.DeepEqual(got, []RunnerCommandType{RunnerCommandStop, RunnerCommandAuthorityChanged}):
			outcomes["revoked first"]++
			if p := f.ticket(t, queued.Id).OpenRound.PermissionRequest; p == nil || p.Id != requestB || p.Decision != nil {
				t.Fatalf("trial %d: request = %+v, want left undecided", trial, p)
			}
		default:
			t.Fatalf("trial %d: approve %d %s, commands %v", trial, codes[1], bodies[1], got)
		}
		f.mustConfirmStop(t, claim)
		if ended := f.ticket(t, queued.Id); ended.Status != Backlog {
			t.Fatalf("trial %d: Ticket after the Stop = %s", trial, ended.Status)
		}
	}
	t.Logf("%v", outcomes)
}

func TestAuthorityCheck_QueuedBehindARevokeDenies(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, grantID := grantForms[0].grant(t, f, "Check behind revoke")
	ctx := context.Background()
	revoking, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = revoking.Rollback(ctx) }()
	if _, err := revoking.Exec(ctx, `UPDATE permission_grants SET state = 'revoked', revoked_at = approved_at WHERE public_id = $1::uuid`, grantID); err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport) }()
	waitForLockWaiter(t, f.pool, "FOR SHARE")
	if err := revoking.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	rec := <-result
	var got AuthorityCheckResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("check: %d %s", rec.Code, rec.Body.String())
	}
	assertDecision(t, got, AuthorityDeny, "")
}

func TestRevoke_WaitsForACheckThatHoldsTheGrant(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, grantID := grantForms[0].grant(t, f, "Revoke behind check")
	ctx := context.Background()
	checking, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = checking.Rollback(ctx) }()
	if _, err := checking.Exec(ctx, `SELECT 1 FROM permission_grants WHERE public_id = $1::uuid FOR SHARE`, grantID); err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- f.revoke(t, grantID) }()
	waitForLockWaiter(t, f.pool, "FOR NO KEY UPDATE")
	select {
	case rec := <-result:
		t.Fatalf("the revoke finished while a check held the grant: %d %s", rec.Code, rec.Body.String())
	default:
	}
	if err := checking.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if rec := <-result; rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body.String())
	}
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
}

func TestRevoke_RacingChecksNeverDeadlocksAndEveryLaterCheckDenies(t *testing.T) {
	for trial := range 4 {
		f := newClaimFixture(t)
		_, claim, grantID := grantForms[trial%len(grantForms)].grant(t, f, fmt.Sprintf("Race %d", trial))
		codes, bodies := sendConcurrently(9, func(i int) *httptest.ResponseRecorder {
			if i == 4 {
				return f.revoke(t, grantID)
			}
			return f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport)
		})
		for i, code := range codes {
			if code != http.StatusOK {
				t.Fatalf("trial %d response %d: %d %s", trial, i, code, bodies[i])
			}
		}
		assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
		var allowedAfter int
		if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM round_authority_checks c JOIN permission_grants g ON g.id = c.grant_id
			WHERE c.id > (SELECT min(id) FROM round_authority_checks WHERE decision = 'deny')`).Scan(&allowedAfter); err != nil || allowedAfter != 0 {
			t.Fatalf("trial %d: %d allows recorded after the first deny (%v)", trial, allowedAfter, err)
		}
	}
}

func TestRevoke_TakesThePriorityLockAndTheTicketRowBeforeTheGrantRow(t *testing.T) {
	f := newClaimFixture(t)
	queued, _, grantID := grantForms[0].grant(t, f, "Lock order")
	ctx := context.Background()
	holder, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if _, err := holder.Exec(ctx, `SELECT 1 FROM permission_grants WHERE public_id = $1::uuid FOR UPDATE`, grantID); err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- f.revoke(t, grantID) }()
	waitForLockWaiter(t, f.pool, "FOR NO KEY UPDATE")
	probe, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = probe.Exec(ctx, `SELECT 1 FROM tickets WHERE public_id = $1::uuid FOR UPDATE NOWAIT`, queued.Id)
	_ = probe.Rollback(ctx)
	if err == nil {
		t.Fatal("the revoke waits for the grant row without holding the Ticket row")
	}
	var ownerID int64
	if err := f.pool.QueryRow(ctx, `SELECT owner_id FROM permission_grants WHERE public_id = $1::uuid`, grantID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	var free bool
	if err := f.pool.QueryRow(ctx, `SELECT pg_try_advisory_lock($1, $2)`, ownerPriorityLockNamespace, int32(uint32(ownerID))).Scan(&free); err != nil || free {
		t.Fatalf("the revoke waits for the grant row without holding the Owner's priority lock (%v)", err)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if rec := <-result; rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s, want 200 once the lock is released", rec.Code, rec.Body.String())
	}
}

func TestRoundCommands_DeliverStopThenAuthorityChangesThenTheRestInIssuedOrder(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Order")
	approvedAt := runnerEpoch.Add(time.Second)
	f.clock.Set(approvedAt)
	grantID := *f.mustApprove(t, queued.Id, claim.RoundId, requestA).OpenRound.PermissionRequest.GrantId
	revokedAt := runnerEpoch.Add(2 * time.Second)
	f.clock.Set(revokedAt)
	f.mustRevoke(t, grantID)

	commands := f.mustCommands(t, claim.RoundId)
	type entry struct {
		commandType RunnerCommandType
		issuedAt    time.Time
	}
	got := []entry{}
	for _, command := range commands {
		got = append(got, entry{command.Type, command.IssuedAt})
	}
	want := []entry{{RunnerCommandStop, revokedAt}, {RunnerCommandAuthorityChanged, approvedAt}, {RunnerCommandAuthorityChanged, revokedAt}, {RunnerCommandApproval, approvedAt}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("commands = %+v, want %+v", got, want)
	}
	if p := f.ticket(t, queued.Id).OpenRound.PermissionRequest; p.Decision == nil || *p.Decision != PermissionApproved {
		t.Fatalf("request = %+v, want the approval kept", p)
	}
	f.mustConfirmStop(t, claim)
}

func TestAuthorityChanged_IsDeliveredAndAcknowledgedWhateverTheClaimEpoch(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, grantID := grantForms[0].grant(t, f, "Epoch")
	f.ackAll(t, claim.RoundId)
	f.mustRevoke(t, grantID)
	if _, err := f.pool.Exec(context.Background(), `UPDATE rounds SET claim_epoch = claim_epoch + 1 WHERE public_id = $1::uuid`, claim.RoundId); err != nil {
		t.Fatal(err)
	}
	commands := f.mustCommands(t, claim.RoundId)
	if len(commands) != 2 || commands[1].Type != RunnerCommandAuthorityChanged || commands[1].ClaimEpoch != claim.ClaimEpoch {
		t.Fatalf("commands = %+v, want the authority change still delivered at epoch %d", commands, claim.ClaimEpoch)
	}
	first := decodeAck(t, f.ack(t, claim.RoundId, commands[1].Id, RunnerCommandApplied))
	if replay := decodeAck(t, f.ack(t, claim.RoundId, commands[1].Id, RunnerCommandApplied)); !reflect.DeepEqual(replay, first) {
		t.Fatalf("a repeated ack = %+v, want %+v", replay, first)
	}
	if got := commandTypes(f.mustCommands(t, claim.RoundId)); !reflect.DeepEqual(got, []RunnerCommandType{RunnerCommandStop}) {
		t.Fatalf("commands after the ack = %v, want only the Stop", got)
	}
}

func TestAuthorityChanged_ExpiryIssuesNoCommandBecauseEveryCheckReadsTheClock(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, grantID := grantForms[1].grant(t, f, "Expiry")
	f.ackAll(t, claim.RoundId)
	before := tableJSON(t, f, "round_commands")
	f.clock.Set(runnerEpoch.Add(time.Hour))
	assertExpiredDeny(t, f.mustCheck(t, claim, writeReport), grantID)
	if got := tableJSON(t, f, "round_commands"); got != before || len(f.mustCommands(t, claim.RoundId)) != 0 {
		t.Fatalf("expiry recorded commands: %s", got)
	}
}

func TestRevoke_TheDatabaseKeepsRevokedAtWithTheRevokedStateAndTheNewCommandType(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, grantID := grantForms[0].grant(t, f, "Constraints")
	ctx := context.Background()
	set := func(state string, revokedAt string) error {
		_, err := f.pool.Exec(ctx, `UPDATE permission_grants SET state = $2, revoked_at = `+revokedAt+` WHERE public_id = $1::uuid`, grantID, state)
		return err
	}
	assertViolates(t, set("revoked", "NULL"), "permission_grants_revoked_at_follows_state")
	assertViolates(t, set("active", "approved_at"), "permission_grants_revoked_at_follows_state")
	assertViolates(t, set("revoked", "approved_at - interval '1 second'"), "permission_grants_revoked_after_approval")
	assertViolates(t, set("expired", "NULL"), "permission_grants_state")
	if err := set("revoked", "approved_at"); err != nil {
		t.Fatal(err)
	}
	insert := func(commandType string) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO round_commands (owner_id, round_id, public_id, type, claim_epoch, issued_at)
			SELECT owner_id, id, $2::uuid, $3, claim_epoch, now() FROM rounds WHERE public_id = $1::uuid`, claim.RoundId, uuid.NewString(), commandType)
		return err
	}
	assertViolates(t, insert("revoke"), "round_commands_type_m5")
	if err := insert("authority_changed"); err != nil {
		t.Fatal(err)
	}
	if err := insert("authority_changed"); err != nil {
		t.Fatalf("a second authority change for the Round: %v", err)
	}
}
