package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

const (
	requestA = "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
	requestB = "0f9e8d7c-6b5a-4948-8776-655443322110"
)

func permissionEvent(t *testing.T, key string, epoch int, requestID string, scope permissionScope) string {
	t.Helper()
	return jsonText(t, map[string]any{"type": "permission_requested", "idempotencyKey": key, "claimEpoch": epoch, "occurredAt": eventOccurredAt,
		"data": map[string]any{"requestId": requestID, "account": scope.account, "action": scope.action, "resource": scope.resource}})
}

func approvalResumedEvent(t *testing.T, key string, epoch int, requestID string) string {
	t.Helper()
	return jsonText(t, map[string]any{"type": "resumed", "idempotencyKey": key, "claimEpoch": epoch, "occurredAt": eventOccurredAt,
		"data": map[string]any{"requestId": requestID}})
}

func (f *claimFixture) requestPermission(t *testing.T, claim RunnerClaim, requestID string, scope permissionScope) *httptest.ResponseRecorder {
	t.Helper()
	return f.reportEvent(t, claim.RoundId, permissionEvent(t, requestID, claim.ClaimEpoch, requestID, scope))
}

func (f *claimFixture) mustRequestPermission(t *testing.T, claim RunnerClaim, requestID string, scope permissionScope) *httptest.ResponseRecorder {
	t.Helper()
	rec := f.requestPermission(t, claim, requestID, scope)
	if rec.Code != http.StatusCreated {
		t.Fatalf("permission_requested: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
	return rec
}

func (f *claimFixture) resumeApproval(t *testing.T, claim RunnerClaim, requestID string) *httptest.ResponseRecorder {
	t.Helper()
	return f.reportEvent(t, claim.RoundId, approvalResumedEvent(t, claim.RoundId+":resume:"+requestID, claim.ClaimEpoch, requestID))
}

func (f *claimFixture) mustResumeApproval(t *testing.T, claim RunnerClaim, requestID string) *httptest.ResponseRecorder {
	t.Helper()
	rec := f.resumeApproval(t, claim, requestID)
	if rec.Code != http.StatusCreated {
		t.Fatalf("resumed: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
	return rec
}

func (f *claimFixture) permissionRound(t *testing.T, title string) (Ticket, RunnerClaim) {
	t.Helper()
	queued, claim := f.runningRound(t, title)
	f.mustRequestPermission(t, claim, requestA, writeReport)
	return queued, claim
}

func permissionPath(ticketID, roundID, requestID, decision string) string {
	return "/api/tickets/" + ticketID + "/rounds/" + roundID + "/permission-requests/" + requestID + "/" + decision
}

func (f *claimFixture) approve(t *testing.T, ticketID, roundID, requestID string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: permissionPath(ticketID, roundID, requestID, "approve"), body: `{"form":"ticket"}`, cookie: f.cookie})
}

func (f *claimFixture) decline(t *testing.T, ticketID, roundID, requestID string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: permissionPath(ticketID, roundID, requestID, "decline"), cookie: f.cookie})
}

