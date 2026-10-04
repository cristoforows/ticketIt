package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

var postGeneral = permissionScope{account: controlledAccount, action: "post_message", resource: "channels/general"}

// Every scope the controlled account declares that the test Rounds never request.
var otherDeclaredScopes = []permissionScope{
	readReport,
	{controlledAccount, "write_note", "notes/other"},
	{controlledAccount, "read_note", "notes/a"},
	postGeneral,
	{controlledAccount, "post_message", "channels/release-notes"},
}

var undeclaredScopes = map[string]permissionScope{
	"an undeclared action":                      {controlledAccount, "delete_note", writeReport.resource},
	"a note action on a channel":                {controlledAccount, "read_note", "channels/general"},
	"a message action on a note":                {controlledAccount, "post_message", writeReport.resource},
	"a wildcard resource":                       {controlledAccount, "write_note", "notes/*"},
	"a prefix resource":                         {controlledAccount, "write_note", "notes/"},
	"a path below a resource":                   {controlledAccount, "write_note", writeReport.resource + "/draft"},
	"an uppercase resource":                     {controlledAccount, "write_note", "notes/Weekly-report"},
	"an account differing by case":              {"Controlled", "write_note", writeReport.resource},
	"an account Galley does not know":           {"github", "push", "repo"},
	"an undeclared action named like a pattern": {controlledAccount, "notes/weekly-report", writeReport.resource},
}

func fullApprovalBody(t *testing.T, form PermissionGrantForm, expiresAt time.Time) string {
	t.Helper()
	body := map[string]any{"form": form, "scope": "full"}
	if form == PermissionGrantFormTime {
		body["expiresAt"] = expiresAt.Format(time.RFC3339Nano)
	}
	return jsonText(t, body)
}

func (f *claimFixture) mustApproveWith(t *testing.T, ticketID, roundID, requestID, body string) (Ticket, string) {
	t.Helper()
	rec := f.approveWith(t, ticketID, roundID, requestID, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("approve %s: status=%d body=%s, want 200", body, rec.Code, rec.Body.String())
	}
	ticket := decodeTicketBody(t, rec)
	return ticket, *ticket.OpenRound.PermissionRequest.GrantId
}

// fullGrantRound leaves a running Round of a new Ticket whose request for writeReport was approved with full access.
func (f *claimFixture) fullGrantRound(t *testing.T, title string, form PermissionGrantForm, expiresAt time.Time) (Ticket, RunnerClaim, string) {
	t.Helper()
	queued, claim := f.permissionRound(t, title)
	_, grantID := f.mustApproveWith(t, queued.Id, claim.RoundId, requestA, fullApprovalBody(t, form, expiresAt))
	f.mustResumeApproval(t, claim, requestA)
	return queued, claim, grantID
}

func (f *claimFixture) foreignOwner(t *testing.T) *claimFixture {
	t.Helper()
	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Researcher", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	return foreign
}

func TestDecideGrantTerms_FullAccessOnlyWhenTheOwnerNamesIt(t *testing.T) {
	at := runnerEpoch.Add(time.Hour)
	scope := func(s PermissionGrantScope) *PermissionGrantScope { return &s }
	for _, tc := range []struct {
		name     string
		req      ApprovePermissionRequest
		wantCode string
		wantFull bool
	}{
		{"ticket with no scope", ApprovePermissionRequest{Form: PermissionGrantFormTicket}, "", false},
		{"time with no scope", ApprovePermissionRequest{Form: PermissionGrantFormTime, ExpiresAt: &at}, "", false},
		{"ticket with the requested scope", ApprovePermissionRequest{Form: PermissionGrantFormTicket, Scope: scope(PermissionGrantScopeRequested)}, "", false},
		{"ticket with full access", ApprovePermissionRequest{Form: PermissionGrantFormTicket, Scope: scope(PermissionGrantScopeFull)}, "", true},
		{"time with full access", ApprovePermissionRequest{Form: PermissionGrantFormTime, ExpiresAt: &at, Scope: scope(PermissionGrantScopeFull)}, "", true},
		{"an unknown scope", ApprovePermissionRequest{Form: PermissionGrantFormTicket, Scope: scope("all")}, "invalid_request", false},
		{"an uppercase scope", ApprovePermissionRequest{Form: PermissionGrantFormTicket, Scope: scope("FULL")}, "invalid_request", false},
		{"an empty scope", ApprovePermissionRequest{Form: PermissionGrantFormTicket, Scope: scope("")}, "invalid_request", false},
		{"full access with a form conflict", ApprovePermissionRequest{Form: PermissionGrantFormTicket, ExpiresAt: &at, Scope: scope(PermissionGrantScopeFull)}, grantFormConflictCode, false},
		{"full access with no form", ApprovePermissionRequest{Scope: scope(PermissionGrantScopeFull)}, "invalid_request", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			terms, rejection := decideGrantTerms(tc.req)
			switch {
			case tc.wantCode != "" && (rejection == nil || rejection.code != tc.wantCode):
				t.Fatalf("rejection = %+v, want %s", rejection, tc.wantCode)
			case tc.wantCode == "" && rejection != nil:
				t.Fatalf("rejection = %+v, want none", rejection)
			case terms.fullAccess != tc.wantFull:
				t.Fatalf("fullAccess = %t, want %t", terms.fullAccess, tc.wantFull)
			}
		})
	}
}

