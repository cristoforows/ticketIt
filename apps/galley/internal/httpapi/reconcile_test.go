package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

func TestDecideReconcile_EveryRow(t *testing.T) {
	interrupted, stopConfirmed := CessationInterrupted, CessationStopConfirmed
	for _, tc := range []struct {
		belief        HeldExecution
		stopRequested bool
		want          reconcileDecision
	}{
		{HeldRunning, false, reconcileDecision{ReconcileContinue, nil, reconcileFlagCleared, HeldRunning}},
		{HeldRunning, true, reconcileDecision{ReconcileStop, nil, reconcileFlagCleared, HeldRunning}},
		{HeldStopped, false, reconcileDecision{ReconcileReportCessation, &interrupted, reconcileFlagUnchanged, HeldStopped}},
		{HeldStopped, true, reconcileDecision{ReconcileReportCessation, &stopConfirmed, reconcileFlagUnchanged, HeldStopped}},
		{HeldUnknown, false, reconcileDecision{ReconcileHold, nil, reconcileFlagSet, HeldUnknown}},
		{HeldUnknown, true, reconcileDecision{ReconcileHold, nil, reconcileFlagSet, HeldUnknown}},
	} {
		if got := decideReconcile(tc.belief, tc.stopRequested); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("decideReconcile(%s, stopRequested=%t) = %+v, want %+v", tc.belief, tc.stopRequested, got, tc.want)
		}
	}
	for _, tc := range []struct {
		flag    reconcileFlag
		current bool
		want    bool
	}{
		{reconcileFlagCleared, true, false}, {reconcileFlagCleared, false, false},
		{reconcileFlagSet, true, true}, {reconcileFlagSet, false, true},
		{reconcileFlagUnchanged, true, true}, {reconcileFlagUnchanged, false, false},
	} {
		if got := (reconcileDecision{flag: tc.flag}).required(tc.current); got != tc.want {
			t.Errorf("flag %d from %t = %t, want %t", tc.flag, tc.current, got, tc.want)
		}
	}
}

func TestDecideWaitingReason_ReconcileRows(t *testing.T) {
	unknown, running, stopped := HeldUnknown, HeldRunning, HeldStopped
	answer := "Use the staging data"
	answered := &RoundQuestion{Text: "Which data?", Answer: &answer}
	for _, tc := range []struct {
		name              string
		state             OpenRoundState
		question          *RoundQuestion
		stopRequested     bool
		connected         bool
		required          bool
		recordedExecution *HeldExecution
		want              RoundWaitingReason
	}{
		{"disconnected outranks execution unknown", OpenRoundRunning, nil, false, false, true, &unknown, WaitingRunnerDisconnected},
		{"disconnected outranks reconciling", OpenRoundRunning, nil, false, false, true, nil, WaitingRunnerDisconnected},
		{"execution unknown outranks stopping", OpenRoundRunning, nil, true, true, true, &unknown, WaitingExecutionUnknown},
		{"execution unknown on a claimed Round", OpenRoundClaimed, nil, false, true, true, &unknown, WaitingExecutionUnknown},
		{"execution unknown outranks the ask", OpenRoundWaitingForInput, answered, false, true, true, &unknown, WaitingExecutionUnknown},
		{"never reconciled is reconciling", OpenRoundRunning, nil, false, true, true, nil, WaitingReconciling},
		{"flagged after running is reconciling", OpenRoundRunning, nil, false, true, true, &running, WaitingReconciling},
		{"flagged after stopped is reconciling", OpenRoundRunning, nil, false, true, true, &stopped, WaitingReconciling},
		{"reconciling outranks stopping", OpenRoundRunning, nil, true, true, true, &running, WaitingReconciling},
		{"reconciling outranks the ask", OpenRoundWaitingForInput, answered, false, true, true, nil, WaitingReconciling},
		{"unflagged unknown cannot exist but reads as the Round's own wait", OpenRoundRunning, nil, false, true, false, &unknown, WaitingWorking},
		{"unflagged after running", OpenRoundRunning, nil, false, true, false, &running, WaitingWorking},
		{"unflagged after stopped with Stop", OpenRoundRunning, nil, true, true, false, &stopped, WaitingStopping},
		{"unflagged answered", OpenRoundWaitingForInput, answered, false, true, false, &running, WaitingResuming},
		{"unflagged claimed", OpenRoundClaimed, nil, false, true, false, nil, WaitingStarting},
	} {
		if got := decideWaitingReason(tc.state, tc.question, nil, tc.stopRequested, tc.connected, false, tc.required, tc.recordedExecution); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}

// Everything the Owner sees as the Round's progress or the Ticket's place: all but the Reconcile columns and the activity.
func roundStateSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var out strings.Builder
	for _, q := range [][2]string{
		{"rounds", `SELECT COALESCE(json_agg(json_build_object('id', id, 'state', state, 'claim_epoch', claim_epoch, 'started_at', started_at, 'ended_at', ended_at,
			'outcome_note', outcome_note, 'question', waiting_question_id, 'request', waiting_permission_request_id) ORDER BY id), '[]')::text FROM rounds`},
		{"tickets", `SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.id), '[]')::text FROM tickets x`},
	} {
		var rows string
		if err := pool.QueryRow(context.Background(), q[1]).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&out, "%s=%s\n", q[0], rows)
	}
	for _, table := range []string{"round_events", "round_engine_references", "usage_observations", "round_deliverables", "round_commands", "round_questions", "round_feedback", "permission_requests", "permission_grants", "round_authority_checks", "runners", "badges"} {
		var rows string
		if err := pool.QueryRow(context.Background(), `SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.id), '[]')::text FROM `+table+` x`).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&out, "%s=%s\n", table, rows)
	}
	return out.String()
}

