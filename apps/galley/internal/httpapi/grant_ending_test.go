package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

var readNote = permissionScope{account: controlledAccount, action: "read_note", resource: "notes/a"}

func (f *claimFixture) grantOnRound(t *testing.T, ticketID string, claim RunnerClaim, requestID string, scope permissionScope, approval string) string {
	t.Helper()
	f.mustRequestPermission(t, claim, requestID, scope)
	_, grantID := f.mustApproveWith(t, ticketID, claim.RoundId, requestID, approval)
	f.mustResumeApproval(t, claim, requestID)
	return grantID
}

func (f *claimFixture) grantStates(t *testing.T, ticketID string) map[string]PermissionGrant {
	t.Helper()
	grants := map[string]PermissionGrant{}
	for _, g := range f.ticket(t, ticketID).PermissionGrants {
		grants[g.Id] = g
	}
	return grants
}

func assertEnded(t *testing.T, g PermissionGrant, at time.Time) {
	t.Helper()
	if g.State != PermissionGrantEndedAtDone || g.EndedAt == nil || !g.EndedAt.Equal(at) || g.RevokedAt != nil || g.ExpiresAt != nil || g.RemainingSeconds != nil ||
		g.AllowedActions.Revoke.Available || g.AllowedActions.Revoke.Reason == nil || g.AllowedActions.Revoke.Reason.Code != grantEndedCode || len(g.CoveredOpenRounds) != 0 {
		t.Fatalf("grant = %+v, want ended at Done at %v, never expired or revoked, with revoke refused as %s", g, at, grantEndedCode)
	}
}

func assertStillActive(t *testing.T, g PermissionGrant) {
	t.Helper()
	if g.State != PermissionGrantActive || g.EndedAt != nil || !g.AllowedActions.Revoke.Available {
		t.Fatalf("grant = %+v, want active", g)
	}
}

func (f *claimFixture) acceptRejected(t *testing.T, id string, status int) *httptest.ResponseRecorder {
	t.Helper()
	return f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/accept", cookie: f.cookie}, status)
}

