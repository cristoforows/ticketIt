package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func (f *claimFixture) stop(t *testing.T, id string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/stop", cookie: f.cookie})
}

func (f *claimFixture) mustStop(t *testing.T, id string) Ticket {
	t.Helper()
	rec := f.stop(t, id)
	if rec.Code != http.StatusOK {
		t.Fatalf("stop: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	return decodeTicketBody(t, rec)
}

func (f *claimFixture) commands(t *testing.T, roundID string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodGet, path: "/api/runner/rounds/" + roundID + "/commands", token: f.token})
}

func (f *claimFixture) mustCommands(t *testing.T, roundID string) []RunnerCommand {
	t.Helper()
	rec := f.commands(t, roundID)
	if rec.Code != http.StatusOK {
		t.Fatalf("commands: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	var list RunnerCommandList
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	return list.Commands
}

func ackPath(roundID, commandID string) string {
	return "/api/runner/rounds/" + roundID + "/commands/" + commandID + "/ack"
}

func (f *claimFixture) ack(t *testing.T, roundID, commandID string, outcome RunnerCommandAckOutcome) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: ackPath(roundID, commandID), body: fmt.Sprintf(`{"outcome":%q}`, outcome), token: f.token})
}

func decodeAck(t *testing.T, rec *httptest.ResponseRecorder) RoundCommandAcknowledgement {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("ack: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	var ack RoundCommandAcknowledgement
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil {
		t.Fatal(err)
	}
	return ack
}

type roundCommandRow struct {
	roundID, commandID, commandType string
	epoch                           int
	issuedAt                        time.Time
	acknowledgedAt                  *time.Time
	outcome                         *string
}

func roundCommandRows(t *testing.T, f *claimFixture) []roundCommandRow {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT r.public_id::text, c.public_id::text, c.type, c.claim_epoch, c.issued_at, c.acknowledged_at, c.ack_outcome
		FROM round_commands c JOIN rounds r ON r.id = c.round_id ORDER BY c.id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []roundCommandRow
	for rows.Next() {
		var row roundCommandRow
		if err := rows.Scan(&row.roundID, &row.commandID, &row.commandType, &row.epoch, &row.issuedAt, &row.acknowledgedAt, &row.outcome); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	return out
}

func (f *claimFixture) stoppedRound(t *testing.T, title string, running bool) (Ticket, RunnerClaim, RunnerCommand) {
	t.Helper()
	queued, claim := f.claimTicket(t, title)
	if running {
		f.startRound(t, claim, claim.RoundId+":0")
	}
	f.mustStop(t, queued.Id)
	commands := f.mustCommands(t, claim.RoundId)
	if len(commands) != 1 {
		t.Fatalf("commands = %+v, want the one Stop", commands)
	}
	return queued, claim, commands[0]
}

func TestDecideStop_AnswersEachCase(t *testing.T) {
	cases := []struct {
		name  string
		state ticketWorkflowState
		want  string
	}{
		{"an open Round", ticketWorkflowState{ticketLock: ticketLock{openRoundID: "r"}}, ""},
		{"an open Round with Stop requested", ticketWorkflowState{ticketLock: ticketLock{openRoundID: "r", stopRequested: true}}, stopAlreadyRequestedCode},
		{"no open Round", ticketWorkflowState{}, stopNotAvailableCode},
		{"an archived Ticket", ticketWorkflowState{ticketLock: ticketLock{archived: true}}, stopNotAvailableCode},
	}
	for _, status := range allTicketStatuses {
		cases = append(cases, struct {
			name  string
			state ticketWorkflowState
			want  string
		}{"an open Round in " + string(status), ticketWorkflowState{ticketLock: ticketLock{openRoundID: "r"}, status: status, agentKind: AgentKindResearch}, ""})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decideStop(tc.state)
			if tc.want == "" {
				if got != nil {
					t.Fatalf("decideStop = %+v, want allowed", got)
				}
				return
			}
			if got == nil || got.code != tc.want || got.message == "" || got.roundID != "" || got.missing != nil {
				t.Fatalf("decideStop = %+v, want %s with a message", got, tc.want)
			}
		})
	}
}