func TestApprove_TheFullScopeRecordsAFullAccessGrantForTheRequestsAgentAndAccount(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Full access")
	approved := runnerEpoch.Add(3 * time.Second)
	f.clock.Set(approved)
	ticket, grantID := f.mustApproveWith(t, queued.Id, claim.RoundId, requestA, fullApprovalBody(t, PermissionGrantFormTicket, time.Time{}))
	assertPermissionWait(t, ticket, claim, WaitingResuming, decisionOf(PermissionApproved))
	if len(ticket.PermissionGrants) != 1 || ticket.PermissionGrantCount != 1 {
		t.Fatalf("grants = %+v, want one", ticket.PermissionGrants)
	}
	g := ticket.PermissionGrants[0]
	if g.Id != grantID || !g.Full || g.Action != nil || g.Resource != nil || g.Account != controlledAccount || !g.SubstituteAccount ||
		g.Agent.Id != f.agent.Id || g.Form != PermissionGrantFormTicket || g.State != PermissionGrantActive || g.ExpiresAt != nil ||
		g.RemainingSeconds != nil || g.RoundId != claim.RoundId || !g.ApprovedAt.Equal(approved) {
		t.Fatalf("grant = %+v, want full access to %s for the Agent on this Ticket", g, controlledAccount)
	}
	assertApprovalCommands(t, f.mustCommands(t, claim.RoundId), grantID)
	var full bool
	var action, resource *string
	if err := f.pool.QueryRow(context.Background(), `SELECT full_access, action, resource FROM permission_grants WHERE public_id = $1::uuid`, grantID).Scan(&full, &action, &resource); err != nil {
		t.Fatal(err)
	}
	if !full || action != nil || resource != nil {
		t.Fatalf("row full_access=%t action=%v resource=%v, want a full grant with no scope", full, action, resource)
	}
	if !reflect.DeepEqual(f.ticket(t, queued.Id), ticket) {
		t.Fatalf("the approval's response differs from a read of the Ticket")
	}
}

func TestApprove_ABodyWithoutTheFullScopeGrantsOnlyTheRequestedScope(t *testing.T) {
	until := runnerEpoch.Add(time.Hour)
	for name, body := range map[string]string{
		"ticket, no scope":        `{"form":"ticket"}`,
		"ticket, requested scope": `{"form":"ticket","scope":"requested"}`,
		"time, no scope":          jsonText(t, map[string]any{"form": "time", "expiresAt": until.Format(time.RFC3339)}),
		"time, requested scope":   jsonText(t, map[string]any{"form": "time", "expiresAt": until.Format(time.RFC3339), "scope": "requested"}),
	} {
		t.Run(name, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.permissionRound(t, "Requested")
			ticket, grantID := f.mustApproveWith(t, queued.Id, claim.RoundId, requestA, body)
			g := grantOf(t, ticket.PermissionGrants, grantID)
			if g.Full || g.Action == nil || *g.Action != writeReport.action || g.Resource == nil || *g.Resource != writeReport.resource {
				t.Fatalf("grant = %+v, want the requested scope only", g)
			}
			f.mustResumeApproval(t, claim, requestA)
			assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)
			for _, scope := range otherDeclaredScopes {
				assertExpiredDeny(t, f.mustCheck(t, claim, scope), "")
			}
		})
	}
}

