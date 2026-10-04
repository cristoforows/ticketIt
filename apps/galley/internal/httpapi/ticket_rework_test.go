package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (f *claimFixture) rework(t *testing.T, id string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/rework", cookie: f.cookie})
}

func (f *claimFixture) mustRework(t *testing.T, id string) Ticket {
	t.Helper()
	rec := f.rework(t, id)
	if rec.Code != http.StatusOK {
		t.Fatalf("rework: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	return decodeTicketBody(t, rec)
}

func (f *claimFixture) deliveredTicket(t *testing.T, title string) (Ticket, RunnerClaim) {
	t.Helper()
	queued, claim := f.runningRound(t, title)
	f.deliver(t, claim)
	return queued, claim
}

func roundSnapshot(t *testing.T, pool *pgxpool.Pool, roundID string) string {
	t.Helper()
	var out strings.Builder
	var row string
	if err := pool.QueryRow(context.Background(), `SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.id), '[]')::text FROM rounds x WHERE x.public_id = $1::uuid`, roundID).Scan(&row); err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(&out, "rounds=%s\n", row)
	for _, table := range []string{"round_events", "round_engine_references", "round_activity", "usage_observations", "round_deliverables", "round_feedback"} {
		if err := pool.QueryRow(context.Background(),
			`SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.id), '[]')::text FROM `+table+` x WHERE x.round_id = (SELECT id FROM rounds WHERE public_id = $1::uuid)`, roundID).Scan(&row); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&out, "%s=%s\n", table, row)
	}
	return out.String()
}

func TestDecideRework_AnswersEachCase(t *testing.T) {
	ready := func(kind AgentKind) ticketWorkflowState {
		return ticketWorkflowState{status: InReview, agentKind: kind, goal: "g", successCriteria: "s", repository: "owner/repo"}
	}
	with := func(state ticketWorkflowState, change func(*ticketWorkflowState)) ticketWorkflowState {
		change(&state)
		return state
	}
	type want struct {
		code    string
		missing []AgentReadinessInput
		roundID string
	}
	cases := []struct {
		name  string
		state ticketWorkflowState
		want  *want
	}{
		{"an Agent Ticket in In Review", ready(AgentKindCoding), nil},
		{"an archived Ticket", with(ready(AgentKindResearch), func(s *ticketWorkflowState) { s.archived = true }), &want{code: reworkNotAvailableCode}},
		{"an archived Ticket with an open Round", with(ready(AgentKindResearch), func(s *ticketWorkflowState) { s.archived, s.openRoundID = true, "r" }), &want{code: reworkNotAvailableCode}},
		{"a Ticket without an Agent", ready(""), &want{code: reworkNotAvailableCode}},
		{"an open Round", with(ready(AgentKindResearch), func(s *ticketWorkflowState) { s.openRoundID = "round-1" }), &want{code: reworkNotAvailableCode, roundID: "round-1"}},
		{"a missing goal", with(ready(AgentKindResearch), func(s *ticketWorkflowState) { s.goal = " " }), &want{code: agentReadinessIncompleteCode, missing: []AgentReadinessInput{AgentReadinessInputGoal}}},
		{"missing Success Criteria", with(ready(AgentKindResearch), func(s *ticketWorkflowState) { s.successCriteria = "" }), &want{code: agentReadinessIncompleteCode, missing: []AgentReadinessInput{AgentReadinessInputSuccessCriteria}}},
		{"a coding Agent without a repository", with(ready(AgentKindCoding), func(s *ticketWorkflowState) { s.repository = "" }), &want{code: agentReadinessIncompleteCode, missing: []AgentReadinessInput{AgentReadinessInputRepository}}},
		{"a research Agent without a repository", with(ready(AgentKindResearch), func(s *ticketWorkflowState) { s.repository = "" }), nil},
	}
	for _, status := range allTicketStatuses {
		if status != InReview {
			cases = append(cases, struct {
				name  string
				state ticketWorkflowState
				want  *want
			}{"status " + string(status), with(ready(AgentKindResearch), func(s *ticketWorkflowState) { s.status = status }), &want{code: reworkNotAvailableCode}})
		}
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decideRework(tc.state)
			if tc.want == nil {
				if got != nil {
					t.Fatalf("decideRework = %+v, want allowed", got)
				}
				return
			}
			if got == nil || got.code != tc.want.code || !reflect.DeepEqual(got.missing, tc.want.missing) || got.roundID != tc.want.roundID || got.message == "" {
				t.Fatalf("decideRework = %+v, want %+v with a message", got, tc.want)
			}
		})
	}
}

