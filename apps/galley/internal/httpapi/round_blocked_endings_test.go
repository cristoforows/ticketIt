package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

const (
	failedExplanation   = "The repository named in the Ticket does not exist, so the goal cannot be met"
	interruptedEvidence = "Execution ceased at step 4 of 4: the engine process exited with signal SIGKILL"
)

type blockedEnding struct {
	eventType RoundEventType
	state     RoundState
	field     string
	note      string
}

var blockedEndings = []blockedEnding{
	{RoundEventFailed, RoundFailed, "explanation", failedExplanation},
	{RoundEventInterrupted, RoundInterrupted, "evidence", interruptedEvidence},
}

func (e blockedEnding) name() string { return string(e.eventType) }

func (e blockedEnding) event(t *testing.T, key string, epoch int, note string) string {
	t.Helper()
	return e.eventWith(t, key, epoch, map[string]any{e.field: note})
}

func (e blockedEnding) eventWith(t *testing.T, key string, epoch int, data any) string {
	t.Helper()
	return jsonText(t, map[string]any{"type": e.eventType, "idempotencyKey": key, "claimEpoch": epoch, "occurredAt": eventOccurredAt, "data": data})
}

func (e blockedEnding) key(claim RunnerClaim) string { return claim.RoundId + ":3" }

func (f *claimFixture) endAs(t *testing.T, e blockedEnding, claim RunnerClaim) *httptest.ResponseRecorder {
	t.Helper()
	return f.reportEvent(t, claim.RoundId, e.event(t, e.key(claim), claim.ClaimEpoch, e.note))
}

func (f *claimFixture) mustEndAs(t *testing.T, e blockedEnding, claim RunnerClaim) *httptest.ResponseRecorder {
	t.Helper()
	return f.mustReport(t, claim.RoundId, e.event(t, e.key(claim), claim.ClaimEpoch, e.note))
}

func (f *claimFixture) statusChange(t *testing.T, id string, status TicketStatus) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/status", body: fmt.Sprintf(`{"status":%q}`, status), cookie: f.cookie})
}

func (f *claimFixture) blockedRound(t *testing.T, e blockedEnding, title string) (Ticket, RunnerClaim) {
	t.Helper()
	queued, claim := f.runningRound(t, title)
	f.mustReport(t, claim.RoundId, progressEvent(t, claim.RoundId+":1", claim.ClaimEpoch, eventOccurredAt, "Reading the Ticket"))
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, claim.ClaimEpoch, usageData(observationA)))
	f.mustEndAs(t, e, claim)
	return queued, claim
}

func wantEndedResult(e blockedEnding, roundID string, endedAt time.Time) string {
	return fmt.Sprintf(`{"endedAt":%q,"roundId":%q,"startedAt":%q,"state":%q,"type":%q}`,
		endedAt.UTC().Format(time.RFC3339Nano), roundID, runnerEpoch.Format(time.RFC3339Nano), e.state, e.eventType)
}

func assertBlockedTicket(t *testing.T, ticket Ticket) {
	t.Helper()
	if ticket.Status != Blocked || ticket.OpenRound != nil || ticket.RequestingAgentWork || ticket.Delivery != nil || len(ticket.Badges) != 0 {
		t.Fatalf("Ticket after the Round ended: status=%s openRound=%+v requestingAgentWork=%t delivery=%+v badges=%+v, want Blocked with no open Round and no Badge",
			ticket.Status, ticket.OpenRound, ticket.RequestingAgentWork, ticket.Delivery, ticket.Badges)
	}
	if stop := ticket.AllowedActions.Stop; stop.Available || stop.Reason == nil || stop.Reason.Code != stopNotAvailableCode {
		t.Fatalf("allowedActions.stop = %+v, want unavailable with %s", stop, stopNotAvailableCode)
	}
}