func TestStop_RecordsOneStopForAClaimedAndARunningRound(t *testing.T) {
	for _, tc := range []struct {
		name       string
		running    bool
		wantStatus TicketStatus
		wantState  OpenRoundState
	}{
		{"claimed", false, Ready, OpenRoundClaimed},
		{"running", true, InProgress, OpenRoundRunning},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.claimTicket(t, tc.name)
			if tc.running {
				f.startRound(t, claim, claim.RoundId+":0")
			}
			before := f.ticket(t, queued.Id)
			if before.OpenRound.StopRequestedAt != nil || !before.AllowedActions.Stop.Available || before.AllowedActions.Stop.Reason != nil {
				t.Fatalf("before Stop: openRound %+v, stop %+v; want no Stop requested and Stop available", before.OpenRound, before.AllowedActions.Stop)
			}
			roundsBefore := roundRows(t, f.pool)

			first := f.stop(t, queued.Id)
			got := decodeTicketBody(t, first)
			if got.OpenRound == nil || got.OpenRound.StopRequestedAt == nil || !got.OpenRound.StopRequestedAt.Equal(runnerEpoch) {
				t.Fatalf("openRound = %+v, want stopRequestedAt %s", got.OpenRound, runnerEpoch)
			}
			if got.Status != tc.wantStatus || got.OpenRound.State != tc.wantState || got.OpenRound.Id != claim.RoundId {
				t.Fatalf("Ticket = %s with Round %s %s, want %s with %s still %s", got.Status, got.OpenRound.Id, got.OpenRound.State, tc.wantStatus, claim.RoundId, tc.wantState)
			}
			want := ErrorDetail{Code: stopAlreadyRequestedCode, Message: "Stop is already requested for this Round"}
			if stop := got.AllowedActions.Stop; stop.Available || stop.Reason == nil || !reflect.DeepEqual(*stop.Reason, want) {
				t.Fatalf("stop advertised after Stop = %+v, want unavailable with %+v", stop, want)
			}
			if !reflect.DeepEqual(roundRows(t, f.pool), roundsBefore) {
				t.Fatalf("rounds changed: before %+v, after %+v", roundsBefore, roundRows(t, f.pool))
			}

			f.clock.Set(runnerEpoch.Add(5 * time.Second))
			repeat := f.stop(t, queued.Id)
			if repeat.Code != http.StatusOK || repeat.Body.String() != first.Body.String() {
				t.Fatalf("repeat: status=%d body=%s, want 200 with the unchanged Ticket %s", repeat.Code, repeat.Body.String(), first.Body.String())
			}
			rows := roundCommandRows(t, f)
			if len(rows) != 1 {
				t.Fatalf("round_commands = %+v, want exactly one", rows)
			}
			if row := rows[0]; row.roundID != claim.RoundId || row.commandType != "stop" || row.epoch != claim.ClaimEpoch || !row.issuedAt.Equal(runnerEpoch) || row.acknowledgedAt != nil || row.outcome != nil {
				t.Fatalf("command = %+v, want an unacknowledged stop for %s at epoch %d issued at %s", row, claim.RoundId, claim.ClaimEpoch, runnerEpoch)
			}
		})
	}
}

func TestStop_ConcurrentRequestsRecordOneStop(t *testing.T) {
	const requests = 8
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Concurrent")

	var codes []int
	var bodies []string
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		codes, bodies = sendConcurrently(requests, func(int) *httptest.ResponseRecorder { return f.stop(t, queued.Id) })
	}()
	select {
	case <-finished:
	case <-time.After(20 * time.Second):
		t.Fatal("the concurrent Stop requests did not finish within 20 s (deadlock)")
	}
	for i, code := range codes {
		if code != http.StatusOK || bodies[i] != bodies[0] {
			t.Fatalf("stop %d: status=%d body=%s, want 200 with the same Ticket as %s", i, code, bodies[i], bodies[0])
		}
	}
	if rows := roundCommandRows(t, f); len(rows) != 1 || rows[0].roundID != claim.RoundId {
		t.Fatalf("round_commands = %+v, want exactly one Stop for %s", rows, claim.RoundId)
	}
}