func TestApprove_TheScopeIsDecodedStrictly(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Strict scope")
	before := databaseSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"a null scope":         `{"form":"ticket","scope":null}`,
		"an uppercase scope":   `{"form":"ticket","scope":"FULL"}`,
		"another scope":        `{"form":"ticket","scope":"all"}`,
		"a boolean scope":      `{"form":"ticket","scope":true}`,
		"the decision's shape": `{"form":"ticket","full":true}`,
		"no form":              `{"scope":"full"}`,
		"full as a form":       `{"form":"full"}`,
	} {
		t.Run(name, func(t *testing.T) {
			assertInvalidRequest(t, f.approveWith(t, queued.Id, claim.RoundId, requestA, body))
		})
	}
	assertErrorCode(t, f.approveWith(t, queued.Id, claim.RoundId, requestA, `{"form":"ticket","scope":"full","expiresAt":"2026-10-01T13:00:00Z"}`), grantFormConflictCode)
	assertSnapshotUnchanged(t, f.pool, before, "malformed full-access approvals")
}

func TestAuthorityCheck_AFullGrantAllowsEveryDeclaredScopeWithoutAnotherRequest(t *testing.T) {
	for _, form := range []PermissionGrantForm{PermissionGrantFormTicket, PermissionGrantFormTime} {
		t.Run(string(form), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim, grantID := f.fullGrantRound(t, "Several actions", form, runnerEpoch.Add(time.Hour))
			for _, scope := range append([]permissionScope{writeReport}, otherDeclaredScopes...) {
				assertDecision(t, f.mustCheck(t, claim, scope), AuthorityAllow, grantID)
			}
			if n := tableRowCount(t, f.pool, "permission_requests"); n != 1 {
				t.Fatalf("%d Permission requests, want only the first", n)
			}
			round := f.roundOf(t, queued.Id)
			if round.State != RoundRunning || round.AuthorityCheckCount != 1+len(otherDeclaredScopes) {
				t.Fatalf("Round = %s with %d checks", round.State, round.AuthorityCheckCount)
			}
			for _, check := range round.AuthorityChecks {
				if check.Decision != AuthorityAllow || check.GrantId == nil || *check.GrantId != grantID {
					t.Fatalf("recorded check %+v, want an allow naming %s", check, grantID)
				}
			}
		})
	}
}

func TestAuthorityCheck_AFullGrantNeverAllowsAnUndeclaredScopeAndNothingIsRecorded(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, _ := f.fullGrantRound(t, "Undeclared", PermissionGrantFormTicket, time.Time{})
	before := databaseSnapshot(t, f.pool)
	for name, scope := range undeclaredScopes {
		t.Run(name, func(t *testing.T) {
			assertErrorCode(t, f.check(t, claim.RoundId, claim.ClaimEpoch, scope), capabilityNotSupportedCode)
			assertErrorCode(t, f.requestPermission(t, claim, requestB, scope), capabilityNotSupportedCode)
		})
	}
	assertSnapshotUnchanged(t, f.pool, before, "undeclared scopes under full access")
	if got := f.ticket(t, queued.Id); got.OpenRound == nil || got.OpenRound.State != OpenRoundRunning {
		t.Fatalf("the Round is %+v, want it still running", got.OpenRound)
	}
}

