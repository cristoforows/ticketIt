package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

const requestC = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"

var readReport = permissionScope{account: controlledAccount, action: "read_note", resource: "notes/weekly-report"}

func timeApprovalBody(t *testing.T, expiresAt time.Time) string {
	t.Helper()
	return jsonText(t, map[string]any{"form": "time", "expiresAt": expiresAt.Format(time.RFC3339Nano)})
}

func (f *claimFixture) approveWith(t *testing.T, ticketID, roundID, requestID, body string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: permissionPath(ticketID, roundID, requestID, "approve"), body: body, cookie: f.cookie})
}

func (f *claimFixture) mustApproveTime(t *testing.T, ticketID, roundID, requestID string, expiresAt time.Time) (Ticket, string) {
	t.Helper()
	rec := f.approveWith(t, ticketID, roundID, requestID, timeApprovalBody(t, expiresAt))
	if rec.Code != http.StatusOK {
		t.Fatalf("approve for a time: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	ticket := decodeTicketBody(t, rec)
	return ticket, *ticket.OpenRound.PermissionRequest.GrantId
}

// timeGrantRound leaves a running Round of a new Ticket holding a time grant for scope that expires at expiresAt.
func (f *claimFixture) timeGrantRound(t *testing.T, title string, scope permissionScope, expiresAt time.Time) (Ticket, RunnerClaim, string) {
	t.Helper()
	queued, claim := f.runningRound(t, title)
	f.mustRequestPermission(t, claim, requestA, scope)
	_, grantID := f.mustApproveTime(t, queued.Id, claim.RoundId, requestA, expiresAt)
	f.mustResumeApproval(t, claim, requestA)
	return queued, claim, grantID
}

func renewalEvent(t *testing.T, epoch int, requestID string, scope permissionScope, renewsGrantID any) string {
	t.Helper()
	return jsonText(t, map[string]any{"type": "permission_requested", "idempotencyKey": requestID, "claimEpoch": epoch, "occurredAt": eventOccurredAt,
		"data": map[string]any{"requestId": requestID, "account": scope.account, "action": scope.action, "resource": scope.resource, "renewsGrantId": renewsGrantID}})
}

func (f *claimFixture) requestRenewal(t *testing.T, claim RunnerClaim, requestID string, scope permissionScope, renewsGrantID any) *httptest.ResponseRecorder {
	t.Helper()
	return f.reportEvent(t, claim.RoundId, renewalEvent(t, claim.ClaimEpoch, requestID, scope, renewsGrantID))
}

func assertExpiredDeny(t *testing.T, got AuthorityCheckResult, expiredGrantID string) {
	t.Helper()
	assertDecision(t, got, AuthorityDeny, "")
	if (got.ExpiredGrantId == nil) != (expiredGrantID == "") || (got.ExpiredGrantId != nil && *got.ExpiredGrantId != expiredGrantID) {
		t.Fatalf("deny names expired grant %v, want %q", got.ExpiredGrantId, expiredGrantID)
	}
}

func grantRow(t *testing.T, f *claimFixture, grantID string) string {
	t.Helper()
	var row string
	if err := f.pool.QueryRow(context.Background(), `SELECT row_to_json(g)::text FROM permission_grants g WHERE public_id = $1::uuid`, grantID).Scan(&row); err != nil {
		t.Fatal(err)
	}
	return row
}

func grantOf(t *testing.T, grants []PermissionGrant, id string) PermissionGrant {
	t.Helper()
	for _, g := range grants {
		if g.Id == id {
			return g
		}
	}
	t.Fatalf("grant %s is not listed in %+v", id, grants)
	return PermissionGrant{}
}

func TestDecideGrantForm_IsTicketOrTimeNeverBoth(t *testing.T) {
	at := runnerEpoch.Add(time.Hour)
	ticket, timeForm := PermissionGrantFormTicket, PermissionGrantFormTime
	for _, tc := range []struct {
		name      string
		req       ApprovePermissionRequest
		wantCode  string
		wantForm  PermissionGrantForm
		wantUntil *time.Time
	}{
		{"ticket", ApprovePermissionRequest{Form: ticket}, "", ticket, nil},
		{"ticket with an expiry", ApprovePermissionRequest{Form: ticket, ExpiresAt: &at}, grantFormConflictCode, "", nil},
		{"time with an expiry", ApprovePermissionRequest{Form: timeForm, ExpiresAt: &at}, "", timeForm, &at},
		{"time without an expiry", ApprovePermissionRequest{Form: timeForm}, "invalid_request", "", nil},
		{"another form", ApprovePermissionRequest{Form: "full"}, "invalid_request", "", nil},
		{"another form with an expiry", ApprovePermissionRequest{Form: "full", ExpiresAt: &at}, "invalid_request", "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			terms, rejection := decideGrantForm(tc.req)
			switch {
			case tc.wantCode != "" && (rejection == nil || rejection.code != tc.wantCode):
				t.Fatalf("rejection = %+v, want %s", rejection, tc.wantCode)
			case tc.wantCode == "" && rejection != nil:
				t.Fatalf("rejection = %+v, want none", rejection)
			case terms.form != tc.wantForm || (terms.expiresAt == nil) != (tc.wantUntil == nil) || (terms.expiresAt != nil && !terms.expiresAt.Equal(*tc.wantUntil)):
				t.Fatalf("terms = %+v, want %s until %v", terms, tc.wantForm, tc.wantUntil)
			}
		})
	}
	nanos := at.Add(1999 * time.Nanosecond).In(time.FixedZone("UTC+8", 8*3600))
	terms, _ := decideGrantForm(ApprovePermissionRequest{Form: timeForm, ExpiresAt: &nanos})
	if want := at.Add(time.Microsecond); !terms.expiresAt.Equal(want) || terms.expiresAt.Location() != time.UTC {
		t.Fatalf("expiresAt = %v, want %v in UTC, truncated to the microsecond PostgreSQL stores", terms.expiresAt, want)
	}
}

func TestDecideGrantExpiry_IsAfterTheApprovalAndAtMostThirtyDaysLater(t *testing.T) {
	approvedAt := runnerEpoch
	for _, tc := range []struct {
		name     string
		until    time.Time
		wantCode string
	}{
		{"one microsecond later", approvedAt.Add(time.Microsecond), ""},
		{"thirty days later", approvedAt.Add(30 * 24 * time.Hour), ""},
		{"the approval instant", approvedAt, invalidGrantExpiryCode},
		{"before the approval", approvedAt.Add(-time.Second), invalidGrantExpiryCode},
		{"just over thirty days later", approvedAt.Add(30*24*time.Hour + time.Microsecond), invalidGrantExpiryCode},
	} {
		t.Run(tc.name, func(t *testing.T) {
			until := tc.until
			rejection := decideGrantExpiry(grantTerms{form: PermissionGrantFormTime, expiresAt: &until}, approvedAt)
			if (rejection == nil) != (tc.wantCode == "") || (rejection != nil && rejection.code != tc.wantCode) {
				t.Fatalf("rejection = %+v, want %q", rejection, tc.wantCode)
			}
		})
	}
	if rejection := decideGrantExpiry(grantTerms{form: PermissionGrantFormTicket}, approvedAt); rejection != nil {
		t.Fatalf("a ticket grant was refused for its expiry: %+v", rejection)
	}
}

func TestNormalisePermissionGrants_DerivesExpiryAndRemainingTimeFromGalleysClock(t *testing.T) {
	now := runnerEpoch
	at := func(d time.Duration) *time.Time { u := now.Add(d).In(time.FixedZone("UTC+8", 8*3600)); return &u }
	grants := []PermissionGrant{
		{Form: PermissionGrantFormTicket, State: PermissionGrantActive},
		{Form: PermissionGrantFormTime, State: PermissionGrantActive, ExpiresAt: at(90 * time.Second)},
		{Form: PermissionGrantFormTime, State: PermissionGrantActive, ExpiresAt: at(time.Microsecond)},
		{Form: PermissionGrantFormTime, State: PermissionGrantActive, ExpiresAt: at(0)},
		{Form: PermissionGrantFormTime, State: PermissionGrantActive, ExpiresAt: at(-time.Hour)},
	}
	normalisePermissionGrants(grants, now)
	want := []struct {
		state     PermissionGrantState
		remaining *int
	}{{PermissionGrantActive, nil}, {PermissionGrantActive, new(90)}, {PermissionGrantActive, new(1)}, {PermissionGrantExpired, new(0)}, {PermissionGrantExpired, new(0)}}
	for i, g := range grants {
		if g.State != want[i].state || (g.RemainingSeconds == nil) != (want[i].remaining == nil) || (g.RemainingSeconds != nil && *g.RemainingSeconds != *want[i].remaining) {
			t.Fatalf("grant %d = %s with %v seconds, want %s with %v", i, g.State, g.RemainingSeconds, want[i].state, want[i].remaining)
		}
		if g.ExpiresAt != nil && g.ExpiresAt.Location() != time.UTC {
			t.Fatalf("grant %d expiresAt %v is not UTC", i, g.ExpiresAt)
		}
	}
}

func TestApprove_TheTimeFormRecordsAnExpiringGrantForTheAgentAndScope(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Time grant")
	approvedAt := runnerEpoch.Add(5 * time.Second)
	f.clock.Set(approvedAt)
	until := approvedAt.Add(2 * time.Hour)
	ticket, grantID := f.mustApproveTime(t, queued.Id, claim.RoundId, requestA, until.In(time.FixedZone("UTC-5", -5*3600)))
	assertPermissionWait(t, ticket, claim, WaitingResuming, decisionOf(PermissionApproved))
	if ticket.PermissionGrantCount != 1 || len(ticket.PermissionGrants) != 1 {
		t.Fatalf("grants = %d listed of %d, want 1", len(ticket.PermissionGrants), ticket.PermissionGrantCount)
	}
	g := ticket.PermissionGrants[0]
	if g.Id != grantID || g.Form != PermissionGrantFormTime || g.State != PermissionGrantActive || g.ExpiresAt == nil || !g.ExpiresAt.Equal(until) ||
		g.ExpiresAt.Location() != time.UTC || g.RemainingSeconds == nil || *g.RemainingSeconds != 7200 || !g.ApprovedAt.Equal(approvedAt) ||
		g.Agent.Id != f.agent.Id || g.Account != writeReport.account || g.Action != writeReport.action || g.Resource != writeReport.resource || g.RoundId != claim.RoundId {
		t.Fatalf("grant = %+v, want a time grant for the Agent and scope until %v with 7200 s left", g, until)
	}
	commands := f.mustCommands(t, claim.RoundId)
	if len(commands) != 1 || commands[0].Type != RunnerCommandApproval || commands[0].Approval == nil || commands[0].Approval.GrantId != grantID {
		t.Fatalf("commands = %+v, want one approval naming %s", commands, grantID)
	}
}

func TestApprove_RefusesBothFormsAndAnExpiryOutsideTheWindowChangingNothing(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Refused forms")
	now := runnerEpoch.Add(time.Minute)
	f.clock.Set(now)
	before := databaseSnapshot(t, f.pool)
	for _, tc := range []struct {
		name, body, code string
	}{
		{"the ticket form with a future expiry", jsonText(t, map[string]any{"form": "ticket", "expiresAt": now.Add(time.Hour).Format(time.RFC3339)}), grantFormConflictCode},
		{"the ticket form with a past expiry", jsonText(t, map[string]any{"form": "ticket", "expiresAt": now.Add(-time.Hour).Format(time.RFC3339)}), grantFormConflictCode},
		{"the time form without an expiry", `{"form":"time"}`, "invalid_request"},
		{"an expiry at Galley's now", timeApprovalBody(t, now), invalidGrantExpiryCode},
		{"an expiry a second ago", timeApprovalBody(t, now.Add(-time.Second)), invalidGrantExpiryCode},
		{"an expiry past the browser's idea of now but not Galley's", timeApprovalBody(t, now.Add(-time.Microsecond)), invalidGrantExpiryCode},
		{"an expiry one microsecond past thirty days", timeApprovalBody(t, now.Add(timeGrantMaxDuration+time.Microsecond)), invalidGrantExpiryCode},
		{"an expiry a year away", timeApprovalBody(t, now.AddDate(1, 0, 0)), invalidGrantExpiryCode},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertErrorCode(t, f.approveWith(t, queued.Id, claim.RoundId, requestA, tc.body), tc.code)
		})
	}
	assertSnapshotUnchanged(t, f.pool, before, "refused grant forms")
	if open := f.ticket(t, queued.Id).OpenRound; open.PermissionRequest.Decision != nil || !f.ticket(t, queued.Id).AllowedActions.PermissionDecision.Available {
		t.Fatalf("the request is no longer open for a decision: %+v", open.PermissionRequest)
	}

	t.Run("exactly thirty days is accepted", func(t *testing.T) {
		_, grantID := f.mustApproveTime(t, queued.Id, claim.RoundId, requestA, now.Add(timeGrantMaxDuration))
		if g := grantOf(t, f.ticket(t, queued.Id).PermissionGrants, grantID); !g.ExpiresAt.Equal(now.Add(timeGrantMaxDuration)) {
			t.Fatalf("expiresAt = %v", g.ExpiresAt)
		}
	})
}