func TestFailedAndInterrupted_EndTheRunningRoundMoveTheTicketToBlockedAndFreeTheSlot(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.runningRound(t, "End me")
			f.mustReport(t, claim.RoundId, progressEvent(t, claim.RoundId+":1", claim.ClaimEpoch, eventOccurredAt, "Reading the Ticket"))
			f.mustReport(t, claim.RoundId, usageEvent(t, observationA, claim.ClaimEpoch, usageData(observationA)))
			open := f.roundOf(t, queued.Id)
			waiting := f.queue(t, "Waiting")
			before := readTicketRowFacts(t, f.pool, queued.Id)

			galleyNow := runnerEpoch.Add(42 * time.Second)
			f.clock.Set(galleyNow)
			rec := f.endAs(t, e, claim)
			if rec.Code != http.StatusCreated {
				t.Fatalf("status=%d, want 201; body=%s", rec.Code, rec.Body.String())
			}
			if got, want := rec.Body.String(), wantEndedResult(e, claim.RoundId, galleyNow); got != want {
				t.Fatalf("body = %s, want %s", got, want)
			}

			ticket := f.ticket(t, queued.Id)
			assertBlockedTicket(t, ticket)
			if !containsStatus(ticket.AllowedActions.StatusChanges, Ready) {
				t.Fatalf("allowedActions.statusChanges = %v, want Ready offered as the recovery", ticket.AllowedActions.StatusChanges)
			}
			after := readTicketRowFacts(t, f.pool, queued.Id)
			if after.status != string(Blocked) || !after.updatedAt.After(before.updatedAt) || after.rank != before.rank || !reflect.DeepEqual(after.agentID, before.agentID) || after.assigneeType != before.assigneeType {
				t.Fatalf("Ticket row before %+v, after %+v: want Blocked, a later updated_at, the same rank and assignment", before, after)
			}
			var state, note string
			var endedAt time.Time
			if err := f.pool.QueryRow(context.Background(), `SELECT state, outcome_note, ended_at FROM rounds WHERE public_id = $1::uuid`, claim.RoundId).Scan(&state, &note, &endedAt); err != nil {
				t.Fatal(err)
			}
			if state != string(e.state) || note != e.note || !endedAt.Equal(galleyNow) {
				t.Fatalf("Round row = %s %q %v, want %s with the note at %v", state, note, endedAt, e.state, galleyNow)
			}
			round := f.roundOf(t, queued.Id)
			if round.State != e.state || round.OutcomeNote == nil || *round.OutcomeNote != e.note || round.EndedAt == nil || !round.EndedAt.Equal(galleyNow) || round.Deliverable != nil ||
				!reflect.DeepEqual(round.Activity, open.Activity) || !reflect.DeepEqual(round.Usage, open.Usage) || len(round.Activity) != 1 || round.Usage.Observations != 1 {
				t.Fatalf("listed Round = %+v, want %s with its note, the open Round's activity %+v and usage %+v, and no deliverable", round, e.state, open.Activity, open.Usage)
			}
			var eventType string
			if err := f.pool.QueryRow(context.Background(), `SELECT type FROM round_events WHERE idempotency_key = $1`, e.key(claim)).Scan(&eventType); err != nil || eventType != string(e.eventType) {
				t.Fatalf("stored event type = %q (%v)", eventType, err)
			}
			if n := tableRowCount(t, f.pool, "round_deliverables"); n != 0 {
				t.Fatalf("round_deliverables = %d, want none: partial results are activity and usage", n)
			}

			badgeRequest(t, f.handler, f.cookie, http.MethodPatch, "/api/tickets/"+queued.Id, `{"title":"Edited once blocked"}`, http.StatusOK)
			f.heartbeat(t, f.token, http.StatusOK)
			if next := f.mustClaim(t); next.Ticket.Id != waiting.Id {
				t.Fatalf("the freed slot claimed %s, want the waiting Ticket %s", next.Ticket.Id, waiting.Id)
			}
		})
	}
}

func TestFailedAndInterrupted_NoRoundStartsUntilTheOwnerMovesTheTicketToReady(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.blockedRound(t, e, "No requeue")
			ended := roundSnapshot(t, f.pool, claim.RoundId)
			for _, at := range []time.Duration{0, time.Minute, 24 * time.Hour} {
				f.clock.Set(runnerEpoch.Add(at))
				f.heartbeat(t, f.token, http.StatusOK)
				assertNoWork(t, f.claim(t))
			}
			if rows := roundRows(t, f.pool); len(rows) != 1 {
				t.Fatalf("rounds = %+v, want only the ended one", rows)
			}
			if got := f.ticket(t, queued.Id); got.Status != Blocked {
				t.Fatalf("Ticket = %s, want still Blocked", got.Status)
			}

			recovered := f.changeStatus(t, queued.Id, Ready)
			if recovered.Status != Ready || !recovered.RequestingAgentWork || recovered.OpenRound != nil {
				t.Fatalf("recovered Ticket = %+v, want Ready, requesting Agent work, no open Round", recovered)
			}
			next := f.mustClaim(t)
			if next.RoundId == claim.RoundId || next.Ticket.Id != queued.Id || next.Sequence != claim.Sequence+1 || next.ClaimEpoch != claim.ClaimEpoch+1 {
				t.Fatalf("next claim = %+v, want a new Round of %s with sequence %d and epoch %d", next, queued.Id, claim.Sequence+1, claim.ClaimEpoch+1)
			}
			if got := roundSnapshot(t, f.pool, claim.RoundId); got != ended {
				t.Fatalf("the ended Round changed:\nbefore %s\nafter %s", ended, got)
			}
			rounds := decodeRounds(t, f.listRounds(t, queued.Id))
			if len(rounds) != 2 || rounds[0].Id != next.RoundId || rounds[0].State != RoundClaimed || rounds[0].OutcomeNote != nil ||
				rounds[1].Id != claim.RoundId || rounds[1].State != e.state || rounds[1].OutcomeNote == nil || *rounds[1].OutcomeNote != e.note {
				t.Fatalf("rounds = %+v, want the new claimed Round above the %s one", rounds, e.state)
			}
		})
	}
}