func (f *claimFixture) mustApprove(t *testing.T, ticketID, roundID, requestID string) Ticket {
	t.Helper()
	rec := f.approve(t, ticketID, roundID, requestID)
	if rec.Code != http.StatusOK {
		t.Fatalf("approve: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	return decodeTicketBody(t, rec)
}

func (f *claimFixture) mustDecline(t *testing.T, ticketID, roundID, requestID string) Ticket {
	t.Helper()
	rec := f.decline(t, ticketID, roundID, requestID)
	if rec.Code != http.StatusOK {
		t.Fatalf("decline: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	return decodeTicketBody(t, rec)
}

func assertPermissionWait(t *testing.T, ticket Ticket, claim RunnerClaim, reason RoundWaitingReason, decision *PermissionRequestDecision) {
	t.Helper()
	open := ticket.OpenRound
	if ticket.Status != Blocked || open == nil || open.Id != claim.RoundId || open.State != OpenRoundWaitingForInput || open.WaitingReason != reason || open.Question != nil {
		t.Fatalf("Ticket = %s %+v, want Blocked with Round %s waiting for a Permission (%s)", ticket.Status, open, claim.RoundId, reason)
	}
	p := open.PermissionRequest
	if p == nil || p.Id != requestA || p.Account != writeReport.account || p.Action != writeReport.action || p.Resource != writeReport.resource ||
		!p.SubstituteAccount || !reflect.DeepEqual(p.Decision, decision) || (p.DecidedAt == nil) != (decision == nil) ||
		(p.GrantId != nil) != (decision != nil && *decision == PermissionApproved) {
		t.Fatalf("openRound.permissionRequest = %+v, want %s on the substitute account decided %v", p, requestA, decision)
	}
	if ticket.RequestingAgentWork || len(ticket.AllowedActions.StatusChanges) != 0 || len(ticket.AllowedActions.StatusChangeRejections) != 0 {
		t.Fatalf("a waiting Ticket offers %+v and requests work=%t", ticket.AllowedActions, ticket.RequestingAgentWork)
	}
}

func decisionOf(d PermissionRequestDecision) *PermissionRequestDecision { return &d }

func TestPermissionRequested_MovesTheRunningRoundToWaitingForAPermissionAndKeepsTheSlot(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Ask for a Permission")
	waiting := f.queue(t, "Behind it")
	asked := runnerEpoch.Add(7 * time.Second)
	f.clock.Set(asked)
	f.heartbeat(t, f.token, http.StatusOK)

	rec := f.mustRequestPermission(t, claim, requestA, writeReport)
	want := fmt.Sprintf(`{"requestId":%q,"roundId":%q,"startedAt":%q,"state":"waiting_for_input","type":"permission_requested"}`, requestA, claim.RoundId, runnerEpoch.Format(time.RFC3339Nano))
	if rec.Body.String() != want {
		t.Fatalf("body = %s, want %s", rec.Body.String(), want)
	}
	ticket := f.ticket(t, queued.Id)
	assertPermissionWait(t, ticket, claim, WaitingForPermission, nil)
	if !ticket.OpenRound.PermissionRequest.RequestedAt.Equal(asked) {
		t.Fatalf("requestedAt = %v, want Galley's clock %v", ticket.OpenRound.PermissionRequest.RequestedAt, asked)
	}
	a := ticket.AllowedActions
	if !a.PermissionDecision.Available || !a.Stop.Available || a.Answer.Available || a.Answer.Reason == nil || a.Answer.Reason.Code != answerNotAvailableCode {
		t.Fatalf("allowedActions permissionDecision=%+v stop=%+v answer=%+v", a.PermissionDecision, a.Stop, a.Answer)
	}
	if len(ticket.PermissionGrants) != 0 {
		t.Fatalf("grants = %+v before any approval", ticket.PermissionGrants)
	}
	assertNoWork(t, f.claim(t))
	if got := f.ticket(t, waiting.Id); got.OpenRound != nil {
		t.Fatalf("the queued Ticket was claimed while the slot is held: %+v", got.OpenRound)
	}
	round := f.roundOf(t, queued.Id)
	if round.State != RoundWaitingForInput || len(round.PermissionRequests) != 1 || round.PermissionRequests[0].Id != requestA || len(round.Questions) != 0 {
		t.Fatalf("listed Round = %+v, want waiting with its one Permission request", round)
	}
	if got := f.ticket(t, queued.Id).AllowedActions.PermissionDecision; !got.Available {
		t.Fatalf("permissionDecision = %+v", got)
	}
	assertTicketLockedWhileWaiting(t, f, queued.Id, claim.RoundId)
}

func assertTicketLockedWhileWaiting(t *testing.T, f *claimFixture, ticketID, roundID string) {
	t.Helper()
	before := databaseSnapshot(t, f.pool)
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"archive":           f.archive(t, ticketID),
		"recovery to Ready": f.statusChange(t, ticketID, Ready),
		"to Backlog":        f.statusChange(t, ticketID, Backlog),
		"edit":              f.do(t, runnerCall{method: http.MethodPatch, path: "/api/tickets/" + ticketID, body: `{"title":"renamed"}`, cookie: f.cookie}),
		"unassign":          f.do(t, runnerCall{method: http.MethodDelete, path: "/api/tickets/" + ticketID + "/assignee", cookie: f.cookie}),
	} {
		t.Run(name, func(t *testing.T) { assertRoundOpen(t, rec, roundID) })
	}
	assertSnapshotUnchanged(t, f.pool, before, "mutations of a Ticket waiting for a Permission")
}

func TestPermissionRequested_KeyIsTheRequestIdAndAReplayRaisesNoSecondRequest(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Replay the request")
	body := permissionEvent(t, requestA, claim.ClaimEpoch, requestA, writeReport)
	first := f.mustReport(t, claim.RoundId, body)
	afterFirst := databaseSnapshot(t, f.pool)

	rec := f.reportEvent(t, claim.RoundId, body)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replay: status=%d body=%s, want 200 with %s", rec.Code, rec.Body.String(), first.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, afterFirst, "a replayed Permission request")
	other := permissionScope{controlledAccount, "read_note", writeReport.resource}
	assertErrorBody(t, f.reportEvent(t, claim.RoundId, permissionEvent(t, requestA, claim.ClaimEpoch, requestA, other)),
		http.StatusConflict, idempotencyKeyConflictCode, idempotencyKeyConflictMessage)
	assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, permissionEvent(t, claim.RoundId+":3", claim.ClaimEpoch, requestA, writeReport)))
	assertErrorCode(t, f.requestPermission(t, claim, requestB, other), eventOutOfOrderCode)
	assertErrorCode(t, f.raise(t, claim, questionA), eventOutOfOrderCode)
	assertSnapshotUnchanged(t, f.pool, afterFirst, "a second ask while a Permission request waits")

	f.mustApprove(t, queued.Id, claim.RoundId, requestA)
	afterApproval := databaseSnapshot(t, f.pool)
	if rec := f.reportEvent(t, claim.RoundId, body); rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replay after approval: status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, afterApproval, "a replayed request after its approval")
	f.mustResumeApproval(t, claim, requestA)
	afterResume := databaseSnapshot(t, f.pool)
	if rec := f.reportEvent(t, claim.RoundId, body); rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replay after resuming: status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, afterResume, "a replayed request after the Round resumed")
	if n := tableRowCount(t, f.pool, "permission_requests"); n != 1 {
		t.Fatalf("permission_requests rows = %d, want 1", n)
	}
	if n := tableRowCount(t, f.pool, "permission_grants"); n != 1 {
		t.Fatalf("permission_grants rows = %d, want 1", n)
	}
}

