package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/routers/legacy"
)

type lockedTicketFixture struct {
	*claimFixture
	locked, anchor   Ticket
	otherAgent       Agent
	attached, spare  Badge
	claim            RunnerClaim
	validateContract func(t *testing.T, call runnerCall) *httptest.ResponseRecorder
}

func newLockedTicketFixture(t *testing.T) *lockedTicketFixture {
	t.Helper()
	f := &lockedTicketFixture{claimFixture: newClaimFixture(t)}
	f.otherAgent = createAgentForTest(t, f.handler, f.cookie, "Second", AgentKindResearch)
	body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/badges", `{"name":"attached"}`, http.StatusCreated)
	f.attached = decodeAs[Badge](t, body)
	body, _, _ = badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/badges", `{"name":"spare"}`, http.StatusCreated)
	f.spare = decodeAs[Badge](t, body)
	f.locked = f.queue(t, "locked")
	badgeRequest(t, f.handler, f.cookie, http.MethodPut, "/api/tickets/"+f.locked.Id+"/badges/"+f.attached.Id, "", http.StatusOK)
	f.anchor = f.queue(t, "anchor")
	f.claim = f.mustClaim(t)
	if f.claim.Ticket.Id != f.locked.Id {
		t.Fatalf("claimed %s, want %s", f.claim.Ticket.Id, f.locked.Id)
	}
	router, err := legacy.NewRouter(loadContract(t))
	if err != nil {
		t.Fatal(err)
	}
	f.validateContract = func(t *testing.T, call runnerCall) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(call.method, call.path, strings.NewReader(call.body))
		if call.body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		req.AddCookie(f.cookie)
		rec := httptest.NewRecorder()
		f.handler.ServeHTTP(rec, req)
		validateAgainstContract(t, router, req, rec)
		return rec
	}
	return f
}

func assertRoundOpen(t *testing.T, rec *httptest.ResponseRecorder, roundID string) {
	t.Helper()
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	body := assertErrorCode(t, rec, roundOpenCode)
	want := ErrorDetail{Code: roundOpenCode, Message: roundOpenMessage, RoundId: &roundID}
	if !reflect.DeepEqual(body.Error, want) {
		t.Fatalf("error = %+v, want %+v", body.Error, want)
	}
}

type lockedTicketSnapshot struct {
	ticket Ticket
	row    ticketRowFacts
	rounds []roundRow
}

func (f *lockedTicketFixture) snapshot(t *testing.T) lockedTicketSnapshot {
	t.Helper()
	return lockedTicketSnapshot{ticket: f.ticket(t, f.locked.Id), row: readTicketRowFacts(t, f.pool, f.locked.Id), rounds: roundRows(t, f.pool)}
}

func TestOpenRoundLock_EveryMutationRejectedWhileOpenAndAcceptedOnceClosed(t *testing.T) {
	type mutation struct {
		name  string
		call  func(f *lockedTicketFixture) runnerCall
		setUp func(t *testing.T, f *lockedTicketFixture)
	}
	ticketPath := func(f *lockedTicketFixture, suffix string) string { return "/api/tickets/" + f.locked.Id + suffix }
	patch := func(field string) func(f *lockedTicketFixture) runnerCall {
		return func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPatch, path: ticketPath(f, ""), body: fmt.Sprintf(`{%q:"changed while locked"}`, field)}
		}
	}
	mutations := []mutation{
		{name: "title", call: patch("title")},
		{name: "goal", call: patch("goal")},
		{name: "context", call: patch("context")},
		{name: "successCriteria", call: patch("successCriteria")},
		{name: "constraints", call: patch("constraints")},
		{name: "repository", call: patch("repository")},
		{name: "assign the Owner", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPut, path: ticketPath(f, "/assignee"), body: `{"type":"owner"}`}
		}},
		{name: "reassign to another Agent", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPut, path: ticketPath(f, "/assignee"), body: assignAgentBody(f.otherAgent.Id)}
		}},
		{name: "unassign", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodDelete, path: ticketPath(f, "/assignee")}
		}},
		{name: "attach a Badge", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPut, path: ticketPath(f, "/badges/"+f.spare.Id)}
		}},
		{name: "detach a Badge", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodDelete, path: ticketPath(f, "/badges/"+f.attached.Id)}
		}},
		{name: "status change", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPost, path: ticketPath(f, "/status"), body: `{"status":"Backlog"}`}
		}},
		{name: "Accept", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPost, path: ticketPath(f, "/accept")}
		}, setUp: func(t *testing.T, f *lockedTicketFixture) {
			setTicketStatusDirect(t, f.pool, resolveTestOwner(t, f.pool), f.locked.Id, InReview)
		}},
		{name: "reorder", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPost, path: ticketPath(f, "/position"), body: fmt.Sprintf(`{"after":%q}`, f.anchor.Id)}
		}},
		{name: "archive", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPost, path: ticketPath(f, "/archive")}
		}},
	}
	for _, m := range mutations {
		t.Run(m.name, func(t *testing.T) {
			f := newLockedTicketFixture(t)
			if m.setUp != nil {
				m.setUp(t, f)
			}
			call := m.call(f)
			before := f.snapshot(t)
			assertRoundOpen(t, f.validateContract(t, call), f.claim.RoundId)
			if after := f.snapshot(t); !reflect.DeepEqual(after, before) {
				t.Fatalf("rejected %s changed state:\nbefore %+v\nafter  %+v", m.name, before, after)
			}

			deliverRoundDirect(t, f.pool, f.claim.RoundId)
			if rec := f.validateContract(t, call); rec.Code != http.StatusOK {
				t.Fatalf("%s after the Round closed: status=%d body=%s", m.name, rec.Code, rec.Body.String())
			}
		})
	}
}