func TestFailedAndInterrupted_OnAClaimedRoundIsEventOutOfOrderAndChangesNothing(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.claimTicket(t, "Never started")
			before := databaseSnapshot(t, f.pool)
			assertErrorBody(t, f.endAs(t, e, claim), http.StatusConflict, eventOutOfOrderCode, eventOutOfOrderMessage(e.eventType, RoundClaimed))
			assertSnapshotUnchanged(t, f.pool, before, string(e.eventType)+" on a claimed Round")
			if got := f.ticket(t, queued.Id); got.Status != Ready || got.OpenRound == nil {
				t.Fatalf("Ticket = %s %+v, want Ready with its Round still open", got.Status, got.OpenRound)
			}
		})
	}
}

func TestFailedAndInterrupted_AtAStaleEpochIsStaleClaimEpochAndChangesNothing(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.runningRound(t, "Stale")
			before := databaseSnapshot(t, f.pool)
			for _, epoch := range []int{claim.ClaimEpoch + 1, claim.ClaimEpoch + 5} {
				rec := f.reportEvent(t, claim.RoundId, e.event(t, fmt.Sprintf("stale-%d", epoch), epoch, e.note))
				assertErrorBody(t, rec, http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
			}
			assertSnapshotUnchanged(t, f.pool, before, string(e.eventType)+" at a stale epoch")
			if got := f.ticket(t, queued.Id); got.Status != InProgress || got.OpenRound == nil {
				t.Fatalf("Ticket = %s %+v, want In Progress, still open", got.Status, got.OpenRound)
			}
			assertNoWork(t, f.claim(t))
		})
	}
}

func TestFailedAndInterrupted_OnAnEndedRoundIsRoundNotOpenAndChangesNothing(t *testing.T) {
	endings := map[string]func(t *testing.T, f *claimFixture, claim RunnerClaim){
		"delivered": func(t *testing.T, f *claimFixture, claim RunnerClaim) { f.deliver(t, claim) },
		"stopped": func(t *testing.T, f *claimFixture, claim RunnerClaim) {
			f.mustStop(t, claim.Ticket.Id)
			f.mustConfirmStop(t, claim)
		},
	}
	for _, earlier := range blockedEndings {
		endings[string(earlier.state)] = func(t *testing.T, f *claimFixture, claim RunnerClaim) { f.mustEndAs(t, earlier, claim) }
	}
	for _, e := range blockedEndings {
		for name, end := range endings {
			t.Run(e.name()+" after "+name, func(t *testing.T) {
				f := newClaimFixture(t)
				_, claim := f.runningRound(t, "Ended first")
				end(t, f, claim)
				before := databaseSnapshot(t, f.pool)
				rec := f.reportEvent(t, claim.RoundId, e.event(t, "late", claim.ClaimEpoch, e.note))
				assertErrorBody(t, rec, http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
				assertSnapshotUnchanged(t, f.pool, before, string(e.eventType)+" for a Round already "+name)
			})
		}
	}
}

func TestFailedAndInterrupted_ReplayReturnsTheStoredResultAndChangesNothing(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			f := newClaimFixture(t)
			_, claim := f.runningRound(t, "Replay")
			first := f.mustEndAs(t, e, claim)
			before := databaseSnapshot(t, f.pool)
			f.clock.Set(runnerEpoch.Add(time.Hour))
			rec := f.endAs(t, e, claim)
			if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
				t.Fatalf("replay: status=%d body=%s, want 200 %s", rec.Code, rec.Body.String(), first.Body.String())
			}
			assertSnapshotUnchanged(t, f.pool, before, "a replayed "+string(e.eventType))
			rec = f.reportEvent(t, claim.RoundId, e.event(t, e.key(claim), claim.ClaimEpoch, "A different note"))
			assertErrorBody(t, rec, http.StatusConflict, idempotencyKeyConflictCode, idempotencyKeyConflictMessage)
			assertSnapshotUnchanged(t, f.pool, before, "a "+string(e.eventType)+" key reused with another note")
		})
	}
}

func TestFailedAndInterrupted_ConcurrentIdenticalReportsApplyExactlyOnce(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.runningRound(t, "Concurrent")
			body := e.event(t, e.key(claim), claim.ClaimEpoch, e.note)
			codes, bodies := sendConcurrently(8, func(int) *httptest.ResponseRecorder { return f.reportEvent(t, claim.RoundId, body) })
			created := 0
			for i, code := range codes {
				switch code {
				case http.StatusCreated:
					created++
				case http.StatusOK:
				default:
					t.Fatalf("response %d: status=%d body=%s", i, code, bodies[i])
				}
				if bodies[i] != bodies[0] {
					t.Fatalf("bodies differ: %s vs %s", bodies[i], bodies[0])
				}
			}
			if events := tableRowCount(t, f.pool, "round_events"); created != 1 || events != 2 {
				t.Fatalf("created=%d events=%d, want one report applied beside execution_started", created, events)
			}
			assertBlockedTicket(t, f.ticket(t, queued.Id))
		})
	}
}