func TestRework_ReturnsAnAgentTicketInReviewToReadyAtTheBottomOfTheOrder(t *testing.T) {
	f := newClaimFixture(t)
	reworked, _ := f.deliveredTicket(t, "Reworked")
	first := f.queue(t, "First")
	second := f.queue(t, "Second")
	if got := f.ticket(t, reworked.Id); got.Status != InReview || got.RequestingAgentWork {
		t.Fatalf("delivered Ticket = %s requesting %t, want In Review and not requesting", got.Status, got.RequestingAgentWork)
	}

	got := f.mustRework(t, reworked.Id)
	if got.Status != Ready || !got.RequestingAgentWork || got.OpenRound != nil {
		t.Fatalf("reworked Ticket = %s requesting %t open Round %+v, want Ready and requesting", got.Status, got.RequestingAgentWork, got.OpenRound)
	}
	if rework := got.AllowedActions.Rework; rework.Available || rework.Reason == nil || rework.Reason.Code != reworkNotAvailableCode {
		t.Fatalf("rework advertised after rework = %+v, want unavailable with %s", rework, reworkNotAvailableCode)
	}
	rank := func(id string) int64 { return readTicketRowFacts(t, f.pool, id).rank }
	if rank(reworked.Id) <= rank(first.Id) || rank(reworked.Id) <= rank(second.Id) {
		t.Fatalf("ranks: reworked %d, first %d, second %d; want the reworked Ticket last", rank(reworked.Id), rank(first.Id), rank(second.Id))
	}

	var claimed []string
	for range 3 {
		claim := f.mustClaim(t)
		claimed = append(claimed, claim.Ticket.Id)
		f.deliverThroughAPI(t, claim.RoundId)
	}
	if want := []string{first.Id, second.Id, reworked.Id}; !equalStrings(claimed, want) {
		t.Fatalf("claim order = %v, want %v", claimed, want)
	}
}

func TestRework_TheNextClaimCreatesRound2AndRound1IsRetainedUnchanged(t *testing.T) {
	f := newClaimFixture(t)
	queued, first := f.runningRound(t, "Twice")
	f.mustReport(t, first.RoundId, progressEvent(t, "note-1", first.ClaimEpoch, eventOccurredAt, "first Round"))
	f.mustReport(t, first.RoundId, usageEvent(t, observationA, first.ClaimEpoch, usageData(observationA)))
	f.deliver(t, first)
	beforeRework := roundSnapshot(t, f.pool, first.RoundId)

	f.mustRework(t, queued.Id)
	if rounds := roundRows(t, f.pool); len(rounds) != 1 {
		t.Fatalf("rounds after rework = %+v, want only Round 1: rework creates no Round", rounds)
	}
	second := f.mustClaim(t)
	if second.Ticket.Id != queued.Id || second.RoundId == first.RoundId || second.Sequence != 2 || second.ClaimEpoch != 2 {
		t.Fatalf("second claim = %+v, want Round 2 of %s with a new ID and epoch 2", second, queued.Id)
	}
	f.startRound(t, second, "start-2")
	f.mustReport(t, second.RoundId, progressEvent(t, "note-2", second.ClaimEpoch, eventOccurredAt, "second Round"))
	f.mustReport(t, second.RoundId, usageEvent(t, observationB, second.ClaimEpoch, usageData(observationB)))
	f.mustReport(t, second.RoundId, deliveredEvent(t, "deliver-2", second.ClaimEpoch, deliverableData("Second result", "Second summary", "Second assessment")))

	if afterRound2 := roundSnapshot(t, f.pool, first.RoundId); afterRound2 != beforeRework {
		t.Fatalf("Round 1 changed:\nbefore:\n%s\nafter:\n%s", beforeRework, afterRound2)
	}
	rounds := decodeRounds(t, f.listRounds(t, queued.Id))
	if len(rounds) != 2 || rounds[0].Id != second.RoundId || rounds[1].Id != first.RoundId {
		t.Fatalf("rounds = %+v, want Round 2 then Round 1", rounds)
	}
	for i, want := range []struct{ body, note string }{{"Second result", "second Round"}, {deliveredBody, "first Round"}} {
		round := rounds[i]
		if round.State != RoundDelivered || round.Deliverable == nil || round.Deliverable.BodyMarkdown != want.body ||
			len(round.Activity) != 1 || round.Activity[0].Note != want.note || round.Usage.Observations != 1 {
			t.Fatalf("rounds[%d] = %+v, want its own delivered result %q, activity %q and one usage observation", i, round, want.body, want.note)
		}
	}
}

