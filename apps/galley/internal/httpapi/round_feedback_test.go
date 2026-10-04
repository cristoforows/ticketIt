package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func feedbackPath(ticketID, roundID string) string {
	return "/api/tickets/" + ticketID + "/rounds/" + roundID + "/feedback"
}

func (f *claimFixture) addFeedback(t *testing.T, ticketID, roundID, body string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: feedbackPath(ticketID, roundID), body: jsonText(t, map[string]string{"body": body}), cookie: f.cookie})
}

func (f *claimFixture) mustAddFeedback(t *testing.T, ticketID, roundID, body string) Ticket {
	t.Helper()
	rec := f.addFeedback(t, ticketID, roundID, body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("feedback: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
	return decodeTicketBody(t, rec)
}

func (f *claimFixture) mustAccept(t *testing.T, id string) Ticket {
	t.Helper()
	return decodeTicketBody(t, f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/accept", cookie: f.cookie}, http.StatusOK))
}

func (f *claimFixture) doneTicket(t *testing.T, title string) (Ticket, RunnerClaim) {
	t.Helper()
	queued, claim := f.deliveredTicket(t, title)
	f.mustAccept(t, queued.Id)
	return queued, claim
}

type feedbackRow struct {
	roundID, body string
	consumedBy    *string
}

func feedbackRows(t *testing.T, f *claimFixture) []feedbackRow {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT r.public_id::text, x.body, c.public_id::text
		FROM round_feedback x JOIN rounds r ON r.id = x.round_id LEFT JOIN rounds c ON c.id = x.consumed_by_round_id ORDER BY x.id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []feedbackRow
	for rows.Next() {
		var row feedbackRow
		if err := rows.Scan(&row.roundID, &row.body, &row.consumedBy); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	return out
}

func claimedBodies(claim RunnerClaim) []string {
	bodies := []string{}
	for _, item := range claim.Ticket.Feedback {
		bodies = append(bodies, item.Body)
	}
	return bodies
}

func assertFeedbackAvailable(t *testing.T, ticket Ticket) {
	t.Helper()
	if a := ticket.AllowedActions.Feedback; !a.Available || a.Reason != nil {
		t.Fatalf("allowedActions.feedback = %+v, want available", a)
	}
}

func assertFeedbackUnavailable(t *testing.T, ticket Ticket) {
	t.Helper()
	if a := ticket.AllowedActions.Feedback; a.Available || a.Reason == nil || a.Reason.Code != feedbackNotAvailableCode {
		t.Fatalf("allowedActions.feedback = %+v, want %s", a, feedbackNotAvailableCode)
	}
}

func TestDecideFeedback_AnswersEachCase(t *testing.T) {
	reviewed := ticketWorkflowState{status: InReview, agentKind: AgentKindResearch, deliveredRoundID: "round-1"}
	with := func(change func(*ticketWorkflowState)) ticketWorkflowState {
		state := reviewed
		change(&state)
		return state
	}
	cases := []struct {
		name      string
		state     ticketWorkflowState
		delivered bool
		allowed   bool
		openID    string
	}{
		{"a delivered Round in In Review", reviewed, true, true, ""},
		{"a delivered Round in Done", with(func(s *ticketWorkflowState) { s.status = Done }), true, true, ""},
		{"a delivered Round while the latest is not", with(func(s *ticketWorkflowState) { s.deliveredRoundID = "" }), true, true, ""},
		{"an archived Ticket", with(func(s *ticketWorkflowState) { s.archived = true }), true, false, ""},
		{"a Ticket without an Agent", with(func(s *ticketWorkflowState) { s.agentKind = "" }), true, false, ""},
		{"an open Round", with(func(s *ticketWorkflowState) { s.openRoundID = "round-2" }), true, false, "round-2"},
		{"a Round not delivered", reviewed, false, false, ""},
	}
	for _, status := range allTicketStatuses {
		if status != InReview && status != Done {
			cases = append(cases, struct {
				name      string
				state     ticketWorkflowState
				delivered bool
				allowed   bool
				openID    string
			}{"status " + string(status), with(func(s *ticketWorkflowState) { s.status = status }), true, false, ""})
		}
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decideFeedback(tc.state, tc.delivered)
			if tc.allowed {
				if got != nil {
					t.Fatalf("decideFeedback = %+v, want allowed", got)
				}
				return
			}
			if got == nil || got.code != feedbackNotAvailableCode || got.message == "" || got.roundID != tc.openID {
				t.Fatalf("decideFeedback = %+v, want %s with a message and round %q", got, feedbackNotAvailableCode, tc.openID)
			}
		})
	}
}

func TestFeedback_IsRecordedOnTheDeliveredRoundInInReviewAndDone(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.deliveredTicket(t, "Feedback")
	reviewed := f.ticket(t, queued.Id)
	assertFeedbackAvailable(t, reviewed)
	before := readTicketRowFacts(t, f.pool, queued.Id)

	added := runnerEpoch.Add(5 * time.Second)
	f.clock.Set(added)
	got := f.mustAddFeedback(t, queued.Id, claim.RoundId, "Cover the EU region too.")
	if got.Status != InReview || got.Delivery == nil || got.Delivery.RoundId != claim.RoundId || got.RequestingAgentWork {
		t.Fatalf("Ticket after feedback = %s %+v requesting %t, want In Review with the delivery unchanged", got.Status, got.Delivery, got.RequestingAgentWork)
	}
	assertFeedbackAvailable(t, got)
	if after := readTicketRowFacts(t, f.pool, queued.Id); !reflect.DeepEqual(after, before) {
		t.Fatalf("Ticket row before %+v, after %+v; feedback changes no Ticket fact", before, after)
	}

	f.mustAccept(t, queued.Id)
	done := f.ticket(t, queued.Id)
	assertFeedbackAvailable(t, done)
	f.clock.Set(added.Add(time.Minute))
	f.mustAddFeedback(t, queued.Id, claim.RoundId, "Line two\n\twith a tab.")

	round := f.roundOf(t, queued.Id)
	if len(round.Feedback) != 2 {
		t.Fatalf("Round 1 feedback = %+v, want two comments", round.Feedback)
	}
	for i, want := range []struct {
		body string
		at   time.Time
	}{{"Cover the EU region too.", added}, {"Line two\n\twith a tab.", added.Add(time.Minute)}} {
		item := round.Feedback[i]
		if item.Body != want.body || !item.CreatedAt.Equal(want.at) || item.ConsumedBy != nil || uuid.Validate(item.Id) != nil {
			t.Fatalf("feedback[%d] = %+v, want %q at %v, unconsumed", i, item, want.body, want.at)
		}
	}
	if rows := roundRows(t, f.pool); len(rows) != 1 {
		t.Fatalf("rounds = %+v, want only Round 1: feedback creates no Round", rows)
	}
	assertNoWork(t, f.claim(t))
}

func TestFeedback_TheReworkClaimCarriesAllUnconsumedFeedbackAndLaterClaimsDoNot(t *testing.T) {
	f := newClaimFixture(t)
	queued, first := f.deliveredTicket(t, "Rework with feedback")
	f.mustAddFeedback(t, queued.Id, first.RoundId, "First comment")
	f.mustAddFeedback(t, queued.Id, first.RoundId, "Second comment")
	f.mustRework(t, queued.Id)

	second := f.mustClaim(t)
	want := []ClaimedFeedback{
		{RoundId: first.RoundId, RoundSequence: 1, Body: "First comment", CreatedAt: runnerEpoch},
		{RoundId: first.RoundId, RoundSequence: 1, Body: "Second comment", CreatedAt: runnerEpoch},
	}
	if second.Ticket.Id != queued.Id || second.Sequence != 2 || !reflect.DeepEqual(second.Ticket.Feedback, want) {
		t.Fatalf("Round 2 claim = %+v, want both comments on Round 1", second)
	}
	for _, row := range feedbackRows(t, f) {
		if row.consumedBy == nil || *row.consumedBy != second.RoundId {
			t.Fatalf("feedback row %+v, want consumed by Round 2", row)
		}
	}
	rounds := decodeRounds(t, f.listRounds(t, queued.Id))
	consumer := &RoundFeedbackConsumer{RoundId: second.RoundId, Sequence: 2}
	if len(rounds) != 2 || len(rounds[0].Feedback) != 0 || len(rounds[1].Feedback) != 2 ||
		!reflect.DeepEqual(rounds[1].Feedback[0].ConsumedBy, consumer) || !reflect.DeepEqual(rounds[1].Feedback[1].ConsumedBy, consumer) {
		t.Fatalf("rounds = %+v, want Round 1's feedback consumed by Round 2", rounds)
	}

	f.deliverThroughAPI(t, second.RoundId)
	f.mustAddFeedback(t, queued.Id, first.RoundId, "Late on Round 1")
	f.mustRework(t, queued.Id)
	third := f.mustClaim(t)
	if got := third.Ticket.Feedback; third.Sequence != 3 || len(got) != 1 || got[0].RoundId != first.RoundId || got[0].RoundSequence != 1 || got[0].Body != "Late on Round 1" {
		t.Fatalf("Round 3 claim feedback = %+v, want only the late comment on Round 1: Round 2 consumed the others", got)
	}

	f.deliverThroughAPI(t, third.RoundId)
	f.mustAddFeedback(t, queued.Id, third.RoundId, "On Round 3")
	f.mustRework(t, queued.Id)
	fourth := f.mustClaim(t)
	if got := fourth.Ticket.Feedback; len(got) != 1 || got[0].RoundId != third.RoundId || got[0].RoundSequence != 3 || got[0].Body != "On Round 3" {
		t.Fatalf("Round 4 claim feedback = %+v, want only Round 3's comment", got)
	}
}

func TestFeedback_ReopeningADoneTicketQueuesItAtTheBottomAndItsClaimCarriesTheFeedback(t *testing.T) {
	f := newClaimFixture(t)
	reopened, first := f.doneTicket(t, "Reopened")
	f.mustAddFeedback(t, reopened.Id, first.RoundId, "Reopen and add a summary table")
	other := f.queue(t, "Queued first")

	ready := decodeTicketBody(t, f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + reopened.Id + "/status", body: `{"status":"Ready"}`, cookie: f.cookie}, http.StatusOK))
	if ready.Status != Ready || !ready.RequestingAgentWork {
		t.Fatalf("Done -> Ready = %s requesting %t, want Ready and requesting", ready.Status, ready.RequestingAgentWork)
	}
	assertFeedbackUnavailable(t, ready)
	if readTicketRowFacts(t, f.pool, reopened.Id).rank <= readTicketRowFacts(t, f.pool, other.Id).rank {
		t.Fatal("the reopened Ticket is not after the Ticket queued before it")
	}

	firstClaim := f.mustClaim(t)
	if firstClaim.Ticket.Id != other.Id || len(firstClaim.Ticket.Feedback) != 0 {
		t.Fatalf("first claim = %+v, want the other Ticket without feedback", firstClaim)
	}
	f.deliverThroughAPI(t, firstClaim.RoundId)
	second := f.mustClaim(t)
	if second.Ticket.Id != reopened.Id || second.Sequence != 2 || claimedBodies(second)[0] != "Reopen and add a summary table" || len(second.Ticket.Feedback) != 1 ||
		second.Ticket.Feedback[0].RoundId != first.RoundId {
		t.Fatalf("reopened claim = %+v, want Round 2 carrying the Done feedback", second)
	}
}