func TestApprove_AClockBehindTheRequestJudgesTheExpiryFromTheRequestTime(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Clock stepped back")
	requestedAt := f.ticket(t, queued.Id).OpenRound.PermissionRequest.RequestedAt
	f.clock.Set(requestedAt.Add(-time.Hour))
	assertErrorCode(t, f.approveWith(t, queued.Id, claim.RoundId, requestA, timeApprovalBody(t, requestedAt.Add(-time.Minute))), invalidGrantExpiryCode)
	ticket, grantID := f.mustApproveTime(t, queued.Id, claim.RoundId, requestA, requestedAt.Add(time.Minute))
	if decided := ticket.OpenRound.PermissionRequest.DecidedAt; decided == nil || !decided.Equal(requestedAt) {
		t.Fatalf("decidedAt = %v, want the request time %v", decided, requestedAt)
	}
	if g := grantOf(t, ticket.PermissionGrants, grantID); !g.ApprovedAt.Equal(requestedAt) {
		t.Fatalf("approvedAt = %v, want the request time %v", g.ApprovedAt, requestedAt)
	}
}

func TestApprove_AnExpiryForAnUnknownRequestIsStillTheSharedNotFound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Unknown")
	rec := f.approveWith(t, queued.Id, claim.RoundId, requestB, timeApprovalBody(t, runnerEpoch.Add(-time.Hour)))
	assertErrorBody(t, rec, http.StatusNotFound, "not_found", permissionRequestNotFoundMessage)
}