func TestRework_Round1EventsCannotAffectRound2(t *testing.T) {
	f := newClaimFixture(t)
	queued, first := f.runningRound(t, "Stale")
	f.mustReport(t, first.RoundId, progressEvent(t, "note-1", first.ClaimEpoch, eventOccurredAt, "first Round"))
	delivery := f.deliver(t, first)
	f.mustRework(t, queued.Id)
	second := f.mustClaim(t)
	f.startRound(t, second, "start-2")

	events := []struct{ name, body string }{
		{"execution_started", startedEvent("late-start", first.ClaimEpoch, eventOccurredAt, eventReference)},
		{"progress", progressEvent(t, "late-note", first.ClaimEpoch, eventOccurredAt, "late")},
		{"usage_observed", usageEvent(t, observationA, first.ClaimEpoch, usageData(observationA))},
		{"delivered", deliveredEvent(t, "late-delivery", first.ClaimEpoch, standardDeliverable())},
	}
	before := databaseSnapshot(t, f.pool)
	for _, event := range events {
		name, body := event.name, event.body
		t.Run(name+" to Round 1", func(t *testing.T) {
			assertErrorBody(t, f.reportEvent(t, first.RoundId, body), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
			assertSnapshotUnchanged(t, f.pool, before, "a Round 1 event after Round 2 opened")
		})
		t.Run(name+" to Round 2 with Round 1's epoch", func(t *testing.T) {
			assertErrorBody(t, f.reportEvent(t, second.RoundId, body), http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
			assertSnapshotUnchanged(t, f.pool, before, "a Round 2 event carrying Round 1's epoch")
		})
	}
	t.Run("replay of Round 1's delivery", func(t *testing.T) {
		replay := f.reportEvent(t, first.RoundId, standardDeliveredEvent(t, first))
		if replay.Code != http.StatusOK || replay.Body.String() != delivery.Body.String() {
			t.Fatalf("replay: status=%d body=%s, want 200 with the stored result %s", replay.Code, replay.Body.String(), delivery.Body.String())
		}
		assertSnapshotUnchanged(t, f.pool, before, "a replay of Round 1's delivery")
	})
	if got := f.ticket(t, queued.Id); got.OpenRound == nil || got.OpenRound.Id != second.RoundId || got.Status != InProgress {
		t.Fatalf("Ticket = %s %+v, want In Progress with Round 2 open", got.Status, got.OpenRound)
	}
}

func TestRework_NothingRestartsOrRequeuesADeliveredRound(t *testing.T) {
	f := newClaimFixture(t)
	queued, _ := f.deliveredTicket(t, "Delivered")
	for range 3 {
		assertNoWork(t, f.claim(t))
	}

	other := createAgentForTest(t, f.handler, f.cookie, "Other", AgentKindResearch)
	badgeRequest(t, f.handler, f.cookie, http.MethodPut, "/api/tickets/"+queued.Id+"/assignee", assignAgentBody(other.Id), http.StatusOK)
	if got := f.ticket(t, queued.Id); got.Status != InReview || got.RequestingAgentWork || got.AssigneeAgent == nil || got.AssigneeAgent.Id != other.Id {
		t.Fatalf("Ticket after reassignment = %s requesting %t agent %+v, want In Review, not requesting, assigned to the other Agent", got.Status, got.RequestingAgentWork, got.AssigneeAgent)
	}
	assertNoWork(t, f.claim(t))
	if rounds := roundRows(t, f.pool); len(rounds) != 1 || rounds[0].state != string(RoundDelivered) {
		t.Fatalf("rounds = %+v, want only the delivered Round", rounds)
	}

	f.mustRework(t, queued.Id)
	if claim := f.mustClaim(t); claim.Ticket.Id != queued.Id || claim.Sequence != 2 || claim.Agent.Id != other.Id {
		t.Fatalf("claim after rework = %+v, want Round 2 for the reassigned Agent", claim)
	}
}

type reworkCase struct {
	name     string
	setup    func(t *testing.T, f *claimFixture) string
	wantCode string
}

func agentTicketAt(status TicketStatus) func(t *testing.T, f *claimFixture) string {
	return func(t *testing.T, f *claimFixture) string {
		queued := f.queue(t, "At "+string(status))
		setTicketStatusDirect(t, f.pool, resolveTestOwner(t, f.pool), queued.Id, status)
		return queued.Id
	}
}

var reworkCases = []reworkCase{
	{"an Agent Ticket in In Review", func(t *testing.T, f *claimFixture) string {
		queued, _ := f.deliveredTicket(t, "Delivered")
		return queued.Id
	}, ""},
	{"a human-assigned Ticket in In Review", func(t *testing.T, f *claimFixture) string {
		body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets", `{"title":"Human","goal":"g","successCriteria":"s"}`, http.StatusCreated)
		id := decodeAs[Ticket](t, body).Id
		badgeRequest(t, f.handler, f.cookie, http.MethodPut, "/api/tickets/"+id+"/assignee", `{"type":"owner"}`, http.StatusOK)
		setTicketStatusDirect(t, f.pool, resolveTestOwner(t, f.pool), id, InReview)
		return id
	}, reworkNotAvailableCode},
	{"an Agent Ticket in Backlog", agentTicketAt(Backlog), reworkNotAvailableCode},
	{"an Agent Ticket in Ready", agentTicketAt(Ready), reworkNotAvailableCode},
	{"an Agent Ticket in In Progress", agentTicketAt(InProgress), reworkNotAvailableCode},
	{"an Agent Ticket in Blocked", agentTicketAt(Blocked), reworkNotAvailableCode},
	{"an Agent Ticket in Done", agentTicketAt(Done), reworkNotAvailableCode},
	{"a claimed Round", func(t *testing.T, f *claimFixture) string {
		queued, _ := f.claimTicket(t, "Claimed")
		return queued.Id
	}, reworkNotAvailableCode},
	{"a running Round", func(t *testing.T, f *claimFixture) string {
		queued, _ := f.runningRound(t, "Running")
		return queued.Id
	}, reworkNotAvailableCode},
	{"an archived Agent Ticket in In Review", func(t *testing.T, f *claimFixture) string {
		queued, _ := f.deliveredTicket(t, "Archived")
		badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+queued.Id+"/archive", "", http.StatusOK)
		return queued.Id
	}, reworkNotAvailableCode},
	{"an Agent Ticket in In Review whose goal was cleared", func(t *testing.T, f *claimFixture) string {
		queued, _ := f.deliveredTicket(t, "Cleared")
		badgeRequest(t, f.handler, f.cookie, http.MethodPatch, "/api/tickets/"+queued.Id, `{"goal":""}`, http.StatusOK)
		return queued.Id
	}, agentReadinessIncompleteCode},
}

func TestRework_RejectionsChangeNothing(t *testing.T) {
	for _, tc := range reworkCases {
		if tc.wantCode == "" {
			continue
		}
		t.Run(tc.name, func(t *testing.T) {
			f := newClaimFixture(t)
			id := tc.setup(t, f)
			before := databaseSnapshot(t, f.pool)
			rec := f.rework(t, id)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("rework: status=%d body=%s, want 400", rec.Code, rec.Body.String())
			}
			detail := assertErrorCode(t, rec, tc.wantCode).Error
			if detail.Message == "" {
				t.Fatalf("error = %+v, want a message", detail)
			}
			if tc.wantCode == agentReadinessIncompleteCode && !reflect.DeepEqual(detail.Missing, &[]AgentReadinessInput{AgentReadinessInputGoal}) {
				t.Fatalf("missing = %v, want [goal]", detail.Missing)
			}
			assertSnapshotUnchanged(t, f.pool, before, "a rejected rework")
		})
	}
}