func TestFeedback_IsNotResentToTheRecoveryClaimAfterTheConsumingRoundFails(t *testing.T) {
	f := newClaimFixture(t)
	queued, first := f.deliveredTicket(t, "Recover")
	f.mustAddFeedback(t, queued.Id, first.RoundId, "Once only")
	f.mustRework(t, queued.Id)
	second := f.mustClaim(t)
	f.startRound(t, second, "start-2")
	f.mustEndAs(t, blockedEndings[0], second)
	blocked := f.ticket(t, queued.Id)
	assertFeedbackUnavailable(t, blocked)
	if rec := f.addFeedback(t, queued.Id, second.RoundId, "On the failed Round"); rec.Code != http.StatusBadRequest {
		t.Fatalf("feedback on a failed Round: status=%d body=%s", rec.Code, rec.Body.String())
	}

	f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/status", body: `{"status":"Ready"}`, cookie: f.cookie}, http.StatusOK)
	third := f.mustClaim(t)
	if third.Sequence != 3 || len(third.Ticket.Feedback) != 0 {
		t.Fatalf("recovery claim feedback = %+v, want none", third.Ticket.Feedback)
	}
	if rows := feedbackRows(t, f); len(rows) != 1 || rows[0].consumedBy == nil || *rows[0].consumedBy != second.RoundId {
		t.Fatalf("feedback rows = %+v, want one consumed by Round 2", rows)
	}
}