func TestFailedAndInterrupted_ConcurrentDifferentEndingsLeaveExactlyOne(t *testing.T) {
	for trial := range 5 {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, fmt.Sprintf("Race %d", trial))
		var wg sync.WaitGroup
		results := make([]*httptest.ResponseRecorder, len(blockedEndings)+1)
		for i, e := range blockedEndings {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[i] = f.reportEvent(t, claim.RoundId, e.event(t, e.name(), claim.ClaimEpoch, e.note))
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[2] = f.reportEvent(t, claim.RoundId, standardDeliveredEvent(t, claim))
		}()
		wg.Wait()
		winner := ""
		for i, rec := range results {
			switch rec.Code {
			case http.StatusCreated:
				if winner != "" {
					t.Fatalf("trial %d: two endings applied (%s and response %d)", trial, winner, i)
				}
				winner = rec.Body.String()
			case http.StatusConflict:
				assertErrorBody(t, rec, http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
			default:
				t.Fatalf("trial %d response %d: status=%d body=%s", trial, i, rec.Code, rec.Body.String())
			}
		}
		round := f.roundOf(t, queued.Id)
		ticket := f.ticket(t, queued.Id)
		switch round.State {
		case RoundFailed, RoundInterrupted:
			assertBlockedTicket(t, ticket)
		case RoundDelivered:
			if ticket.Status != InReview || round.OutcomeNote != nil {
				t.Fatalf("trial %d: delivered Round %+v with Ticket %s, want In Review and no note", trial, round, ticket.Status)
			}
		default:
			t.Fatalf("trial %d: Round = %s, want one ending", trial, round.State)
		}
		if !strings.Contains(winner, `"state":"`+string(round.State)+`"`) {
			t.Fatalf("trial %d: the 201 %s does not name the stored state %s", trial, winner, round.State)
		}
	}
}

// A runner may find the work impossible after the Owner asked to Stop; the Round ends with what actually happened.
func TestFailedAndInterrupted_AfterAStopRequestEndTheRoundAsReportedWithoutTheStoppedBadge(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim, _ := f.stoppedRound(t, "Stop requested", true)
			f.mustEndAs(t, e, claim)
			assertBlockedTicket(t, f.ticket(t, queued.Id))
			if round := f.roundOf(t, queued.Id); round.State != e.state {
				t.Fatalf("Round = %s, want %s", round.State, e.state)
			}
			if commands := f.mustCommands(t, claim.RoundId); len(commands) != 0 {
				t.Fatalf("commands of the ended Round = %+v, want none", commands)
			}
			if rows := badgeRows(t, f); len(rows) != 0 {
				t.Fatalf("badges = %+v, want none", rows)
			}
			assertErrorBody(t, f.confirmStop(t, claim), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
		})
	}
}

func TestFailedAndInterrupted_AreTerminal(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.blockedRound(t, e, "Terminal")
			before := databaseSnapshot(t, f.pool)
			bodies := map[string]string{
				"execution_started": startedEvent("late-start", claim.ClaimEpoch, eventOccurredAt, "controlled:late"),
				"progress":          progressEvent(t, "late-progress", claim.ClaimEpoch, eventOccurredAt, "Still going"),
				"usage_observed":    usageEvent(t, observationB, claim.ClaimEpoch, usageData(observationB)),
				"delivered":         deliveredEvent(t, "late-deliver", claim.ClaimEpoch, standardDeliverable()),
				"stop_confirmed":    stopConfirmedEvent(t, "late-stop", claim.ClaimEpoch, stopEvidence),
			}
			for _, other := range blockedEndings {
				bodies[string(other.eventType)] = other.event(t, "late-"+other.name(), claim.ClaimEpoch, other.note)
			}
			for name, body := range bodies {
				t.Run(name, func(t *testing.T) {
					assertErrorBody(t, f.reportEvent(t, claim.RoundId, body), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
				})
			}
			rec := f.stop(t, queued.Id)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("Stop on a Blocked Ticket: status=%d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			assertErrorCode(t, rec, stopNotAvailableCode)
			assertSnapshotUnchanged(t, f.pool, before, "events and a Stop after the Round ended")
		})
	}
}