func TestAuthorityCheck_ATicketFullGrantIsBoundToItsAgentTicketAndOwner(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, grantID := f.fullGrantRound(t, "Bound", PermissionGrantFormTicket, time.Time{})
	assertDecision(t, f.mustCheck(t, claim, readReport), AuthorityAllow, grantID)
	f.deliver(t, claim)

	t.Run("a later Round of the same Ticket", func(t *testing.T) {
		f.mustRework(t, queued.Id)
		again := f.mustClaim(t)
		f.startRound(t, again, again.RoundId+":start")
		assertDecision(t, f.mustCheck(t, again, postGeneral), AuthorityAllow, grantID)
		f.deliver(t, again)
	})
	t.Run("another Ticket of the same Agent", func(t *testing.T) {
		_, other := f.runningRound(t, "Another Ticket")
		for _, scope := range append([]permissionScope{writeReport}, otherDeclaredScopes...) {
			assertExpiredDeny(t, f.mustCheck(t, other, scope), "")
		}
		f.deliver(t, other)
	})
	t.Run("the same Ticket reassigned to another Agent", func(t *testing.T) {
		writer := createAgentForTest(t, f.handler, f.cookie, "Writer", AgentKindResearch)
		f.mustRework(t, queued.Id)
		f.changeStatus(t, queued.Id, Backlog)
		if rec := f.do(t, runnerCall{method: http.MethodPut, path: "/api/tickets/" + queued.Id + "/assignee", body: assignAgentBody(writer.Id), cookie: f.cookie}); rec.Code != http.StatusOK {
			t.Fatalf("reassign: status=%d body=%s", rec.Code, rec.Body.String())
		}
		f.changeStatus(t, queued.Id, Ready)
		reassigned := f.mustClaim(t)
		f.startRound(t, reassigned, reassigned.RoundId+":start")
		assertExpiredDeny(t, f.mustCheck(t, reassigned, readReport), "")
		f.deliver(t, reassigned)
	})
	t.Run("another Owner", func(t *testing.T) {
		foreign := f.foreignOwner(t)
		_, theirs := foreign.runningRound(t, "Theirs")
		assertExpiredDeny(t, foreign.mustCheck(t, theirs, readReport), "")
	})
}

func TestAuthorityCheck_ATimeFullGrantCoversItsAgentOnEveryTicketUntilItsExpiry(t *testing.T) {
	f := newClaimFixture(t)
	until := runnerEpoch.Add(time.Hour)
	_, first, grantID := f.fullGrantRound(t, "Origin", PermissionGrantFormTime, until)
	f.deliver(t, first)

	writer := createAgentForTest(t, f.handler, f.cookie, "Writer", AgentKindResearch)
	queueTicketAs(t, f.handler, f.cookie, writer, "The writer's Ticket")
	theirs := f.mustClaim(t)
	f.startRound(t, theirs, theirs.RoundId+":start")
	for _, scope := range otherDeclaredScopes {
		assertExpiredDeny(t, f.mustCheck(t, theirs, scope), "")
	}
	f.deliver(t, theirs)

	other, second := f.runningRound(t, "Another Ticket")
	f.clock.Set(until.Add(-time.Microsecond))
	f.reconnect(t, second)
	for _, scope := range otherDeclaredScopes {
		assertDecision(t, f.mustCheck(t, second, scope), AuthorityAllow, grantID)
	}
	if shown := f.ticket(t, other.Id); shown.PermissionGrantCount != 1 || !shown.PermissionGrants[0].Full || shown.PermissionGrants[0].RemainingSeconds == nil || *shown.PermissionGrants[0].RemainingSeconds != 1 {
		t.Fatalf("another Ticket of the Agent lists %+v, want the full time grant with 1 s left", shown.PermissionGrants)
	}
	f.clock.Set(until)
	for _, scope := range append([]permissionScope{writeReport}, otherDeclaredScopes...) {
		assertExpiredDeny(t, f.mustCheck(t, second, scope), grantID)
	}
	if shown := f.ticket(t, other.Id); shown.PermissionGrants[0].State != PermissionGrantExpired {
		t.Fatalf("grant = %+v, want expired", shown.PermissionGrants[0])
	}
}