func TestFeedback_IsRejectedWithoutADeliveredRoundUnderReview(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, f *claimFixture) (ticketID, roundID string)
	}{
		{"a claimed Round", func(t *testing.T, f *claimFixture) (string, string) {
			queued, claim := f.claimTicket(t, "Claimed")
			return queued.Id, claim.RoundId
		}},
		{"a running Round", func(t *testing.T, f *claimFixture) (string, string) {
			queued, claim := f.runningRound(t, "Running")
			return queued.Id, claim.RoundId
		}},
		{"Round 1 while Round 2 is open", func(t *testing.T, f *claimFixture) (string, string) {
			queued, first := f.deliveredTicket(t, "Open again")
			f.mustRework(t, queued.Id)
			f.mustClaim(t)
			return queued.Id, first.RoundId
		}},
		{"a reworked Ticket waiting in Ready", func(t *testing.T, f *claimFixture) (string, string) {
			queued, first := f.deliveredTicket(t, "Ready")
			f.mustRework(t, queued.Id)
			return queued.Id, first.RoundId
		}},
		{"an archived Ticket in In Review", func(t *testing.T, f *claimFixture) (string, string) {
			queued, first := f.deliveredTicket(t, "Archived")
			f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/archive", cookie: f.cookie}, http.StatusOK)
			return queued.Id, first.RoundId
		}},
		{"an archived Ticket in Done", func(t *testing.T, f *claimFixture) (string, string) {
			queued, first := f.doneTicket(t, "Archived Done")
			f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/archive", cookie: f.cookie}, http.StatusOK)
			return queued.Id, first.RoundId
		}},
		{"a Ticket reassigned to the Owner after delivery", func(t *testing.T, f *claimFixture) (string, string) {
			queued, first := f.deliveredTicket(t, "Human")
			f.expect(t, runnerCall{method: http.MethodPut, path: "/api/tickets/" + queued.Id + "/assignee", body: `{"type":"owner"}`, cookie: f.cookie}, http.StatusOK)
			return queued.Id, first.RoundId
		}},
		{"an unassigned Ticket after delivery", func(t *testing.T, f *claimFixture) (string, string) {
			queued, first := f.deliveredTicket(t, "Unassigned")
			f.expect(t, runnerCall{method: http.MethodDelete, path: "/api/tickets/" + queued.Id + "/assignee", cookie: f.cookie}, http.StatusOK)
			return queued.Id, first.RoundId
		}},
		{"a failed Round", func(t *testing.T, f *claimFixture) (string, string) {
			queued, claim := f.blockedRound(t, blockedEndings[0], "Failed")
			return queued.Id, claim.RoundId
		}},
		{"an interrupted Round", func(t *testing.T, f *claimFixture) (string, string) {
			queued, claim := f.blockedRound(t, blockedEndings[1], "Interrupted")
			return queued.Id, claim.RoundId
		}},
		{"a stopped Round", func(t *testing.T, f *claimFixture) (string, string) {
			queued, claim := f.runningRound(t, "Stopped")
			f.mustStop(t, queued.Id)
			f.mustConfirmStop(t, claim)
			return queued.Id, claim.RoundId
		}},
		{"a failed Round after an earlier delivered one, the Ticket then In Review", func(t *testing.T, f *claimFixture) (string, string) {
			queued, _ := f.deliveredTicket(t, "Earlier")
			f.mustRework(t, queued.Id)
			failed := f.mustClaim(t)
			f.startRound(t, failed, failed.RoundId+":0")
			f.mustEndAs(t, blockedEndings[0], failed)
			for _, call := range []struct{ method, path, body string }{
				{http.MethodPut, "/assignee", `{"type":"owner"}`},
				{http.MethodPost, "/status", `{"status":"InProgress"}`},
				{http.MethodPost, "/status", `{"status":"InReview"}`},
				{http.MethodPut, "/assignee", assignAgentBody(f.agent.Id)},
			} {
				f.expect(t, runnerCall{method: call.method, path: "/api/tickets/" + queued.Id + call.path, body: call.body, cookie: f.cookie}, http.StatusOK)
			}
			return queued.Id, failed.RoundId
		}},
		{"a human Ticket moved to In Review with an earlier Agent Round", func(t *testing.T, f *claimFixture) (string, string) {
			queued, claim := f.blockedRound(t, blockedEndings[0], "Human review")
			f.expect(t, runnerCall{method: http.MethodPut, path: "/api/tickets/" + queued.Id + "/assignee", body: `{"type":"owner"}`, cookie: f.cookie}, http.StatusOK)
			f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/status", body: `{"status":"InProgress"}`, cookie: f.cookie}, http.StatusOK)
			f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/status", body: `{"status":"InReview"}`, cookie: f.cookie}, http.StatusOK)
			f.expect(t, runnerCall{method: http.MethodPut, path: "/api/tickets/" + queued.Id + "/assignee", body: assignAgentBody(f.agent.Id), cookie: f.cookie}, http.StatusOK)
			return queued.Id, claim.RoundId
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newClaimFixture(t)
			ticketID, roundID := tc.setup(t, f)
			ticket := f.ticket(t, ticketID)
			before := databaseSnapshot(t, f.pool)
			rec := f.addFeedback(t, ticketID, roundID, "Not now")
			assertTransitionRejection(t, rec, feedbackNotAvailableCode)
			assertSnapshotUnchanged(t, f.pool, before, "rejected feedback")
			if ticket.Delivery == nil || ticket.Delivery.RoundId == roundID {
				assertFeedbackUnavailable(t, ticket)
			}
		})
	}
}