// Template has no write path at all (D4, M8), so the lock does not
// change its existing rejection.
func TestOpenRoundLock_TemplateStaysUnchangeable(t *testing.T) {
	f := newLockedTicketFixture(t)
	before := f.snapshot(t)
	rec := f.do(t, runnerCall{method: http.MethodPatch, path: "/api/tickets/" + f.locked.Id, body: `{"template":"Coding"}`, cookie: f.cookie})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("template change while locked: status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec, "invalid_request")
	if after := f.snapshot(t); !reflect.DeepEqual(after, before) {
		t.Fatalf("rejected template change changed state:\nbefore %+v\nafter  %+v", before, after)
	}
}

func TestOpenRoundLock_RestoreIsUnaffected(t *testing.T) {
	f := newLockedTicketFixture(t)
	rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + f.locked.Id + "/restore", cookie: f.cookie})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("restore of a locked, unarchived Ticket: status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec, notArchivedCode)
}

func TestOpenRoundLock_OtherTicketsMayStillBeMovedAroundIt(t *testing.T) {
	f := newLockedTicketFixture(t)
	before := readTicketRowFacts(t, f.pool, f.locked.Id)
	f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + f.anchor.Id + "/position", body: fmt.Sprintf(`{"before":%q}`, f.locked.Id), cookie: f.cookie}, http.StatusOK)
	f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + f.anchor.Id + "/status", body: `{"status":"Backlog"}`, cookie: f.cookie}, http.StatusOK)
	if after := readTicketRowFacts(t, f.pool, f.locked.Id); !reflect.DeepEqual(after, before) {
		t.Fatalf("moving another Ticket changed the locked one: before %+v, after %+v", before, after)
	}
}

func TestTicketAllowedActions_MatchCommandsWhileARoundIsOpen(t *testing.T) {
	f := newClaimFixture(t)
	ownerID := resolveTestOwner(t, f.pool)
	for _, template := range []TicketTemplate{Basic, Coding} {
		for _, from := range allTicketStatuses {
			t.Run(fmt.Sprintf("%s/%s", template, from), func(t *testing.T) {
				body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets",
					fmt.Sprintf(`{"title":%q,"template":%q,"goal":"g","successCriteria":"s"}`, t.Name(), template), http.StatusCreated)
				id := decodeAs[Ticket](t, body).Id
				badgeRequest(t, f.handler, f.cookie, http.MethodPut, "/api/tickets/"+id+"/assignee", assignAgentBody(f.agent.Id), http.StatusOK)
				badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+id+"/status", `{"status":"Ready"}`, http.StatusOK)
				claim := f.mustClaim(t)
				if claim.Ticket.Id != id {
					t.Fatalf("claimed %s, want %s", claim.Ticket.Id, id)
				}
				t.Cleanup(func() {
					deliverRoundDirect(t, f.pool, claim.RoundId)
					badgeRequest(t, f.handler, f.cookie, http.MethodDelete, "/api/tickets/"+id+"/assignee", "", http.StatusOK)
				})
				setTicketStatusDirect(t, f.pool, ownerID, id, from)
				ticket := f.ticket(t, id)
				advertised := ticket.AllowedActions
				want := ErrorDetail{Code: roundOpenCode, Message: roundOpenMessage, RoundId: &claim.RoundId}
				if len(advertised.StatusChanges) != 0 || len(advertised.StatusChangeRejections) != 0 || advertised.Accept.Available ||
					advertised.Accept.Reason == nil || !reflect.DeepEqual(*advertised.Accept.Reason, want) {
					t.Fatalf("advertised = %+v, want nothing offered and Accept refused with %+v", advertised, want)
				}
				if ticket.RequestingAgentWork {
					t.Error("a locked Ticket requests Agent work")
				}
				for _, target := range allTicketStatuses {
					rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/status", body: fmt.Sprintf(`{"status":%q}`, target), cookie: f.cookie})
					if rec.Code != http.StatusBadRequest || !reflect.DeepEqual(decodeErrorBody(t, rec).Error, want) {
						t.Errorf("%s -> %s not advertised, command status %d %s", from, target, rec.Code, rec.Body.String())
					}
				}
				rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/accept", cookie: f.cookie})
				if rec.Code != http.StatusBadRequest || !reflect.DeepEqual(decodeErrorBody(t, rec).Error, *advertised.Accept.Reason) {
					t.Errorf("Accept from %s: advertised %+v, command %d %s", from, *advertised.Accept.Reason, rec.Code, rec.Body.String())
				}
				if got := readTicketRowFacts(t, f.pool, id); got.status != string(from) {
					t.Errorf("Status after rejected commands = %s, want %s", got.status, from)
				}
			})
		}
	}
}