func TestRenewal_AnExpiredFullGrantIsRenewedForTheRequestedScopeOrAgainInFull(t *testing.T) {
	for _, scope := range []PermissionGrantScope{PermissionGrantScopeRequested, PermissionGrantScopeFull} {
		t.Run(string(scope), func(t *testing.T) {
			f := newClaimFixture(t)
			until := runnerEpoch.Add(time.Minute)
			queued, claim, expired := f.fullGrantRound(t, "Renew full", PermissionGrantFormTime, until)
			f.clock.Set(until.Add(time.Second))
			f.reconnect(t, claim)
			assertExpiredDeny(t, f.mustCheck(t, claim, readReport), expired)
			oldRow := grantRow(t, f, expired)

			if rec := f.requestRenewal(t, claim, requestB, readReport, expired); rec.Code != http.StatusCreated {
				t.Fatalf("renewal: status=%d body=%s", rec.Code, rec.Body.String())
			}
			if p := f.ticket(t, queued.Id).OpenRound.PermissionRequest; p.RenewsGrantId == nil || *p.RenewsGrantId != expired || p.Action != readReport.action {
				t.Fatalf("waiting request = %+v, want %s renewing %s", p, readReport, expired)
			}
			_, renewed := f.mustApproveWith(t, queued.Id, claim.RoundId, requestB, jsonText(t, map[string]any{"form": "ticket", "scope": scope}))
			f.mustResumeApproval(t, claim, requestB)
			assertDecision(t, f.mustCheck(t, claim, readReport), AuthorityAllow, renewed)
			if scope == PermissionGrantScopeFull {
				assertDecision(t, f.mustCheck(t, claim, postGeneral), AuthorityAllow, renewed)
			} else {
				assertExpiredDeny(t, f.mustCheck(t, claim, postGeneral), expired)
			}
			if after := grantRow(t, f, expired); after != oldRow {
				t.Fatalf("the expired grant changed:\nbefore %s\nafter  %s", oldRow, after)
			}
			if g := grantOf(t, f.ticket(t, queued.Id).PermissionGrants, renewed); g.Full != (scope == PermissionGrantScopeFull) {
				t.Fatalf("renewed grant = %+v, want full=%t", g, scope == PermissionGrantScopeFull)
			}
		})
	}
}

func TestRenewal_AnExpiredFullGrantIsNamedOnlyForItsOwnAgentAndAccount(t *testing.T) {
	f := newClaimFixture(t)
	until := runnerEpoch.Add(time.Minute)
	_, first, expired := f.fullGrantRound(t, "Origin", PermissionGrantFormTime, until)
	f.deliver(t, first)
	writer := createAgentForTest(t, f.handler, f.cookie, "Writer", AgentKindResearch)
	queueTicketAs(t, f.handler, f.cookie, writer, "Writer's")
	theirs := f.mustClaim(t)
	f.startRound(t, theirs, theirs.RoundId+":start")
	f.clock.Set(until)
	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.requestRenewal(t, theirs, requestB, readReport, expired), http.StatusBadRequest, invalidRenewalCode, invalidRenewalMessage)
	assertErrorCode(t, f.requestRenewal(t, theirs, requestB, permissionScope{"github", "push", "repo"}, expired), capabilityNotSupportedCode)
	assertSnapshotUnchanged(t, f.pool, before, "renewals of another Agent's full grant")
}

func TestAuthorityCheck_AGranularGrantOrTheAccountAloneNeverImpliesFullAccess(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Granular")
	for _, scope := range append([]permissionScope{writeReport}, otherDeclaredScopes...) {
		assertExpiredDeny(t, f.mustCheck(t, claim, scope), "")
	}
	f.mustRequestPermission(t, claim, requestA, writeReport)
	ticketGrant := *f.mustApprove(t, queued.Id, claim.RoundId, requestA).OpenRound.PermissionRequest.GrantId
	f.mustResumeApproval(t, claim, requestA)
	f.mustRequestPermission(t, claim, requestB, postGeneral)
	_, timeGrant := f.mustApproveTime(t, queued.Id, claim.RoundId, requestB, runnerEpoch.Add(time.Hour))
	f.mustResumeApproval(t, claim, requestB)

	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, ticketGrant)
	assertDecision(t, f.mustCheck(t, claim, postGeneral), AuthorityAllow, timeGrant)
	for _, scope := range otherDeclaredScopes {
		if scope != postGeneral {
			assertExpiredDeny(t, f.mustCheck(t, claim, scope), "")
		}
	}
	for _, g := range f.ticket(t, queued.Id).PermissionGrants {
		if g.Full {
			t.Fatalf("grant %+v is full access; only the Owner's full scope creates one", g)
		}
	}
}

func TestAuthorityCheck_AnExactGrantIsNamedBeforeAFullGrant(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, fullGrant := f.fullGrantRound(t, "Both", PermissionGrantFormTicket, time.Time{})
	f.mustRequestPermission(t, claim, requestB, readReport)
	exact := *f.mustApprove(t, queued.Id, claim.RoundId, requestB).OpenRound.PermissionRequest.GrantId
	f.mustResumeApproval(t, claim, requestB)
	assertDecision(t, f.mustCheck(t, claim, readReport), AuthorityAllow, exact)
	assertDecision(t, f.mustCheck(t, claim, postGeneral), AuthorityAllow, fullGrant)
}