func TestFailedAndInterrupted_ATicketNotInProgressRollsBackAndAnswers500(t *testing.T) {
	for _, e := range blockedEndings {
		for _, status := range []TicketStatus{Ready, Blocked, Backlog} {
			t.Run(e.name()+" with the Ticket "+string(status), func(t *testing.T) {
				f := newClaimFixture(t)
				queued, claim := f.runningRound(t, "Broken invariant")
				var logs bytes.Buffer
				handler := NewHandlerWithClock(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), f.pool, testLogger(&logs), f.clock.Now)
				if _, err := f.pool.Exec(context.Background(), `UPDATE tickets SET status = $2 WHERE public_id = $1::uuid`, queued.Id, string(status)); err != nil {
					t.Fatal(err)
				}
				before := databaseSnapshot(t, f.pool)
				req := httptest.NewRequest(http.MethodPost, "/api/runner/rounds/"+claim.RoundId+"/events", strings.NewReader(e.event(t, "end", claim.ClaimEpoch, e.note)))
				req.Header.Set("Authorization", "Bearer "+f.token)
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)
				assertErrorBody(t, rec, http.StatusInternalServerError, "internal_error", roundEventFailedMessage)
				assertSnapshotUnchanged(t, f.pool, before, "a "+string(e.eventType)+" whose Ticket guard failed")
				if out := logs.String(); !strings.Contains(out, claim.RoundId) || !strings.Contains(out, "ERROR") || !strings.Contains(out, errEndingTicketNotActive.Error()) {
					t.Fatalf("the broken invariant was not logged with the Round id:\n%s", out)
				}
			})
		}
	}
}

func TestFailedAndInterrupted_AFailureAtTheLastWriteRollsBackEveryChange(t *testing.T) {
	f := newClaimFixture(t)
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `CREATE FUNCTION refuse_endings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
		CREATE TRIGGER refuse_endings BEFORE INSERT ON round_events FOR EACH ROW WHEN (NEW.type IN ('failed', 'interrupted')) EXECUTE FUNCTION refuse_endings()`); err != nil {
		t.Fatal(err)
	}
	queued, claim := f.runningRound(t, "Rollback")
	f.queue(t, "Waiting")
	for _, e := range blockedEndings {
		before := databaseSnapshot(t, f.pool)
		assertErrorBody(t, f.endAs(t, e, claim), http.StatusServiceUnavailable, "database_unavailable", roundEventFailedMessage)
		assertSnapshotUnchanged(t, f.pool, before, "a "+string(e.eventType)+" whose last write failed")
		if got := f.ticket(t, queued.Id); got.Status != InProgress || got.OpenRound == nil {
			t.Fatalf("%s: Ticket = %s %+v, want In Progress, still open", e.name(), got.Status, got.OpenRound)
		}
		assertNoWork(t, f.claim(t))
	}
}

func TestFailedAndInterrupted_NoteLimitsAtTheAPI(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			f := newClaimFixture(t)
			_, claim := f.runningRound(t, "Limits")
			before := databaseSnapshot(t, f.pool)
			shape := fmt.Sprintf(`"data" must be an object with exactly %q`, e.field)
			limits := fmt.Sprintf(`%q must be 1 to 2000 characters, not blank, without control characters other than tab and line feed`, e.field)
			other := map[string]string{"explanation": "evidence", "evidence": "explanation"}[e.field]
			for name, tc := range map[string]struct {
				data    any
				message string
			}{
				"no note":              {map[string]any{}, shape},
				"the other note field": {map[string]any{other: e.note}, shape},
				"an extra field":       {map[string]any{e.field: e.note, "note": "n"}, shape},
				"a number":             {map[string]any{e.field: 1}, shape},
				"null":                 {map[string]any{e.field: nil}, limits},
				"data is an array":     {[]any{e.note}, shape},
				"empty":                {map[string]any{e.field: ""}, limits},
				"blank":                {map[string]any{e.field: " \t\n "}, limits},
				"2001 characters":      {map[string]any{e.field: strings.Repeat("界", 2001)}, limits},
				"a carriage return":    {map[string]any{e.field: "a\rb"}, limits},
				"a NUL":                {map[string]any{e.field: "a\x00b"}, limits},
			} {
				t.Run(name, func(t *testing.T) {
					rec := f.reportEvent(t, claim.RoundId, e.eventWith(t, "bad", claim.ClaimEpoch, tc.data))
					assertErrorBody(t, rec, http.StatusBadRequest, "invalid_request", tc.message)
				})
			}
			assertSnapshotUnchanged(t, f.pool, before, "invalid "+string(e.eventType)+" bodies")
			longest := strings.Repeat("界", 1998) + "\t\n"
			f.mustReport(t, claim.RoundId, e.event(t, "ok", claim.ClaimEpoch, longest))
			if round := f.roundOf(t, claim.Ticket.Id); round.OutcomeNote == nil || *round.OutcomeNote != longest {
				t.Fatalf("outcomeNote = %v, want the 2000-character note verbatim", round.OutcomeNote)
			}
		})
	}
}

