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
	questionA    = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
	questionB    = "9a8b7c6d-5e4f-4321-9fed-cba987654321"
	questionText = "Which region should the report cover?"
	ownerAnswer  = "Only the EU region, please."
)

func questionEvent(t *testing.T, key string, epoch int, questionID, text string) string {
	t.Helper()
	return jsonText(t, map[string]any{"type": "question_raised", "idempotencyKey": key, "claimEpoch": epoch, "occurredAt": eventOccurredAt,
		"data": map[string]any{"questionId": questionID, "text": text}})
}

func resumedEvent(t *testing.T, key string, epoch int, questionID string) string {
	t.Helper()
	return jsonText(t, map[string]any{"type": "resumed", "idempotencyKey": key, "claimEpoch": epoch, "occurredAt": eventOccurredAt,
		"data": map[string]any{"questionId": questionID}})
}

func (f *claimFixture) raise(t *testing.T, claim RunnerClaim, questionID string) *httptest.ResponseRecorder {
	t.Helper()
	return f.reportEvent(t, claim.RoundId, questionEvent(t, questionID, claim.ClaimEpoch, questionID, questionText))
}

func (f *claimFixture) resume(t *testing.T, claim RunnerClaim, questionID string) *httptest.ResponseRecorder {
	t.Helper()
	return f.reportEvent(t, claim.RoundId, resumedEvent(t, claim.RoundId+":resume:"+questionID, claim.ClaimEpoch, questionID))
}

func answerPath(ticketID, roundID, questionID string) string {
	return "/api/tickets/" + ticketID + "/rounds/" + roundID + "/questions/" + questionID + "/answer"
}

func (f *claimFixture) answer(t *testing.T, ticketID, roundID, questionID, answer string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: answerPath(ticketID, roundID, questionID), body: jsonText(t, map[string]string{"answer": answer}), cookie: f.cookie})
}