func TestAuthorityCheck_AFullGrantAppliesOnlyToItsOwnAccount(t *testing.T) {
	const second = "second"
	connectedAccountActions[second] = map[string]*regexp.Regexp{"read_note": regexp.MustCompile(`^notes/` + scopeName + `$`)}
	t.Cleanup(func() { delete(connectedAccountActions, second) })
	secondRead := permissionScope{second, "read_note", "notes/a"}

	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Two accounts")
	f.mustRequestPermission(t, claim, requestA, secondRead)
	_, secondGrant := f.mustApproveWith(t, queued.Id, claim.RoundId, requestA, fullApprovalBody(t, PermissionGrantFormTicket, time.Time{}))
	f.mustResumeApproval(t, claim, requestA)
	assertDecision(t, f.mustCheck(t, claim, secondRead), AuthorityAllow, secondGrant)
	for _, scope := range append([]permissionScope{writeReport, {controlledAccount, "read_note", "notes/a"}}, otherDeclaredScopes...) {
		assertExpiredDeny(t, f.mustCheck(t, claim, scope), "")
	}
	assertErrorCode(t, f.check(t, claim.RoundId, claim.ClaimEpoch, permissionScope{second, "write_note", "notes/a"}), capabilityNotSupportedCode)

	f.mustRequestPermission(t, claim, requestB, readReport)
	_, controlledGrant := f.mustApproveWith(t, queued.Id, claim.RoundId, requestB, fullApprovalBody(t, PermissionGrantFormTicket, time.Time{}))
	f.mustResumeApproval(t, claim, requestB)
	assertDecision(t, f.mustCheck(t, claim, postGeneral), AuthorityAllow, controlledGrant)
	assertDecision(t, f.mustCheck(t, claim, secondRead), AuthorityAllow, secondGrant)
	grants := f.ticket(t, queued.Id).PermissionGrants
	if g := grantOf(t, grants, secondGrant); !g.Full || g.Account != second || g.SubstituteAccount {
		t.Fatalf("grant = %+v, want full access to %s", g, second)
	}
}

func TestRenewal_AnExpiredFullGrantOnAnotherAccountIsNeverNamedOrRenewed(t *testing.T) {
	const second = "second"
	connectedAccountActions[second] = map[string]*regexp.Regexp{"read_note": regexp.MustCompile(`^notes/` + scopeName + `$`)}
	t.Cleanup(func() { delete(connectedAccountActions, second) })
	secondRead := permissionScope{second, "read_note", "notes/a"}

	f := newClaimFixture(t)
	until := runnerEpoch.Add(time.Minute)
	queued, claim := f.runningRound(t, "Two accounts")
	f.mustRequestPermission(t, claim, requestA, secondRead)
	_, secondGrant := f.mustApproveWith(t, queued.Id, claim.RoundId, requestA, fullApprovalBody(t, PermissionGrantFormTime, until))
	f.mustResumeApproval(t, claim, requestA)
	f.clock.Set(until)
	f.reconnect(t, claim)
	assertExpiredDeny(t, f.mustCheck(t, claim, secondRead), secondGrant)
	assertExpiredDeny(t, f.mustCheck(t, claim, readReport), "")

	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.requestRenewal(t, claim, requestB, readReport, secondGrant), http.StatusBadRequest, invalidRenewalCode, invalidRenewalMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a renewal naming another account's full grant")
}

