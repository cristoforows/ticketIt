package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func (f *claimFixture) listRounds(t *testing.T, ticketID string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodGet, path: "/api/tickets/" + ticketID + "/rounds", cookie: f.cookie})
}

func decodeRounds(t *testing.T, rec *httptest.ResponseRecorder) []TicketRound {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var list TicketRoundList
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	return list.Rounds
}

func TestListTicketRounds_ReportsTheOpenRoundAsItMoves(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Rounds")

	claimedAt := runnerEpoch
	want := TicketRound{Id: claim.RoundId, Sequence: 1, State: RoundClaimed, Agent: claim.Agent, ClaimedAt: claimedAt}
	got := decodeRounds(t, f.listRounds(t, queued.Id))
	if len(got) != 1 || got[0].Id != want.Id || got[0].Sequence != 1 || got[0].State != RoundClaimed || got[0].Agent != want.Agent ||
		!got[0].ClaimedAt.Equal(claimedAt) || got[0].StartedAt != nil || got[0].EndedAt != nil {
		t.Fatalf("rounds after the claim = %+v, want %+v", got, want)
	}

	startedAt := runnerEpoch.Add(5 * time.Second)
	f.clock.Set(startedAt)
	f.startRound(t, claim, "k")
	got = decodeRounds(t, f.listRounds(t, queued.Id))
	if len(got) != 1 || got[0].State != RoundRunning || got[0].StartedAt == nil || !got[0].StartedAt.Equal(startedAt) || got[0].EndedAt != nil {
		t.Fatalf("rounds after the event = %+v, want running, started at %v", got, startedAt)
	}
}

func TestListTicketRounds_NewestFirst(t *testing.T) {
	f := newClaimFixture(t)
	queued, first := f.claimTicket(t, "Twice")
	f.startRound(t, first, "k")
	backToReady := func() {
		t.Helper()
		if _, err := f.pool.Exec(context.Background(), `UPDATE tickets SET status = 'Ready'`); err != nil {
			t.Fatal(err)
		}
	}
	deliverRoundDirect(t, f.pool, first.RoundId)
	backToReady()
	second := f.mustClaim(t)
	if second.Ticket.Id != queued.Id || second.Sequence != 2 {
		t.Fatalf("second claim = %+v, want Round 2 of the same Ticket", second)
	}
	deliverRoundDirect(t, f.pool, second.RoundId)
	third := f.mustClaim(t)

	rounds := decodeRounds(t, f.listRounds(t, queued.Id))
	if len(rounds) != 3 {
		t.Fatalf("rounds = %+v, want 3", rounds)
	}
	for i, want := range []struct {
		id       string
		sequence int
		state    RoundState
		ended    bool
	}{{third.RoundId, 3, RoundClaimed, false}, {second.RoundId, 2, "delivered", true}, {first.RoundId, 1, "delivered", true}} {
		if rounds[i].Id != want.id || rounds[i].Sequence != want.sequence || rounds[i].State != want.state || (rounds[i].EndedAt != nil) != want.ended {
			t.Fatalf("rounds[%d] = %+v, want %+v", i, rounds[i], want)
		}
	}
}

func TestListTicketRounds_NoRoundsIsAnEmptyArray(t *testing.T) {
	f := newClaimFixture(t)
	queued := f.queue(t, "Never claimed")
	rec := f.listRounds(t, queued.Id)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"rounds":[]}` {
		t.Fatalf("status=%d body=%s, want 200 with an empty array", rec.Code, rec.Body.String())
	}
}

func TestListTicketRounds_WorksForAnArchivedTicket(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Archived")
	f.startRound(t, claim, "k")
	deliverRoundDirect(t, f.pool, claim.RoundId)
	if rec := f.archive(t, queued.Id); rec.Code != http.StatusOK {
		t.Fatalf("archive: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rounds := decodeRounds(t, f.listRounds(t, queued.Id)); len(rounds) != 1 || rounds[0].Id != claim.RoundId {
		t.Fatalf("rounds of an archived Ticket = %+v", rounds)
	}
}

func TestListTicketRounds_UnknownForeignAndMalformedTicketsAreTheSameNotFound(t *testing.T) {
	f := newClaimFixture(t)
	f.claimTicket(t, "Mine")
	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	theirs := foreign.queue(t, "Theirs")

	var want string
	for _, id := range []string{uuid.NewString(), theirs.Id, "not-a-uuid", uuid.Nil.String()} {
		rec := f.listRounds(t, id)
		assertErrorBody(t, rec, http.StatusNotFound, "not_found", "no ticket with that identifier")
		if want == "" {
			want = rec.Body.String()
		}
		if rec.Body.String() != want {
			t.Fatalf("not-found body %q differs from %q", rec.Body.String(), want)
		}
	}
	if rec := f.do(t, runnerCall{method: http.MethodGet, path: "/api/tickets/" + theirs.Id + "/rounds", cookie: foreignCookie}); rec.Code != http.StatusOK {
		t.Fatalf("the owner of the Ticket: status=%d", rec.Code)
	}
}

func TestListTicketRounds_RequiresAnOwnerSession(t *testing.T) {
	f := newClaimFixture(t)
	queued, _ := f.claimTicket(t, "Session only")
	path := "/api/tickets/" + queued.Id + "/rounds"
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodGet, path: path}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodGet, path: path, token: f.token}))
}

func TestListTicketRounds_IsReadOnly(t *testing.T) {
	f := newClaimFixture(t)
	queued, _ := f.claimTicket(t, "Read only")
	before := databaseSnapshot(t, f.pool)
	f.listRounds(t, queued.Id)
	assertSnapshotUnchanged(t, f.pool, before, "listing Rounds")
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		rec := f.expect(t, runnerCall{method: method, path: "/api/tickets/" + queued.Id + "/rounds", cookie: f.cookie}, http.StatusMethodNotAllowed)
		if rec.Header().Get("Allow") != "GET" {
			t.Fatalf("%s Allow = %q, want GET", method, rec.Header().Get("Allow"))
		}
	}
	if n := tableRowCount(t, f.pool, "rounds"); n != 1 {
		t.Fatalf("rounds = %d", n)
	}
}