func TestAuthorityCheck_ATimeGrantAuthorizesItsAgentAndScopeOnEveryTicketUntilExpiry(t *testing.T) {
	f := newClaimFixture(t)
	until := runnerEpoch.Add(time.Hour)
	origin, first, timeGrant := f.timeGrantRound(t, "Origin", writeReport, until)
	assertDecision(t, f.mustCheck(t, first, writeReport), AuthorityAllow, timeGrant)

	f.mustRequestPermission(t, first, requestB, readReport)
	ticketGrant := *f.mustApprove(t, origin.Id, first.RoundId, requestB).OpenRound.PermissionRequest.GrantId
	f.mustResumeApproval(t, first, requestB)
	assertDecision(t, f.mustCheck(t, first, readReport), AuthorityAllow, ticketGrant)
	f.deliver(t, first)

	other, second := f.runningRound(t, "Another Ticket")
	for _, tc := range []struct {
		name  string
		scope permissionScope
		want  AuthorityDecision
		grant string
	}{
		{"the time grant's scope", writeReport, AuthorityAllow, timeGrant},
		{"the ticket grant's scope on another Ticket", readReport, AuthorityDeny, ""},
		{"another resource", permissionScope{controlledAccount, writeReport.action, "notes/weekly"}, AuthorityDeny, ""},
		{"a longer resource", permissionScope{controlledAccount, writeReport.action, writeReport.resource + "s"}, AuthorityDeny, ""},
		{"another action", permissionScope{controlledAccount, "post_message", "channels/weekly-report"}, AuthorityDeny, ""},
	} {
		t.Run(tc.name, func(t *testing.T) { assertDecision(t, f.mustCheck(t, second, tc.scope), tc.want, tc.grant) })
	}
	shown := f.ticket(t, other.Id)
	if shown.PermissionGrantCount != 1 || len(shown.PermissionGrants) != 1 || shown.PermissionGrants[0].Id != timeGrant {
		t.Fatalf("another Ticket of the Agent lists %+v, want only the time grant", shown.PermissionGrants)
	}
	f.deliver(t, second)

	t.Run("another Agent", func(t *testing.T) {
		writer := createAgentForTest(t, f.handler, f.cookie, "Writer", AgentKindResearch)
		theirs := queueTicketAs(t, f.handler, f.cookie, writer, "The writer's Ticket")
		claim := f.mustClaim(t)
		if claim.Ticket.Id != theirs.Id {
			t.Fatalf("claimed %s, want %s", claim.Ticket.Id, theirs.Id)
		}
		f.startRound(t, claim, claim.RoundId+":start")
		assertExpiredDeny(t, f.mustCheck(t, claim, writeReport), "")
		if shown := f.ticket(t, theirs.Id); shown.PermissionGrantCount != 0 {
			t.Fatalf("another Agent's Ticket lists %+v", shown.PermissionGrants)
		}
		f.deliver(t, claim)
	})

	t.Run("another Owner", func(t *testing.T) {
		foreignCookie, _ := secondOwnerSession(t, f.pool)
		foreign := &claimFixture{runnerFixture: f.runnerFixture}
		foreign.cookie = foreignCookie
		foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Researcher", AgentKindResearch)
		foreign.token = foreign.pair(t).Token
		foreign.register(t, foreign.token, http.StatusOK)
		_, theirs := foreign.runningRound(t, "Theirs")
		assertExpiredDeny(t, foreign.mustCheck(t, theirs, writeReport), "")
	})

	t.Run("after expiry, on every Ticket", func(t *testing.T) {
		f.mustRework(t, other.Id)
		again := f.mustClaim(t)
		f.startRound(t, again, again.RoundId+":start")
		f.clock.Set(until)
		assertExpiredDeny(t, f.mustCheck(t, again, writeReport), timeGrant)
	})
}