func TestPermissionRequested_DataIsValidatedStrictly(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Strict request")
	before := databaseSnapshot(t, f.pool)
	event := func(key string, data any) string {
		return jsonText(t, map[string]any{"type": "permission_requested", "idempotencyKey": key, "claimEpoch": claim.ClaimEpoch, "occurredAt": eventOccurredAt, "data": data})
	}
	valid := func(overrides map[string]any) map[string]any {
		data := map[string]any{"requestId": requestA, "account": writeReport.account, "action": writeReport.action, "resource": writeReport.resource}
		for k, v := range overrides {
			if v == nil {
				delete(data, k)
			} else {
				data[k] = v
			}
		}
		return data
	}
	for name, body := range map[string]string{
		"no resource":           event(requestA, valid(map[string]any{"resource": nil})),
		"an extra field":        event(requestA, valid(map[string]any{"grantId": requestB})),
		"a form":                event(requestA, valid(map[string]any{"form": "ticket"})),
		"an empty action":       event(requestA, valid(map[string]any{"action": ""})),
		"a control character":   event(requestA, valid(map[string]any{"resource": "notes/a\u0007"})),
		"a resource over 200":   event(requestA, valid(map[string]any{"resource": "notes/" + strings.Repeat("a", 200)})),
		"an uppercase id":       event(strings.ToUpper(requestA), valid(map[string]any{"requestId": strings.ToUpper(requestA)})),
		"the nil UUID":          event(uuid.Nil.String(), valid(map[string]any{"requestId": uuid.Nil.String()})),
		"not a UUID":            event("request-1", valid(map[string]any{"requestId": "request-1"})),
		"a numeric account":     event(requestA, valid(map[string]any{"account": 7})),
		"data that is a list":   event(requestA, []string{requestA}),
		"the key is not the id": event(requestB, valid(nil)),
	} {
		t.Run(name, func(t *testing.T) { assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, body)) })
	}
	for name, scope := range map[string]permissionScope{
		"an undeclared account":         {"github", writeReport.action, writeReport.resource},
		"an undeclared action":          {controlledAccount, "delete_note", writeReport.resource},
		"a resource outside the action": {controlledAccount, writeReport.action, "channels/general"},
		"a wildcard resource":           {controlledAccount, writeReport.action, "notes/*"},
	} {
		t.Run(name, func(t *testing.T) {
			assertErrorCode(t, f.requestPermission(t, claim, requestA, scope), capabilityNotSupportedCode)
		})
	}
	assertSnapshotUnchanged(t, f.pool, before, "rejected Permission requests")
}

func TestPermissionRequested_IsAcceptedOnlyFromARunningRound(t *testing.T) {
	t.Run("claimed", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Not started")
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.requestPermission(t, claim, requestA, writeReport), eventOutOfOrderCode)
		assertSnapshotUnchanged(t, f.pool, before, "a request before the Round started")
	})
	t.Run("a stale epoch", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.runningRound(t, "Stale")
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.reportEvent(t, claim.RoundId, permissionEvent(t, requestA, claim.ClaimEpoch+1, requestA, writeReport)), staleClaimEpochCode)
		assertSnapshotUnchanged(t, f.pool, before, "a request at a stale epoch")
	})
	t.Run("ended", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.runningRound(t, "Delivered")
		f.deliverThroughAPI(t, claim.RoundId)
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.requestPermission(t, claim, requestA, writeReport), roundNotOpenCode)
		assertSnapshotUnchanged(t, f.pool, before, "a request after the Round ended")
	})
	t.Run("waiting on a question", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.waitingRound(t, "Asking")
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.requestPermission(t, claim, requestA, writeReport), eventOutOfOrderCode)
		assertSnapshotUnchanged(t, f.pool, before, "a request while a question waits")
	})
	t.Run("while Stop is requested", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, "Stopping")
		f.mustStop(t, queued.Id)
		f.mustRequestPermission(t, claim, requestA, writeReport)
		ticket := f.ticket(t, queued.Id)
		if ticket.OpenRound == nil || ticket.OpenRound.WaitingReason != WaitingStopping || ticket.OpenRound.PermissionRequest == nil {
			t.Fatalf("openRound = %+v, want waiting on the request with Stopping outranking it", ticket.OpenRound)
		}
		if d := ticket.AllowedActions.PermissionDecision; d.Available || d.Reason == nil || d.Reason.Code != stopAlreadyRequestedCode {
			t.Fatalf("allowedActions.permissionDecision = %+v, want refused with %s", d, stopAlreadyRequestedCode)
		}
	})
}