func TestFeedback_AllowedActionsEqualTheCommandsAnswer(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, f *claimFixture) string
	}{
		{"In Review", func(t *testing.T, f *claimFixture) string { q, _ := f.deliveredTicket(t, "Review"); return q.Id }},
		{"Done", func(t *testing.T, f *claimFixture) string { q, _ := f.doneTicket(t, "Done"); return q.Id }},
		{"a running Round", func(t *testing.T, f *claimFixture) string { q, _ := f.runningRound(t, "Running"); return q.Id }},
		{"Ready after rework", func(t *testing.T, f *claimFixture) string {
			q, _ := f.deliveredTicket(t, "Ready")
			f.mustRework(t, q.Id)
			return q.Id
		}},
		{"archived", func(t *testing.T, f *claimFixture) string {
			q, _ := f.deliveredTicket(t, "Archived")
			f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + q.Id + "/archive", cookie: f.cookie}, http.StatusOK)
			return q.Id
		}},
		{"human-assigned", func(t *testing.T, f *claimFixture) string {
			q, _ := f.deliveredTicket(t, "Human")
			f.expect(t, runnerCall{method: http.MethodPut, path: "/api/tickets/" + q.Id + "/assignee", body: `{"type":"owner"}`, cookie: f.cookie}, http.StatusOK)
			return q.Id
		}},
		{"Blocked after failure", func(t *testing.T, f *claimFixture) string {
			q, _ := f.blockedRound(t, blockedEndings[0], "Failed")
			return q.Id
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newClaimFixture(t)
			id := tc.setup(t, f)
			ticket := f.ticket(t, id)
			roundID := f.roundOf(t, id).Id
			advertised := ticket.AllowedActions.Feedback
			rec := f.addFeedback(t, id, roundID, "Advertised?")
			if advertised.Available {
				if advertised.Reason != nil || rec.Code != http.StatusCreated {
					t.Fatalf("advertised %+v, command %d %s; want 201", advertised, rec.Code, rec.Body.String())
				}
				return
			}
			if advertised.Reason == nil || rec.Code != http.StatusBadRequest || !reflect.DeepEqual(decodeErrorBody(t, rec).Error, *advertised.Reason) {
				t.Fatalf("advertised %+v, command %d %s; want unavailable with the command's error", advertised, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestFeedback_UnknownForeignAndMismatchedIdsAreTheSameNotFound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.deliveredTicket(t, "Mine")
	other, otherClaim := f.deliveredTicket(t, "Another of mine")
	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	theirs, theirClaim := foreign.deliveredTicket(t, "Theirs")

	before := databaseSnapshot(t, f.pool)
	for name, path := range map[string]string{
		"an unknown Ticket":               feedbackPath(uuid.NewString(), claim.RoundId),
		"an unknown Round":                feedbackPath(queued.Id, uuid.NewString()),
		"a Round of another of my Ticket": feedbackPath(queued.Id, otherClaim.RoundId),
		"my Round under another Ticket":   feedbackPath(other.Id, claim.RoundId),
		"another Owner's Round":           feedbackPath(theirs.Id, theirClaim.RoundId),
		"another Owner's Round on mine":   feedbackPath(queued.Id, theirClaim.RoundId),
		"a malformed Ticket id":           feedbackPath("not-a-uuid", claim.RoundId),
		"a malformed Round id":            feedbackPath(queued.Id, "round-1"),
	} {
		t.Run(name, func(t *testing.T) {
			rec := f.do(t, runnerCall{method: http.MethodPost, path: path, body: `{"body":"yes"}`, cookie: f.cookie})
			assertErrorBody(t, rec, http.StatusNotFound, "not_found", roundNotFoundMessage)
		})
	}
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: feedbackPath(queued.Id, claim.RoundId), body: `{"body":"yes"}`}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: feedbackPath(queued.Id, claim.RoundId), body: `{"body":"yes"}`, token: f.token}))
	assertSnapshotUnchanged(t, f.pool, before, "feedback that is not the Owner's")
	if theirRound := foreign.roundOf(t, theirs.Id); len(theirRound.Feedback) != 0 {
		t.Fatalf("the other Owner's Round gained feedback: %+v", theirRound.Feedback)
	}
}