func TestDone_EndsEveryTicketGrantOfTheTicketAndNothingElse(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Grants end")
	ticketBody := `{"form":"ticket"}`
	scoped := f.grantOnRound(t, queued.Id, claim, requestA, writeReport, ticketBody)
	second := f.grantOnRound(t, queued.Id, claim, requestB, readNote, ticketBody)
	full := f.grantOnRound(t, queued.Id, claim, uuid.NewString(), postGeneral, fullApprovalBody(t, PermissionGrantFormTicket, time.Time{}))
	timed := f.grantOnRound(t, queued.Id, claim, uuid.NewString(), permissionScope{controlledAccount, "post_message", "channels/release-notes"}, timeApprovalBody(t, runnerEpoch.Add(time.Hour)))
	revoked := f.grantOnRound(t, queued.Id, claim, uuid.NewString(), permissionScope{controlledAccount, "write_note", "notes/other"}, ticketBody)
	f.mustRevoke(t, revoked)
	f.ackAll(t, claim.RoundId)

	f.deliver(t, claim)
	other, otherClaim := f.runningRound(t, "Other Ticket")
	otherGrant := f.grantOnRound(t, other.Id, otherClaim, uuid.NewString(), writeReport, ticketBody)
	otherTimed := f.grantOnRound(t, other.Id, otherClaim, uuid.NewString(), readNote, timeApprovalBody(t, runnerEpoch.Add(time.Hour)))
	f.ackAll(t, otherClaim.RoundId)

	for id, g := range f.grantStates(t, queued.Id) {
		if id != revoked && id != otherGrant {
			assertStillActive(t, g)
		}
	}

	doneAt := runnerEpoch.Add(11 * time.Second)
	f.clock.Set(doneAt)
	accepted := f.mustAccept(t, queued.Id)
	for _, id := range []string{scoped, second, full} {
		assertEnded(t, grantOf(t, accepted.PermissionGrants, id), doneAt)
	}
	if g := grantOf(t, accepted.PermissionGrants, timed); g.State != PermissionGrantActive || g.EndedAt != nil {
		t.Fatalf("time grant = %+v, want untouched by Done", g)
	}
	if g := grantOf(t, accepted.PermissionGrants, revoked); g.State != PermissionGrantRevoked || g.EndedAt != nil {
		t.Fatalf("revoked grant = %+v, want still revoked and never ended", g)
	}
	if !equalGrants(accepted.PermissionGrants, f.ticket(t, queued.Id).PermissionGrants) {
		t.Fatalf("accept returned %s, the read returns %s", jsonText(t, accepted.PermissionGrants), jsonText(t, f.ticket(t, queued.Id).PermissionGrants))
	}

	if g := f.grantStates(t, other.Id)[otherGrant]; g.State != PermissionGrantActive {
		t.Fatalf("another Ticket's grant = %+v, want untouched by this Ticket's Done", g)
	}
	assertDecision(t, f.mustCheck(t, otherClaim, writeReport), AuthorityAllow, otherGrant)
	assertDecision(t, f.mustCheck(t, otherClaim, readNote), AuthorityAllow, otherTimed)

	if rec := f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport); rec.Code != http.StatusConflict {
		t.Fatalf("a check on the delivered Round after Done = %d %s, want 409: nothing runs on a Done Ticket", rec.Code, rec.Body.String())
	}
	var ended int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM permission_grants WHERE state = 'ended_at_done' AND ended_at = $1`, doneAt).Scan(&ended); err != nil || ended != 3 {
		t.Fatalf("grants ended at Done = %d (%v), want 3", ended, err)
	}
}

func equalGrants(a, b []PermissionGrant) bool {
	return reflect.DeepEqual(a, b)
}

func TestDone_EndsTheGrantsOfEveryAgentTheTicketHeld(t *testing.T) {
	f := newClaimFixture(t)
	queued, first := f.runningRound(t, "Two Agents")
	grantA := f.grantOnRound(t, queued.Id, first, requestA, writeReport, `{"form":"ticket"}`)
	f.deliver(t, first)
	f.mustRework(t, queued.Id)

	agentB := createAgentForTest(t, f.handler, f.cookie, "Second", AgentKindResearch)
	f.changeStatus(t, queued.Id, Backlog)
	f.expect(t, runnerCall{method: http.MethodPut, path: "/api/tickets/" + queued.Id + "/assignee", body: assignAgentBody(agentB.Id), cookie: f.cookie}, http.StatusOK)
	f.changeStatus(t, queued.Id, Ready)
	second := f.mustClaim(t)
	f.startRound(t, second, second.RoundId+":0")
	grantB := f.grantOnRound(t, queued.Id, second, requestB, writeReport, `{"form":"ticket"}`)
	f.deliver(t, second)

	read := f.ticket(t, queued.Id)
	if len(read.PermissionGrants) != 2 || grantOf(t, read.PermissionGrants, grantA).Agent.Id == grantOf(t, read.PermissionGrants, grantB).Agent.Id {
		t.Fatalf("grants = %+v, want one per Agent", read.PermissionGrants)
	}
	doneAt := runnerEpoch.Add(5 * time.Second)
	f.clock.Set(doneAt)
	accepted := f.mustAccept(t, queued.Id)
	assertEnded(t, grantOf(t, accepted.PermissionGrants, grantA), doneAt)
	assertEnded(t, grantOf(t, accepted.PermissionGrants, grantB), doneAt)
}

func TestDone_ReopenedRoundsDenyEndedGrantsAndKeepTimeGrants(t *testing.T) {
	for _, form := range grantForms {
		t.Run(form.name, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, first, grantID := form.grant(t, f, "Reopen "+form.name)
			endsAtDone := form.name == "ticket" || form.name == "full ticket"
			assertDecision(t, f.mustCheck(t, first, writeReport), AuthorityAllow, grantID)
			f.deliver(t, first)
			doneAt := runnerEpoch.Add(3 * time.Second)
			f.clock.Set(doneAt)
			f.mustAccept(t, queued.Id)
			if f.changeStatus(t, queued.Id, Ready).Status != Ready {
				t.Fatalf("Done -> Ready failed")
			}
			second := f.mustClaim(t)
			if second.Ticket.Id != queued.Id || second.Sequence != 2 {
				t.Fatalf("claim = %+v, want Round 2 of the reopened Ticket", second)
			}
			f.startRound(t, second, second.RoundId+":0")

			grant := f.grantStates(t, queued.Id)[grantID]
			if !endsAtDone {
				assertStillActive(t, grant)
				assertDecision(t, f.mustCheck(t, second, writeReport), AuthorityAllow, grantID)
				return
			}
			assertEnded(t, grant, doneAt)
			assertExpiredDeny(t, f.mustCheck(t, second, writeReport), "")
			if form.name == "full ticket" {
				assertExpiredDeny(t, f.mustCheck(t, second, readNote), "")
			}
			assertErrorCode(t, f.revoke(t, grantID), grantEndedCode)
			if g := f.grantStates(t, queued.Id)[grantID]; g.State != PermissionGrantEndedAtDone {
				t.Fatalf("grant after a rejected revoke = %+v, want still ended", g)
			}
		})
	}
}

func TestDone_AFreshGrantAfterReopeningWorksAndTheEndedOneStaysEnded(t *testing.T) {
	f := newClaimFixture(t)
	queued, first, oldGrant := grantForms[0].grant(t, f, "Fresh grant")
	f.deliver(t, first)
	doneAt := runnerEpoch.Add(4 * time.Second)
	f.clock.Set(doneAt)
	f.mustAccept(t, queued.Id)
	f.changeStatus(t, queued.Id, Ready)
	second := f.mustClaim(t)
	f.startRound(t, second, second.RoundId+":0")

	assertExpiredDeny(t, f.mustCheck(t, second, writeReport), "")
	f.mustRequestPermission(t, second, requestB, writeReport)
	waiting := f.ticket(t, queued.Id)
	if waiting.Status != Blocked || waiting.OpenRound == nil || waiting.OpenRound.WaitingReason != WaitingForPermission {
		t.Fatalf("Ticket = %s %+v, want Blocked waiting for a Permission again", waiting.Status, waiting.OpenRound)
	}
	if g := grantOf(t, waiting.PermissionGrants, oldGrant); g.State != PermissionGrantEndedAtDone || len(g.CoveredOpenRounds) != 0 {
		t.Fatalf("ended grant = %+v, want ended and covering no open Round", g)
	}

	f.clock.Set(doneAt.Add(time.Minute))
	_, fresh := f.mustApproveWith(t, queued.Id, second.RoundId, requestB, `{"form":"ticket"}`)
	f.mustResumeApproval(t, second, requestB)
	if fresh == oldGrant {
		t.Fatalf("the fresh grant reuses the ended grant %s", oldGrant)
	}
	assertDecision(t, f.mustCheck(t, second, writeReport), AuthorityAllow, fresh)
	states := f.grantStates(t, queued.Id)
	assertEnded(t, states[oldGrant], doneAt)
	assertStillActive(t, states[fresh])
	if len(states) != 2 {
		t.Fatalf("grants = %+v, want the ended grant and the fresh one", states)
	}
	f.deliver(t, second)
	f.mustAccept(t, queued.Id)
	assertEnded(t, f.grantStates(t, queued.Id)[fresh], doneAt.Add(time.Minute))
}

func TestDone_AnEndedGrantIsNeverRenewedNorNamedAsExpired(t *testing.T) {
	f := newClaimFixture(t)
	queued, first, oldGrant := grantForms[0].grant(t, f, "Not renewable")
	f.deliver(t, first)
	f.mustAccept(t, queued.Id)
	f.changeStatus(t, queued.Id, Ready)
	second := f.mustClaim(t)
	f.startRound(t, second, second.RoundId+":0")

	assertExpiredDeny(t, f.mustCheck(t, second, writeReport), "")
	assertErrorCode(t, f.requestRenewal(t, second, requestB, writeReport, oldGrant), invalidRenewalCode)
	if tableRowCount(t, f.pool, "permission_requests") != 1 {
		t.Fatalf("a rejected renewal recorded a request")
	}
}

func TestRework_TicketGrantsSurviveReviewAndAdditionalRounds(t *testing.T) {
	f := newClaimFixture(t)
	queued, first, grantID := grantForms[0].grant(t, f, "Rework")
	f.deliver(t, first)
	assertStillActive(t, f.grantStates(t, queued.Id)[grantID])
	f.mustRework(t, queued.Id)
	second := f.mustClaim(t)
	f.startRound(t, second, second.RoundId+":0")
	assertStillActive(t, f.grantStates(t, queued.Id)[grantID])
	assertDecision(t, f.mustCheck(t, second, writeReport), AuthorityAllow, grantID)
	f.deliver(t, second)
	f.mustRework(t, queued.Id)
	third := f.mustClaim(t)
	f.startRound(t, third, third.RoundId+":0")
	assertDecision(t, f.mustCheck(t, third, writeReport), AuthorityAllow, grantID)
}

func TestDone_ATimeGrantOnTheTicketStillAllowsOnThisAndAnotherTicketAfterDoneAndReopen(t *testing.T) {
	f := newClaimFixture(t)
	queued, first, timed := f.timeGrantRound(t, "Time grant", writeReport, runnerEpoch.Add(time.Hour))
	f.deliver(t, first)
	f.mustAccept(t, queued.Id)
	elsewhere := f.queue(t, "Elsewhere")
	other := f.mustClaim(t)
	if other.Ticket.Id != elsewhere.Id {
		t.Fatalf("claimed %s, want %s", other.Ticket.Id, elsewhere.Id)
	}
	f.startRound(t, other, other.RoundId+":0")
	assertDecision(t, f.mustCheck(t, other, writeReport), AuthorityAllow, timed)
	f.deliver(t, other)

	f.changeStatus(t, queued.Id, Ready)
	reopened := f.mustClaim(t)
	f.startRound(t, reopened, reopened.RoundId+":0")
	assertDecision(t, f.mustCheck(t, reopened, writeReport), AuthorityAllow, timed)
	assertStillActive(t, f.grantStates(t, queued.Id)[timed])
}

func TestDone_EveryPathToDoneEndsGrantsAndNoOtherPathExists(t *testing.T) {
	f := newClaimFixture(t)

	t.Run("a plain status change to Done is refused and ends nothing", func(t *testing.T) {
		queued, claim, grantID := grantForms[0].grant(t, f, "Plain")
		f.deliver(t, claim)
		assertErrorCode(t, f.statusChange(t, queued.Id, Done), invalidTransitionCode)
		if got := f.ticket(t, queued.Id); got.Status != InReview {
			t.Fatalf("status = %s, want InReview", got.Status)
		}
		assertStillActive(t, f.grantStates(t, queued.Id)[grantID])
	})

	t.Run("accepting an archived Ticket is refused and ends nothing", func(t *testing.T) {
		queued, claim, grantID := grantForms[0].grant(t, f, "Archived")
		f.deliver(t, claim)
		f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/archive", cookie: f.cookie}, http.StatusOK)
		f.acceptRejected(t, queued.Id, http.StatusBadRequest)
		assertStillActive(t, f.grantStates(t, queued.Id)[grantID])
	})

	t.Run("accepting from a state other than In Review is refused and ends nothing", func(t *testing.T) {
		queued, claim, grantID := grantForms[0].grant(t, f, "Running")
		f.acceptRejected(t, queued.Id, http.StatusBadRequest)
		assertStillActive(t, f.grantStates(t, queued.Id)[grantID])
		f.deliver(t, claim)
	})

	t.Run("archiving and restoring a Done Ticket leaves its grants ended", func(t *testing.T) {
		queued, claim, grantID := grantForms[0].grant(t, f, "Archive Done")
		f.deliver(t, claim)
		doneAt := runnerEpoch.Add(2 * time.Second)
		f.clock.Set(doneAt)
		f.mustAccept(t, queued.Id)
		f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/archive", cookie: f.cookie}, http.StatusOK)
		assertEnded(t, f.grantStates(t, queued.Id)[grantID], doneAt)
		restored := decodeTicketBody(t, f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/restore", cookie: f.cookie}, http.StatusOK))
		if restored.Status != Done {
			t.Fatalf("restored status = %s, want Done", restored.Status)
		}
		assertEnded(t, f.grantStates(t, queued.Id)[grantID], doneAt)
	})

	t.Run("accept is the one Status write that ends grants", func(t *testing.T) {
		queued, claim, grantID := grantForms[0].grant(t, f, "Accept")
		f.deliver(t, claim)
		f.mustAccept(t, queued.Id)
		if f.grantStates(t, queued.Id)[grantID].State != PermissionGrantEndedAtDone {
			t.Fatalf("accept did not end the grant")
		}
	})
}

func TestEveryTicketStatusWriteIsAccountedFor(t *testing.T) {
	accounted := map[string]int{
		"ticket_lifecycle.go":   1,
		"ticket_archive.go":     1,
		"round_endings.go":      1,
		"round_events.go":       1,
		"round_deliverables.go": 1,
		"round_questions.go":    1,
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	pattern := regexp.MustCompile(`UPDATE tickets SET status`)
	found := map[string]int{}
	for _, file := range files {
		if filepath.Ext(file) != ".go" || len(file) > 8 && file[len(file)-8:] == "_test.go" {
			continue
		}
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if n := len(pattern.FindAll(body, -1)); n > 0 {
			found[file] = n
		}
	}
	var got, want []string
	for file, n := range found {
		got = append(got, fmt.Sprintf("%s:%d", file, n))
	}
	for file, n := range accounted {
		want = append(want, fmt.Sprintf("%s:%d", file, n))
	}
	sort.Strings(got)
	sort.Strings(want)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("Status writes = %v, want %v: a new Status write must end ticket grants when it can produce Done, then be listed here", got, want)
	}
}

func TestDone_EndingAndTheStatusChangeCommitTogether(t *testing.T) {
	for _, tc := range []struct{ name, table, condition string }{
		{"the grants fail after the Ticket row changed", "permission_grants", "NEW.state = 'ended_at_done'"},
		{"the Ticket row fails after the grants ended", "tickets", "NEW.status = 'Done'"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim, grantID := grantForms[0].grant(t, f, "Atomic")
			f.deliver(t, claim)
			ctx := context.Background()
			if _, err := f.pool.Exec(ctx, `CREATE FUNCTION fail_done() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF `+tc.condition+` THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$`); err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(ctx, `CREATE TRIGGER fail_done BEFORE UPDATE ON `+tc.table+` FOR EACH ROW EXECUTE FUNCTION fail_done()`); err != nil {
				t.Fatal(err)
			}
			rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/accept", cookie: f.cookie})
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("accept = %d %s, want 503 from the injected failure", rec.Code, rec.Body.String())
			}
			if got := f.ticket(t, queued.Id); got.Status != InReview {
				t.Fatalf("status = %s after a failed accept, want InReview", got.Status)
			}
			assertStillActive(t, f.grantStates(t, queued.Id)[grantID])
			if _, err := f.pool.Exec(ctx, `DROP TRIGGER fail_done ON `+tc.table); err != nil {
				t.Fatal(err)
			}
			f.mustAccept(t, queued.Id)
			if f.grantStates(t, queued.Id)[grantID].State != PermissionGrantEndedAtDone {
				t.Fatalf("the retried accept did not end the grant")
			}
			if _, err := f.pool.Exec(ctx, `DROP FUNCTION fail_done()`); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDone_ConcurrentAcceptsEndTheGrantsOnce(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, grantID := grantForms[0].grant(t, f, "Twice")
	f.deliver(t, claim)
	const racers = 6
	codes := make(chan int, racers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			codes <- f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/accept", cookie: f.cookie}).Code
		}()
	}
	close(start)
	wg.Wait()
	close(codes)
	outcomes := map[int]int{}
	for code := range codes {
		outcomes[code]++
	}
	if outcomes[http.StatusOK] != 1 || outcomes[http.StatusBadRequest] != racers-1 {
		t.Fatalf("outcomes = %v, want one 200 and the rest 400", outcomes)
	}
	if f.grantStates(t, queued.Id)[grantID].State != PermissionGrantEndedAtDone {
		t.Fatalf("grant not ended")
	}
}

func TestDone_AcceptRacingARevokeLeavesTheGrantRevokedOrEndedAndTheResponseSaysWhich(t *testing.T) {
	f := newClaimFixture(t)
	for i := range 8 {
		queued, claim, grantID := grantForms[0].grant(t, f, fmt.Sprintf("Race %d", i))
		f.deliver(t, claim)
		start := make(chan struct{})
		var acceptCode, revokeCode int
		var revokeBody string
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			acceptCode = f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/accept", cookie: f.cookie}).Code
		}()
		go func() {
			defer wg.Done()
			<-start
			rec := f.revoke(t, grantID)
			revokeCode, revokeBody = rec.Code, rec.Body.String()
		}()
		close(start)
		wg.Wait()
		if acceptCode != http.StatusOK {
			t.Fatalf("accept = %d, want 200", acceptCode)
		}
		state := f.grantStates(t, queued.Id)[grantID].State
		switch {
		case revokeCode == http.StatusOK && state == PermissionGrantRevoked:
		case revokeCode == http.StatusBadRequest && state == PermissionGrantEndedAtDone:
		default:
			t.Fatalf("revoke = %d %s with the grant %s, want 200 and revoked or 400 and ended", revokeCode, revokeBody, state)
		}
	}
}

func TestDone_AnotherTicketsChecksKeepAllowingWhileThisTicketIsAccepted(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, _ := grantForms[0].grant(t, f, "Accepting")
	f.deliver(t, claim)
	other, otherClaim, otherGrant := func() (Ticket, RunnerClaim, string) {
		q, c := f.runningRound(t, "Checking")
		return q, c, f.grantOnRound(t, q.Id, c, requestB, writeReport, `{"form":"ticket"}`)
	}()
	_ = other

	stop := make(chan struct{})
	failures := make(chan string, 1)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			rec := f.check(t, otherClaim.RoundId, otherClaim.ClaimEpoch, writeReport)
			if rec.Code != http.StatusOK || !jsonContains(rec.Body.String(), otherGrant) {
				select {
				case failures <- fmt.Sprintf("%d %s", rec.Code, rec.Body.String()):
				default:
				}
				return
			}
		}
	}()
	f.mustAccept(t, queued.Id)
	close(stop)
	wg.Wait()
	select {
	case failure := <-failures:
		t.Fatalf("a check on another Ticket during the accept = %s, want allow by its own grant", failure)
	default:
	}
}

func jsonContains(body, needle string) bool {
	return regexp.MustCompile(regexp.QuoteMeta(needle)).MatchString(body)
}

func TestPermissionGrantsTable_EndedGrantsAreTicketFormOnlyAndTimestampedExactly(t *testing.T) {
	f := newClaimFixture(t)
	_, ticketClaim, ticketGrant := grantForms[0].grant(t, f, "Ticket form")
	f.deliver(t, ticketClaim)
	_, _, timeGrant := grantForms[1].grant(t, f, "Time form")
	ctx := context.Background()
	for _, tc := range []struct {
		name, grant, set, constraint string
	}{
		{"a time grant ended at Done", timeGrant, "state = 'ended_at_done', ended_at = approved_at + interval '1 second'", "permission_grants_only_ticket_form_ends_at_done"},
		{"an ended grant without its time", ticketGrant, "state = 'ended_at_done'", "permission_grants_ended_at_follows_state"},
		{"an active grant with an ending time", ticketGrant, "ended_at = approved_at + interval '1 second'", "permission_grants_ended_at_follows_state"},
		{"an ending before the approval", ticketGrant, "state = 'ended_at_done', ended_at = approved_at - interval '1 second'", "permission_grants_ended_after_approval"},
		{"an unknown state", ticketGrant, "state = 'ended'", "permission_grants_state"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.pool.Exec(ctx, `UPDATE permission_grants SET `+tc.set+` WHERE public_id = $1::uuid`, tc.grant)
			assertViolates(t, err, tc.constraint)
		})
	}
	if _, err := f.pool.Exec(ctx, `UPDATE permission_grants SET state = 'ended_at_done', ended_at = approved_at WHERE public_id = $1::uuid`, ticketGrant); err != nil {
		t.Fatalf("a well-formed ending: %v", err)
	}
}

func TestDone_AClockBehindTheApprovalRecordsTheEndingAtTheApproval(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, grantID := grantForms[0].grant(t, f, "Clock behind")
	f.deliver(t, claim)
	f.clock.Set(runnerEpoch.Add(-time.Hour))

	ended := f.grantStates(t, f.mustAccept(t, queued.Id).Id)[grantID]
	assertEnded(t, ended, ended.ApprovedAt)
}