func TestApprove_RecordsTheGrantAndQueuesAnApprovalCommandWithoutMovingTheRound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Approve me")
	approved := runnerEpoch.Add(20 * time.Second)
	f.clock.Set(approved)
	f.heartbeat(t, f.token, http.StatusOK)
	before := readTicketRowFacts(t, f.pool, queued.Id)

	ticket := f.mustApprove(t, queued.Id, claim.RoundId, requestA)
	assertPermissionWait(t, ticket, claim, WaitingResuming, decisionOf(PermissionApproved))
	request := ticket.OpenRound.PermissionRequest
	if !request.DecidedAt.Equal(approved) {
		t.Fatalf("decidedAt = %v, want %v", request.DecidedAt, approved)
	}
	if len(ticket.PermissionGrants) != 1 {
		t.Fatalf("grants = %+v, want one", ticket.PermissionGrants)
	}
	grant := ticket.PermissionGrants[0]
	wantGrant := PermissionGrant{Id: *request.GrantId, Agent: TicketAssigneeAgent{Id: f.agent.Id, Name: f.agent.Name, Kind: f.agent.Kind},
		Account: writeReport.account, Action: new(writeReport.action), Resource: new(writeReport.resource), SubstituteAccount: true,
		Form: PermissionGrantFormTicket, State: PermissionGrantActive, RoundId: claim.RoundId, CreatedAt: approved, ApprovedAt: approved}
	if !reflect.DeepEqual(grant, wantGrant) {
		t.Fatalf("grant = %+v, want %+v", grant, wantGrant)
	}
	if d := ticket.AllowedActions.PermissionDecision; d.Available || d.Reason == nil || d.Reason.Code != permissionAlreadyDecidedCode {
		t.Fatalf("allowedActions.permissionDecision = %+v, want refused with %s", d, permissionAlreadyDecidedCode)
	}
	if !reflect.DeepEqual(f.ticket(t, queued.Id), ticket) {
		t.Fatalf("the approval's response differs from a read of the Ticket")
	}
	if after := readTicketRowFacts(t, f.pool, queued.Id); !reflect.DeepEqual(after, before) {
		t.Fatalf("the approval changed the Ticket row: before %+v, after %+v", before, after)
	}
	if rows := roundRows(t, f.pool); len(rows) != 1 || rows[0].state != string(RoundWaitingForInput) {
		t.Fatalf("Rounds = %+v, want the Round still waiting", rows)
	}

	commands := f.mustCommands(t, claim.RoundId)
	rows := roundCommandRows(t, f)
	want := []RunnerCommand{{Id: rows[0].commandID, Type: RunnerCommandApproval, ClaimEpoch: claim.ClaimEpoch, IssuedAt: approved,
		Approval: &RunnerCommandApprovalData{RequestId: requestA, GrantId: grant.Id}}}
	if !reflect.DeepEqual(commands, want) {
		t.Fatalf("commands = %+v, want %+v", commands, want)
	}
	decodeAck(t, f.ack(t, claim.RoundId, commands[0].Id, RunnerCommandApplied))
	if got := f.ticket(t, queued.Id); got.Status != Blocked || got.OpenRound.State != OpenRoundWaitingForInput {
		t.Fatalf("the ack moved the Ticket: %s %+v", got.Status, got.OpenRound)
	}
}

func TestResumed_AfterApprovalContinuesTheSameRoundToDelivery(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Resume me")
	grantID := f.mustApprove(t, queued.Id, claim.RoundId, requestA).PermissionGrants[0].Id
	rec := f.mustResumeApproval(t, claim, requestA)
	want := fmt.Sprintf(`{"requestId":%q,"roundId":%q,"startedAt":%q,"state":"running","type":"resumed"}`, requestA, claim.RoundId, runnerEpoch.Format(time.RFC3339Nano))
	if rec.Body.String() != want {
		t.Fatalf("body = %s, want %s", rec.Body.String(), want)
	}
	ticket := f.ticket(t, queued.Id)
	if ticket.Status != InProgress || ticket.OpenRound == nil || ticket.OpenRound.Id != claim.RoundId || ticket.OpenRound.State != OpenRoundRunning ||
		ticket.OpenRound.PermissionRequest != nil || ticket.OpenRound.WaitingReason != WaitingWorking {
		t.Fatalf("Ticket after resuming = %s %+v, want In Progress with the same Round running", ticket.Status, ticket.OpenRound)
	}
	if d := ticket.AllowedActions.PermissionDecision; d.Available || d.Reason == nil || d.Reason.Code != permissionDecisionNotAvailableCode {
		t.Fatalf("allowedActions.permissionDecision = %+v, want %s", d, permissionDecisionNotAvailableCode)
	}
	if replay := f.resumeApproval(t, claim, requestA); replay.Code != http.StatusOK || replay.Body.String() != want {
		t.Fatalf("replayed resume: status=%d body=%s", replay.Code, replay.Body.String())
	}

	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)
	f.mustReport(t, claim.RoundId, progressEvent(t, claim.RoundId+":perform:1", claim.ClaimEpoch, eventOccurredAt, "Performed write_note on notes/weekly-report"))
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)
	f.mustReport(t, claim.RoundId, progressEvent(t, claim.RoundId+":perform:2", claim.ClaimEpoch, eventOccurredAt, "Performed write_note on notes/weekly-report"))
	f.deliver(t, claim)

	if got := f.ticket(t, queued.Id); got.Status != InReview || got.OpenRound != nil || len(got.PermissionGrants) != 1 {
		t.Fatalf("Ticket after delivery = %s %+v grants %+v, want In Review keeping its grant", got.Status, got.OpenRound, got.PermissionGrants)
	}
	rounds := decodeRounds(t, f.listRounds(t, queued.Id))
	if len(rounds) != 1 || rounds[0].Id != claim.RoundId || rounds[0].State != RoundDelivered || len(rounds[0].PermissionRequests) != 1 ||
		rounds[0].AuthorityCheckCount != 2 || len(rounds[0].Activity) != 2 {
		t.Fatalf("Rounds = %+v, want the one Round delivered with one request, two checks and two performances", rounds)
	}
	if n := tableRowCount(t, f.pool, "permission_requests"); n != 1 {
		t.Fatalf("permission_requests rows = %d, want 1", n)
	}
}