type reconcileColumns struct {
	required  bool
	execution *string
	at        *time.Time
}

func (f *claimFixture) reconcileColumns(t *testing.T, roundID string) reconcileColumns {
	t.Helper()
	var c reconcileColumns
	if err := f.pool.QueryRow(context.Background(), `SELECT reconcile_required, reconcile_execution, reconciled_at FROM rounds WHERE public_id = $1::uuid`, roundID).
		Scan(&c.required, &c.execution, &c.at); err != nil {
		t.Fatal(err)
	}
	return c
}

func (f *claimFixture) assertFlag(t *testing.T, roundID string, want bool) {
	t.Helper()
	if got := f.reconcileColumns(t, roundID).required; got != want {
		t.Fatalf("reconcile_required = %t, want %t", got, want)
	}
}

func (f *claimFixture) registerResult(t *testing.T) RunnerRegistration {
	t.Helper()
	var reg RunnerRegistration
	if err := json.Unmarshal(f.register(t, f.token, http.StatusOK).Body.Bytes(), &reg); err != nil {
		t.Fatal(err)
	}
	return reg
}

func activityTexts(notes []RoundActivityNote) []string {
	texts := []string{}
	for _, n := range notes {
		if strings.HasPrefix(n.Note, "Reconciled with the runner") {
			texts = append(texts, n.Note)
		}
	}
	return texts
}

func TestReconcile_RefusesABadShapeWith400AndChangesNothing(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Shapes")
	held := func(fields string) string { return `{"held":[{` + fields + `}]}` }
	id := `"roundId":"` + claim.RoundId + `"`
	before := databaseSnapshot(t, f.pool)
	for _, body := range []string{
		``, `{}`, `[]`, `{"held":null}`, `{"held":{}}`, `{"held":[],"extra":1}`, `{"held":[]} {}`,
		`{"held":[{` + id + `,"claimEpoch":1,"execution":"running"},{` + id + `,"claimEpoch":1,"execution":"running"}]}`,
		held(id + `,"claimEpoch":1`),
		held(id + `,"execution":"running"`),
		held(`"claimEpoch":1,"execution":"running"`),
		held(`"roundId":"","claimEpoch":1,"execution":"running"`),
		held(id + `,"claimEpoch":0,"execution":"running"`),
		held(id + `,"claimEpoch":2147483648,"execution":"running"`),
		held(id + `,"claimEpoch":"1","execution":"running"`),
		held(id + `,"claimEpoch":1.5,"execution":"running"`),
		held(id + `,"claimEpoch":1,"execution":"paused"`),
		held(id + `,"claimEpoch":1,"execution":null`),
		held(id + `,"claimEpoch":1,"execution":"running","engine":"x"`),
		held(`"roundId":7,"claimEpoch":1,"execution":"running"`),
	} {
		assertInvalidRequest(t, f.reconcile(t, body))
	}
	assertSnapshotUnchanged(t, f.pool, before, "a 400 Reconcile")
}