func TestAuthorityCheck_ATimeGrantExpiresAtItsInstantByGalleysClockBetweenTwoChecks(t *testing.T) {
	f := newClaimFixture(t)
	until := runnerEpoch.Add(10 * time.Minute)
	queued, claim, grantID := f.timeGrantRound(t, "Expiring", writeReport, until)

	f.clock.Set(until.Add(-time.Microsecond))
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)
	f.clock.Set(until)
	assertExpiredDeny(t, f.mustCheck(t, claim, writeReport), grantID)
	f.clock.Set(until.Add(time.Hour))
	assertExpiredDeny(t, f.mustCheck(t, claim, writeReport), grantID)

	round := f.roundOf(t, queued.Id)
	checks := round.AuthorityChecks
	if len(checks) != 3 {
		t.Fatalf("checks = %+v, want the three after the approval", checks)
	}
	for i, want := range []struct {
		at      time.Time
		allow   bool
		expired bool
	}{{until.Add(-time.Microsecond), true, false}, {until, false, true}, {until.Add(time.Hour), false, true}} {
		c := checks[i]
		if !c.CheckedAt.Equal(want.at) || (c.Decision == AuthorityAllow) != want.allow || (c.ExpiredGrantId != nil) != want.expired ||
			(c.ExpiredGrantId != nil && *c.ExpiredGrantId != grantID) {
			t.Fatalf("check %d = %+v, want at %v allow=%t naming the expired grant=%t", i, c, want.at, want.allow, want.expired)
		}
	}
	g := grantOf(t, f.ticket(t, queued.Id).PermissionGrants, grantID)
	if g.State != PermissionGrantExpired || *g.RemainingSeconds != 0 || !g.ExpiresAt.Equal(until) {
		t.Fatalf("grant = %+v, want it listed as expired at %v", g, until)
	}
	var state string
	if err := f.pool.QueryRow(context.Background(), `SELECT state FROM permission_grants WHERE public_id = $1::uuid`, grantID).Scan(&state); err != nil || state != "active" {
		t.Fatalf("stored state = %q (%v): expiry is derived at read time, never written", state, err)
	}
}