func (f *claimFixture) mustAnswer(t *testing.T, ticketID, roundID, questionID string) Ticket {
	t.Helper()
	rec := f.answer(t, ticketID, roundID, questionID, ownerAnswer)
	if rec.Code != http.StatusOK {
		t.Fatalf("answer: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	return decodeTicketBody(t, rec)
}

func (f *claimFixture) waitingRound(t *testing.T, title string) (Ticket, RunnerClaim) {
	t.Helper()
	queued, claim := f.runningRound(t, title)
	if rec := f.raise(t, claim, questionA); rec.Code != http.StatusCreated {
		t.Fatalf("question_raised: status=%d body=%s", rec.Code, rec.Body.String())
	}
	return queued, claim
}

func assertTransitionRejection(t *testing.T, rec *httptest.ResponseRecorder, code string) {
	t.Helper()
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s, want 400 %s", rec.Code, rec.Body.String(), code)
	}
	assertErrorCode(t, rec, code)
}

func assertWaitingTicket(t *testing.T, ticket Ticket, claim RunnerClaim, reason RoundWaitingReason, answer *string) {
	t.Helper()
	open := ticket.OpenRound
	if ticket.Status != Blocked || open == nil || open.Id != claim.RoundId || open.State != OpenRoundWaitingForInput || open.WaitingReason != reason {
		t.Fatalf("Ticket = %s %+v, want Blocked with Round %s waiting for input (%s)", ticket.Status, open, claim.RoundId, reason)
	}
	q := open.Question
	if q == nil || q.Id != questionA || q.Text != questionText || !reflect.DeepEqual(q.Answer, answer) || (q.AnsweredAt == nil) != (answer == nil) {
		t.Fatalf("openRound.question = %+v, want %s with answer %v", q, questionA, answer)
	}
	if ticket.RequestingAgentWork || len(ticket.AllowedActions.StatusChanges) != 0 || len(ticket.AllowedActions.StatusChangeRejections) != 0 {
		t.Fatalf("a waiting Ticket offers %+v and requests work=%t", ticket.AllowedActions, ticket.RequestingAgentWork)
	}
}

func TestQuestionRaised_MovesTheRunningRoundToWaitingAndTheTicketToBlockedAndKeepsTheSlot(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Ask me")
	waiting := f.queue(t, "Behind it")
	before := readTicketRowFacts(t, f.pool, queued.Id)

	asked := runnerEpoch.Add(7 * time.Second)
	f.clock.Set(asked)
	f.heartbeat(t, f.token, http.StatusOK)
	rec := f.raise(t, claim, questionA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
	want := fmt.Sprintf(`{"questionId":%q,"roundId":%q,"startedAt":%q,"state":"waiting_for_input","type":"question_raised"}`, questionA, claim.RoundId, runnerEpoch.Format(time.RFC3339Nano))
	if rec.Body.String() != want {
		t.Fatalf("body = %s, want %s", rec.Body.String(), want)
	}

	ticket := f.ticket(t, queued.Id)
	assertWaitingTicket(t, ticket, claim, WaitingForAnswer, nil)
	if !ticket.OpenRound.Question.AskedAt.Equal(asked) {
		t.Fatalf("askedAt = %v, want Galley's clock %v", ticket.OpenRound.Question.AskedAt, asked)
	}
	if !ticket.AllowedActions.Answer.Available || !ticket.AllowedActions.Stop.Available {
		t.Fatalf("allowedActions answer=%+v stop=%+v, want both available", ticket.AllowedActions.Answer, ticket.AllowedActions.Stop)
	}
	after := readTicketRowFacts(t, f.pool, queued.Id)
	if after.status != string(Blocked) || after.rank != before.rank || !reflect.DeepEqual(after.agentID, before.agentID) {
		t.Fatalf("Ticket row before %+v, after %+v", before, after)
	}
	if rows := roundRows(t, f.pool); len(rows) != 1 || rows[0].state != string(RoundWaitingForInput) {
		t.Fatalf("Rounds = %+v, want the one Round waiting for input", rows)
	}
	assertNoWork(t, f.claim(t))
	if got := f.ticket(t, waiting.Id); got.OpenRound != nil {
		t.Fatalf("the queued Ticket was claimed while the slot is held: %+v", got.OpenRound)
	}
	round := f.roundOf(t, queued.Id)
	if round.State != RoundWaitingForInput || len(round.Questions) != 1 || round.Questions[0].Id != questionA || round.Questions[0].Answer != nil {
		t.Fatalf("listed Round = %+v, want waiting with its unanswered question", round)
	}
}

func TestWaitingForInput_TheTicketStaysLockedAndRecoveryIsNotOffered(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Locked while asking")
	before := databaseSnapshot(t, f.pool)
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"archive":           f.archive(t, queued.Id),
		"recovery to Ready": f.statusChange(t, queued.Id, Ready),
		"to Backlog":        f.statusChange(t, queued.Id, Backlog),
		"to In Progress":    f.statusChange(t, queued.Id, InProgress),
		"edit":              f.do(t, runnerCall{method: http.MethodPatch, path: "/api/tickets/" + queued.Id, body: `{"title":"renamed"}`, cookie: f.cookie}),
		"unassign":          f.do(t, runnerCall{method: http.MethodDelete, path: "/api/tickets/" + queued.Id + "/assignee", cookie: f.cookie}),
	} {
		t.Run(name, func(t *testing.T) { assertRoundOpen(t, rec, claim.RoundId) })
	}
	assertSnapshotUnchanged(t, f.pool, before, "mutations of a Ticket waiting for input")
}

func TestQuestionRaised_KeyIsTheQuestionIdAndAReplayRaisesNoSecondQuestion(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Replay the question")
	body := questionEvent(t, questionA, claim.ClaimEpoch, questionA, questionText)
	first := f.mustReport(t, claim.RoundId, body)
	afterFirst := databaseSnapshot(t, f.pool)

	rec := f.reportEvent(t, claim.RoundId, body)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replay: status=%d body=%s, want 200 with %s", rec.Code, rec.Body.String(), first.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, afterFirst, "a replayed question")

	assertErrorBody(t, f.reportEvent(t, claim.RoundId, questionEvent(t, questionA, claim.ClaimEpoch, questionA, "Another wording")),
		http.StatusConflict, idempotencyKeyConflictCode, idempotencyKeyConflictMessage)
	assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, questionEvent(t, claim.RoundId+":3", claim.ClaimEpoch, questionA, questionText)))
	assertErrorCode(t, f.reportEvent(t, claim.RoundId, questionEvent(t, questionB, claim.ClaimEpoch, questionB, questionText)), eventOutOfOrderCode)
	assertSnapshotUnchanged(t, f.pool, afterFirst, "a second question while one waits")

	f.mustAnswer(t, queued.Id, claim.RoundId, questionA)
	f.mustReport(t, claim.RoundId, resumedEvent(t, claim.RoundId+":4", claim.ClaimEpoch, questionA))
	afterResume := databaseSnapshot(t, f.pool)
	rec = f.reportEvent(t, claim.RoundId, body)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replay after resuming: status=%d body=%s, want 200 with the stored result", rec.Code, rec.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, afterResume, "a replayed question after the Round resumed")
	if n := tableRowCount(t, f.pool, "round_questions"); n != 1 {
		t.Fatalf("round_questions rows = %d, want 1", n)
	}
	assertErrorCode(t, f.reportEvent(t, claim.RoundId, questionEvent(t, questionA, claim.ClaimEpoch, questionA, "Asked again")), idempotencyKeyConflictCode)
}

