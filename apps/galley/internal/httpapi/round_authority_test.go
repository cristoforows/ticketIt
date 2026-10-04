package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

var writeReport = permissionScope{account: controlledAccount, action: "write_note", resource: "notes/weekly-report"}

func authorityCheckBody(t *testing.T, scope permissionScope, epoch int) string {
	t.Helper()
	return jsonText(t, map[string]any{"account": scope.account, "action": scope.action, "resource": scope.resource, "epoch": epoch})
}

func authorityCheckPath(roundID string) string {
	return "/api/runner/rounds/" + roundID + "/authority-checks"
}

func (f *claimFixture) check(t *testing.T, roundID string, epoch int, scope permissionScope) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: authorityCheckPath(roundID), body: authorityCheckBody(t, scope, epoch), token: f.token})
}

func (f *claimFixture) mustCheck(t *testing.T, claim RunnerClaim, scope permissionScope) AuthorityCheckResult {
	t.Helper()
	rec := f.check(t, claim.RoundId, claim.ClaimEpoch, scope)
	if rec.Code != http.StatusOK {
		t.Fatalf("authority check %s: status=%d body=%s, want 200", scope, rec.Code, rec.Body.String())
	}
	var result AuthorityCheckResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func assertDecision(t *testing.T, got AuthorityCheckResult, want AuthorityDecision, grantID string) {
	t.Helper()
	switch {
	case got.Decision != want:
		t.Fatalf("decision = %+v, want %s", got, want)
	case want == AuthorityDeny && got.GrantId != nil:
		t.Fatalf("a deny names grant %s", *got.GrantId)
	case want == AuthorityAllow && (got.GrantId == nil || *got.GrantId != grantID):
		t.Fatalf("allow names grant %v, want %s", got.GrantId, grantID)
	}
}

func TestAuthorityCheck_ReadsGrantsLive(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Live")
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	f.mustRequestPermission(t, claim, requestA, writeReport)

	grantID := f.mustApprove(t, queued.Id, claim.RoundId, requestA).PermissionGrants[0].Id
	f.mustResumeApproval(t, claim, requestA)
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)

	assertDecision(t, f.mustCheck(t, claim, permissionScope{controlledAccount, "read_note", writeReport.resource}), AuthorityDeny, "")
}

func TestAuthorityCheck_MatchesTheGrantsAgentTicketAndScopeExactly(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Granted")
	grantID := f.mustApprove(t, queued.Id, claim.RoundId, requestA).PermissionGrants[0].Id
	f.mustResumeApproval(t, claim, requestA)

	for _, tc := range []struct {
		name  string
		scope permissionScope
		want  AuthorityDecision
	}{
		{"the granted scope", writeReport, AuthorityAllow},
		{"another action on the resource", permissionScope{controlledAccount, "read_note", writeReport.resource}, AuthorityDeny},
		{"a longer resource", permissionScope{controlledAccount, writeReport.action, writeReport.resource + "s"}, AuthorityDeny},
		{"a shorter resource", permissionScope{controlledAccount, writeReport.action, "notes/weekly"}, AuthorityDeny},
		{"another resource", permissionScope{controlledAccount, writeReport.action, "notes/other"}, AuthorityDeny},
		{"another action and kind of resource", permissionScope{controlledAccount, "post_message", "channels/weekly-report"}, AuthorityDeny},
	} {
		t.Run(tc.name, func(t *testing.T) { assertDecision(t, f.mustCheck(t, claim, tc.scope), tc.want, grantID) })
	}
	before := databaseSnapshot(t, f.pool)
	for name, scope := range map[string]permissionScope{
		"an undeclared account":         {"github", writeReport.action, writeReport.resource},
		"an account differing by case":  {"Controlled", writeReport.action, writeReport.resource},
		"an undeclared action":          {controlledAccount, "delete_note", writeReport.resource},
		"a resource outside the action": {controlledAccount, writeReport.action, "channels/weekly-report"},
		"a wildcard":                    {controlledAccount, writeReport.action, "notes/*"},
		"a prefix":                      {controlledAccount, writeReport.action, "notes/"},
		"a path below the resource":     {controlledAccount, writeReport.action, writeReport.resource + "/draft"},
		"an uppercase resource":         {controlledAccount, writeReport.action, "notes/Weekly-report"},
	} {
		t.Run(name, func(t *testing.T) {
			assertErrorCode(t, f.check(t, claim.RoundId, claim.ClaimEpoch, scope), unsupportedScopeCode)
		})
	}
	assertSnapshotUnchanged(t, f.pool, before, "checks of unsupported scopes")

	t.Run("another Ticket of the same Agent", func(t *testing.T) {
		f.deliver(t, claim)
		_, other := f.runningRound(t, "Another Ticket")
		assertDecision(t, f.mustCheck(t, other, writeReport), AuthorityDeny, "")
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
		if reassigned.Ticket.Id != queued.Id || reassigned.Agent.Id != writer.Id {
			t.Fatalf("claim = %+v, want %s for the writer", reassigned, queued.Id)
		}
		f.startRound(t, reassigned, reassigned.RoundId+":start")
		assertDecision(t, f.mustCheck(t, reassigned, writeReport), AuthorityDeny, "")
		if grants := f.ticket(t, queued.Id).PermissionGrants; len(grants) != 1 || grants[0].Agent.Id != f.agent.Id {
			t.Fatalf("grants = %+v, want the one grant, still bound to the first Agent", grants)
		}
	})
}