func TestRework_UnknownMalformedAndForeignTicketsAreTheSameNotFoundAndUnauthenticatedIs401(t *testing.T) {
	f := newClaimFixture(t)
	f.deliveredTicket(t, "Mine")
	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	theirs, _ := foreign.deliveredTicket(t, "Theirs")

	before := databaseSnapshot(t, f.pool)
	for _, id := range []string{uuid.NewString(), "not-a-uuid", theirs.Id, strings.ToUpper(theirs.Id)} {
		assertTicketNotFound(t, f.rework(t, id))
	}
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + theirs.Id + "/rework"}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + theirs.Id + "/rework", token: f.token}))
	assertSnapshotUnchanged(t, f.pool, before, "a rework that is not the Owner's")
	if got := foreign.ticket(t, theirs.Id); got.Status != InReview {
		t.Fatalf("the other Owner's Ticket = %s, want In Review", got.Status)
	}
}

func TestRework_OnlyPostIsAllowed(t *testing.T) {
	f := newClaimFixture(t)
	queued, _ := f.deliveredTicket(t, "Methods")
	rec := f.expect(t, runnerCall{method: http.MethodGet, path: "/api/tickets/" + queued.Id + "/rework", cookie: f.cookie}, http.StatusMethodNotAllowed)
	if rec.Header().Get("Allow") != "POST" {
		t.Fatalf("Allow = %q, want POST", rec.Header().Get("Allow"))
	}
}