func TestQuestionRaised_DataIsValidatedStrictly(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Strict question")
	before := databaseSnapshot(t, f.pool)
	event := func(key string, data any) string {
		return jsonText(t, map[string]any{"type": "question_raised", "idempotencyKey": key, "claimEpoch": claim.ClaimEpoch, "occurredAt": eventOccurredAt, "data": data})
	}
	for name, body := range map[string]string{
		"no text":              event(questionA, map[string]any{"questionId": questionA}),
		"an extra field":       event(questionA, map[string]any{"questionId": questionA, "text": "q", "options": []string{"a"}}),
		"a blank text":         event(questionA, map[string]any{"questionId": questionA, "text": " \n\t "}),
		"a control character":  event(questionA, map[string]any{"questionId": questionA, "text": "a\u0007b"}),
		"text over 2000":       event(questionA, map[string]any{"questionId": questionA, "text": strings.Repeat("界", 2001)}),
		"an uppercase id":      event(strings.ToUpper(questionA), map[string]any{"questionId": strings.ToUpper(questionA), "text": "q"}),
		"the nil UUID":         event(uuid.Nil.String(), map[string]any{"questionId": uuid.Nil.String(), "text": "q"}),
		"not a UUID":           event("question-1", map[string]any{"questionId": "question-1", "text": "q"}),
		"a numeric questionId": event(questionA, map[string]any{"questionId": 7, "text": "q"}),
	} {
		t.Run(name, func(t *testing.T) { assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, body)) })
	}
	assertSnapshotUnchanged(t, f.pool, before, "rejected questions")
	f.mustReport(t, claim.RoundId, event(questionA, map[string]any{"questionId": questionA, "text": strings.Repeat("界", 2000)}))
}

func TestQuestionRaised_IsAcceptedOnlyFromARunningRound(t *testing.T) {
	t.Run("claimed", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Not started")
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.raise(t, claim, questionA), eventOutOfOrderCode)
		assertSnapshotUnchanged(t, f.pool, before, "a question before the Round started")
	})
	t.Run("a stale epoch", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.runningRound(t, "Stale")
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.reportEvent(t, claim.RoundId, questionEvent(t, questionA, claim.ClaimEpoch+1, questionA, questionText)), staleClaimEpochCode)
		assertSnapshotUnchanged(t, f.pool, before, "a question at a stale epoch")
	})
	t.Run("ended", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.runningRound(t, "Delivered")
		f.deliverThroughAPI(t, claim.RoundId)
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.raise(t, claim, questionA), roundNotOpenCode)
		assertSnapshotUnchanged(t, f.pool, before, "a question after the Round ended")
	})
	t.Run("while Stop is requested", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, "Stopping")
		f.mustStop(t, queued.Id)
		f.mustReport(t, claim.RoundId, questionEvent(t, questionA, claim.ClaimEpoch, questionA, questionText))
		ticket := f.ticket(t, queued.Id)
		if ticket.OpenRound == nil || ticket.OpenRound.WaitingReason != WaitingStopping {
			t.Fatalf("openRound = %+v, want waiting with Stopping outranking the question", ticket.OpenRound)
		}
		if a := ticket.AllowedActions.Answer; a.Available || a.Reason == nil || a.Reason.Code != stopAlreadyRequestedCode {
			t.Fatalf("allowedActions.answer = %+v, want refused with %s", a, stopAlreadyRequestedCode)
		}
	})
}