func TestReconcile_LadderRefusesInOrderAndChangesNothing(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Ladder")
	foreign := f.foreignOwner(t)
	_, theirs := foreign.runningRound(t, "Theirs")
	before := databaseSnapshot(t, f.pool)
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/reconcile", body: reconcileBody(t), cookie: f.cookie}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/reconcile", body: reconcileBody(t)}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/reconcile", body: `nonsense`, token: "wrong"}))
	for _, roundID := range []string{"not-a-uuid", uuid.NewString(), theirs.RoundId} {
		body := reconcileBody(t, map[string]any{"roundId": roundID, "claimEpoch": 1, "execution": "running"})
		assertErrorBody(t, f.reconcile(t, body), http.StatusNotFound, "not_found", roundNotFoundMessage)
	}
	assertErrorBody(t, f.reconcile(t, reconcileBody(t, map[string]any{"roundId": claim.RoundId, "claimEpoch": claim.ClaimEpoch + 1, "execution": "running"})),
		http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a refused Reconcile")

	f.deliver(t, claim)
	before = databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.reconcile(t, reconcileBody(t, map[string]any{"roundId": claim.RoundId, "claimEpoch": claim.ClaimEpoch + 1, "execution": "running"})),
		http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
	for _, execution := range []HeldExecution{HeldRunning, HeldStopped, HeldUnknown} {
		assertErrorBody(t, f.reconcile(t, reconcileBody(t, heldRound(claim, execution))), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
	}
	assertSnapshotUnchanged(t, f.pool, before, "a Reconcile of an ended Round")
	if got := f.ticket(t, queued.Id).Status; got != InReview {
		t.Fatalf("Ticket = %s, want Review", got)
	}
}

func TestReconcile_NeverChangesRoundStateTicketStatusSlotOrLock(t *testing.T) {
	type setup struct {
		name string
		make func(t *testing.T, f *claimFixture) (Ticket, RunnerClaim)
	}
	for _, s := range []setup{
		{"claimed", func(t *testing.T, f *claimFixture) (Ticket, RunnerClaim) { return f.claimTicket(t, "Claimed") }},
		{"running", func(t *testing.T, f *claimFixture) (Ticket, RunnerClaim) { return f.runningRound(t, "Running") }},
		{"waiting for an answer", func(t *testing.T, f *claimFixture) (Ticket, RunnerClaim) {
			queued, claim := f.runningRound(t, "Asking")
			f.mustReport(t, claim.RoundId, questionEvent(t, questionA, claim.ClaimEpoch, questionA, questionText))
			return queued, claim
		}},
		{"waiting for a Permission", func(t *testing.T, f *claimFixture) (Ticket, RunnerClaim) { return f.permissionRound(t, "Permission") }},
	} {
		for _, stop := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s, stop=%t", s.name, stop), func(t *testing.T) {
				f := newClaimFixture(t)
				queued, claim := s.make(t, f)
				f.queue(t, "Waiting behind it")
				if stop {
					f.mustStop(t, queued.Id)
				}
				status := f.ticket(t, queued.Id).Status
				before := roundStateSnapshot(t, f.pool)
				for _, body := range []string{
					reconcileBody(t),
					reconcileBody(t, heldRound(claim, HeldUnknown)),
					reconcileBody(t, heldRound(claim, HeldStopped)),
					reconcileBody(t, heldRound(claim, HeldRunning)),
					reconcileBody(t),
					reconcileBody(t, heldRound(claim, HeldRunning)),
				} {
					got := f.mustReconcile(t, body)
					if got.Round == nil || got.Round.RoundId != claim.RoundId || got.Round.TicketStatus != status || got.Round.ClaimEpoch != claim.ClaimEpoch {
						t.Fatalf("reconcile %s = %+v, want the open Round of a %s Ticket", body, got.Round, status)
					}
					assertSnapshotUnchanged2(t, before, roundStateSnapshot(t, f.pool), body)
					ticket := f.ticket(t, queued.Id)
					if ticket.OpenRound == nil || ticket.OpenRound.Id != claim.RoundId || ticket.Status != status {
						t.Fatalf("after %s: Ticket = %s %+v, want still %s and locked by its open Round", body, ticket.Status, ticket.OpenRound, status)
					}
					assertErrorCode(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/archive", cookie: f.cookie}), roundOpenCode)
					if rec := f.claim(t); rec.Code != http.StatusNoContent {
						t.Fatalf("a claim after %s: status=%d, want 204 while the Round stays open", body, rec.Code)
					}
				}
			})
		}
	}
}

func assertSnapshotUnchanged2(t *testing.T, before, after, what string) {
	t.Helper()
	if before != after {
		t.Fatalf("Reconcile %s changed state:\nbefore:\n%s\nafter:\n%s", what, before, after)
	}
}

func TestReconcile_ReturnsTheDispositionAndThePendingCommandsStopFirst(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, grantID := f.fullGrantRound(t, "Commands", PermissionGrantFormTicket, time.Time{})
	f.mustRevoke(t, grantID)
	f.mustStop(t, queued.Id)
	want := f.mustCommands(t, claim.RoundId)
	if len(want) < 2 || want[0].Type != RunnerCommandStop || want[1].Type != RunnerCommandAuthorityChanged {
		t.Fatalf("commands = %+v, want Stop first then the authority change", want)
	}
	stopConfirmed, interrupted := CessationStopConfirmed, CessationInterrupted
	for _, tc := range []struct {
		belief      HeldExecution
		disposition ReconcileDisposition
		event       *CessationEvent
	}{
		{HeldUnknown, ReconcileHold, nil},
		{HeldStopped, ReconcileReportCessation, &stopConfirmed},
		{HeldRunning, ReconcileStop, nil},
	} {
		got := f.mustReconcile(t, reconcileBody(t, heldRound(claim, tc.belief))).Round
		if got.Disposition != tc.disposition || !reflect.DeepEqual(got.CessationEvent, tc.event) || !reflect.DeepEqual(got.Commands, want) ||
			got.State != OpenRoundRunning || got.TicketStatus != InProgress {
			t.Fatalf("%s: %+v, want %s naming %v with commands %+v", tc.belief, got, tc.disposition, tc.event, want)
		}
	}

	g := newClaimFixture(t)
	_, other := g.runningRound(t, "No Stop")
	for belief, disposition := range map[HeldExecution]ReconcileDisposition{HeldRunning: ReconcileContinue, HeldUnknown: ReconcileHold} {
		if got := g.mustReconcile(t, reconcileBody(t, heldRound(other, belief))).Round; got.Disposition != disposition || got.CessationEvent != nil || len(got.Commands) != 0 {
			t.Fatalf("%s without Stop: %+v, want %s and no commands", belief, got, disposition)
		}
	}
	if got := g.mustReconcile(t, reconcileBody(t, heldRound(other, HeldStopped))).Round; got.Disposition != ReconcileReportCessation || !reflect.DeepEqual(got.CessationEvent, &interrupted) {
		t.Fatalf("stopped without Stop: %+v, want report_cessation naming interrupted", got)
	}
}