func TestAuthorityCheck_ReusesTheGrantInALaterRoundOfTheSameTicketWithoutANewRequest(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Reuse")
	grantID := f.mustApprove(t, queued.Id, claim.RoundId, requestA).PermissionGrants[0].Id
	f.mustResumeApproval(t, claim, requestA)
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)
	f.deliver(t, claim)

	f.mustRework(t, queued.Id)
	next := f.mustClaim(t)
	if next.Ticket.Id != queued.Id || next.RoundId == claim.RoundId {
		t.Fatalf("claim = %+v, want a second Round of %s", next, queued.Id)
	}
	f.startRound(t, next, next.RoundId+":start")
	assertDecision(t, f.mustCheck(t, next, writeReport), AuthorityAllow, grantID)
	if n := tableRowCount(t, f.pool, "permission_requests"); n != 1 {
		t.Fatalf("permission_requests = %d, want the one request", n)
	}
	rounds := decodeRounds(t, f.listRounds(t, queued.Id))
	if len(rounds) != 2 || len(rounds[0].PermissionRequests) != 0 || rounds[0].AuthorityCheckCount != 1 || len(rounds[1].PermissionRequests) != 1 || rounds[1].AuthorityCheckCount != 2 {
		t.Fatalf("rounds = %+v, want the newest Round with one check and no request, then the first with the request and two checks", rounds)
	}
	if c := rounds[0].AuthorityChecks[0]; c.Decision != AuthorityAllow || c.GrantId == nil || *c.GrantId != grantID {
		t.Fatalf("the later Round's check = %+v, want an allow by %s", c, grantID)
	}
}

func TestAuthorityCheck_RecordsEveryCheckAndListsTheLatestFifty(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Many checks")
	at := runnerEpoch.Add(3 * time.Second)
	f.clock.Set(at)
	f.heartbeat(t, f.token, http.StatusOK)
	for i := range authorityChecksShown + 3 {
		f.mustCheck(t, claim, permissionScope{controlledAccount, "read_note", fmt.Sprintf("notes/n%d", i)})
	}
	round := f.roundOf(t, queued.Id)
	if round.AuthorityCheckCount != authorityChecksShown+3 || len(round.AuthorityChecks) != authorityChecksShown {
		t.Fatalf("count=%d listed=%d, want %d and %d", round.AuthorityCheckCount, len(round.AuthorityChecks), authorityChecksShown+3, authorityChecksShown)
	}
	first, last := round.AuthorityChecks[0], round.AuthorityChecks[authorityChecksShown-1]
	if first.Resource != "notes/n3" || last.Resource != fmt.Sprintf("notes/n%d", authorityChecksShown+2) || !first.CheckedAt.Equal(at) || first.Decision != AuthorityDeny || first.GrantId != nil {
		t.Fatalf("listed checks run %+v .. %+v, want the latest fifty, oldest first", first, last)
	}
}

func TestAuthorityCheck_IsAnsweredOnlyForTheRunningRoundAtItsEpoch(t *testing.T) {
	t.Run("a stale epoch", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.runningRound(t, "Stale")
		before := databaseSnapshot(t, f.pool)
		for _, epoch := range []int{claim.ClaimEpoch + 1, claim.ClaimEpoch - 1} {
			if epoch < 1 {
				continue
			}
			assertErrorBody(t, f.check(t, claim.RoundId, epoch, writeReport), http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
		}
		assertSnapshotUnchanged(t, f.pool, before, "a check at a stale epoch")
	})
	t.Run("a claimed Round", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Not started")
		before := databaseSnapshot(t, f.pool)
		assertErrorBody(t, f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport), http.StatusConflict, roundNotRunningCode, roundNotRunningMessage)
		assertSnapshotUnchanged(t, f.pool, before, "a check before the Round started")
	})
	t.Run("a waiting Round", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.permissionRound(t, "Waiting")
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport), roundNotRunningCode)
		assertSnapshotUnchanged(t, f.pool, before, "a check while the Round waits")
	})
	for _, ending := range []string{"delivered", "stopped", "failed"} {
		t.Run("an ended Round: "+ending, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.permissionRound(t, "Ended")
			f.mustApprove(t, queued.Id, claim.RoundId, requestA)
			f.mustResumeApproval(t, claim, requestA)
			f.mustCheck(t, claim, writeReport)
			switch ending {
			case "delivered":
				f.deliver(t, claim)
			case "stopped":
				f.mustStop(t, queued.Id)
				f.mustConfirmStop(t, claim)
			case "failed":
				f.mustEndAs(t, blockedEndings[0], claim)
			}
			before := databaseSnapshot(t, f.pool)
			assertErrorBody(t, f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
			assertSnapshotUnchanged(t, f.pool, before, "a check after the Round ended")
		})
	}
	t.Run("while Stop is requested the check still answers truly", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, "Stopping")
		f.mustStop(t, queued.Id)
		assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityDeny, "")
	})
}