func TestWaitingForInput_OnlyResumedStopConfirmedAndInterruptedAreAccepted(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.waitingRound(t, "Only resume")
	before := databaseSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"execution_started": startedEvent("k1", claim.ClaimEpoch, eventOccurredAt, eventReference),
		"progress":          progressEvent(t, "k2", claim.ClaimEpoch, eventOccurredAt, "working while waiting"),
		"usage_observed":    usageEvent(t, observationA, claim.ClaimEpoch, usageData(observationA)),
		"delivered":         deliveredEvent(t, "k3", claim.ClaimEpoch, standardDeliverable()),
		"failed":            blockedEndings[0].event(t, "k4", claim.ClaimEpoch, failedExplanation),
	} {
		t.Run(name, func(t *testing.T) { assertErrorCode(t, f.reportEvent(t, claim.RoundId, body), eventOutOfOrderCode) })
	}
	assertErrorCode(t, f.reportEvent(t, claim.RoundId, stopConfirmedEvent(t, "k6", claim.ClaimEpoch, stopEvidence)), stopNotRequestedCode)
	assertSnapshotUnchanged(t, f.pool, before, "events a waiting Round does not take")
	if rec := f.reportEvent(t, claim.RoundId, blockedEndings[1].event(t, "k5", claim.ClaimEpoch, interruptedEvidence)); rec.Code != http.StatusCreated {
		t.Fatalf("interrupted while waiting for input: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
}

func TestAnswer_RecordsTheAnswerAndQueuesAnAnswerCommandWithoutMovingTheRound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Answer me")
	answered := runnerEpoch.Add(20 * time.Second)
	f.clock.Set(answered)
	f.heartbeat(t, f.token, http.StatusOK)
	before := readTicketRowFacts(t, f.pool, queued.Id)

	ticket := f.mustAnswer(t, queued.Id, claim.RoundId, questionA)
	answer := ownerAnswer
	assertWaitingTicket(t, ticket, claim, WaitingResuming, &answer)
	if !ticket.OpenRound.Question.AnsweredAt.Equal(answered) {
		t.Fatalf("answeredAt = %v, want %v", ticket.OpenRound.Question.AnsweredAt, answered)
	}
	if a := ticket.AllowedActions.Answer; a.Available || a.Reason == nil || a.Reason.Code != questionAlreadyAnsweredCode {
		t.Fatalf("allowedActions.answer = %+v, want refused with %s", a, questionAlreadyAnsweredCode)
	}
	if !reflect.DeepEqual(f.ticket(t, queued.Id), ticket) {
		t.Fatalf("the answer's response differs from a read of the Ticket")
	}
	if after := readTicketRowFacts(t, f.pool, queued.Id); !reflect.DeepEqual(after, before) {
		t.Fatalf("the answer changed the Ticket row: before %+v, after %+v", before, after)
	}
	if rows := roundRows(t, f.pool); len(rows) != 1 || rows[0].state != string(RoundWaitingForInput) {
		t.Fatalf("Rounds = %+v, want the Round still waiting", rows)
	}

	commands := f.mustCommands(t, claim.RoundId)
	rows := roundCommandRows(t, f)
	want := []RunnerCommand{{Id: rows[0].commandID, Type: RunnerCommandAnswer, ClaimEpoch: claim.ClaimEpoch, IssuedAt: answered,
		Answer: &RunnerCommandAnswerData{QuestionId: questionA, Text: ownerAnswer}}}
	if !reflect.DeepEqual(commands, want) {
		t.Fatalf("commands = %+v, want %+v", commands, want)
	}
	decodeAck(t, f.ack(t, claim.RoundId, commands[0].Id, RunnerCommandApplied))
	if got := f.mustCommands(t, claim.RoundId); len(got) != 0 {
		t.Fatalf("commands after the ack = %+v, want none", got)
	}
	if got := f.ticket(t, queued.Id); got.Status != Blocked || got.OpenRound.State != OpenRoundWaitingForInput {
		t.Fatalf("the ack moved the Ticket: %s %+v", got.Status, got.OpenRound)
	}
}