func TestReconcile_AnAcknowledgedButUnconfirmedStopStillAnswersStop(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, stop := f.stoppedRound(t, "Acknowledged Stop", true)
	if rec := f.ack(t, claim.RoundId, stop.Id, RunnerCommandApplied); rec.Code != http.StatusOK {
		t.Fatalf("ack = %d %s", rec.Code, rec.Body)
	}
	if pending := f.mustCommands(t, claim.RoundId); len(pending) != 0 {
		t.Fatalf("pending commands = %+v, want none after the ack", pending)
	}
	stopConfirmed := CessationStopConfirmed
	for belief, want := range map[HeldExecution]reconcileDecision{
		HeldRunning: {disposition: ReconcileStop},
		HeldStopped: {disposition: ReconcileReportCessation, cessationEvent: &stopConfirmed},
	} {
		got := f.mustReconcile(t, reconcileBody(t, heldRound(claim, belief))).Round
		if got.Disposition != want.disposition || !reflect.DeepEqual(got.CessationEvent, want.cessationEvent) || got.State != OpenRoundRunning {
			t.Fatalf("%s: %+v, want %s naming %v", belief, got, want.disposition, want.cessationEvent)
		}
	}
}

func TestReconcile_TheNamedCessationEventEndsTheRoundThroughTheEventLadder(t *testing.T) {
	t.Run("stop_confirmed after a Stop", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, "Stopped")
		f.mustStop(t, queued.Id)
		got := f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldStopped))).Round
		if *got.CessationEvent != CessationStopConfirmed {
			t.Fatalf("cessation = %s", *got.CessationEvent)
		}
		f.mustConfirmStop(t, claim)
		if ticket := f.ticket(t, queued.Id); ticket.OpenRound != nil {
			t.Fatalf("Round still open after stop_confirmed: %+v", ticket.OpenRound)
		}
	})
	t.Run("interrupted while running", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, "Interrupted")
		got := f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldStopped))).Round
		if *got.CessationEvent != CessationInterrupted {
			t.Fatalf("cessation = %s", *got.CessationEvent)
		}
		f.mustEndAs(t, blockedEndings[1], claim)
		if ticket := f.ticket(t, queued.Id); ticket.OpenRound != nil || ticket.Status != Blocked {
			t.Fatalf("Ticket = %s %+v, want Blocked with no open Round", ticket.Status, ticket.OpenRound)
		}
	})
	t.Run("interrupted ends a claimed Round", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim := f.claimTicket(t, "Claimed")
		got := f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldStopped))).Round
		if *got.CessationEvent != CessationInterrupted {
			t.Fatalf("cessation = %s", *got.CessationEvent)
		}
		f.mustEndAs(t, blockedEndings[1], claim)
		if ticket := f.ticket(t, queued.Id); ticket.OpenRound != nil || ticket.Status != Blocked {
			t.Fatalf("Ticket = %s %+v, want Blocked with no open Round", ticket.Status, ticket.OpenRound)
		}
	})
	t.Run("interrupted ends a Round waiting for input", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, claim := f.waitingRound(t, "Waiting")
		got := f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldStopped))).Round
		if *got.CessationEvent != CessationInterrupted {
			t.Fatalf("cessation = %s", *got.CessationEvent)
		}
		f.mustEndAs(t, blockedEndings[1], claim)
		if ticket := f.ticket(t, queued.Id); ticket.OpenRound != nil || ticket.Status != Blocked {
			t.Fatalf("Ticket = %s %+v, want Blocked with no open Round", ticket.Status, ticket.OpenRound)
		}
	})
}

func TestReconcile_HoldingNothingReconcilesTheOwnersOpenRoundAsUnknown(t *testing.T) {
	f := newClaimFixture(t)
	before := databaseSnapshot(t, f.pool)
	if got := f.mustReconcile(t, reconcileBody(t)); got.Round != nil {
		t.Fatalf("no open Round: %+v, want round null", got.Round)
	}
	assertSnapshotUnchanged(t, f.pool, before, "a Reconcile with no open Round")

	foreign := f.foreignOwner(t)
	foreign.runningRound(t, "Theirs")
	if got := f.mustReconcile(t, reconcileBody(t)); got.Round != nil {
		t.Fatalf("another Owner's open Round: %+v, want round null", got.Round)
	}

	queued, claim := f.runningRound(t, "Mine")
	f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning)))
	got := f.mustReconcile(t, reconcileBody(t)).Round
	if got == nil || got.RoundId != claim.RoundId || got.Disposition != ReconcileHold || got.ClaimEpoch != claim.ClaimEpoch {
		t.Fatalf("holding nothing = %+v, want hold for %s", got, claim.RoundId)
	}
	f.assertFlag(t, claim.RoundId, true)
	f.assertWaitingReason(t, queued.Id, WaitingExecutionUnknown)
	f.deliver(t, claim)
	if got := f.mustReconcile(t, reconcileBody(t)); got.Round != nil {
		t.Fatalf("after delivery: %+v, want round null", got.Round)
	}
}