func TestStop_AStopCommittedBesideTheLockIsAnsweredAsAlreadyRequested(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Beside")
	ctx := context.Background()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `INSERT INTO round_commands (owner_id, round_id, public_id, type, claim_epoch, issued_at)
		SELECT owner_id, id, $2::uuid, 'stop', claim_epoch, $3 FROM rounds WHERE public_id = $1::uuid`, claim.RoundId, uuid.NewString(), runnerEpoch); err != nil {
		t.Fatal(err)
	}
	stopped := make(chan *httptest.ResponseRecorder, 1)
	go func() { stopped <- f.stop(t, queued.Id) }()
	waitForLockWaiters(t, f.pool, "INSERT INTO round_commands", 1)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := decodeTicketBody(t, <-stopped)
	if got.OpenRound == nil || got.OpenRound.StopRequestedAt == nil || got.AllowedActions.Stop.Available {
		t.Fatalf("Ticket = %+v, want Stop requested", got.OpenRound)
	}
	if rows := roundCommandRows(t, f); len(rows) != 1 {
		t.Fatalf("round_commands = %+v, want only the Stop committed beside the lock", rows)
	}
}

var stopNotAvailableCases = []struct {
	name  string
	setup func(t *testing.T, f *claimFixture) string
}{
	{"a Backlog Ticket", func(t *testing.T, f *claimFixture) string {
		body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets", `{"title":"Backlog"}`, http.StatusCreated)
		return decodeAs[Ticket](t, body).Id
	}},
	{"a Ticket waiting in Ready", func(t *testing.T, f *claimFixture) string {
		return f.queue(t, "Waiting").Id
	}},
	{"a delivered Ticket", func(t *testing.T, f *claimFixture) string {
		queued, _ := f.deliveredTicket(t, "Delivered")
		return queued.Id
	}},
	{"a Ticket whose stopped Round delivered", func(t *testing.T, f *claimFixture) string {
		queued, claim, _ := f.stoppedRound(t, "Stopped then delivered", true)
		f.deliver(t, claim)
		return queued.Id
	}},
	{"an archived Ticket", func(t *testing.T, f *claimFixture) string {
		queued, _ := f.deliveredTicket(t, "Archived")
		badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+queued.Id+"/archive", "", http.StatusOK)
		return queued.Id
	}},
}

func TestStop_WithoutAnOpenRoundIsStopNotAvailableAndAdvertisedSo(t *testing.T) {
	for _, tc := range stopNotAvailableCases {
		t.Run(tc.name, func(t *testing.T) {
			f := newClaimFixture(t)
			id := tc.setup(t, f)
			advertised := f.ticket(t, id).AllowedActions.Stop
			before := databaseSnapshot(t, f.pool)
			rec := f.stop(t, id)
			want := ErrorDetail{Code: stopNotAvailableCode, Message: "Stop needs an open Round"}
			if rec.Code != http.StatusBadRequest || !reflect.DeepEqual(decodeErrorBody(t, rec).Error, want) {
				t.Fatalf("stop: status=%d body=%s, want 400 %+v", rec.Code, rec.Body.String(), want)
			}
			if advertised.Available || advertised.Reason == nil || !reflect.DeepEqual(*advertised.Reason, want) {
				t.Fatalf("advertised %+v, want unavailable with the command's error", advertised)
			}
			assertSnapshotUnchanged(t, f.pool, before, "a refused Stop")
		})
	}
}

func TestStop_UnknownMalformedAndForeignTicketsAreTheSameNotFoundAndUnauthenticatedIs401(t *testing.T) {
	f := newClaimFixture(t)
	f.runningRound(t, "Mine")
	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	theirs, _ := foreign.runningRound(t, "Theirs")

	before := databaseSnapshot(t, f.pool)
	for _, id := range []string{uuid.NewString(), "not-a-uuid", theirs.Id, strings.ToUpper(theirs.Id)} {
		assertTicketNotFound(t, f.stop(t, id))
	}
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + theirs.Id + "/stop"}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + theirs.Id + "/stop", token: foreign.token}))
	assertSnapshotUnchanged(t, f.pool, before, "a Stop that is not the Owner's")
}