func TestAnswer_TheFirstAnswerWins(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Answer twice")
	f.mustAnswer(t, queued.Id, claim.RoundId, questionA)
	before := databaseSnapshot(t, f.pool)
	rec := f.answer(t, queued.Id, claim.RoundId, questionA, "A second thought")
	assertErrorBody(t, rec, http.StatusBadRequest, questionAlreadyAnsweredCode, questionAlreadyAnsweredMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a second answer")
}

func TestAnswer_ConcurrentAnswersRecordExactlyOne(t *testing.T) {
	for trial := range 4 {
		f := newClaimFixture(t)
		queued, claim := f.waitingRound(t, fmt.Sprintf("Race %d", trial))
		codes, bodies := sendConcurrently(8, func(i int) *httptest.ResponseRecorder {
			return f.answer(t, queued.Id, claim.RoundId, questionA, fmt.Sprintf("answer %d", i))
		})
		winner := -1
		for i, code := range codes {
			switch {
			case code == http.StatusOK && winner == -1:
				winner = i
			case code == http.StatusBadRequest && strings.Contains(bodies[i], questionAlreadyAnsweredCode):
			default:
				t.Fatalf("trial %d response %d: status=%d body=%s", trial, i, code, bodies[i])
			}
		}
		if winner == -1 {
			t.Fatalf("trial %d: no answer recorded: %v", trial, bodies)
		}
		got := f.ticket(t, queued.Id).OpenRound.Question
		if want := fmt.Sprintf("answer %d", winner); got.Answer == nil || *got.Answer != want {
			t.Fatalf("trial %d: stored answer %v, want the winner's %q", trial, got.Answer, want)
		}
		commands := f.mustCommands(t, claim.RoundId)
		if len(commands) != 1 || commands[0].Answer == nil || commands[0].Answer.Text != *got.Answer {
			t.Fatalf("trial %d: commands = %+v, want one carrying the stored answer", trial, commands)
		}
	}
}

func TestAnswer_UnknownForeignAndMismatchedIdsAreTheSameNotFound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Mine")
	other := f.queue(t, "Another of mine")
	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	theirs, theirClaim := foreign.waitingRound(t, "Theirs")

	before := databaseSnapshot(t, f.pool)
	for name, path := range map[string]string{
		"an unknown Ticket":             answerPath(uuid.NewString(), claim.RoundId, questionA),
		"an unknown Round":              answerPath(queued.Id, uuid.NewString(), questionA),
		"an unknown question":           answerPath(queued.Id, claim.RoundId, questionB),
		"another Ticket of the Owner's": answerPath(other.Id, claim.RoundId, questionA),
		"another Owner's question":      answerPath(theirs.Id, theirClaim.RoundId, questionA),
		"another Owner's Round on mine": answerPath(queued.Id, theirClaim.RoundId, questionA),
		"a malformed Ticket id":         answerPath("not-a-uuid", claim.RoundId, questionA),
		"a malformed question id":       answerPath(queued.Id, claim.RoundId, "question-1"),
	} {
		t.Run(name, func(t *testing.T) {
			rec := f.do(t, runnerCall{method: http.MethodPost, path: path, body: `{"answer":"yes"}`, cookie: f.cookie})
			assertErrorBody(t, rec, http.StatusNotFound, "not_found", questionNotFoundMessage)
		})
	}
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: answerPath(queued.Id, claim.RoundId, questionA), body: `{"answer":"yes"}`}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: answerPath(queued.Id, claim.RoundId, questionA), body: `{"answer":"yes"}`, token: f.token}))
	assertSnapshotUnchanged(t, f.pool, before, "answers that are not the Owner's")
}

func TestAnswer_TheBodyIsDecodedStrictly(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Strict answer")
	before := databaseSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"no body":             "",
		"no answer":           `{}`,
		"an extra field":      `{"answer":"yes","questionId":"x"}`,
		"a numeric answer":    `{"answer":7}`,
		"a null answer":       `{"answer":null}`,
		"a blank answer":      `{"answer":" \n\t "}`,
		"a control character": `{"answer":"a\u0007b"}`,
		"over 2000":           jsonText(t, map[string]string{"answer": strings.Repeat("界", 2001)}),
		"trailing data":       `{"answer":"yes"} {}`,
		"not JSON":            `answer=yes`,
	} {
		t.Run(name, func(t *testing.T) {
			assertInvalidRequest(t, f.do(t, runnerCall{method: http.MethodPost, path: answerPath(queued.Id, claim.RoundId, questionA), body: body, cookie: f.cookie}))
		})
	}
	assertSnapshotUnchanged(t, f.pool, before, "malformed answers")
	if rec := f.answer(t, queued.Id, claim.RoundId, questionA, strings.Repeat("界", 2000)); rec.Code != http.StatusOK {
		t.Fatalf("a 2000-character answer: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAnswer_IsRefusedOnceStopIsRequestedAndAfterTheRoundEnds(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Stop the question")
	stopping := f.mustStop(t, queued.Id)
	if stopping.OpenRound == nil || stopping.OpenRound.WaitingReason != WaitingStopping {
		t.Fatalf("openRound after Stop = %+v, want Stopping", stopping.OpenRound)
	}
	if a := stopping.AllowedActions.Answer; a.Available || a.Reason == nil || a.Reason.Code != stopAlreadyRequestedCode {
		t.Fatalf("allowedActions.answer = %+v, want refused with %s", a, stopAlreadyRequestedCode)
	}
	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.answer(t, queued.Id, claim.RoundId, questionA, ownerAnswer), http.StatusBadRequest, stopAlreadyRequestedCode, answerStopRequestedMessage)
	assertSnapshotUnchanged(t, f.pool, before, "an answer once Stop is requested")

	f.mustConfirmStop(t, claim)
	after := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.answer(t, queued.Id, claim.RoundId, questionA, ownerAnswer), http.StatusBadRequest, roundNotOpenCode, roundNotOpenMessage)
	assertErrorCode(t, f.resume(t, claim, questionA), roundNotOpenCode)
	assertSnapshotUnchanged(t, f.pool, after, "an answer and a resume after the Round stopped")
}