func TestReconcile_FlagLifecycle(t *testing.T) {
	f := newClaimFixture(t)
	if reg := f.registerResult(t); reg.ReconcileRequired {
		t.Fatal("register with no open Round reports reconcileRequired")
	}
	queued, claim := f.runningRound(t, "Flags")
	f.assertFlag(t, claim.RoundId, false)
	if beat := f.mustHeartbeat(t); beat.ReconcileRequired {
		t.Fatal("a heartbeat within the window flagged the Round")
	}

	steps := []struct {
		name string
		do   func() bool
		want bool
	}{
		{"register sets it", func() bool { return f.registerResult(t).ReconcileRequired }, true},
		{"report_cessation leaves it set", func() bool {
			f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldStopped)))
			return true
		}, true},
		{"continue clears it", func() bool {
			f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning)))
			return false
		}, false},
		{"report_cessation leaves it clear", func() bool {
			f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldStopped)))
			return false
		}, false},
		{"hold sets it", func() bool {
			f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldUnknown)))
			return f.mustHeartbeat(t).ReconcileRequired
		}, true},
		{"a heartbeat leaves it set", func() bool { return f.mustHeartbeat(t).ReconcileRequired }, true},
		{"stop clears it", func() bool {
			f.mustStop(t, queued.Id)
			got := f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning))).Round
			if got.Disposition != ReconcileStop {
				t.Fatalf("disposition = %s, want stop", got.Disposition)
			}
			return f.mustHeartbeat(t).ReconcileRequired
		}, false},
	}
	for _, step := range steps {
		if got := step.do(); got != step.want {
			t.Fatalf("%s: response reconcileRequired = %t, want %t", step.name, got, step.want)
		}
		f.assertFlag(t, claim.RoundId, step.want)
	}
}

func TestHeartbeat_FlagsTheOpenRoundExactlyFromTheHealthWindow(t *testing.T) {
	for _, tc := range []struct {
		gap  time.Duration
		want bool
	}{
		{runnerHealthWindow - time.Microsecond, false},
		{runnerHealthWindow, true},
		{runnerHealthWindow + time.Microsecond, true},
		{24 * time.Hour, true},
	} {
		t.Run(tc.gap.String(), func(t *testing.T) {
			f := newClaimFixture(t)
			_, claim := f.runningRound(t, "Gap")
			f.clock.Set(runnerEpoch.Add(time.Hour))
			f.heartbeat(t, f.token, http.StatusOK)
			f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning)))
			f.clock.Set(runnerEpoch.Add(time.Hour + tc.gap))
			if got := f.mustHeartbeat(t).ReconcileRequired; got != tc.want {
				t.Fatalf("heartbeat after %s: reconcileRequired = %t, want %t", tc.gap, got, tc.want)
			}
			f.assertFlag(t, claim.RoundId, tc.want)
		})
	}
	t.Run("never seen", func(t *testing.T) {
		at := runnerEpoch
		for _, tc := range []struct {
			previous *time.Time
			want     bool
		}{
			{nil, true},
			{&at, false},
		} {
			if got := heartbeatAfterAGap(runnerEpoch.Add(runnerHealthWindow-time.Microsecond), tc.previous); got != tc.want {
				t.Fatalf("heartbeatAfterAGap(previous=%v) = %t, want %t", tc.previous, got, tc.want)
			}
		}
	})
	t.Run("only the Owner's open Round", func(t *testing.T) {
		f := newClaimFixture(t)
		foreign := f.foreignOwner(t)
		_, theirs := foreign.runningRound(t, "Theirs")
		foreign.mustReconcile(t, reconcileBody(t, heldRound(theirs, HeldRunning)))
		_, ended := f.runningRound(t, "Ended")
		f.mustReconcile(t, reconcileBody(t, heldRound(ended, HeldRunning)))
		f.deliver(t, ended)
		f.clock.Set(runnerEpoch.Add(time.Hour))
		if f.mustHeartbeat(t).ReconcileRequired || f.registerResult(t).ReconcileRequired {
			t.Fatal("reconcileRequired with no open Round")
		}
		f.assertFlag(t, ended.RoundId, false)
		foreign.assertFlag(t, theirs.RoundId, false)
	})
}