func TestStopping_TheTicketStaysLockedAndTheSlotTaken(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, _ := f.stoppedRound(t, "Stopping", true)
	waiting := f.queue(t, "Waiting")
	for range 3 {
		assertNoWork(t, f.claim(t))
	}
	for _, call := range []runnerCall{
		{method: http.MethodPatch, path: "/api/tickets/" + queued.Id, body: `{"goal":"changed"}`},
		{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/status", body: `{"status":"Blocked"}`},
		{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/archive"},
		{method: http.MethodDelete, path: "/api/tickets/" + queued.Id + "/assignee"},
	} {
		call.cookie = f.cookie
		assertRoundOpen(t, f.do(t, call), claim.RoundId)
	}
	f.mustReport(t, claim.RoundId, progressEvent(t, "after-stop", claim.ClaimEpoch, eventOccurredAt, "an in-flight note"))
	got := f.ticket(t, queued.Id)
	if got.Status != InProgress || got.OpenRound == nil || got.OpenRound.State != OpenRoundRunning || got.OpenRound.StopRequestedAt == nil || got.RequestingAgentWork {
		t.Fatalf("Ticket = %s %+v requesting %t, want In Progress, running and Stopping", got.Status, got.OpenRound, got.RequestingAgentWork)
	}
	if !f.ticket(t, waiting.Id).RequestingAgentWork {
		t.Fatal("the waiting Ticket stopped requesting work")
	}
}

func TestRoundCommands_ListsOnlyThatRoundsUnacknowledgedCommands(t *testing.T) {
	f := newClaimFixture(t)
	queued, first := f.claimTicket(t, "Listed")
	if got := f.mustCommands(t, first.RoundId); len(got) != 0 {
		t.Fatalf("commands before Stop = %+v, want none", got)
	}
	f.mustStop(t, queued.Id)
	listed := f.mustCommands(t, first.RoundId)
	rows := roundCommandRows(t, f)
	want := []RunnerCommand{{Id: rows[0].commandID, Type: RunnerCommandStop, ClaimEpoch: first.ClaimEpoch, IssuedAt: runnerEpoch}}
	if !reflect.DeepEqual(listed, want) {
		t.Fatalf("commands = %+v, want %+v", listed, want)
	}
	if again := f.mustCommands(t, first.RoundId); !reflect.DeepEqual(again, want) {
		t.Fatalf("second poll = %+v, want the unacknowledged command again", again)
	}
	f.deliverThroughAPI(t, first.RoundId)
	if got := f.mustCommands(t, first.RoundId); len(got) != 0 {
		t.Fatalf("commands of the delivered Round = %+v, want none", got)
	}

	f.mustRework(t, queued.Id)
	second := f.mustClaim(t)
	if got := f.mustCommands(t, second.RoundId); len(got) != 0 {
		t.Fatalf("commands of Round 2 = %+v, want none: Round 1's Stop is not Round 2's", got)
	}
	f.mustStop(t, queued.Id)
	listed = f.mustCommands(t, second.RoundId)
	if len(listed) != 1 || listed[0].Id == want[0].Id || listed[0].ClaimEpoch != second.ClaimEpoch {
		t.Fatalf("commands of Round 2 = %+v, want its own Stop at epoch %d", listed, second.ClaimEpoch)
	}
	decodeAck(t, f.ack(t, second.RoundId, listed[0].Id, RunnerCommandApplied))
	if got := f.mustCommands(t, second.RoundId); len(got) != 0 {
		t.Fatalf("commands after the ack = %+v, want none", got)
	}
}

func TestRoundCommands_UnknownMalformedAndForeignRoundsAreTheSameNotFoundAndUnauthenticatedIs401(t *testing.T) {
	f := newClaimFixture(t)
	f.stoppedRound(t, "Mine", false)
	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	_, theirs, theirCommand := foreign.stoppedRound(t, "Theirs", false)

	before := databaseSnapshot(t, f.pool)
	for _, id := range []string{uuid.NewString(), "not-a-uuid", theirs.RoundId} {
		assertErrorBody(t, f.commands(t, id), http.StatusNotFound, "not_found", roundNotFoundMessage)
		assertErrorBody(t, f.ack(t, id, theirCommand.Id, RunnerCommandApplied), http.StatusNotFound, "not_found", roundOrCommandNotFoundMessage)
	}
	path := "/api/runner/rounds/" + theirs.RoundId + "/commands"
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodGet, path: path}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodGet, path: path, cookie: foreignCookie}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: ackPath(theirs.RoundId, theirCommand.Id), body: `{"outcome":"applied"}`, cookie: foreignCookie}))
	assertSnapshotUnchanged(t, f.pool, before, "a command read or ack that is not the Owner's")
}