func TestApprove_ConcurrentFullAndRequestedApprovalsRecordExactlyOneGrant(t *testing.T) {
	for trial := range 4 {
		f := newClaimFixture(t)
		queued, claim := f.permissionRound(t, fmt.Sprintf("Race %d", trial))
		codes, bodies := sendConcurrently(6, func(i int) *httptest.ResponseRecorder {
			if i%2 == 0 {
				return f.approveWith(t, queued.Id, claim.RoundId, requestA, fullApprovalBody(t, PermissionGrantFormTicket, time.Time{}))
			}
			return f.approve(t, queued.Id, claim.RoundId, requestA)
		})
		winner := -1
		for i, code := range codes {
			switch {
			case code == http.StatusOK && winner < 0:
				winner = i
			case code == http.StatusBadRequest && strings.Contains(bodies[i], permissionAlreadyDecidedCode):
			default:
				t.Fatalf("trial %d response %d: status=%d body=%s", trial, i, code, bodies[i])
			}
		}
		grants := f.ticket(t, queued.Id).PermissionGrants
		if winner < 0 || len(grants) != 1 || tableRowCount(t, f.pool, "permission_grants") != 1 || len(f.mustCommands(t, claim.RoundId)) != 2 {
			t.Fatalf("trial %d: winner %d, grants %+v", trial, winner, grants)
		}
		if grants[0].Full != (winner%2 == 0) {
			t.Fatalf("trial %d: the grant %+v does not follow the winning approval %d", trial, grants[0], winner)
		}
	}
}

func TestApprove_AFullApprovalRacingStopLeavesNoGrantOrBothCommands(t *testing.T) {
	outcomes := map[string]int{}
	for trial := range 6 {
		f := newClaimFixture(t)
		queued, claim := f.permissionRound(t, fmt.Sprintf("Race %d", trial))
		codes, bodies := sendConcurrently(2, func(i int) *httptest.ResponseRecorder {
			if i == 0 {
				return f.stop(t, queued.Id)
			}
			return f.approveWith(t, queued.Id, claim.RoundId, requestA, fullApprovalBody(t, PermissionGrantFormTicket, time.Time{}))
		})
		if codes[0] != http.StatusOK {
			t.Fatalf("trial %d: stop %d %s", trial, codes[0], bodies[0])
		}
		commands, grants := f.mustCommands(t, claim.RoundId), tableRowCount(t, f.pool, "permission_grants")
		switch {
		case codes[1] == http.StatusOK && len(commands) == 3 && commands[0].Type == RunnerCommandStop && grants == 1:
			outcomes["approved first"]++
		case codes[1] == http.StatusBadRequest && strings.Contains(bodies[1], stopAlreadyRequestedCode) && len(commands) == 1 && grants == 0:
			outcomes["stopped first"]++
		default:
			t.Fatalf("trial %d: approve %d %s, commands %+v, grants %d", trial, codes[1], bodies[1], commands, grants)
		}
		f.mustConfirmStop(t, claim)
		assertErrorCode(t, f.check(t, claim.RoundId, claim.ClaimEpoch, readReport), roundNotOpenCode)
	}
	t.Logf("%v", outcomes)
}

func assertViolatesOneOf(t *testing.T, err error, constraints ...string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		for _, c := range constraints {
			if pgErr.ConstraintName == c {
				return
			}
		}
	}
	t.Fatalf("err = %v, want a violation of one of %v", err, constraints)
}