func TestResumed_NeedsTheApprovalOfTheRequestTheRoundWaitsOn(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Not yet")
	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.resumeApproval(t, claim, requestA), http.StatusConflict, approvalNotSuppliedCode, approvalNotSuppliedMessage)
	assertErrorBody(t, f.resume(t, claim, questionA), http.StatusConflict, answerNotSuppliedCode, answerNotSuppliedMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a resume before the approval")

	f.mustApprove(t, queued.Id, claim.RoundId, requestA)
	before = databaseSnapshot(t, f.pool)
	assertErrorCode(t, f.resumeApproval(t, claim, requestB), approvalNotSuppliedCode)
	assertErrorCode(t, f.reportEvent(t, claim.RoundId, approvalResumedEvent(t, "stale", claim.ClaimEpoch+1, requestA)), staleClaimEpochCode)
	assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, jsonText(t, map[string]any{"type": "resumed", "idempotencyKey": "x", "claimEpoch": claim.ClaimEpoch, "occurredAt": eventOccurredAt,
		"data": map[string]any{"requestId": requestA, "questionId": questionA}})))
	assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, jsonText(t, map[string]any{"type": "resumed", "idempotencyKey": "x", "claimEpoch": claim.ClaimEpoch, "occurredAt": eventOccurredAt,
		"data": map[string]any{"requestId": requestA, "grantId": requestB}})))
	assertSnapshotUnchanged(t, f.pool, before, "resumes that are not the approved request's")

	t.Run("a Round waiting on a question", func(t *testing.T) {
		g := newClaimFixture(t)
		asking, waiting := g.waitingRound(t, "Asking")
		g.mustAnswer(t, asking.Id, waiting.RoundId, questionA)
		assertErrorCode(t, g.resumeApproval(t, waiting, requestA), approvalNotSuppliedCode)
	})
}

func TestPermissionDecision_TheFirstDecisionWins(t *testing.T) {
	for _, tc := range []struct{ first, second string }{
		{"approve", "approve"}, {"approve", "decline"}, {"decline", "approve"}, {"decline", "decline"},
	} {
		t.Run(tc.first+" then "+tc.second, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.permissionRound(t, "Decide twice")
			decide := map[string]func(t *testing.T, ticketID, roundID, requestID string) *httptest.ResponseRecorder{"approve": f.approve, "decline": f.decline}
			if rec := decide[tc.first](t, queued.Id, claim.RoundId, requestA); rec.Code != http.StatusOK {
				t.Fatalf("%s: %d %s", tc.first, rec.Code, rec.Body.String())
			}
			before := databaseSnapshot(t, f.pool)
			assertErrorBody(t, decide[tc.second](t, queued.Id, claim.RoundId, requestA), http.StatusBadRequest, permissionAlreadyDecidedCode, permissionAlreadyDecidedMessage)
			assertSnapshotUnchanged(t, f.pool, before, "a second decision")
		})
	}
}

func TestPermissionDecision_ConcurrentDecisionsRecordExactlyOne(t *testing.T) {
	outcomes := map[PermissionRequestDecision]int{}
	for trial := range 6 {
		f := newClaimFixture(t)
		queued, claim := f.permissionRound(t, fmt.Sprintf("Race %d", trial))
		codes, bodies := sendConcurrently(8, func(i int) *httptest.ResponseRecorder {
			if i%2 == 0 {
				return f.approve(t, queued.Id, claim.RoundId, requestA)
			}
			return f.decline(t, queued.Id, claim.RoundId, requestA)
		})
		winner := -1
		for i, code := range codes {
			switch {
			case code == http.StatusOK && winner == -1:
				winner = i
			case code == http.StatusBadRequest && strings.Contains(bodies[i], permissionAlreadyDecidedCode):
			default:
				t.Fatalf("trial %d response %d: status=%d body=%s", trial, i, code, bodies[i])
			}
		}
		if winner == -1 {
			t.Fatalf("trial %d: no decision recorded: %v", trial, bodies)
		}
		want := map[bool]PermissionRequestDecision{true: PermissionApproved, false: PermissionDeclined}[winner%2 == 0]
		got := f.ticket(t, queued.Id)
		if d := got.OpenRound.PermissionRequest.Decision; d == nil || *d != want {
			t.Fatalf("trial %d: stored decision %v, want the winner's %s", trial, d, want)
		}
		grants, commands := tableRowCount(t, f.pool, "permission_grants"), f.mustCommands(t, claim.RoundId)
		if approved := want == PermissionApproved; (grants == 1) != approved || (len(commands) == 1) != approved || grants > 1 || len(commands) > 1 {
			t.Fatalf("trial %d: %s left %d grants and commands %+v", trial, want, grants, commands)
		}
		outcomes[want]++
	}
	t.Logf("%v", outcomes)
}