// Lost contact, unknown state and a stale epoch never produce Interrupted (execution-interface.md, "Confirmed cessation").
func TestInterrupted_NoSignalButTheRunnersOwnReportEndsARound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Only the runner's evidence")
	f.queue(t, "Waiting")
	for range 3 {
		f.mustCommands(t, claim.RoundId)
	}
	f.clock.Set(runnerEpoch.Add(24 * time.Hour))
	assertNoWork(t, f.claim(t))
	interrupted := blockedEndings[1]
	assertErrorBody(t, f.reportEvent(t, claim.RoundId, interrupted.event(t, "stale", claim.ClaimEpoch+1, interrupted.note)), http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
	f.heartbeat(t, f.token, http.StatusOK)
	assertNoWork(t, f.claim(t))
	if got := f.ticket(t, queued.Id); got.Status != InProgress || got.OpenRound == nil || got.OpenRound.State != OpenRoundRunning {
		t.Fatalf("Ticket = %s %+v, want In Progress with its Round still running", got.Status, got.OpenRound)
	}
	f.mustEndAs(t, interrupted, claim)
	assertBlockedTicket(t, f.ticket(t, queued.Id))
	f.mustClaim(t)
}

func TestRecoveryFromBlocked_TheReadinessCheckApplies(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, _ := f.blockedRound(t, e, "Recover")
			badgeRequest(t, f.handler, f.cookie, http.MethodPatch, "/api/tickets/"+queued.Id, `{"goal":"  "}`, http.StatusOK)
			ticket := f.ticket(t, queued.Id)
			advertised := rejectionFor(ticket.AllowedActions, Ready)
			if containsStatus(ticket.AllowedActions.StatusChanges, Ready) || advertised == nil || advertised.Code != agentReadinessIncompleteCode {
				t.Fatalf("allowedActions = %+v, want Ready rejected with %s", ticket.AllowedActions, agentReadinessIncompleteCode)
			}
			before := databaseSnapshot(t, f.pool)
			rec := f.statusChange(t, queued.Id, Ready)
			body := assertErrorCode(t, rec, agentReadinessIncompleteCode)
			if rec.Code != http.StatusBadRequest || !reflect.DeepEqual(body.Error, *advertised) || body.Error.Missing == nil || !reflect.DeepEqual(*body.Error.Missing, []AgentReadinessInput{AgentReadinessInputGoal}) {
				t.Fatalf("Ready without a goal: status=%d error=%+v, want 400 %+v missing the goal", rec.Code, body.Error, *advertised)
			}
			assertSnapshotUnchanged(t, f.pool, before, "a recovery refused by the readiness check")
			assertNoWork(t, f.claim(t))
			badgeRequest(t, f.handler, f.cookie, http.MethodPatch, "/api/tickets/"+queued.Id, `{"goal":"Find the cause"}`, http.StatusOK)
			if got := f.changeStatus(t, queued.Id, Ready); !got.RequestingAgentWork {
				t.Fatalf("recovered Ticket = %+v, want requesting Agent work", got)
			}
		})
	}
}

func TestRecoveryFromBlocked_EntersReadyAtTheBottomOfTheOrder(t *testing.T) {
	f := newClaimFixture(t)
	queued, _ := f.blockedRound(t, blockedEndings[0], "Recover last")
	first := f.queue(t, "Queued while Blocked")
	second := f.queue(t, "Queued after")
	before := readTicketRowFacts(t, f.pool, queued.Id)
	f.changeStatus(t, queued.Id, Ready)
	var highest int64
	if err := f.pool.QueryRow(context.Background(), `SELECT max(priority_rank) FROM tickets`).Scan(&highest); err != nil {
		t.Fatal(err)
	}
	after := readTicketRowFacts(t, f.pool, queued.Id)
	if after.rank != highest || after.rank <= readTicketRowFacts(t, f.pool, second.Id).rank || after.rank == before.rank {
		t.Fatalf("recovered rank %d (was %d, highest %d), want it moved to the bottom below %s", after.rank, before.rank, highest, second.Id)
	}
	f.heartbeat(t, f.token, http.StatusOK)
	if next := f.mustClaim(t); next.Ticket.Id != first.Id {
		t.Fatalf("next claim = %s, want %s, queued above the recovered Ticket", next.Ticket.Id, first.Id)
	}
}