func TestStopConfirmed_FromWaitingForInputMovesTheTicketToBacklogWithTheStoppedBadgeAndFreesTheSlot(t *testing.T) {
	for _, answered := range []bool{false, true} {
		t.Run(map[bool]string{false: "unanswered", true: "answered"}[answered], func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.waitingRound(t, "Stop while asking")
			if answered {
				f.mustAnswer(t, queued.Id, claim.RoundId, questionA)
			}
			waiting := f.queue(t, "Next")
			f.mustStop(t, queued.Id)
			commands := f.mustCommands(t, claim.RoundId)
			if commands[0].Type != RunnerCommandStop {
				t.Fatalf("commands = %+v, want the Stop listed first", commands)
			}
			endedAt := runnerEpoch.Add(time.Minute)
			f.clock.Set(endedAt)
			rec := f.mustConfirmStop(t, claim)
			if got, want := rec.Body.String(), wantStoppedResult(claim.RoundId, &runnerEpoch, endedAt); got != want {
				t.Fatalf("body = %s, want %s", got, want)
			}
			assertStoppedTicket(t, f.ticket(t, queued.Id), stoppedBadgeOf(t, f))
			round := f.roundOf(t, queued.Id)
			if round.State != RoundStopped || len(round.Questions) != 1 || (round.Questions[0].Answer != nil) != answered {
				t.Fatalf("listed Round = %+v, want stopped with its question kept", round)
			}
			f.heartbeat(t, f.token, http.StatusOK)
			if next := f.mustClaim(t); next.Ticket.Id != waiting.Id {
				t.Fatalf("the freed slot claimed %s, want %s", next.Ticket.Id, waiting.Id)
			}
		})
	}
}

func TestRoundCommands_AStopIsListedBeforeAnEarlierAnswer(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Order")
	f.mustAnswer(t, queued.Id, claim.RoundId, questionA)
	f.clock.Set(runnerEpoch.Add(time.Second))
	f.mustStop(t, queued.Id)
	commands := f.mustCommands(t, claim.RoundId)
	if len(commands) != 2 || commands[0].Type != RunnerCommandStop || commands[1].Type != RunnerCommandAnswer || !commands[0].IssuedAt.After(commands[1].IssuedAt) {
		t.Fatalf("commands = %+v, want the later Stop before the earlier answer", commands)
	}
	if commands[0].Answer != nil {
		t.Fatalf("the Stop carries an answer: %+v", commands[0])
	}
}