func TestFeedback_TheBodyIsDecodedStrictly(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.deliveredTicket(t, "Strict feedback")
	before := databaseSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"no body":              "",
		"no body field":        `{}`,
		"an extra field":       `{"body":"yes","roundId":"x"}`,
		"a numeric body":       `{"body":7}`,
		"a null body":          `{"body":null}`,
		"an empty body":        `{"body":""}`,
		"a blank body":         `{"body":" \n\t "}`,
		"a Unicode-blank body": `{"body":" 　"}`,
		"a carriage return":    `{"body":"a\r\nb"}`,
		"a control character":  `{"body":"a\u0007b"}`,
		"over 10000":           jsonText(t, map[string]string{"body": strings.Repeat("界", 10001)}),
		"trailing data":        `{"body":"yes"} {}`,
		"not JSON":             `body=yes`,
	} {
		t.Run(name, func(t *testing.T) {
			assertInvalidRequest(t, f.do(t, runnerCall{method: http.MethodPost, path: feedbackPath(queued.Id, claim.RoundId), body: body, cookie: f.cookie}))
		})
	}
	assertSnapshotUnchanged(t, f.pool, before, "malformed feedback")
	f.mustAddFeedback(t, queued.Id, claim.RoundId, strings.Repeat("界", 10000))
	if round := f.roundOf(t, queued.Id); len(round.Feedback) != 1 || round.Feedback[0].Body != strings.Repeat("界", 10000) {
		t.Fatal("a 10000-character body was not kept whole")
	}
}