func TestAuthorityCheck_UnknownForeignAndMalformedRoundsAreTheSameNotFound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Mine")
	f.mustApprove(t, queued.Id, claim.RoundId, requestA)
	f.mustResumeApproval(t, claim, requestA)

	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	_, theirs := foreign.runningRound(t, "Theirs")

	before := databaseSnapshot(t, f.pool)
	assertRoundNotFound(t, foreign.check(t, claim.RoundId, claim.ClaimEpoch, writeReport))
	assertRoundNotFound(t, f.check(t, theirs.RoundId, theirs.ClaimEpoch, writeReport))
	assertRoundNotFound(t, f.check(t, uuid.NewString(), 1, writeReport))
	assertRoundNotFound(t, f.check(t, strings.ToUpper(theirs.RoundId), theirs.ClaimEpoch, writeReport))
	assertRoundNotFound(t, f.check(t, "round-1", claim.ClaimEpoch, writeReport))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: authorityCheckPath(claim.RoundId), body: authorityCheckBody(t, writeReport, claim.ClaimEpoch)}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: authorityCheckPath(claim.RoundId), body: authorityCheckBody(t, writeReport, claim.ClaimEpoch), cookie: f.cookie}))
	assertSnapshotUnchanged(t, f.pool, before, "checks of a Round that is not the runner's")
	assertDecision(t, foreign.mustCheck(t, theirs, writeReport), AuthorityDeny, "")
}

func TestAuthorityCheck_TheBodyIsDecodedStrictly(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Strict check")
	before := databaseSnapshot(t, f.pool)
	valid := map[string]any{"account": writeReport.account, "action": writeReport.action, "resource": writeReport.resource, "epoch": claim.ClaimEpoch}
	with := func(key string, value any) string {
		body := map[string]any{}
		for k, v := range valid {
			body[k] = v
		}
		if value == nil {
			delete(body, key)
		} else {
			body[key] = value
		}
		return jsonText(t, body)
	}
	for name, body := range map[string]string{
		"no body":              "",
		"no account":           with("account", nil),
		"no epoch":             with("epoch", nil),
		"an extra field":       with("grantId", uuid.NewString()),
		"a numeric action":     with("action", 7),
		"an empty resource":    with("resource", ""),
		"a control character":  with("resource", "notes/a\u0007"),
		"a resource over 200":  with("resource", "notes/"+strings.Repeat("a", 200)),
		"a zero epoch":         with("epoch", 0),
		"a fractional epoch":   with("epoch", 1.5),
		"trailing data":        jsonText(t, valid) + " {}",
		"an array":             `[]`,
		"an epoch as a string": with("epoch", "1"),
	} {
		t.Run(name, func(t *testing.T) {
			assertInvalidRequest(t, f.do(t, runnerCall{method: http.MethodPost, path: authorityCheckPath(claim.RoundId), body: body, token: f.token}))
		})
	}
	assertSnapshotUnchanged(t, f.pool, before, "malformed checks")
}

func TestAuthorityCheck_ChecksRecordTheirDecisionAndTheGrant(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Constraints")
	f.mustCheck(t, claim, writeReport)
	ownerID, roundID := roundRowIDs(t, f, claim.RoundId)
	insert := func(decision string, grant any, epoch int) error {
		_, err := f.pool.Exec(context.Background(), `INSERT INTO round_authority_checks (owner_id, round_id, account, action, resource, claim_epoch, decision, grant_id, checked_at)
			VALUES ($1, $2, 'controlled', 'read_note', 'notes/a', $3, $4, $5, now())`, ownerID, roundID, epoch, decision, grant)
		return err
	}
	assertViolates(t, insert("allow", nil, 1), "round_authority_checks_grant_follows_decision")
	assertViolates(t, insert("maybe", nil, 1), "round_authority_checks_decision")
	assertViolates(t, insert("deny", nil, 0), "round_authority_checks_claim_epoch_positive")
	assertViolates(t, insert("allow", int64(1<<40), 1), "round_authority_checks_grant_fk")
}