func TestDecline_LeavesTheRoundWaitingWithNoGrantOrCommandAndStopStillEndsIt(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Decline me")
	before := readTicketRowFacts(t, f.pool, queued.Id)
	ticket := f.mustDecline(t, queued.Id, claim.RoundId, requestA)
	assertPermissionWait(t, ticket, claim, WaitingForPermission, decisionOf(PermissionDeclined))
	if len(ticket.PermissionGrants) != 0 || tableRowCount(t, f.pool, "permission_grants") != 0 {
		t.Fatalf("a decline created a grant: %+v", ticket.PermissionGrants)
	}
	if d := ticket.AllowedActions.PermissionDecision; d.Available || d.Reason == nil || d.Reason.Code != permissionAlreadyDecidedCode {
		t.Fatalf("allowedActions.permissionDecision = %+v", d)
	}
	if !ticket.AllowedActions.Stop.Available {
		t.Fatalf("Stop is not offered after a decline: %+v", ticket.AllowedActions.Stop)
	}
	if got := f.mustCommands(t, claim.RoundId); len(got) != 0 {
		t.Fatalf("commands after a decline = %+v, want none", got)
	}
	if after := readTicketRowFacts(t, f.pool, queued.Id); !reflect.DeepEqual(after, before) {
		t.Fatalf("the decline changed the Ticket row: before %+v, after %+v", before, after)
	}

	afterDecline := databaseSnapshot(t, f.pool)
	assertErrorCode(t, f.resumeApproval(t, claim, requestA), approvalNotSuppliedCode)
	assertErrorCode(t, f.requestPermission(t, claim, requestB, writeReport), eventOutOfOrderCode)
	assertErrorCode(t, f.raise(t, claim, questionA), eventOutOfOrderCode)
	assertErrorCode(t, f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport), roundNotRunningCode)
	assertSnapshotUnchanged(t, f.pool, afterDecline, "a resume, a new request, a question and a check after a decline")
	assertTicketLockedWhileWaiting(t, f, queued.Id, claim.RoundId)

	f.mustStop(t, queued.Id)
	f.assertWaitingReason(t, queued.Id, WaitingStopping)
	f.mustConfirmStop(t, claim)
	assertStoppedTicket(t, f.ticket(t, queued.Id), stoppedBadgeOf(t, f))
	round := f.roundOf(t, queued.Id)
	if round.State != RoundStopped || len(round.PermissionRequests) != 1 || round.PermissionRequests[0].Decision == nil || *round.PermissionRequests[0].Decision != PermissionDeclined {
		t.Fatalf("listed Round = %+v, want stopped keeping its declined request", round)
	}
}

func TestPermissionDecision_IsRefusedOnceStopIsRequestedAndAfterTheRoundEnds(t *testing.T) {
	for _, decision := range []string{"approve", "decline"} {
		t.Run(decision, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.permissionRound(t, "Stop the request")
			decide := map[string]func(t *testing.T, ticketID, roundID, requestID string) *httptest.ResponseRecorder{"approve": f.approve, "decline": f.decline}[decision]
			stopping := f.mustStop(t, queued.Id)
			if stopping.OpenRound == nil || stopping.OpenRound.WaitingReason != WaitingStopping {
				t.Fatalf("openRound after Stop = %+v, want Stopping", stopping.OpenRound)
			}
			if d := stopping.AllowedActions.PermissionDecision; d.Available || d.Reason == nil || d.Reason.Code != stopAlreadyRequestedCode {
				t.Fatalf("allowedActions.permissionDecision = %+v, want refused with %s", d, stopAlreadyRequestedCode)
			}
			before := databaseSnapshot(t, f.pool)
			assertErrorBody(t, decide(t, queued.Id, claim.RoundId, requestA), http.StatusBadRequest, stopAlreadyRequestedCode, permissionStopRequestedMessage)
			assertSnapshotUnchanged(t, f.pool, before, "a decision once Stop is requested")

			f.mustConfirmStop(t, claim)
			after := databaseSnapshot(t, f.pool)
			assertErrorBody(t, decide(t, queued.Id, claim.RoundId, requestA), http.StatusBadRequest, roundNotOpenCode, roundNotOpenMessage)
			assertErrorCode(t, f.resumeApproval(t, claim, requestA), roundNotOpenCode)
			assertSnapshotUnchanged(t, f.pool, after, "a late decision after the Round stopped")
			if n := tableRowCount(t, f.pool, "permission_grants"); n != 0 {
				t.Fatalf("grants = %d after a refused late approval", n)
			}
		})
	}
	t.Run("an approved request of a Round that ended later", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim := f.permissionRound(t, "Ended")
		f.mustApprove(t, queued.Id, claim.RoundId, requestA)
		f.mustResumeApproval(t, claim, requestA)
		f.deliver(t, claim)
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.approve(t, queued.Id, claim.RoundId, requestA), permissionAlreadyDecidedCode)
		assertSnapshotUnchanged(t, f.pool, before, "a replayed approval after delivery")
	})
}

func TestApprove_RacingStopLeavesEitherAStoppingRoundWithNoGrantOrBothCommands(t *testing.T) {
	outcomes := map[string]int{}
	for trial := range 8 {
		f := newClaimFixture(t)
		queued, claim := f.permissionRound(t, fmt.Sprintf("Race %d", trial))
		codes, bodies := sendConcurrently(2, func(i int) *httptest.ResponseRecorder {
			if i == 0 {
				return f.stop(t, queued.Id)
			}
			return f.approve(t, queued.Id, claim.RoundId, requestA)
		})
		if codes[0] != http.StatusOK {
			t.Fatalf("trial %d: stop: %d %s", trial, codes[0], bodies[0])
		}
		commands := f.mustCommands(t, claim.RoundId)
		grants := tableRowCount(t, f.pool, "permission_grants")
		switch codes[1] {
		case http.StatusOK:
			if len(commands) != 2 || commands[0].Type != RunnerCommandStop || commands[1].Type != RunnerCommandApproval || grants != 1 {
				t.Fatalf("trial %d: commands = %+v grants=%d, want the Stop first, then the approval, and one grant", trial, commands, grants)
			}
			outcomes["approved first"]++
		case http.StatusBadRequest:
			if !strings.Contains(bodies[1], stopAlreadyRequestedCode) || len(commands) != 1 || grants != 0 {
				t.Fatalf("trial %d: approve %s, commands %+v, grants %d", trial, bodies[1], commands, grants)
			}
			outcomes["stopped first"]++
		default:
			t.Fatalf("trial %d: approve: %d %s", trial, codes[1], bodies[1])
		}
		f.mustConfirmStop(t, claim)
		if got := f.ticket(t, queued.Id); got.Status != Backlog {
			t.Fatalf("trial %d: Ticket after the Stop = %s", trial, got.Status)
		}
	}
	t.Logf("%v", outcomes)
}