func TestRecoveryFromBlocked_IsAgentOnlyAndNeedsNoOpenRound(t *testing.T) {
	t.Run("a human-assigned Ticket", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, _ := f.blockedRound(t, blockedEndings[0], "Handed to a person")
		badgeRequest(t, f.handler, f.cookie, http.MethodPut, "/api/tickets/"+queued.Id+"/assignee", `{"type":"owner"}`, http.StatusOK)
		if got := f.ticket(t, queued.Id).AllowedActions; containsStatus(got.StatusChanges, Ready) || rejectionFor(got, Ready) != nil || !containsStatus(got.StatusChanges, InProgress) {
			t.Fatalf("allowedActions = %+v, want In Progress offered and Ready neither offered nor explained", got)
		}
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.statusChange(t, queued.Id, Ready), invalidTransitionCode)
		assertSnapshotUnchanged(t, f.pool, before, "a human-assigned Blocked -> Ready")
	})
	t.Run("an unassigned Ticket", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, _ := f.blockedRound(t, blockedEndings[1], "Unassigned")
		badgeRequest(t, f.handler, f.cookie, http.MethodDelete, "/api/tickets/"+queued.Id+"/assignee", "", http.StatusOK)
		before := databaseSnapshot(t, f.pool)
		assertErrorCode(t, f.statusChange(t, queued.Id, Ready), invalidTransitionCode)
		assertSnapshotUnchanged(t, f.pool, before, "an unassigned Blocked -> Ready")
	})
	t.Run("an Agent-assigned Ticket with an open Round", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, "Still open")
		if _, err := f.pool.Exec(context.Background(), `UPDATE tickets SET status = 'Blocked' WHERE public_id = $1::uuid`, queued.Id); err != nil {
			t.Fatal(err)
		}
		if got := f.ticket(t, queued.Id).AllowedActions; len(got.StatusChanges) != 0 {
			t.Fatalf("allowedActions.statusChanges = %v, want none while the Round is open", got.StatusChanges)
		}
		before := databaseSnapshot(t, f.pool)
		body := assertErrorCode(t, f.statusChange(t, queued.Id, Ready), roundOpenCode)
		if body.Error.RoundId == nil || *body.Error.RoundId != claim.RoundId {
			t.Fatalf("round_open names %v, want %s", body.Error.RoundId, claim.RoundId)
		}
		assertSnapshotUnchanged(t, f.pool, before, "Blocked -> Ready with an open Round")
	})
}

func TestRecoveryFromBlocked_ConcurrentRequestsApplyOnce(t *testing.T) {
	f := newClaimFixture(t)
	queued, _ := f.blockedRound(t, blockedEndings[0], "Twice")
	f.queue(t, "Neighbour")
	codes, bodies := sendConcurrently(6, func(int) *httptest.ResponseRecorder { return f.statusChange(t, queued.Id, Ready) })
	applied := 0
	for i, code := range codes {
		switch code {
		case http.StatusOK:
			applied++
		case http.StatusBadRequest:
			if !strings.Contains(bodies[i], invalidTransitionCode) {
				t.Fatalf("response %d: %s, want %s for Ready -> Ready", i, bodies[i], invalidTransitionCode)
			}
		default:
			t.Fatalf("response %d: status=%d body=%s", i, code, bodies[i])
		}
	}
	if applied != 1 {
		t.Fatalf("%d recoveries applied, want exactly one", applied)
	}
	var highest int64
	if err := f.pool.QueryRow(context.Background(), `SELECT max(priority_rank) FROM tickets`).Scan(&highest); err != nil {
		t.Fatal(err)
	}
	if got := readTicketRowFacts(t, f.pool, queued.Id); got.status != string(Ready) || got.rank != highest {
		t.Fatalf("recovered Ticket row = %+v, want Ready at the bottom rank %d", got, highest)
	}
}

func TestRecoveryFromBlocked_RacingTheEndingIsSerialisedEitherWay(t *testing.T) {
	for _, e := range blockedEndings {
		t.Run(e.name(), func(t *testing.T) {
			outcomes := map[string]int{}
			for trial := range 8 {
				f := newClaimFixture(t)
				queued, claim := f.runningRound(t, fmt.Sprintf("Race %d", trial))
				var wg sync.WaitGroup
				var ended, recovered *httptest.ResponseRecorder
				wg.Add(2)
				go func() { defer wg.Done(); ended = f.endAs(t, e, claim) }()
				go func() { defer wg.Done(); recovered = f.statusChange(t, queued.Id, Ready) }()
				wg.Wait()
				if ended.Code != http.StatusCreated {
					t.Fatalf("trial %d: ending status=%d body=%s", trial, ended.Code, ended.Body.String())
				}
				ticket := f.ticket(t, queued.Id)
				switch recovered.Code {
				case http.StatusOK:
					if ticket.Status != Ready || !ticket.RequestingAgentWork {
						t.Fatalf("trial %d: recovery applied but Ticket = %+v", trial, ticket)
					}
					outcomes["recovered after the ending"]++
				case http.StatusBadRequest:
					assertErrorCode(t, recovered, roundOpenCode)
					assertBlockedTicket(t, ticket)
					outcomes["refused while open"]++
				default:
					t.Fatalf("trial %d: recovery status=%d body=%s", trial, recovered.Code, recovered.Body.String())
				}
				if ticket.OpenRound != nil {
					t.Fatalf("trial %d: an open Round after the ending: %+v", trial, ticket.OpenRound)
				}
			}
			t.Logf("%v", outcomes)
		})
	}
}