func TestReconcile_NotesOnlyWhenTheRecordedExecutionChanges(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Notes")
	const (
		running = "Reconciled with the runner: execution running"
		unknown = "Reconciled with the runner: the runner cannot confirm execution"
		stopped = "Reconciled with the runner: the runner reports execution stopped"
	)
	var want []string
	for _, step := range []struct {
		body string
		note string
	}{
		{reconcileBody(t, heldRound(claim, HeldUnknown)), unknown},
		{reconcileBody(t, heldRound(claim, HeldUnknown)), ""},
		{reconcileBody(t), ""},
		{reconcileBody(t, heldRound(claim, HeldRunning)), running},
		{reconcileBody(t, heldRound(claim, HeldRunning)), ""},
		{reconcileBody(t, heldRound(claim, HeldStopped)), stopped},
		{reconcileBody(t, heldRound(claim, HeldStopped)), ""},
		{reconcileBody(t, heldRound(claim, HeldRunning)), running},
		{reconcileBody(t), unknown},
	} {
		before := databaseSnapshot(t, f.pool)
		f.mustReconcile(t, step.body)
		if step.note != "" {
			want = append(want, step.note)
		} else {
			assertSnapshotUnchanged(t, f.pool, before, "a repeated Reconcile "+step.body)
		}
		if got := activityTexts(f.allActivity(t, queued.Id, claim.RoundId)); !reflect.DeepEqual(got, want) {
			t.Fatalf("after %s: Reconcile notes = %q, want %q", step.body, got, want)
		}
	}
	notes := f.allActivity(t, queued.Id, claim.RoundId)
	for i, n := range notes {
		if n.Seq != i+1 {
			t.Fatalf("activity seq = %+v, want gap-free", notes)
		}
	}
	at := f.clock.Now()
	if last := notes[len(notes)-1]; !last.OccurredAt.Equal(at) {
		t.Fatalf("note occurredAt = %v, want Galley's clock %v", last.OccurredAt, at)
	}
	if c := f.reconcileColumns(t, claim.RoundId); c.at == nil || !c.at.Equal(at) {
		t.Fatalf("reconciled_at = %v, want %v", c.at, at)
	}
}

func TestReconcile_WaitingReasonsFollowTheFlagAndTheRecordedExecution(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Reasons")
	f.assertWaitingReason(t, queued.Id, WaitingWorking)
	f.register(t, f.token, http.StatusOK)
	f.assertWaitingReason(t, queued.Id, WaitingReconciling)
	f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldUnknown)))
	f.assertWaitingReason(t, queued.Id, WaitingExecutionUnknown)
	f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldStopped)))
	f.assertWaitingReason(t, queued.Id, WaitingReconciling)
	f.clock.Set(runnerEpoch.Add(runnerHealthWindow))
	f.assertWaitingReason(t, queued.Id, WaitingRunnerDisconnected)
	f.heartbeat(t, f.token, http.StatusOK)
	f.assertWaitingReason(t, queued.Id, WaitingReconciling)
	f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning)))
	f.assertWaitingReason(t, queued.Id, WaitingWorking)
	f.mustStop(t, queued.Id)
	f.mustReconcile(t, reconcileBody(t))
	f.assertWaitingReason(t, queued.Id, WaitingExecutionUnknown)
}