func TestResumed_ContinuesTheSameRoundToDelivery(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Resume me")
	f.mustAnswer(t, queued.Id, claim.RoundId, questionA)
	rec := f.resume(t, claim, questionA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("resumed: status=%d body=%s", rec.Code, rec.Body.String())
	}
	want := fmt.Sprintf(`{"questionId":%q,"roundId":%q,"startedAt":%q,"state":"running","type":"resumed"}`, questionA, claim.RoundId, runnerEpoch.Format(time.RFC3339Nano))
	if rec.Body.String() != want {
		t.Fatalf("body = %s, want %s", rec.Body.String(), want)
	}
	ticket := f.ticket(t, queued.Id)
	if ticket.Status != InProgress || ticket.OpenRound == nil || ticket.OpenRound.Id != claim.RoundId || ticket.OpenRound.State != OpenRoundRunning ||
		ticket.OpenRound.Question != nil || ticket.OpenRound.WaitingReason != WaitingWorking {
		t.Fatalf("Ticket after resuming = %s %+v, want In Progress with the same Round running", ticket.Status, ticket.OpenRound)
	}
	if a := ticket.AllowedActions.Answer; a.Available || a.Reason == nil || a.Reason.Code != answerNotAvailableCode {
		t.Fatalf("allowedActions.answer = %+v, want %s", a, answerNotAvailableCode)
	}
	replay := f.resume(t, claim, questionA)
	if replay.Code != http.StatusOK || replay.Body.String() != want {
		t.Fatalf("replayed resume: status=%d body=%s", replay.Code, replay.Body.String())
	}

	f.mustReport(t, claim.RoundId, progressEvent(t, claim.RoundId+":5", claim.ClaimEpoch, eventOccurredAt, "Owner's answer: "+ownerAnswer))
	f.mustReport(t, claim.RoundId, questionEvent(t, questionB, claim.ClaimEpoch, questionB, "And the year?"))
	f.mustAnswer(t, queued.Id, claim.RoundId, questionB)
	f.mustReport(t, claim.RoundId, resumedEvent(t, claim.RoundId+":7", claim.ClaimEpoch, questionB))
	f.mustReport(t, claim.RoundId, deliveredEvent(t, claim.RoundId+":deliver", claim.ClaimEpoch, standardDeliverable()))

	if got := f.ticket(t, queued.Id); got.Status != InReview || got.OpenRound != nil {
		t.Fatalf("Ticket after delivery = %s %+v, want In Review", got.Status, got.OpenRound)
	}
	rounds := decodeRounds(t, f.listRounds(t, queued.Id))
	if len(rounds) != 1 || rounds[0].Id != claim.RoundId || rounds[0].State != RoundDelivered {
		t.Fatalf("Rounds = %+v, want the one Round delivered", rounds)
	}
	questions := rounds[0].Questions
	if len(questions) != 2 || questions[0].Id != questionA || questions[1].Id != questionB || questions[0].Answer == nil || *questions[0].Answer != ownerAnswer || questions[1].Answer == nil {
		t.Fatalf("questions = %+v, want both, oldest first, answered", questions)
	}
	if len(rounds[0].Activity) != 1 || rounds[0].Activity[0].Note != "Owner's answer: "+ownerAnswer {
		t.Fatalf("activity = %+v, want the answer note", rounds[0].Activity)
	}
}

func TestResumed_NeedsTheAnswerToTheQuestionTheRoundWaitsOn(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Not yet")
	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.resume(t, claim, questionA), http.StatusConflict, answerNotSuppliedCode, answerNotSuppliedMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a resume before the answer")

	f.mustAnswer(t, queued.Id, claim.RoundId, questionA)
	before = databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.resume(t, claim, questionB), http.StatusConflict, answerNotSuppliedCode, answerNotSuppliedMessage)
	assertErrorCode(t, f.reportEvent(t, claim.RoundId, resumedEvent(t, "stale", claim.ClaimEpoch+1, questionA)), staleClaimEpochCode)
	assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, jsonText(t, map[string]any{"type": "resumed", "idempotencyKey": "x", "claimEpoch": claim.ClaimEpoch, "occurredAt": eventOccurredAt,
		"data": map[string]any{"questionId": questionA, "answer": "smuggled"}})))
	assertSnapshotUnchanged(t, f.pool, before, "a resume for another question")

	t.Run("a running Round", func(t *testing.T) {
		g := newClaimFixture(t)
		_, running := g.runningRound(t, "Running")
		assertErrorCode(t, g.resume(t, running, questionA), eventOutOfOrderCode)
	})
}

func TestWaitingReason_FollowsTheQuestionStopAndRunnerContact(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Reasons")
	if got := f.ticket(t, queued.Id).OpenRound.WaitingReason; got != WaitingForAnswer {
		t.Fatalf("reason = %s, want %s", got, WaitingForAnswer)
	}
	f.mustAnswer(t, queued.Id, claim.RoundId, questionA)
	if got := f.ticket(t, queued.Id).OpenRound.WaitingReason; got != WaitingResuming {
		t.Fatalf("reason = %s, want %s", got, WaitingResuming)
	}
	f.clock.Set(runnerEpoch.Add(time.Hour))
	if got := f.ticket(t, queued.Id).OpenRound.WaitingReason; got != WaitingRunnerDisconnected {
		t.Fatalf("reason = %s, want %s", got, WaitingRunnerDisconnected)
	}
}

func TestAnswer_TakesTheTicketRowThenTheQuestionRow(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.waitingRound(t, "Lock order")
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
	go func() { result <- f.answer(t, queued.Id, claim.RoundId, questionA, ownerAnswer) }()
	waitForLockWaiter(t, f.pool, "FOR UPDATE")
	probe, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := probe.Exec(ctx, `SELECT 1 FROM round_questions WHERE question_id = $1::uuid FOR UPDATE NOWAIT`, questionA); err != nil {
		t.Fatalf("the waiting answer already holds the question row: %v", err)
	}
	_ = probe.Rollback(ctx)
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if rec := <-result; rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s, want 200 once the lock is released", rec.Code, rec.Body.String())
	}
}