func TestAck_RecordsOnceReplaysTheStoredValuesAndRefusesAnotherOutcome(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, command := f.stoppedRound(t, "Acked", true)
	ticketBefore, roundsBefore := f.ticket(t, queued.Id), roundRows(t, f.pool)

	f.clock.Set(runnerEpoch.Add(3 * time.Second))
	first := f.ack(t, claim.RoundId, command.Id, RunnerCommandApplied)
	want := RoundCommandAcknowledgement{Id: command.Id, AcknowledgedAt: runnerEpoch.Add(3 * time.Second), Outcome: RunnerCommandApplied}
	if got := decodeAck(t, first); !reflect.DeepEqual(got, want) {
		t.Fatalf("ack = %+v, want %+v", got, want)
	}

	f.clock.Set(runnerEpoch.Add(9 * time.Second))
	replay := f.ack(t, claim.RoundId, command.Id, RunnerCommandApplied)
	if replay.Code != http.StatusOK || replay.Body.String() != first.Body.String() {
		t.Fatalf("replay: status=%d body=%s, want 200 with the stored %s", replay.Code, replay.Body.String(), first.Body.String())
	}
	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.ack(t, claim.RoundId, command.Id, RunnerCommandIgnored), http.StatusConflict, commandAlreadyAcknowledgedCode, commandAlreadyAcknowledgedMessage)
	assertSnapshotUnchanged(t, f.pool, before, "an ack with another outcome")

	rows := roundCommandRows(t, f)
	if len(rows) != 1 || rows[0].acknowledgedAt == nil || !rows[0].acknowledgedAt.Equal(want.AcknowledgedAt) || rows[0].outcome == nil || *rows[0].outcome != "applied" {
		t.Fatalf("round_commands = %+v, want one acknowledged applied at %s", rows, want.AcknowledgedAt)
	}
	if got := f.ticket(t, queued.Id); !reflect.DeepEqual(got, ticketBefore) {
		t.Fatalf("the ack changed the Ticket:\nbefore %+v\nafter  %+v", ticketBefore, got)
	}
	if got := roundRows(t, f.pool); !reflect.DeepEqual(got, roundsBefore) {
		t.Fatalf("the ack changed the Round: before %+v, after %+v", roundsBefore, got)
	}
}

func TestAck_RefusesAnotherRoundsCommandAndAMalformedBody(t *testing.T) {
	f := newClaimFixture(t)
	queued, first, firstCommand := f.stoppedRound(t, "First", true)
	f.deliver(t, first)
	f.mustRework(t, queued.Id)
	second := f.mustClaim(t)

	before := databaseSnapshot(t, f.pool)
	for _, commandID := range []string{firstCommand.Id, uuid.NewString(), "not-a-uuid"} {
		assertErrorBody(t, f.ack(t, second.RoundId, commandID, RunnerCommandApplied), http.StatusNotFound, "not_found", roundOrCommandNotFoundMessage)
	}
	path := ackPath(first.RoundId, firstCommand.Id)
	for _, body := range []string{``, `{}`, `{"outcome":"done"}`, `{"outcome":"applied","extra":1}`, `{"outcome":"applied"} {}`, `[]`} {
		rec := f.do(t, runnerCall{method: http.MethodPost, path: path, body: body, token: f.token})
		if rec.Code != http.StatusBadRequest || !strings.Contains(assertErrorCode(t, rec, "invalid_request").Error.Message, acknowledgeCommandShape) {
			t.Fatalf("ack with %q: status=%d body=%s, want 400 naming the shape", body, rec.Code, rec.Body.String())
		}
	}
	assertSnapshotUnchanged(t, f.pool, before, "a refused ack")
}

func TestAck_ConcurrentAcknowledgementsRecordOneOutcome(t *testing.T) {
	const requests = 8
	f := newClaimFixture(t)
	_, claim, command := f.stoppedRound(t, "Racing acks", true)
	outcomes := []RunnerCommandAckOutcome{RunnerCommandApplied, RunnerCommandIgnored}

	var codes []int
	var bodies []string
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		codes, bodies = sendConcurrently(requests, func(i int) *httptest.ResponseRecorder {
			return f.ack(t, claim.RoundId, command.Id, outcomes[i%2])
		})
	}()
	select {
	case <-finished:
	case <-time.After(20 * time.Second):
		t.Fatal("the concurrent acks did not finish within 20 s (deadlock)")
	}

	rows := roundCommandRows(t, f)
	if len(rows) != 1 || rows[0].outcome == nil {
		t.Fatalf("round_commands = %+v, want one acknowledged command", rows)
	}
	stored := RunnerCommandAckOutcome(*rows[0].outcome)
	var accepted []string
	for i, code := range codes {
		switch {
		case outcomes[i%2] == stored && code == http.StatusOK:
			accepted = append(accepted, bodies[i])
		case outcomes[i%2] != stored && code == http.StatusConflict && strings.Contains(bodies[i], commandAlreadyAcknowledgedCode):
		default:
			t.Fatalf("ack %d (%s) with %s stored: status=%d body=%s", i, outcomes[i%2], stored, code, bodies[i])
		}
	}
	for _, body := range accepted {
		if body != accepted[0] {
			t.Fatalf("accepted acks disagree: %s vs %s", body, accepted[0])
		}
	}
	if len(accepted) != requests/2 {
		t.Fatalf("%d acks accepted, want %d", len(accepted), requests/2)
	}
}