func TestFeedback_TheStoreRefusesWhatGalleyNeverWrites(t *testing.T) {
	f := newClaimFixture(t)
	_, first := f.deliveredTicket(t, "Constraints")
	other, otherClaim := f.deliveredTicket(t, "Other")
	ctx := context.Background()
	for _, tc := range []struct {
		name, body, consumer, constraint string
	}{
		{"an empty body", "", "NULL", "round_feedback_body_length"},
		{"a blank body", " \n\t", "NULL", "round_feedback_body_not_blank"},
		{"a body over 10000", strings.Repeat("界", 10001), "NULL", "round_feedback_body_length"},
		{"consumed by its own Round", "x", "(SELECT id FROM rounds WHERE public_id = '" + first.RoundId + "')", "round_feedback_consumed_by_another_round"},
		{"consumed by another Ticket's Round", "x", "(SELECT id FROM rounds WHERE public_id = '" + otherClaim.RoundId + "')", "round_feedback_consumed_by_round_fk"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.pool.Exec(ctx, `INSERT INTO round_feedback (owner_id, public_id, ticket_id, round_id, body, created_at, consumed_by_round_id)
				SELECT r.owner_id, gen_random_uuid(), r.ticket_id, r.id, $2, now(), `+tc.consumer+` FROM rounds r WHERE r.public_id = $1::uuid`, first.RoundId, tc.body)
			assertViolates(t, err, tc.constraint)
		})
	}
	t.Run("feedback on a Round of another Ticket", func(t *testing.T) {
		_, err := f.pool.Exec(ctx, `INSERT INTO round_feedback (owner_id, public_id, ticket_id, round_id, body, created_at)
			SELECT r.owner_id, gen_random_uuid(), t.id, r.id, 'x', now() FROM rounds r, tickets t WHERE r.public_id = $1::uuid AND t.public_id = $2::uuid`, first.RoundId, other.Id)
		assertViolates(t, err, "round_feedback_round_fk")
	})
}