func TestAuthorityCheck_RefusesADisconnectedRunnerThenAnUnreconciledRoundRecordingNothing(t *testing.T) {
	f := newClaimFixture(t)
	var logs bytes.Buffer
	f.handler = NewHandlerWithClock(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), f.pool, testLogger(&logs), f.clock.Now)
	queued, claim, grantID := f.fullGrantRound(t, "Refusals", PermissionGrantFormTicket, time.Time{})
	f.ackAll(t, claim.RoundId)
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)

	type refusal struct {
		name   string
		epoch  int
		status int
		code   string
	}
	refuse := func(steps ...refusal) {
		t.Helper()
		for _, r := range steps {
			before := databaseSnapshot(t, f.pool)
			logs.Reset()
			rec := f.check(t, claim.RoundId, r.epoch, writeReport)
			assertErrorCode(t, rec, r.code)
			if rec.Code != r.status {
				t.Fatalf("%s: status=%d, want %d", r.name, rec.Code, r.status)
			}
			assertSnapshotUnchanged(t, f.pool, before, r.name)
			logged := strings.Contains(logs.String(), "authority check refused") && strings.Contains(logs.String(), r.code)
			if want := r.code == runnerDisconnectedCode || r.code == reconcileRequiredCode; logged != want {
				t.Fatalf("%s: logged=%t, want %t; logs=%s", r.name, logged, want, logs.String())
			}
		}
	}
	stale := claim.ClaimEpoch + 1

	f.clock.Set(runnerEpoch.Add(runnerHealthWindow))
	refuse(
		refusal{"a stale epoch outranks disconnection", stale, http.StatusConflict, staleClaimEpochCode},
		refusal{"disconnected", claim.ClaimEpoch, http.StatusConflict, runnerDisconnectedCode},
	)
	f.clock.Set(runnerEpoch.Add(runnerHealthWindow - time.Microsecond))
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)

	f.register(t, f.token, http.StatusOK)
	refuse(refusal{"flagged", claim.ClaimEpoch, http.StatusConflict, reconcileRequiredCode})
	f.clock.Set(f.clock.Now().Add(runnerHealthWindow))
	refuse(
		refusal{"disconnection outranks the flag", claim.ClaimEpoch, http.StatusConflict, runnerDisconnectedCode},
		refusal{"a stale epoch outranks both", stale, http.StatusConflict, staleClaimEpochCode},
	)
	f.heartbeat(t, f.token, http.StatusOK)
	f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldUnknown)))
	refuse(refusal{"execution unknown", claim.ClaimEpoch, http.StatusConflict, reconcileRequiredCode})
	f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldStopped)))
	refuse(refusal{"a stopped report leaves it flagged", claim.ClaimEpoch, http.StatusConflict, reconcileRequiredCode})
	f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning)))
	assertDecision(t, f.mustCheck(t, claim, writeReport), AuthorityAllow, grantID)

	f.mustReport(t, claim.RoundId, questionEvent(t, questionA, claim.ClaimEpoch, questionA, questionText))
	f.register(t, f.token, http.StatusOK)
	refuse(refusal{"the flag outranks round_not_running", claim.ClaimEpoch, http.StatusConflict, reconcileRequiredCode})
	f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning)))
	refuse(refusal{"not running", claim.ClaimEpoch, http.StatusConflict, roundNotRunningCode})

	f.mustStop(t, queued.Id)
	f.mustConfirmStop(t, claim)
	f.clock.Set(f.clock.Now().Add(time.Hour))
	f.register(t, f.token, http.StatusOK)
	f.clock.Set(f.clock.Now().Add(time.Hour))
	refuse(refusal{"round_not_open outranks disconnection", claim.ClaimEpoch, http.StatusConflict, roundNotOpenCode})
	var requests int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM permission_requests`).Scan(&requests); err != nil || requests != 1 {
		t.Fatalf("permission requests = %d (%v), want only the one the Round raised", requests, err)
	}
}

func TestRoundEvents_AreNotGatedOnTheFlagOrOnDisconnection(t *testing.T) {
	type eventCase struct {
		name  string
		setup func(t *testing.T, f *claimFixture, queued Ticket, claim RunnerClaim)
		body  func(t *testing.T, claim RunnerClaim) string
		want  int
	}
	start := func(t *testing.T, f *claimFixture, _ Ticket, claim RunnerClaim) { f.startRound(t, claim, "start") }
	for _, event := range []eventCase{
		{"execution_started", func(*testing.T, *claimFixture, Ticket, RunnerClaim) {}, func(_ *testing.T, c RunnerClaim) string {
			return startedEvent("k", c.ClaimEpoch, eventOccurredAt, eventReference)
		}, http.StatusCreated},
		{"progress", start, func(t *testing.T, c RunnerClaim) string {
			return progressEvent(t, "k", c.ClaimEpoch, eventOccurredAt, "on")
		}, http.StatusCreated},
		{"usage_observed", start, func(t *testing.T, c RunnerClaim) string {
			return usageEvent(t, observationA, c.ClaimEpoch, usageData(observationA))
		}, http.StatusCreated},
		{"delivered", start, func(t *testing.T, c RunnerClaim) string {
			return deliveredEvent(t, "k", c.ClaimEpoch, standardDeliverable())
		}, http.StatusCreated},
		{"failed", start, func(t *testing.T, c RunnerClaim) string {
			return blockedEndings[0].event(t, "k", c.ClaimEpoch, failedExplanation)
		}, http.StatusCreated},
		{"interrupted", start, func(t *testing.T, c RunnerClaim) string {
			return blockedEndings[1].event(t, "k", c.ClaimEpoch, interruptedEvidence)
		}, http.StatusCreated},
		{"stop_confirmed", func(t *testing.T, f *claimFixture, q Ticket, c RunnerClaim) { start(t, f, q, c); f.mustStop(t, q.Id) }, func(t *testing.T, c RunnerClaim) string {
			return stopConfirmedEvent(t, "k", c.ClaimEpoch, stopEvidence)
		}, http.StatusCreated},
		{"question_raised", start, func(t *testing.T, c RunnerClaim) string {
			return questionEvent(t, questionA, c.ClaimEpoch, questionA, questionText)
		}, http.StatusCreated},
		{"resumed after an answer", func(t *testing.T, f *claimFixture, q Ticket, c RunnerClaim) {
			start(t, f, q, c)
			f.mustReport(t, c.RoundId, questionEvent(t, questionA, c.ClaimEpoch, questionA, questionText))
			f.mustAnswer(t, q.Id, c.RoundId, questionA)
		}, func(t *testing.T, c RunnerClaim) string { return resumedEvent(t, "k", c.ClaimEpoch, questionA) }, http.StatusCreated},
		{"permission_requested", start, func(t *testing.T, c RunnerClaim) string {
			return permissionEvent(t, requestA, c.ClaimEpoch, requestA, writeReport)
		}, http.StatusCreated},
		{"resumed after an approval", func(t *testing.T, f *claimFixture, q Ticket, c RunnerClaim) {
			start(t, f, q, c)
			f.mustRequestPermission(t, c, requestA, writeReport)
			f.mustApproveWith(t, q.Id, c.RoundId, requestA, `{"form":"ticket"}`)
		}, func(t *testing.T, c RunnerClaim) string { return approvalResumedEvent(t, "k", c.ClaimEpoch, requestA) }, http.StatusCreated},
	} {
		for _, condition := range []string{"flagged", "execution unknown", "disconnected", "disconnected and flagged"} {
			t.Run(event.name+", "+condition, func(t *testing.T) {
				f := newClaimFixture(t)
				queued, claim := f.claimTicket(t, "Not gated")
				event.setup(t, f, queued, claim)
				switch condition {
				case "flagged":
					f.register(t, f.token, http.StatusOK)
				case "execution unknown":
					f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldUnknown)))
				case "disconnected":
					f.clock.Set(f.clock.Now().Add(runnerHealthWindow))
				case "disconnected and flagged":
					f.register(t, f.token, http.StatusOK)
					f.clock.Set(f.clock.Now().Add(time.Hour))
				}
				if rec := f.reportEvent(t, claim.RoundId, event.body(t, claim)); rec.Code != event.want {
					t.Fatalf("status=%d body=%s, want %d", rec.Code, rec.Body.String(), event.want)
				}
			})
		}
	}
}

func TestReconcile_TakesTheOwnersPriorityLockThenTheTicketRowThenTheRoundRow(t *testing.T) {
	for _, tc := range []struct {
		name, holds, blockedOn string
		lockedAfterwards       string
	}{
		{"the Owner's priority lock comes first", "priority", "pg_advisory_xact_lock", `SELECT 1 FROM tickets WHERE public_id = $1::uuid FOR UPDATE NOWAIT`},
		{"the Ticket row comes before the Round row", "ticket", "FOR UPDATE", `SELECT 1 FROM rounds r JOIN tickets t ON t.id = r.ticket_id WHERE t.public_id = $1::uuid FOR UPDATE OF r NOWAIT`},
	} {
		for _, held := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s, holding a Round=%t", tc.name, held), func(t *testing.T) {
				f := newClaimFixture(t)
				queued, claim := f.runningRound(t, "Lock order")
				ctx := context.Background()
				holder, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = holder.Rollback(ctx) }()
				switch tc.holds {
				case "priority":
					if err := lockOwnerPriority(ctx, holder, resolveTestOwner(t, f.pool)); err != nil {
						t.Fatal(err)
					}
				case "ticket":
					if _, err := holder.Exec(ctx, `SELECT 1 FROM tickets WHERE public_id = $1::uuid FOR UPDATE`, queued.Id); err != nil {
						t.Fatal(err)
					}
				}
				body := reconcileBody(t)
				if held {
					body = reconcileBody(t, heldRound(claim, HeldRunning))
				}
				result := make(chan *httptest.ResponseRecorder, 1)
				go func() { result <- f.reconcile(t, body) }()
				waitForLockWaiter(t, f.pool, tc.blockedOn)

				probe, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := probe.Exec(ctx, tc.lockedAfterwards, queued.Id); err != nil {
					t.Fatalf("the Reconcile, still waiting, already holds the lock that must come after: %v", err)
				}
				_ = probe.Rollback(ctx)
				if err := holder.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				if rec := <-result; rec.Code != http.StatusOK {
					t.Fatalf("status=%d body=%s, want 200 once the lock is released", rec.Code, rec.Body.String())
				}
			})
		}
	}
}

func TestReconcile_ConcurrentWithEventsAndHeartbeatsKeepsActivityGapFreeAndNotesOnce(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Concurrent")
	f.register(t, f.token, http.StatusOK)
	const n = 8
	var wg sync.WaitGroup
	codes := make(chan int, 3*n)
	for i := 0; i < n; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			codes <- f.reconcile(t, reconcileBody(t, heldRound(claim, HeldRunning))).Code
		}()
		go func(i int) {
			defer wg.Done()
			codes <- f.reportEvent(t, claim.RoundId, progressEvent(t, fmt.Sprintf("p%d", i), claim.ClaimEpoch, eventOccurredAt, fmt.Sprintf("step %d", i))).Code
		}(i)
		go func() {
			defer wg.Done()
			codes <- f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/heartbeat", token: f.token}).Code
		}()
	}
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != http.StatusOK && code != http.StatusCreated {
			t.Fatalf("a concurrent call answered %d", code)
		}
	}
	notes := f.allActivity(t, queued.Id, claim.RoundId)
	if got := activityTexts(notes); len(got) != 1 {
		t.Fatalf("Reconcile notes = %q, want exactly one", got)
	}
	if len(notes) != n+1 {
		t.Fatalf("notes = %d, want %d", len(notes), n+1)
	}
	for i, note := range notes {
		if note.Seq != i+1 {
			t.Fatalf("seq %d at %d: activity not gap-free", note.Seq, i)
		}
	}
	f.assertFlag(t, claim.RoundId, false)
}