func TestAck_TwoOutcomesQueuedBehindTheRowLockRecordOne(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, command := f.stoppedRound(t, "Queued acks", true)
	ctx := context.Background()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT 1 FROM round_commands WHERE public_id = $1::uuid FOR UPDATE`, command.Id); err != nil {
		t.Fatal(err)
	}
	outcomes := []RunnerCommandAckOutcome{RunnerCommandApplied, RunnerCommandIgnored}
	recs := make(chan struct {
		outcome RunnerCommandAckOutcome
		rec     *httptest.ResponseRecorder
	}, len(outcomes))
	for _, outcome := range outcomes {
		go func() {
			recs <- struct {
				outcome RunnerCommandAckOutcome
				rec     *httptest.ResponseRecorder
			}{outcome, f.ack(t, claim.RoundId, command.Id, outcome)}
		}()
	}
	waitForLockWaiters(t, f.pool, "round_commands", len(outcomes))
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	results := map[int][]RunnerCommandAckOutcome{}
	for range outcomes {
		got := <-recs
		results[got.rec.Code] = append(results[got.rec.Code], got.outcome)
	}
	rows := roundCommandRows(t, f)
	if len(results[http.StatusOK]) != 1 || len(results[http.StatusConflict]) != 1 {
		t.Fatalf("results by status = %v, want one 200 and one 409", results)
	}
	if rows[0].outcome == nil || RunnerCommandAckOutcome(*rows[0].outcome) != results[http.StatusOK][0] {
		t.Fatalf("stored outcome = %v, want the accepted %s", rows[0].outcome, results[http.StatusOK][0])
	}
}

func TestRoundCommands_AStaleEpochStopHasNoEffectOnTheNextRound(t *testing.T) {
	f := newClaimFixture(t)
	queued, first, stale := f.stoppedRound(t, "Stale", true)
	f.deliver(t, first)
	f.mustRework(t, queued.Id)
	second := f.mustClaim(t)
	f.startRound(t, second, "start-2")
	if stale.ClaimEpoch != first.ClaimEpoch || second.ClaimEpoch == stale.ClaimEpoch {
		t.Fatalf("epochs: stale command %d, Round 1 %d, Round 2 %d; want the command on Round 1's", stale.ClaimEpoch, first.ClaimEpoch, second.ClaimEpoch)
	}
	ticket := f.ticket(t, queued.Id)
	if ticket.OpenRound == nil || ticket.OpenRound.StopRequestedAt != nil || !ticket.AllowedActions.Stop.Available {
		t.Fatalf("Round 2 = %+v, stop %+v; want no Stop requested and Stop available", ticket.OpenRound, ticket.AllowedActions.Stop)
	}

	roundsBefore := roundRows(t, f.pool)
	decodeAck(t, f.ack(t, first.RoundId, stale.Id, RunnerCommandIgnored))
	if got := f.ticket(t, queued.Id); !reflect.DeepEqual(got, ticket) {
		t.Fatalf("acking Round 1's Stop changed the Ticket:\nbefore %+v\nafter  %+v", ticket, got)
	}
	if got := roundRows(t, f.pool); !reflect.DeepEqual(got, roundsBefore) {
		t.Fatalf("acking Round 1's Stop changed a Round: before %+v, after %+v", roundsBefore, got)
	}
	if got := f.mustCommands(t, second.RoundId); len(got) != 0 {
		t.Fatalf("commands of Round 2 = %+v, want none", got)
	}

	f.mustStop(t, queued.Id)
	listed := f.mustCommands(t, second.RoundId)
	if len(listed) != 1 || listed[0].ClaimEpoch != second.ClaimEpoch {
		t.Fatalf("commands of Round 2 = %+v, want one Stop at epoch %d", listed, second.ClaimEpoch)
	}
}