func TestAuthorityCheck_ATimeGrantSurvivesItsOriginatingTicketReachingDone(t *testing.T) {
	f := newClaimFixture(t)
	origin, first, grantID := f.timeGrantRound(t, "Origin", writeReport, runnerEpoch.Add(time.Hour))
	f.deliver(t, first)
	if done := f.mustAccept(t, origin.Id); done.Status != Done {
		t.Fatalf("Ticket = %s, want Done", done.Status)
	}
	_, next := f.runningRound(t, "Next")
	assertDecision(t, f.mustCheck(t, next, writeReport), AuthorityAllow, grantID)
	if g := grantOf(t, f.ticket(t, origin.Id).PermissionGrants, grantID); g.State != PermissionGrantActive {
		t.Fatalf("the Done Ticket lists %+v, want the grant still active", g)
	}
}

func TestRenewal_NamesTheExpiredGrantAndItsApprovalCreatesANewGrantLeavingTheOldRowUnchanged(t *testing.T) {
	for _, form := range []PermissionGrantForm{PermissionGrantFormTime, PermissionGrantFormTicket} {
		t.Run(string(form), func(t *testing.T) {
			f := newClaimFixture(t)
			until := runnerEpoch.Add(time.Minute)
			queued, claim, expired := f.timeGrantRound(t, "Renew", writeReport, until)
			f.clock.Set(until.Add(time.Second))
			assertExpiredDeny(t, f.mustCheck(t, claim, writeReport), expired)
			oldRow := grantRow(t, f, expired)

			rec := f.requestRenewal(t, claim, requestB, writeReport, expired)
			if rec.Code != http.StatusCreated {
				t.Fatalf("renewal: status=%d body=%s", rec.Code, rec.Body.String())
			}
			waiting := f.ticket(t, queued.Id)
			if p := waiting.OpenRound.PermissionRequest; p == nil || p.Id != requestB || p.RenewsGrantId == nil || *p.RenewsGrantId != expired {
				t.Fatalf("the waiting request = %+v, want %s renewing %s", p, requestB, expired)
			}
			body := `{"form":"ticket"}`
			renewedUntil := until.Add(time.Hour)
			if form == PermissionGrantFormTime {
				body = timeApprovalBody(t, renewedUntil)
			}
			rec = f.approveWith(t, queued.Id, claim.RoundId, requestB, body)
			if rec.Code != http.StatusOK {
				t.Fatalf("approve renewal: status=%d body=%s", rec.Code, rec.Body.String())
			}
			renewed := *decodeTicketBody(t, rec).OpenRound.PermissionRequest.GrantId
			if renewed == expired {
				t.Fatal("the renewal reused the expired grant")
			}
			f.mustResumeApproval(t, claim, requestB)
			assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, renewed)
			if after := grantRow(t, f, expired); after != oldRow {
				t.Fatalf("the expired grant changed:\nbefore %s\nafter  %s", oldRow, after)
			}
			ticket := f.ticket(t, queued.Id)
			if old, fresh := grantOf(t, ticket.PermissionGrants, expired), grantOf(t, ticket.PermissionGrants, renewed); old.State != PermissionGrantExpired ||
				fresh.State != PermissionGrantActive || fresh.Form != form || ticket.PermissionGrantCount != 2 {
				t.Fatalf("grants = %+v, want the expired one and a new active %s grant", ticket.PermissionGrants, form)
			}
			requests := f.roundOf(t, queued.Id).PermissionRequests
			if len(requests) != 2 || requests[0].RenewsGrantId != nil || requests[1].RenewsGrantId == nil || *requests[1].RenewsGrantId != expired {
				t.Fatalf("requests = %+v, want the first plain and the second renewing %s", requests, expired)
			}
		})
	}
}