func decodeErrorBody(t *testing.T, rec *httptest.ResponseRecorder) ErrorBody {
	t.Helper()
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not an ErrorBody: %v", rec.Body.String(), err)
	}
	return body
}

func TestClaimAndUnassign_RaceEitherOrder(t *testing.T) {
	f := newClaimFixture(t)
	outcomes := map[string]int{}
	for trial := 0; trial < 300 && (outcomes["unassign won"] < 10 || outcomes["claim won"] < 10); trial++ {
		queued := f.queue(t, fmt.Sprintf("race %d", trial))
		unassign := runnerCall{method: http.MethodDelete, path: "/api/tickets/" + queued.Id + "/assignee", cookie: f.cookie}
		var claimRec, unassignRec *httptest.ResponseRecorder
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); <-start; claimRec = f.claim(t) }()
		jitter := time.Duration(rand.IntN(800)) * time.Microsecond
		go func() { defer wg.Done(); <-start; time.Sleep(jitter); unassignRec = f.do(t, unassign) }()
		close(start)
		wg.Wait()

		ticket := f.ticket(t, queued.Id)
		switch {
		case claimRec.Code == http.StatusCreated && unassignRec.Code == http.StatusBadRequest:
			claim := decodeClaim(t, claimRec)
			assertRoundOpen(t, unassignRec, claim.RoundId)
			if claim.Ticket.Id != queued.Id || ticket.AssigneeAgent == nil || ticket.AssigneeAgent.Id != f.agent.Id || ticket.OpenRound == nil || ticket.OpenRound.Id != claim.RoundId {
				t.Fatalf("trial %d: claim won but Ticket = %+v, claim = %+v", trial, ticket, claim)
			}
			outcomes["claim won"]++
			deliverRoundDirect(t, f.pool, claim.RoundId)
			if rec := f.do(t, unassign); rec.Code != http.StatusOK {
				t.Fatalf("unassign after the Round closed: status=%d body=%s", rec.Code, rec.Body.String())
			}
		case claimRec.Code == http.StatusNoContent && unassignRec.Code == http.StatusOK:
			if ticket.AssigneeType != "" || ticket.OpenRound != nil {
				t.Fatalf("trial %d: unassign won but Ticket = %+v", trial, ticket)
			}
			for _, row := range roundRows(t, f.pool) {
				if row.ticketID == queued.Id {
					t.Fatalf("trial %d: unassign won but the Ticket has a Round %+v", trial, row)
				}
			}
			outcomes["unassign won"]++
		default:
			t.Fatalf("trial %d: claim %d %s, unassign %d %s; want exactly one to win", trial, claimRec.Code, claimRec.Body.String(), unassignRec.Code, unassignRec.Body.String())
		}
	}
	t.Logf("outcomes: %v", outcomes)
	if outcomes["unassign won"] == 0 || outcomes["claim won"] == 0 {
		t.Fatalf("only one order was observed: %v", outcomes)
	}
}

func TestClaim_EditWaitingOnTheClaimSeesItsRound(t *testing.T) {
	f := newClaimFixture(t)
	queued := f.queue(t, "claimed first")
	ctx := context.Background()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT 1 FROM tickets WHERE public_id = $1::uuid FOR UPDATE`, queued.Id); err != nil {
		t.Fatal(err)
	}
	claimed := make(chan *httptest.ResponseRecorder, 1)
	go func() { claimed <- f.claim(t) }()
	waitForLockWaiters(t, f.pool, "FOR UPDATE", 1)
	edited := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		edited <- f.do(t, runnerCall{method: http.MethodPatch, path: "/api/tickets/" + queued.Id, body: `{"goal":"changed"}`, cookie: f.cookie})
	}()
	waitForLockWaiters(t, f.pool, "FOR UPDATE", 2)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	claim := decodeClaim(t, <-claimed)
	assertRoundOpen(t, <-edited, claim.RoundId)
	if got := f.ticket(t, queued.Id); got.Goal != queued.Goal {
		t.Fatalf("goal = %q after the edit lost to the claim", got.Goal)
	}
}