func TestPermissionDecision_UnknownForeignAndMismatchedIdsAreTheSameNotFound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Mine")
	other := f.queue(t, "Another of mine")
	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	theirs, theirClaim := foreign.permissionRound(t, "Theirs")

	before := databaseSnapshot(t, f.pool)
	for _, decision := range []string{"approve", "decline"} {
		for name, path := range map[string]string{
			"an unknown Ticket":             permissionPath(uuid.NewString(), claim.RoundId, requestA, decision),
			"an unknown Round":              permissionPath(queued.Id, uuid.NewString(), requestA, decision),
			"an unknown request":            permissionPath(queued.Id, claim.RoundId, requestB, decision),
			"another Ticket of the Owner's": permissionPath(other.Id, claim.RoundId, requestA, decision),
			"another Owner's request":       permissionPath(theirs.Id, theirClaim.RoundId, requestA, decision),
			"another Owner's Round on mine": permissionPath(queued.Id, theirClaim.RoundId, requestA, decision),
			"a malformed Ticket id":         permissionPath("not-a-uuid", claim.RoundId, requestA, decision),
			"a malformed request id":        permissionPath(queued.Id, claim.RoundId, "request-1", decision),
			"another Owner's, uppercase":    permissionPath(strings.ToUpper(theirs.Id), strings.ToUpper(theirClaim.RoundId), strings.ToUpper(requestA), decision),
		} {
			t.Run(decision+": "+name, func(t *testing.T) {
				rec := f.do(t, runnerCall{method: http.MethodPost, path: path, body: map[string]string{"approve": `{"form":"ticket"}`}[decision], cookie: f.cookie})
				assertErrorBody(t, rec, http.StatusNotFound, "not_found", permissionRequestNotFoundMessage)
			})
		}
		path := permissionPath(queued.Id, claim.RoundId, requestA, decision)
		assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: path, body: `{"form":"ticket"}`}))
		assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: path, body: `{"form":"ticket"}`, token: f.token}))
	}
	assertSnapshotUnchanged(t, f.pool, before, "decisions that are not the Owner's")
}

func TestApprove_TheBodyIsDecodedStrictly(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Strict approval")
	before := databaseSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"no body":                        "",
		"no form":                        `{}`,
		"a time form":                    `{"form":"time"}`,
		"a full form":                    `{"form":"full"}`,
		"a null form":                    `{"form":null}`,
		"an uppercase form":              `{"form":"Ticket"}`,
		"an extra field":                 `{"form":"ticket","grantId":"x"}`,
		"a null expiry":                  `{"form":"ticket","expiresAt":null}`,
		"a time form with a null expiry": `{"form":"time","expiresAt":null}`,
		"a date expiry":                  `{"form":"time","expiresAt":"2026-10-05"}`,
		"a numeric expiry":               `{"form":"time","expiresAt":1790000000}`,
		"an expiry with no zone":         `{"form":"time","expiresAt":"2026-10-05T00:00:00"}`,
		"trailing data":                  `{"form":"ticket"} {}`,
		"not JSON":                       `form=ticket`,
	} {
		t.Run(name, func(t *testing.T) {
			assertInvalidRequest(t, f.do(t, runnerCall{method: http.MethodPost, path: permissionPath(queued.Id, claim.RoundId, requestA, "approve"), body: body, cookie: f.cookie}))
		})
	}
	assertSnapshotUnchanged(t, f.pool, before, "malformed approvals")
}

func TestWaitingReason_AWaitingForAPermissionFollowsTheDecisionStopAndRunnerContact(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Reasons")
	f.assertWaitingReason(t, queued.Id, WaitingForPermission)
	f.mustApprove(t, queued.Id, claim.RoundId, requestA)
	f.assertWaitingReason(t, queued.Id, WaitingResuming)
	f.clock.Set(runnerEpoch.Add(time.Hour))
	f.assertWaitingReason(t, queued.Id, WaitingRunnerDisconnected)
}

func TestPermissionDecision_TakesTheTicketRowThenTheRequestRow(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Lock order")
	ctx := context.Background()
	holder, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if _, err := holder.Exec(ctx, `SELECT 1 FROM tickets WHERE public_id = $1::uuid FOR UPDATE`, queued.Id); err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- f.approve(t, queued.Id, claim.RoundId, requestA) }()
	waitForLockWaiter(t, f.pool, "FOR UPDATE")
	probe, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := probe.Exec(ctx, `SELECT 1 FROM permission_requests WHERE request_id = $1::uuid FOR UPDATE NOWAIT`, requestA); err != nil {
		t.Fatalf("the waiting approval already holds the request row: %v", err)
	}
	_ = probe.Rollback(ctx)
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if rec := <-result; rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s, want 200 once the lock is released", rec.Code, rec.Body.String())
	}
}