func TestDecidePlainStatusChange_RecoveryFromBlocked(t *testing.T) {
	research := ticketWorkflowState{status: Blocked, agentKind: AgentKindResearch, goal: "g", successCriteria: "s"}
	coding := ticketWorkflowState{status: Blocked, agentKind: AgentKindCoding, goal: "g", successCriteria: "s", repository: "r"}
	human := ticketWorkflowState{status: Blocked}
	for _, tc := range []struct {
		name     string
		state    ticketWorkflowState
		target   TicketStatus
		wantCode string
	}{
		{"a research Agent's Ticket to Ready", research, Ready, ""},
		{"a coding Agent's Ticket to Ready", coding, Ready, ""},
		{"an Agent's Ticket whose Round waits for input to Ready", ticketWorkflowState{ticketLock: ticketLock{openRoundID: "r"}, status: Blocked, agentKind: AgentKindResearch, goal: "g", successCriteria: "s"}, Ready, invalidTransitionCode},
		{"an Agent's Ticket to Ready without a goal", ticketWorkflowState{status: Blocked, agentKind: AgentKindResearch, successCriteria: "s"}, Ready, agentReadinessIncompleteCode},
		{"a coding Agent's Ticket to Ready without a repository", ticketWorkflowState{status: Blocked, agentKind: AgentKindCoding, goal: "g", successCriteria: "s"}, Ready, agentReadinessIncompleteCode},
		{"a human Ticket to Ready", human, Ready, invalidTransitionCode},
		{"a human Ticket with every Agent input to Ready", ticketWorkflowState{status: Blocked, goal: "g", successCriteria: "s", repository: "r"}, Ready, invalidTransitionCode},
		{"a human Ticket to In Progress", human, InProgress, ""},
		{"a human Ticket to Backlog", human, Backlog, invalidTransitionCode},
		{"an Agent's Ticket to In Progress", research, InProgress, agentOwnedTransitionCode},
		{"an Agent's Ticket to Backlog", research, Backlog, invalidTransitionCode},
		{"an Agent's Ticket to In Review", research, InReview, invalidTransitionCode},
		{"an Agent's Ticket to Done", research, Done, invalidTransitionCode},
		{"an Agent's In Review Ticket to Ready", ticketWorkflowState{status: InReview, agentKind: AgentKindResearch, goal: "g", successCriteria: "s"}, Ready, invalidTransitionCode},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := decidePlainStatusChange(tc.state, tc.target)
			switch {
			case tc.wantCode == "" && got != nil:
				t.Fatalf("rejected with %+v", got)
			case tc.wantCode != "" && (got == nil || got.code != tc.wantCode):
				t.Fatalf("decision = %+v, want %s", got, tc.wantCode)
			}
		})
	}
}

func TestRounds_TheDatabaseEnforcesTheFailedAndInterruptedOutcomes(t *testing.T) {
	f := newClaimFixture(t)
	a := f.queue(t, "A")
	ctx := context.Background()
	insert := func(sequence int, state, started, ended string, note any) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO rounds (owner_id, public_id, ticket_id, agent_id, sequence, state, claim_epoch, claimed_at, started_at, ended_at, outcome_note)
			SELECT t.owner_id, gen_random_uuid(), t.id, t.assignee_agent_id, $2, $3, 1, now(), `+started+`, `+ended+`, $4
			  FROM tickets t WHERE t.public_id = $1::uuid`, a.Id, sequence, state, note)
		return err
	}
	sequence := 1
	for _, state := range []string{"failed", "interrupted"} {
		for _, tc := range []struct {
			name, started, ended string
			note                 any
			constraint           string
		}{
			{"without a note", "now()", "now()", nil, "rounds_outcome_note_follows_state"},
			{"without a start", "NULL", "now()", "n", "rounds_timestamps_follow_state"},
			{"without an end", "now()", "NULL", "n", "rounds_timestamps_follow_state"},
			{"with an empty note", "now()", "now()", "", "rounds_outcome_note_length"},
			{"with a note over 2000 characters", "now()", "now()", strings.Repeat("界", 2001), "rounds_outcome_note_length"},
			{"ended before it started", "now()", "now() - interval '1 hour'", "n", "rounds_timestamps_ordered"},
		} {
			t.Run(state+" "+tc.name, func(t *testing.T) {
				assertViolates(t, insert(99, state, tc.started, tc.ended, tc.note), tc.constraint)
			})
		}
		sequence++
		if err := insert(sequence, state, "now()", "now()", strings.Repeat("界", 2000)); err != nil {
			t.Fatalf("a %s Round with a 2000-character note: %v", state, err)
		}
		sequence++
		if err := insert(sequence, state, "now()", "now()", "beside the open Round"); err != nil {
			t.Fatalf("%s Rounds hold no slot: %v", state, err)
		}
	}
	assertViolates(t, insert(98, "delivered", "now()", "now()", "n"), "rounds_outcome_note_follows_state")
	ownerID, roundID := roundRowIDs(t, f, f.mustClaim(t).RoundId)
	for _, eventType := range []string{"failed", "interrupted"} {
		if _, err := f.pool.Exec(ctx, `INSERT INTO round_events (owner_id, round_id, idempotency_key, type, claim_epoch, occurred_at, received_at, payload_hash, result)
			VALUES ($1, $2, $3, $3, 1, now(), now(), decode(repeat('00', 32), 'hex'), '{}')`, ownerID, roundID, eventType); err != nil {
			t.Fatalf("a %s event: %v", eventType, err)
		}
	}
}