func TestFeedback_TakesTheTicketRowLock(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.deliveredTicket(t, "Lock")
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
	go func() { result <- f.addFeedback(t, queued.Id, claim.RoundId, "Waits for the lock") }()
	waitForLockWaiter(t, f.pool, "FOR UPDATE")
	if n := tableRowCount(t, f.pool, "round_feedback"); n != 0 {
		t.Fatalf("round_feedback rows while the Ticket row is held = %d, want 0", n)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if rec := <-result; rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s, want 201 once the lock is released", rec.Code, rec.Body.String())
	}
}

func TestFeedback_RacingReworkAndClaimsNeitherLosesNorRepeatsFeedback(t *testing.T) {
	const comments = 6
	for trial := range 6 {
		f := newClaimFixture(t)
		queued, first := f.deliveredTicket(t, "Racing")

		requests := comments + 1 + 4
		var codes []int
		var bodies []string
		finished := make(chan struct{})
		go func() {
			defer close(finished)
			codes, bodies = sendConcurrently(requests, func(i int) *httptest.ResponseRecorder {
				switch {
				case i < comments:
					return f.addFeedback(t, queued.Id, first.RoundId, "comment "+string(rune('A'+i)))
				case i == comments:
					return f.rework(t, queued.Id)
				default:
					return f.claim(t)
				}
			})
		}()
		select {
		case <-finished:
		case <-time.After(20 * time.Second):
			t.Fatalf("trial %d: did not finish within 20 s (deadlock)", trial)
		}

		var accepted []string
		var claims []RunnerClaim
		for i, code := range codes {
			switch {
			case i < comments && code == http.StatusCreated:
				accepted = append(accepted, "comment "+string(rune('A'+i)))
			case i < comments:
				if code != http.StatusBadRequest || !strings.Contains(bodies[i], feedbackNotAvailableCode) {
					t.Fatalf("trial %d: feedback %d = %d %s", trial, i, code, bodies[i])
				}
			case i == comments:
				if code != http.StatusOK {
					t.Fatalf("trial %d: rework = %d %s", trial, code, bodies[i])
				}
			case code == http.StatusCreated:
				claims = append(claims, decodeClaim(t, httptestRecorder(code, bodies[i])))
			case code != http.StatusNoContent:
				t.Fatalf("trial %d: claim = %d %s", trial, code, bodies[i])
			}
		}
		if len(claims) > 1 {
			t.Fatalf("trial %d: %d claims succeeded, want at most one", trial, len(claims))
		}
		t.Logf("trial %d: %d of %d comments accepted, %d claims during the race", trial, len(accepted), comments, len(claims))
		if len(claims) == 0 {
			claims = append(claims, f.mustClaim(t))
		}
		got := claimedBodies(claims[0])
		sort.Strings(accepted)
		sort.Strings(got)
		if !equalStrings(got, accepted) && !(len(got) == 0 && len(accepted) == 0) {
			t.Fatalf("trial %d: claim carried %v, accepted %v", trial, got, accepted)
		}
		rows := feedbackRows(t, f)
		if len(rows) != len(accepted) {
			t.Fatalf("trial %d: %d feedback rows, %d accepted", trial, len(rows), len(accepted))
		}
		for _, row := range rows {
			if row.consumedBy == nil || *row.consumedBy != claims[0].RoundId {
				t.Fatalf("trial %d: row %+v, want consumed by %s", trial, row, claims[0].RoundId)
			}
		}
	}
}

func TestFeedback_ConcurrentClaimsConsumeItOnce(t *testing.T) {
	const claims = 8
	f := newClaimFixture(t)
	queued, first := f.deliveredTicket(t, "One claim")
	f.mustAddFeedback(t, queued.Id, first.RoundId, "Only once")
	f.mustRework(t, queued.Id)

	codes, bodies := sendConcurrently(claims, func(int) *httptest.ResponseRecorder { return f.claim(t) })
	var carried int
	for i, code := range codes {
		switch code {
		case http.StatusCreated:
			claim := decodeClaim(t, httptestRecorder(code, bodies[i]))
			if got := claimedBodies(claim); !equalStrings(got, []string{"Only once"}) {
				t.Fatalf("claim feedback = %v, want the one comment", got)
			}
			carried++
		case http.StatusNoContent:
		default:
			t.Fatalf("claim %d = %d %s", i, code, bodies[i])
		}
	}
	if carried != 1 {
		t.Fatalf("%d claims carried the feedback, want exactly one", carried)
	}
}

func httptestRecorder(code int, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	rec.Code = code
	rec.Body.WriteString(body)
	return rec
}