func TestAnswer_RacingStopLeavesEitherAStoppingRoundWithNoAnswerOrBothCommands(t *testing.T) {
	outcomes := map[string]int{}
	for trial := range 8 {
		f := newClaimFixture(t)
		queued, claim := f.waitingRound(t, fmt.Sprintf("Race %d", trial))
		codes, bodies := sendConcurrently(2, func(i int) *httptest.ResponseRecorder {
			if i == 0 {
				return f.stop(t, queued.Id)
			}
			return f.answer(t, queued.Id, claim.RoundId, questionA, ownerAnswer)
		})
		if codes[0] != http.StatusOK {
			t.Fatalf("trial %d: stop: %d %s", trial, codes[0], bodies[0])
		}
		commands := f.mustCommands(t, claim.RoundId)
		switch codes[1] {
		case http.StatusOK:
			if len(commands) != 2 || commands[0].Type != RunnerCommandStop {
				t.Fatalf("trial %d: commands = %+v, want the Stop first, then the answer", trial, commands)
			}
			outcomes["answered first"]++
		case http.StatusBadRequest:
			if !strings.Contains(bodies[1], stopAlreadyRequestedCode) || len(commands) != 1 {
				t.Fatalf("trial %d: answer %s, commands %+v", trial, bodies[1], commands)
			}
			outcomes["stopped first"]++
		default:
			t.Fatalf("trial %d: answer: %d %s", trial, codes[1], bodies[1])
		}
	}
	t.Logf("%v", outcomes)
}

func TestRoundQuestions_TheDatabaseEnforcesTheQuestionInvariants(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.waitingRound(t, "Constraints")
	ownerID, roundID := roundRowIDs(t, f, claim.RoundId)
	ctx := context.Background()
	insert := func(questionID, text string, answer any, answeredAt string) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO round_questions (owner_id, round_id, question_id, text, asked_at, answer, answered_at)
			VALUES ($1, $2, $3::uuid, $4, now(), $5, `+answeredAt+`)`, ownerID, roundID, questionID, text, answer)
		return err
	}
	for _, tc := range []struct {
		name, questionID, text string
		answer                 any
		answeredAt, constraint string
	}{
		{"a second unanswered question", questionB, "q", nil, "NULL", "round_questions_one_unanswered_per_round"},
		{"the same question id", questionA, "q", "a", "now()", "round_questions_question_unique"},
		{"an answer without a time", questionB, "q", "a", "NULL", "round_questions_answered_together"},
		{"a time without an answer", questionB, "q", nil, "now()", "round_questions_answered_together"},
		{"an answer before the question", questionB, "q", "a", "now() - interval '1 hour'", "round_questions_answered_after_asked"},
		{"an empty text", questionB, "", "a", "now()", "round_questions_text_length"},
		{"a blank text", questionB, " \n", "a", "now()", "round_questions_text_not_blank"},
		{"a blank answer", questionB, "q", " \t", "now()", "round_questions_answer_not_blank"},
		{"an answer over 2000", questionB, "q", strings.Repeat("界", 2001), "now()", "round_questions_answer_length"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertViolates(t, insert(tc.questionID, tc.text, tc.answer, tc.answeredAt), tc.constraint)
		})
	}
	var questionRowID int64
	if err := f.pool.QueryRow(ctx, `SELECT id FROM round_questions WHERE question_id = $1::uuid`, questionA).Scan(&questionRowID); err != nil {
		t.Fatal(err)
	}
	command := func(commandType string, questionID any) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO round_commands (owner_id, round_id, public_id, type, claim_epoch, issued_at, question_id)
			VALUES ($1, $2, gen_random_uuid(), $3, 1, now(), $4)`, ownerID, roundID, commandType, questionID)
		return err
	}
	assertViolates(t, command("answer", nil), "round_commands_question_follows_type")
	assertViolates(t, command("stop", questionRowID), "round_commands_question_follows_type")
	if err := command("answer", questionRowID); err != nil {
		t.Fatal(err)
	}
	assertViolates(t, command("answer", questionRowID), "round_commands_one_answer_per_question")
	assertViolates(t, func() error {
		_, err := f.pool.Exec(ctx, `UPDATE rounds SET started_at = NULL WHERE id = $1`, roundID)
		return err
	}(), "rounds_timestamps_follow_state")
}