func TestPermissions_TheDatabaseEnforcesTheRequestGrantAndWaitInvariants(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.permissionRound(t, "Constraints")
	ownerID, roundID := roundRowIDs(t, f, claim.RoundId)
	ctx := context.Background()
	exec := func(sql string, args ...any) error {
		_, err := f.pool.Exec(ctx, sql, args...)
		return err
	}
	insertRequest := func(requestID, resource, decision, decidedAt string) error {
		return exec(`INSERT INTO permission_requests (owner_id, ticket_id, agent_id, round_id, request_id, account, action, resource, requested_at, decision, decided_at)
			SELECT owner_id, ticket_id, agent_id, id, $2::uuid, 'controlled', 'write_note', $3, now(), $4, `+decidedAt+` FROM rounds WHERE id = $1`,
			roundID, requestID, resource, nullable(decision))
	}
	for _, tc := range []struct {
		name, requestID, resource, decision, decidedAt, constraint string
	}{
		{"a second undecided request", requestB, "notes/a", "", "NULL", "permission_requests_one_undecided_per_round"},
		{"the same request id", requestA, "notes/a", "declined", "now()", "permission_requests_request_unique"},
		{"a decision without a time", requestB, "notes/a", "approved", "NULL", "permission_requests_decided_together"},
		{"a time without a decision", requestB, "notes/a", "", "now()", "permission_requests_decided_together"},
		{"another decision", requestB, "notes/a", "maybe", "now()", "permission_requests_decision"},
		{"a decision before the request", requestB, "notes/a", "declined", "now() - interval '1 hour'", "permission_requests_decided_after_requested"},
		{"an empty resource", requestB, "", "declined", "now()", "permission_requests_resource_length"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertViolates(t, insertRequest(tc.requestID, tc.resource, tc.decision, tc.decidedAt), tc.constraint)
		})
	}
	t.Run("a request for another Agent of the Round", func(t *testing.T) {
		other := createAgentForTest(t, f.handler, f.cookie, "Other", AgentKindResearch)
		assertViolates(t, exec(`INSERT INTO permission_requests (owner_id, ticket_id, agent_id, round_id, request_id, account, action, resource, requested_at, decision, decided_at)
			SELECT r.owner_id, r.ticket_id, a.id, r.id, $2::uuid, 'controlled', 'write_note', 'notes/a', now(), 'declined', now() FROM rounds r, agents a WHERE r.id = $1 AND a.public_id = $3::uuid`,
			roundID, requestB, other.Id), "permission_requests_round_agent_fk")
	})

	var requestRowID int64
	if err := f.pool.QueryRow(ctx, `SELECT id FROM permission_requests WHERE request_id = $1::uuid`, requestA).Scan(&requestRowID); err != nil {
		t.Fatal(err)
	}
	t.Run("the Round waits on exactly one ask", func(t *testing.T) {
		assertViolates(t, exec(`UPDATE rounds SET waiting_permission_request_id = NULL WHERE id = $1`, roundID), "rounds_waits_on_one_ask")
		assertViolates(t, exec(`UPDATE rounds SET state = 'running' WHERE id = $1`, roundID), "rounds_waits_on_one_ask")
		var questionRowID int64
		if err := f.pool.QueryRow(ctx, `INSERT INTO round_questions (owner_id, round_id, question_id, text, asked_at, answer, answered_at)
			VALUES ($1, $2, $3::uuid, 'q', now(), 'a', now()) RETURNING id`, ownerID, roundID, questionA).Scan(&questionRowID); err != nil {
			t.Fatal(err)
		}
		assertViolates(t, exec(`UPDATE rounds SET waiting_question_id = $2 WHERE id = $1`, roundID, questionRowID), "rounds_waits_on_one_ask")
		assertViolates(t, exec(`UPDATE rounds SET waiting_question_id = $2, waiting_permission_request_id = NULL WHERE id = $1`, roundID, questionRowID+1000), "rounds_waiting_question_fk")
	})
	insertGrant := func(form, state, resource, approvedAt string) error {
		return exec(`INSERT INTO permission_grants (owner_id, public_id, ticket_id, agent_id, request_id, account, action, resource, form, state, created_at, approved_at)
			SELECT owner_id, gen_random_uuid(), ticket_id, agent_id, id, account, action, $2, $3, $4, now(), `+approvedAt+` FROM permission_requests WHERE id = $1`,
			requestRowID, resource, form, state)
	}
	assertViolates(t, insertGrant("full", "active", writeReport.resource, "now()"), "permission_grants_form")
	assertViolates(t, insertGrant("ticket", "ended", writeReport.resource, "now()"), "permission_grants_state")
	assertViolates(t, insertGrant("ticket", "active", "notes/other", "now()"), "permission_grants_request_scope_fk")
	assertViolates(t, insertGrant("ticket", "active", writeReport.resource, "now() + interval '1 second'"), "permission_grants_approved_at_creation")
	assertViolates(t, exec(`INSERT INTO permission_grants (owner_id, public_id, ticket_id, agent_id, request_id, account, action, resource, form, state, created_at, approved_at)
		SELECT p.owner_id, gen_random_uuid(), t.id, p.agent_id, p.id, p.account, p.action, p.resource, 'ticket', 'active', now(), now()
		FROM permission_requests p, tickets t WHERE p.id = $1 AND t.public_id = $2::uuid`, requestRowID, f.queue(t, "Other Ticket").Id), "permission_grants_request_scope_fk")

	f.mustApprove(t, queued.Id, claim.RoundId, requestA)
	assertViolates(t, insertGrant("ticket", "active", writeReport.resource, "now()"), "permission_grants_request_id_key")
	command := func(commandType string, requestID any) error {
		return exec(`INSERT INTO round_commands (owner_id, round_id, public_id, type, claim_epoch, issued_at, permission_request_id)
			VALUES ($1, $2, gen_random_uuid(), $3, 1, now(), $4)`, ownerID, roundID, commandType, requestID)
	}
	assertViolates(t, command("approval", nil), "round_commands_permission_request_follows_type")
	assertViolates(t, command("stop", requestRowID), "round_commands_permission_request_follows_type")
	assertViolates(t, command("approval", requestRowID), "round_commands_one_approval_per_request")
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