func TestFullAccess_TheDatabaseKeepsAFullGrantScopelessAndBoundToItsRequest(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.permissionRound(t, "Constraints")
	ctx := context.Background()
	var requestRowID int64
	if err := f.pool.QueryRow(ctx, `SELECT id FROM permission_requests WHERE request_id = $1::uuid`, requestA).Scan(&requestRowID); err != nil {
		t.Fatal(err)
	}
	insertGrant := func(full bool, action, resource, account, ticket, agent string) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO permission_grants (owner_id, public_id, ticket_id, agent_id, request_id, account, action, resource, form, state, created_at, approved_at, full_access)
			SELECT owner_id, gen_random_uuid(), `+ticket+`, `+agent+`, id, `+account+`, `+action+`, `+resource+`, 'ticket', 'active', now(), now(), $2 FROM permission_requests WHERE id = $1`,
			requestRowID, full)
		return err
	}
	otherTicket := f.queue(t, "Other Ticket").Id
	otherAgent := createAgentForTest(t, f.handler, f.cookie, "Other", AgentKindResearch).Id
	for _, tc := range []struct {
		name                                     string
		full                                     bool
		action, resource, account, ticket, agent string
		constraint                               string
	}{
		{"a full grant with an action", true, "action", "NULL", "account", "ticket_id", "agent_id", "permission_grants_scope_follows_full_access"},
		{"a full grant with a resource", true, "NULL", "resource", "account", "ticket_id", "agent_id", "permission_grants_scope_follows_full_access"},
		{"a full grant with the request's scope", true, "action", "resource", "account", "ticket_id", "agent_id", "permission_grants_scope_follows_full_access"},
		{"a requested grant without an action", false, "NULL", "resource", "account", "ticket_id", "agent_id", "permission_grants_scope_follows_full_access"},
		{"a requested grant without a scope", false, "NULL", "NULL", "account", "ticket_id", "agent_id", "permission_grants_scope_follows_full_access"},
		{"a full grant for another account", true, "NULL", "NULL", "'github'", "ticket_id", "agent_id", "permission_grants_request_account_fk"},
		{"a full grant on another Ticket", true, "NULL", "NULL", "account", "(SELECT id FROM tickets WHERE public_id = '" + otherTicket + "')", "agent_id", "permission_grants_request_account_fk"},
		{"a full grant for another Agent", true, "NULL", "NULL", "account", "ticket_id", "(SELECT id FROM agents WHERE public_id = '" + otherAgent + "')", "permission_grants_request_account_fk"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertViolates(t, insertGrant(tc.full, tc.action, tc.resource, tc.account, tc.ticket, tc.agent), tc.constraint)
		})
	}

	ownerID, roundID := roundRowIDs(t, f, claim.RoundId)
	_, err := f.pool.Exec(ctx, `UPDATE permission_requests SET renews_full_access = true WHERE id = $1`, requestRowID)
	assertViolates(t, err, "permission_requests_renews_full_access_follows_grant")
	if err := insertGrant(true, "NULL", "NULL", "account", "ticket_id", "agent_id"); err != nil {
		t.Fatalf("a full grant for the request: %v", err)
	}
	var fullGrantRowID int64
	if err := f.pool.QueryRow(ctx, `SELECT id FROM permission_grants WHERE request_id = $1`, requestRowID).Scan(&fullGrantRowID); err != nil {
		t.Fatal(err)
	}
	renew := func(grantRowID int64, full bool) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO permission_requests (owner_id, ticket_id, agent_id, round_id, request_id, account, action, resource, requested_at, decision, decided_at, renews_grant_id, renews_full_access)
			SELECT owner_id, ticket_id, agent_id, round_id, gen_random_uuid(), account, 'read_note', 'notes/a', now(), 'declined', now(), $2, $3 FROM permission_requests WHERE id = $1`,
			requestRowID, grantRowID, full)
		return err
	}
	assertViolatesOneOf(t, renew(fullGrantRowID, false), "permission_requests_renews_grant_fk", "permission_requests_renews_grant_account_fk")
	if err := renew(fullGrantRowID, true); err != nil {
		t.Fatalf("a renewal of the full grant for another scope of its account: %v", err)
	}
	_, err = f.pool.Exec(ctx, `INSERT INTO round_authority_checks (owner_id, round_id, account, action, resource, claim_epoch, decision, grant_id, checked_at)
		VALUES ($1, $2, 'controlled', 'read_note', 'notes/a', 1, 'allow', $3, now())`, ownerID, roundID, fullGrantRowID)
	if err != nil {
		t.Fatalf("a check allowed by the full grant: %v", err)
	}
	t.Run("a renewal naming a granular grant as full", func(t *testing.T) {
		g := newClaimFixture(t)
		_, first, granular := g.timeGrantRound(t, "Granular", writeReport, runnerEpoch.Add(time.Minute))
		g.deliver(t, first)
		_, other := g.runningRound(t, "Renewing")
		g.mustRequestPermission(t, other, requestB, writeReport)
		_, err := g.pool.Exec(ctx, `UPDATE permission_requests SET renews_grant_id = (SELECT id FROM permission_grants WHERE public_id = $1::uuid), renews_full_access = true WHERE request_id = $2::uuid`, granular, requestB)
		assertViolates(t, err, "permission_requests_renews_grant_account_fk")
		_, err = g.pool.Exec(ctx, `UPDATE permission_requests SET renews_grant_id = (SELECT id FROM permission_grants WHERE public_id = $1::uuid), renews_full_access = false WHERE request_id = $2::uuid`, granular, requestB)
		if err != nil {
			t.Fatalf("a renewal of the granular grant for its scope: %v", err)
		}
	})
}