func TestRework_AllowedActionsEqualTheCommandsAnswer(t *testing.T) {
	for _, tc := range reworkCases {
		t.Run(tc.name, func(t *testing.T) {
			f := newClaimFixture(t)
			id := tc.setup(t, f)
			advertised := f.ticket(t, id).AllowedActions.Rework
			rec := f.rework(t, id)
			if tc.wantCode == "" {
				if !advertised.Available || advertised.Reason != nil || rec.Code != http.StatusOK {
					t.Fatalf("advertised %+v, command %d %s; want available and 200", advertised, rec.Code, rec.Body.String())
				}
				return
			}
			if advertised.Available || advertised.Reason == nil || rec.Code != http.StatusBadRequest || !reflect.DeepEqual(decodeErrorBody(t, rec).Error, *advertised.Reason) {
				t.Fatalf("advertised %+v, command %d %s; want unavailable with the command's error", advertised, rec.Code, rec.Body.String())
			}
			if advertised.Reason.Code != tc.wantCode {
				t.Fatalf("reason code = %s, want %s", advertised.Reason.Code, tc.wantCode)
			}
		})
	}
}

func TestRework_ConcurrentRequestsReturnTheTicketToReadyOnce(t *testing.T) {
	const requests = 8
	f := newClaimFixture(t)
	reworked, _ := f.deliveredTicket(t, "Reworked")
	other := f.queue(t, "Other")

	var codes []int
	var bodies []string
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		codes, bodies = sendConcurrently(requests, func(int) *httptest.ResponseRecorder { return f.rework(t, reworked.Id) })
	}()
	select {
	case <-finished:
	case <-time.After(20 * time.Second):
		t.Fatal("the concurrent rework requests did not finish within 20 s (deadlock)")
	}

	succeeded := 0
	for i, code := range codes {
		switch code {
		case http.StatusOK:
			succeeded++
		case http.StatusBadRequest:
			if !strings.Contains(bodies[i], reworkNotAvailableCode) {
				t.Fatalf("rejected rework body = %s, want %s", bodies[i], reworkNotAvailableCode)
			}
		default:
			t.Fatalf("rework %d: status=%d body=%s", i, code, bodies[i])
		}
	}
	if succeeded != 1 {
		t.Fatalf("%d requests succeeded (%v), want exactly one", succeeded, codes)
	}
	if got := f.ticket(t, reworked.Id); got.Status != Ready || !got.RequestingAgentWork {
		t.Fatalf("Ticket = %s requesting %t, want Ready and requesting", got.Status, got.RequestingAgentWork)
	}
	if readTicketRowFacts(t, f.pool, reworked.Id).rank <= readTicketRowFacts(t, f.pool, other.Id).rank {
		t.Fatal("the reworked Ticket is not after the other Ready Ticket")
	}
}

func TestRework_RacingAcceptEndsInExactlyOneOutcome(t *testing.T) {
	for trial := range 6 {
		f := newClaimFixture(t)
		queued, _ := f.deliveredTicket(t, "Racing")

		var reworkRec, acceptRec *httptest.ResponseRecorder
		finished := make(chan struct{})
		go func() {
			defer close(finished)
			sendConcurrently(2, func(i int) *httptest.ResponseRecorder {
				if i == 0 {
					reworkRec = f.rework(t, queued.Id)
					return reworkRec
				}
				acceptRec = f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/accept", cookie: f.cookie})
				return acceptRec
			})
		}()
		select {
		case <-finished:
		case <-time.After(20 * time.Second):
			t.Fatalf("trial %d: rework and Accept did not finish within 20 s (deadlock)", trial)
		}

		got := f.ticket(t, queued.Id)
		switch {
		case reworkRec.Code == http.StatusOK && acceptRec.Code == http.StatusBadRequest:
			assertErrorCode(t, acceptRec, invalidTransitionCode)
			if got.Status != Ready || !got.RequestingAgentWork {
				t.Fatalf("trial %d: rework won but the Ticket is %s requesting %t", trial, got.Status, got.RequestingAgentWork)
			}
		case acceptRec.Code == http.StatusOK && reworkRec.Code == http.StatusBadRequest:
			assertErrorCode(t, reworkRec, reworkNotAvailableCode)
			if got.Status != Done || got.RequestingAgentWork {
				t.Fatalf("trial %d: Accept won but the Ticket is %s requesting %t", trial, got.Status, got.RequestingAgentWork)
			}
		default:
			t.Fatalf("trial %d: rework %d %s, Accept %d %s; want exactly one to win", trial, reworkRec.Code, reworkRec.Body.String(), acceptRec.Code, acceptRec.Body.String())
		}
	}
}