func TestRenewal_OnlyAnExpiredTimeGrantOfTheRoundsAgentForTheSameScopeCanBeNamed(t *testing.T) {
	f := newClaimFixture(t)
	until := runnerEpoch.Add(time.Minute)
	origin, first, expiredWrite := f.timeGrantRound(t, "Origin", writeReport, until)
	f.mustRequestPermission(t, first, requestB, readReport)
	_, expiredRead := f.mustApproveTime(t, origin.Id, first.RoundId, requestB, until)
	f.mustResumeApproval(t, first, requestB)
	f.mustRequestPermission(t, first, requestC, permissionScope{controlledAccount, "post_message", "channels/general"})
	ticketGrant := *f.mustApprove(t, origin.Id, first.RoundId, requestC).OpenRound.PermissionRequest.GrantId
	f.mustResumeApproval(t, first, requestC)
	f.deliver(t, first)

	writer := createAgentForTest(t, f.handler, f.cookie, "Writer", AgentKindResearch)
	writersTicket := queueTicketAs(t, f.handler, f.cookie, writer, "Writer's")
	theirClaim := f.mustClaim(t)
	f.startRound(t, theirClaim, theirClaim.RoundId+":start")
	f.mustRequestPermission(t, theirClaim, requestA, writeReport)
	_, writersGrant := f.mustApproveTime(t, writersTicket.Id, theirClaim.RoundId, requestA, until)
	f.mustResumeApproval(t, theirClaim, requestA)
	f.deliver(t, theirClaim)

	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Researcher", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	_, _, foreignGrant := foreign.timeGrantRound(t, "Theirs", writeReport, until)

	_, claim := f.runningRound(t, "Renewing")
	f.mustRequestPermission(t, claim, uuid.NewString(), permissionScope{controlledAccount, "write_note", "notes/live"})
	liveGrant := ""
	{
		ticket := f.ticket(t, claim.Ticket.Id)
		_, liveGrant = f.mustApproveTime(t, ticket.Id, claim.RoundId, ticket.OpenRound.PermissionRequest.Id, until.Add(time.Hour))
		f.mustResumeApproval(t, claim, ticket.OpenRound.PermissionRequest.Id)
	}
	f.clock.Set(until)

	before := databaseSnapshot(t, f.pool)
	for _, tc := range []struct {
		name  string
		scope permissionScope
		grant string
	}{
		{"an unknown grant", writeReport, uuid.NewString()},
		{"the expired grant for another scope", writeReport, expiredRead},
		{"a ticket grant", permissionScope{controlledAccount, "post_message", "channels/general"}, ticketGrant},
		{"a time grant that has not expired", permissionScope{controlledAccount, "write_note", "notes/live"}, liveGrant},
		{"another Agent's expired grant for the scope", writeReport, writersGrant},
		{"another Owner's expired grant for the scope", writeReport, foreignGrant},
		{"the right grant under another scope", readReport, expiredWrite},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertErrorBody(t, f.requestRenewal(t, claim, requestB, tc.scope, tc.grant), http.StatusBadRequest, invalidRenewalCode, invalidRenewalMessage)
		})
	}
	for name, value := range map[string]any{
		"a null grant":       nil,
		"an uppercase grant": strings.ToUpper(expiredWrite),
		"the nil UUID":       uuid.Nil.String(),
		"not a UUID":         "grant-1",
		"a number":           7,
	} {
		t.Run(name, func(t *testing.T) { assertInvalidRequest(t, f.requestRenewal(t, claim, requestB, writeReport, value)) })
	}
	assertSnapshotUnchanged(t, f.pool, before, "renewals naming a grant that cannot be renewed")

	if rec := f.requestRenewal(t, claim, requestB, writeReport, expiredWrite); rec.Code != http.StatusCreated {
		t.Fatalf("a renewal of the expired grant: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := f.requestRenewal(t, claim, requestB, writeReport, expiredWrite); rec.Code != http.StatusOK {
		t.Fatalf("its replay: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
}

func TestRenewal_TheDatabaseTiesTheRenewedGrantToTheRequestsAgentAndScope(t *testing.T) {
	f := newClaimFixture(t)
	until := runnerEpoch.Add(time.Minute)
	_, first, expired := f.timeGrantRound(t, "Origin", writeReport, until)
	f.deliver(t, first)
	_, claim := f.runningRound(t, "Renewing")
	f.mustRequestPermission(t, claim, requestB, readReport)
	ctx := context.Background()
	assertViolates(t, func() error {
		_, err := f.pool.Exec(ctx, `UPDATE permission_requests SET renews_grant_id = (SELECT id FROM permission_grants WHERE public_id = $1::uuid) WHERE request_id = $2::uuid`, expired, requestB)
		return err
	}(), "permission_requests_renews_grant_fk")
}

func TestTimeGrants_TheDatabaseKeepsOneFormAndTheExpiryWindow(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.permissionRound(t, "Constraints")
	ctx := context.Background()
	var requestRowID int64
	if err := f.pool.QueryRow(ctx, `SELECT id FROM permission_requests WHERE request_id = $1::uuid`, requestA).Scan(&requestRowID); err != nil {
		t.Fatal(err)
	}
	insertGrant := func(form, expiresAt string) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO permission_grants (owner_id, public_id, ticket_id, agent_id, request_id, account, action, resource, form, state, created_at, approved_at, expires_at)
			SELECT owner_id, gen_random_uuid(), ticket_id, agent_id, id, account, action, resource, $2, 'active', '2026-10-01T12:00:00Z', '2026-10-01T12:00:00Z', `+expiresAt+` FROM permission_requests WHERE id = $1`,
			requestRowID, form)
		return err
	}
	for _, tc := range []struct{ name, form, expiresAt, constraint string }{
		{"a time grant without an expiry", "time", "NULL", "permission_grants_expiry_follows_form"},
		{"a ticket grant with an expiry", "ticket", "'2026-10-01T13:00:00Z'", "permission_grants_expiry_follows_form"},
		{"an expiry at the approval", "time", "'2026-10-01T12:00:00Z'", "permission_grants_expiry_window"},
		{"an expiry before the approval", "time", "'2026-10-01T11:00:00Z'", "permission_grants_expiry_window"},
		{"an expiry past thirty days", "time", "'2026-10-31T12:00:00.000001Z'", "permission_grants_expiry_window"},
	} {
		t.Run(tc.name, func(t *testing.T) { assertViolates(t, insertGrant(tc.form, tc.expiresAt), tc.constraint) })
	}
	if err := insertGrant("time", "'2026-10-31T12:00:00Z'"); err != nil {
		t.Fatalf("a thirty-day time grant: %v", err)
	}
	ownerID, roundID := roundRowIDs(t, f, claim.RoundId)
	_, err := f.pool.Exec(ctx, `INSERT INTO round_authority_checks (owner_id, round_id, account, action, resource, claim_epoch, decision, grant_id, expired_grant_id, checked_at)
		SELECT $1, $2, account, action, resource, 1, 'allow', id, id, now() FROM permission_grants WHERE request_id = $3`, ownerID, roundID, requestRowID)
	assertViolates(t, err, "round_authority_checks_expired_grant_on_deny")
}

func TestApprove_ConcurrentTimeApprovalsRecordExactlyOneGrant(t *testing.T) {
	for trial := range 4 {
		f := newClaimFixture(t)
		queued, claim := f.permissionRound(t, fmt.Sprintf("Race %d", trial))
		codes, bodies := sendConcurrently(6, func(i int) *httptest.ResponseRecorder {
			if i%2 == 0 {
				return f.approveWith(t, queued.Id, claim.RoundId, requestA, timeApprovalBody(t, runnerEpoch.Add(time.Duration(i+1)*time.Hour)))
			}
			return f.approve(t, queued.Id, claim.RoundId, requestA)
		})
		winners := 0
		for i, code := range codes {
			switch {
			case code == http.StatusOK:
				winners++
			case code == http.StatusBadRequest && strings.Contains(bodies[i], permissionAlreadyDecidedCode):
			default:
				t.Fatalf("trial %d response %d: status=%d body=%s", trial, i, code, bodies[i])
			}
		}
		if grants := tableRowCount(t, f.pool, "permission_grants"); winners != 1 || grants != 1 || len(f.mustCommands(t, claim.RoundId)) != 1 {
			t.Fatalf("trial %d: %d winners, %d grants", trial, winners, grants)
		}
	}
}

func TestApprove_ATimeApprovalRacingStopLeavesNoGrantOrBothCommands(t *testing.T) {
	outcomes := map[string]int{}
	for trial := range 6 {
		f := newClaimFixture(t)
		queued, claim := f.permissionRound(t, fmt.Sprintf("Race %d", trial))
		codes, bodies := sendConcurrently(3, func(i int) *httptest.ResponseRecorder {
			switch i {
			case 0:
				return f.stop(t, queued.Id)
			case 1:
				return f.approveWith(t, queued.Id, claim.RoundId, requestA, timeApprovalBody(t, runnerEpoch.Add(time.Hour)))
			}
			return f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport)
		})
		if codes[0] != http.StatusOK || codes[2] != http.StatusConflict || !strings.Contains(bodies[2], roundNotRunningCode) {
			t.Fatalf("trial %d: stop %d %s; check %d %s", trial, codes[0], bodies[0], codes[2], bodies[2])
		}
		commands, grants := f.mustCommands(t, claim.RoundId), tableRowCount(t, f.pool, "permission_grants")
		switch {
		case codes[1] == http.StatusOK && len(commands) == 2 && grants == 1:
			outcomes["approved first"]++
		case codes[1] == http.StatusBadRequest && strings.Contains(bodies[1], stopAlreadyRequestedCode) && len(commands) == 1 && grants == 0:
			outcomes["stopped first"]++
		default:
			t.Fatalf("trial %d: approve %d %s, commands %+v, grants %d", trial, codes[1], bodies[1], commands, grants)
		}
		if n := tableRowCount(t, f.pool, "round_authority_checks"); n != 0 {
			t.Fatalf("trial %d: a check of a waiting Round was recorded", trial)
		}
	}
	t.Logf("%v", outcomes)
}

func TestTicket_ListsTheGrantsThatApplyToItNewestFiftyWithTheirCount(t *testing.T) {
	f := newClaimFixture(t)
	until := runnerEpoch.Add(time.Hour)
	origin, first, timeGrant := f.timeGrantRound(t, "Origin", writeReport, until)
	f.mustRequestPermission(t, first, requestB, readReport)
	ticketGrant := *f.mustApprove(t, origin.Id, first.RoundId, requestB).OpenRound.PermissionRequest.GrantId
	f.mustResumeApproval(t, first, requestB)
	f.deliver(t, first)

	writer := createAgentForTest(t, f.handler, f.cookie, "Writer", AgentKindResearch)
	theirs := queueTicketAs(t, f.handler, f.cookie, writer, "Writer's")
	theirClaim := f.mustClaim(t)
	f.startRound(t, theirClaim, theirClaim.RoundId+":start")
	f.mustRequestPermission(t, theirClaim, requestA, writeReport)
	_, writersGrant := f.mustApproveTime(t, theirs.Id, theirClaim.RoundId, requestA, until)
	f.mustResumeApproval(t, theirClaim, requestA)
	f.deliver(t, theirClaim)
	sibling := f.queue(t, "Sibling")

	for _, tc := range []struct {
		name, ticketID string
		want           []string
	}{
		{"the originating Ticket", origin.Id, []string{timeGrant, ticketGrant}},
		{"another Ticket of the same Agent", sibling.Id, []string{timeGrant}},
		{"the other Agent's Ticket", theirs.Id, []string{writersGrant}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ticket := f.ticket(t, tc.ticketID)
			var got []string
			for _, g := range ticket.PermissionGrants {
				got = append(got, g.Id)
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") || ticket.PermissionGrantCount != len(tc.want) {
				t.Fatalf("grants = %v (count %d), want %v", got, ticket.PermissionGrantCount, tc.want)
			}
		})
	}
	listed := false
	list, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodGet, "/api/tickets", "", http.StatusOK)
	for _, ticket := range decodeAs[TicketList](t, list).Tickets {
		if ticket.Id == sibling.Id {
			listed = len(ticket.PermissionGrants) == 1 && ticket.PermissionGrants[0].Id == timeGrant
		}
	}
	if !listed {
		t.Fatal("the Ticket list does not show the sibling's time grant")
	}

	ctx := context.Background()
	var requestRowID int64
	if err := f.pool.QueryRow(ctx, `SELECT id FROM permission_requests WHERE request_id = $1::uuid AND round_id = (SELECT id FROM rounds WHERE public_id = $2::uuid)`, requestA, first.RoundId).Scan(&requestRowID); err != nil {
		t.Fatal(err)
	}
	extra := permissionGrantsShown + 2
	for i := range extra {
		if _, err := f.pool.Exec(ctx, `WITH r AS (INSERT INTO permission_requests (owner_id, ticket_id, agent_id, round_id, request_id, account, action, resource, requested_at, decision, decided_at)
				SELECT owner_id, ticket_id, agent_id, round_id, gen_random_uuid(), account, action, $2, requested_at, 'approved', requested_at FROM permission_requests WHERE id = $1 RETURNING *)
			INSERT INTO permission_grants (owner_id, public_id, ticket_id, agent_id, request_id, account, action, resource, form, state, created_at, approved_at, expires_at)
			SELECT owner_id, gen_random_uuid(), ticket_id, agent_id, id, account, action, resource, 'time', 'active', decided_at, decided_at, decided_at + interval '1 day' FROM r`,
			requestRowID, fmt.Sprintf("notes/extra-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	ticket := f.ticket(t, sibling.Id)
	if ticket.PermissionGrantCount != extra+1 || len(ticket.PermissionGrants) != permissionGrantsShown ||
		ticket.PermissionGrants[0].Resource != fmt.Sprintf("notes/extra-%d", extra-permissionGrantsShown) || ticket.PermissionGrants[permissionGrantsShown-1].Resource != fmt.Sprintf("notes/extra-%d", extra-1) {
		t.Fatalf("listed %d of %d from %s to %s, want the newest %d of %d, oldest first", len(ticket.PermissionGrants), ticket.PermissionGrantCount,
			ticket.PermissionGrants[0].Resource, ticket.PermissionGrants[len(ticket.PermissionGrants)-1].Resource, permissionGrantsShown, extra+1)
	}
}
