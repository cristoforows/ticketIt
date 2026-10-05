package httpapi

import (
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
)

func strandedSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var rows string
	if err := pool.QueryRow(context.Background(), `SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.id), '[]')::text FROM round_attestations x`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return databaseSnapshot(t, pool) + "round_attestations=" + rows + "\n"
}

func assertStrandedSnapshotUnchanged(t *testing.T, pool *pgxpool.Pool, before, what string) {
	t.Helper()
	if after := strandedSnapshot(t, pool); after != before {
		t.Fatalf("%s changed state:\nbefore:\n%s\nafter:\n%s", what, before, after)
	}
}

// Re-pairing replaces the Owner's runner; the new credential registers and is connected.
func (f *claimFixture) repair(t *testing.T) string {
	t.Helper()
	token := f.pair(t).Token
	f.register(t, token, http.StatusOK)
	return token
}

func (f *claimFixture) lapse() {
	f.clock.Set(f.clock.Now().Add(runnerHealthWindow))
}

func roundHolder(t *testing.T, pool *pgxpool.Pool, roundID string) (holder *int64, key *string) {
	t.Helper()
	if err := pool.QueryRow(context.Background(), `SELECT runner_id, claim_idempotency_key FROM rounds WHERE public_id = $1::uuid`, roundID).Scan(&holder, &key); err != nil {
		t.Fatal(err)
	}
	return holder, key
}

func currentRunnerID(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(context.Background(), `SELECT id FROM runners`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestClaim_RecordsTheClaimingRunnerAndItsKey(t *testing.T) {
	f := newClaimFixture(t)
	f.queue(t, "held")
	rec := f.do(t, claimCallWithKey(f.token, "key-1"))
	claim := decodeClaim(t, rec)
	holder, key := roundHolder(t, f.pool, claim.RoundId)
	if holder == nil || *holder != currentRunnerID(t, f.pool) || key == nil || *key != "key-1" {
		t.Fatalf("runner_id=%v key=%v, want the claiming runner and its key", holder, key)
	}
}

func TestClaim_ReplayReturnsTheSameRoundAndBodyAndSurvivesFeedbackConsumption(t *testing.T) {
	f := newClaimFixture(t)
	queued, first := f.deliveredTicket(t, "Feedback")
	f.mustAddFeedback(t, queued.Id, first.RoundId, "Cover the EU region too.")
	f.mustRework(t, queued.Id)

	call := claimCallWithKey(f.token, "rework-claim")
	created := f.do(t, call)
	claim := decodeClaim(t, created)
	if len(claim.Ticket.Feedback) != 1 || claim.Sequence != 2 {
		t.Fatalf("claim = %+v, want Round 2 carrying the one feedback", claim)
	}
	rounds := decodeRounds(t, f.listRounds(t, queued.Id))
	if rounds[1].Feedback[0].ConsumedBy == nil || rounds[1].Feedback[0].ConsumedBy.RoundId != claim.RoundId {
		t.Fatalf("feedback = %+v, want consumed by the claim", rounds[1].Feedback)
	}
	before := strandedSnapshot(t, f.pool)
	for i := range 3 {
		replayed := f.do(t, call)
		if replayed.Code != http.StatusOK || replayed.Body.String() != created.Body.String() {
			t.Fatalf("replay %d: status=%d body=%s, want 200 with the 201 body %s", i, replayed.Code, replayed.Body.String(), created.Body.String())
		}
	}
	assertStrandedSnapshotUnchanged(t, f.pool, before, "a replayed claim")
	if rows := roundRows(t, f.pool); len(rows) != 2 {
		t.Fatalf("rounds = %+v, want the two Rounds only", rows)
	}
}

func TestClaim_AReplayIsNever204(t *testing.T) {
	f := newClaimFixture(t)
	f.queue(t, "replay while disconnected")
	call := claimCallWithKey(f.token, "k")
	created := f.do(t, call)
	decodeClaim(t, created)
	f.lapse()
	if got := f.health(t).State; got != RunnerDisconnected {
		t.Fatalf("health = %s", got)
	}
	assertNoWork(t, f.claim(t))
	if replayed := f.do(t, call); replayed.Code != http.StatusOK || replayed.Body.String() != created.Body.String() {
		t.Fatalf("replay while disconnected: status=%d body=%s, want 200 with the original body", replayed.Code, replayed.Body.String())
	}
}

func TestClaim_ANewKeyWithNoRoundIs204AndRemainsSoForItsReplay(t *testing.T) {
	f := newClaimFixture(t)
	call := claimCallWithKey(f.token, "nothing-yet")
	assertNoWork(t, f.do(t, call))
	queued := f.queue(t, "later")
	claim := decodeClaim(t, f.do(t, call))
	if claim.Ticket.Id != queued.Id {
		t.Fatalf("claim = %+v", claim)
	}
}

func TestClaim_AnotherRunnersKeyIsIdempotencyKeyConflict(t *testing.T) {
	f := newClaimFixture(t)
	f.queue(t, "first runner")
	call := claimCallWithKey(f.token, "shared-key")
	decodeClaim(t, f.do(t, call))
	oldToken := f.token
	f.token = f.repair(t)
	before := strandedSnapshot(t, f.pool)
	assertErrorBody(t, f.do(t, claimCallWithKey(f.token, "shared-key")), http.StatusConflict, idempotencyKeyConflictCode, claimKeyOtherRunnerMessage)
	assertUnauthenticated(t, f.do(t, claimCallWithKey(oldToken, "shared-key")))
	assertStrandedSnapshotUnchanged(t, f.pool, before, "another runner's claim key")
}

func TestClaim_AKeyWhoseRoundLeftClaimedIsNotReplayable(t *testing.T) {
	f := newClaimFixture(t)
	f.queue(t, "started")
	call := claimCallWithKey(f.token, "k")
	claim := decodeClaim(t, f.do(t, call))
	f.startRound(t, claim, "start")
	before := strandedSnapshot(t, f.pool)
	assertErrorBody(t, f.do(t, call), http.StatusConflict, claimNotReplayableCode, claimNotReplayableMessage)
	f.deliverThroughAPI(t, claim.RoundId)
	assertErrorBody(t, f.do(t, call), http.StatusConflict, claimNotReplayableCode, claimNotReplayableMessage)
	if before == strandedSnapshot(t, f.pool) {
		t.Fatal("delivery changed nothing")
	}
}

func TestClaim_KeysAreScopedToTheOwner(t *testing.T) {
	f := newClaimFixture(t)
	f.queue(t, "mine")
	decodeClaim(t, f.do(t, claimCallWithKey(f.token, "same")))

	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	theirs := foreign.queue(t, "theirs")
	if claim := decodeClaim(t, foreign.do(t, claimCallWithKey(foreign.token, "same"))); claim.Ticket.Id != theirs.Id {
		t.Fatalf("foreign claim = %+v", claim)
	}
}

func TestClaim_TheBodyIsRequiredAndStrict(t *testing.T) {
	f := newClaimFixture(t)
	f.queue(t, "waits")
	before := strandedSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"no body":          "",
		"empty object":     `{}`,
		"null key":         `{"idempotencyKey":null}`,
		"numeric key":      `{"idempotencyKey":7}`,
		"empty key":        `{"idempotencyKey":""}`,
		"key over 200":     fmt.Sprintf(`{"idempotencyKey":%q}`, strings.Repeat("k", idempotencyKeyMaxLength+1)),
		"control in key":   `{"idempotencyKey":"a\u0007b"}`,
		"line feed in key": `{"idempotencyKey":"a\nb"}`,
		"extra field":      `{"idempotencyKey":"k","x":1}`,
		"two documents":    `{"idempotencyKey":"k"}{}`,
		"array":            `[]`,
	} {
		t.Run(name, func(t *testing.T) {
			assertInvalidRequest(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/claims", token: f.token, body: body}))
		})
	}
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/claims", body: `{}`}))
	assertStrandedSnapshotUnchanged(t, f.pool, before, "refused claim bodies")
	decodeClaim(t, f.do(t, claimCallWithKey(f.token, strings.Repeat("界", idempotencyKeyMaxLength))))
}

func TestClaim_ConcurrentClaimsWithOneKeyCreateOneRound(t *testing.T) {
	const claimants = 16
	for trial := range 4 {
		f := newClaimFixture(t)
		f.queue(t, "one key")
		call := claimCallWithKey(f.token, fmt.Sprintf("trial-%d", trial))
		recs := make([]*httptest.ResponseRecorder, claimants)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i := range claimants {
			wg.Add(1)
			go func() { defer wg.Done(); <-start; recs[i] = f.do(t, call) }()
		}
		close(start)
		wg.Wait()
		var created string
		for _, rec := range recs {
			if rec.Code == http.StatusCreated {
				if created != "" {
					t.Fatalf("trial %d: two 201s", trial)
				}
				created = rec.Body.String()
			}
		}
		if created == "" {
			t.Fatalf("trial %d: no 201", trial)
		}
		for i, rec := range recs {
			if rec.Code != http.StatusCreated && (rec.Code != http.StatusOK || rec.Body.String() != created) {
				t.Fatalf("trial %d claimant %d: status=%d body=%s, want 200 with the 201 body", trial, i, rec.Code, rec.Body.String())
			}
		}
		if rows := roundRows(t, f.pool); len(rows) != 1 {
			t.Fatalf("trial %d: rounds = %+v", trial, rows)
		}
	}
}

func TestClaim_TheDatabaseEnforcesOneRoundPerKeyAndAWholeClaimRecord(t *testing.T) {
	f := newClaimFixture(t)
	a := f.queue(t, "A")
	claim := decodeClaim(t, f.do(t, claimCallWithKey(f.token, "dup")))
	f.deliverThroughAPI(t, claim.RoundId)
	ctx := context.Background()
	insert := func(sequence int, runner, key, payload string) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO rounds (owner_id, public_id, ticket_id, agent_id, sequence, state, claim_epoch, claimed_at, started_at, ended_at, runner_id, claim_idempotency_key, claim_payload)
			SELECT t.owner_id, gen_random_uuid(), t.id, t.assignee_agent_id, $2, 'delivered', 9, now(), now(), now(), `+runner+`, `+key+`, `+payload+`
			  FROM tickets t WHERE t.public_id = $1::uuid`, a.Id, sequence)
		return err
	}
	assertViolates(t, insert(5, "1", "'dup'", "'{}'"), "rounds_claim_idempotency_key_unique")
	assertViolates(t, insert(6, "1", "NULL", "'{}'"), "rounds_claim_recorded_together")
	assertViolates(t, insert(7, "NULL", "'k'", "'{}'"), "rounds_claim_recorded_together")
	assertViolates(t, insert(8, "1", "'k'", "NULL"), "rounds_claim_recorded_together")
	assertViolates(t, insert(9, "1", "''", "'{}'"), "rounds_claim_idempotency_key_length")
	if err := insert(10, "NULL", "NULL", "NULL"); err != nil {
		t.Fatalf("a Round with no claim record, as before #171: %v", err)
	}
}

func TestDecideClaimReplay(t *testing.T) {
	for _, tc := range []struct {
		holder, caller int64
		state          RoundState
		want           claimOutcome
	}{
		{1, 1, RoundClaimed, claimReplayed},
		{1, 1, RoundRunning, claimKeyNotReplayable},
		{1, 1, RoundWaitingForInput, claimKeyNotReplayable},
		{1, 1, RoundInterrupted, claimKeyNotReplayable},
		{1, 2, RoundClaimed, claimKeyOtherRunner},
		{1, 2, RoundRunning, claimKeyOtherRunner},
	} {
		if got := decideClaimReplay(tc.holder, tc.caller, string(tc.state)); got != tc.want {
			t.Errorf("holder %d caller %d %s: %d, want %d", tc.holder, tc.caller, tc.state, got, tc.want)
		}
	}
}

func TestRunnerHolds(t *testing.T) {
	one, two := int64(1), int64(2)
	for _, tc := range []struct {
		holder *int64
		caller int64
		want   bool
	}{{&one, 1, true}, {&two, 1, false}, {nil, 1, false}, {nil, 0, false}} {
		if got := runnerHolds(tc.holder, tc.caller); got != tc.want {
			t.Errorf("runnerHolds(%v, %d) = %t, want %t", tc.holder, tc.caller, got, tc.want)
		}
	}
}

// A running Round with a pending Stop, held by the first runner; the second runner replaces it.
func (f *claimFixture) replacedRound(t *testing.T) (Ticket, RunnerClaim, RunnerCommand, string) {
	t.Helper()
	queued, claim, stop := f.stoppedRound(t, "Replaced", true)
	f.mustReport(t, claim.RoundId, progressEvent(t, "p1", claim.ClaimEpoch, eventOccurredAt, "first runner's step"))
	old := f.token
	f.token = f.repair(t)
	return queued, claim, stop, old
}

func TestFencing_ARepairedCredentialIsAnotherRunnerAndChangesNothing(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, stop, oldToken := f.replacedRound(t)
	before := strandedSnapshot(t, f.pool)

	notHolder := func(rec *httptest.ResponseRecorder) {
		t.Helper()
		assertErrorBody(t, rec, http.StatusConflict, runnerNotHolderCode, runnerNotHolderMessage)
	}
	notHolder(f.reportEvent(t, claim.RoundId, progressEvent(t, "p2", claim.ClaimEpoch, eventOccurredAt, "the new runner")))
	notHolder(f.reportEvent(t, claim.RoundId, progressEvent(t, "p1", claim.ClaimEpoch, eventOccurredAt, "first runner's step")))
	notHolder(f.reportEvent(t, claim.RoundId, stopConfirmedEvent(t, "s", claim.ClaimEpoch, stopEvidence)))
	notHolder(f.reportEvent(t, claim.RoundId, blockedEndings[1].event(t, "i", claim.ClaimEpoch, interruptedEvidence)))
	notHolder(f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport))
	notHolder(f.ack(t, claim.RoundId, stop.Id, RunnerCommandApplied))
	notHolder(f.reconcile(t, reconcileBody(t, heldRound(claim, HeldRunning))))
	if commands := f.mustCommands(t, claim.RoundId); len(commands) != 0 {
		t.Fatalf("commands for a non-holder = %+v, want none", commands)
	}
	got := f.mustReconcile(t, reconcileBody(t)).Round
	if got == nil || got.RoundId != claim.RoundId || got.Disposition != ReconcileHold || len(got.Commands) != 0 || got.CessationEvent != nil {
		t.Fatalf("held-nothing Reconcile by a non-holder = %+v, want this Round on hold with no commands", got)
	}
	assertStrandedSnapshotUnchanged(t, f.pool, before, "the replacing runner's reports")

	for _, call := range []runnerCall{
		{method: http.MethodPost, path: "/api/runner/rounds/" + claim.RoundId + "/events", body: progressEvent(t, "p3", claim.ClaimEpoch, eventOccurredAt, "old")},
		{method: http.MethodPost, path: authorityCheckPath(claim.RoundId), body: authorityCheckBody(t, writeReport, claim.ClaimEpoch)},
		{method: http.MethodGet, path: "/api/runner/rounds/" + claim.RoundId + "/commands"},
		{method: http.MethodPost, path: ackPath(claim.RoundId, stop.Id), body: `{"outcome":"applied"}`},
		{method: http.MethodPost, path: "/api/runner/reconcile", body: reconcileBody(t, heldRound(claim, HeldRunning))},
		{method: http.MethodPost, path: "/api/runner/heartbeat"},
		claimCall(""),
	} {
		call.token = oldToken
		assertUnauthenticated(t, f.do(t, call))
	}
	assertStrandedSnapshotUnchanged(t, f.pool, before, "the replaced credential's calls")
	if ticket := f.ticket(t, queued.Id); ticket.OpenRound == nil || ticket.OpenRound.WaitingReason != WaitingRunnerReplaced {
		t.Fatalf("openRound = %+v, want still open and runner_replaced", ticket.OpenRound)
	}
}

func TestFencing_ComesAfterLookupAndShapeAndBeforeReplayAndEpoch(t *testing.T) {
	f := newClaimFixture(t)
	_, claim, stop, _ := f.replacedRound(t)
	before := strandedSnapshot(t, f.pool)
	unknown := uuid.NewString()
	assertRoundNotFound(t, f.reportEvent(t, unknown, progressEvent(t, "p", 1, eventOccurredAt, "x")))
	assertRoundNotFound(t, f.check(t, unknown, 1, writeReport))
	assertRoundNotFound(t, f.reconcile(t, reconcileBody(t, map[string]any{"roundId": unknown, "claimEpoch": 1, "execution": "running"})))
	assertErrorBody(t, f.ack(t, claim.RoundId, uuid.NewString(), RunnerCommandApplied), http.StatusNotFound, "not_found", roundOrCommandNotFoundMessage)
	assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, `{}`))
	assertInvalidRequest(t, f.ack(t, claim.RoundId, stop.Id, "maybe"))
	assertErrorCode(t, f.check(t, claim.RoundId, claim.ClaimEpoch, undeclaredScopes["an undeclared action"]), capabilityNotSupportedCode)
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"event at a stale epoch":     f.reportEvent(t, claim.RoundId, progressEvent(t, "p9", claim.ClaimEpoch+1, eventOccurredAt, "x")),
		"replay of the holder's key": f.reportEvent(t, claim.RoundId, progressEvent(t, "p1", claim.ClaimEpoch, eventOccurredAt, "first runner's step")),
		"conflict on the holder key": f.reportEvent(t, claim.RoundId, progressEvent(t, "p1", claim.ClaimEpoch, eventOccurredAt, "different")),
		"check at a stale epoch":     f.check(t, claim.RoundId, claim.ClaimEpoch+1, writeReport),
		"reconcile at a stale epoch": f.reconcile(t, reconcileBody(t, map[string]any{"roundId": claim.RoundId, "claimEpoch": claim.ClaimEpoch + 1, "execution": "stopped"})),
	} {
		if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), runnerNotHolderCode) {
			t.Errorf("%s: status=%d body=%s, want 409 %s", name, rec.Code, rec.Body.String(), runnerNotHolderCode)
		}
	}
	assertStrandedSnapshotUnchanged(t, f.pool, before, "refused non-holder calls")
}

func TestFencing_TheHolderIsUnaffected(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, stop := f.stoppedRound(t, "Holder", true)
	if got := f.mustCommands(t, claim.RoundId); len(got) != 1 || got[0].Id != stop.Id {
		t.Fatalf("holder's commands = %+v", got)
	}
	decodeAck(t, f.ack(t, claim.RoundId, stop.Id, RunnerCommandApplied))
	f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning)))
	f.mustConfirmStop(t, claim)
	if ticket := f.ticket(t, queued.Id); ticket.OpenRound != nil || ticket.Status != Backlog {
		t.Fatalf("Ticket = %s %+v", ticket.Status, ticket.OpenRound)
	}
}

func TestFencing_ARoundWithNoRecordedHolderIsHeldByNoRunner(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Before #171")
	if _, err := f.pool.Exec(context.Background(), `UPDATE rounds SET runner_id = NULL, claim_idempotency_key = NULL, claim_payload = NULL WHERE public_id = $1::uuid`, claim.RoundId); err != nil {
		t.Fatal(err)
	}
	before := strandedSnapshot(t, f.pool)
	assertErrorCode(t, f.reportEvent(t, claim.RoundId, progressEvent(t, "p", claim.ClaimEpoch, eventOccurredAt, "x")), runnerNotHolderCode)
	assertErrorCode(t, f.reconcile(t, reconcileBody(t, heldRound(claim, HeldRunning))), runnerNotHolderCode)
	if got := f.mustReconcile(t, reconcileBody(t)).Round; got == nil || got.Disposition != ReconcileHold {
		t.Fatalf("held nothing = %+v, want hold", got)
	}
	assertStrandedSnapshotUnchanged(t, f.pool, before, "calls about an unheld Round")
	ticket := f.ticket(t, queued.Id)
	if ticket.OpenRound.WaitingReason != WaitingRunnerReplaced || !ticket.AllowedActions.AttestCessation.Available {
		t.Fatalf("openRound = %+v, attestCessation = %+v, want runner_replaced and attestable", ticket.OpenRound, ticket.AllowedActions.AttestCessation)
	}
}

func TestWaitingReason_RunnerReplacedRows(t *testing.T) {
	unknown := HeldUnknown
	for _, tc := range []struct {
		name                               string
		state                              OpenRoundState
		stop, connected, replaced, flagged bool
		recorded                           *HeldExecution
		want                               RoundWaitingReason
	}{
		{"disconnected outranks replaced", OpenRoundRunning, false, false, true, false, nil, WaitingRunnerDisconnected},
		{"replaced outranks execution unknown", OpenRoundRunning, false, true, true, true, &unknown, WaitingRunnerReplaced},
		{"replaced outranks reconciling", OpenRoundRunning, false, true, true, true, nil, WaitingRunnerReplaced},
		{"replaced outranks stopping", OpenRoundRunning, true, true, true, false, nil, WaitingRunnerReplaced},
		{"replaced on a claimed Round", OpenRoundClaimed, false, true, true, false, nil, WaitingRunnerReplaced},
		{"replaced while waiting for input", OpenRoundWaitingForInput, false, true, true, false, nil, WaitingRunnerReplaced},
		{"not replaced is the Round's own wait", OpenRoundRunning, false, true, false, false, nil, WaitingWorking},
	} {
		if got := decideWaitingReason(tc.state, nil, nil, tc.stop, tc.connected, tc.replaced, tc.flagged, tc.recorded); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestHolderHealthOf(t *testing.T) {
	one, two := int64(1), int64(2)
	for _, tc := range []struct {
		holder, current *int64
		connected       bool
		want            RoundHolderHealth
	}{
		{&one, &one, true, HolderConnected},
		{&one, &one, false, HolderDisconnected},
		{&one, &two, true, HolderReplaced},
		{&one, &two, false, HolderReplaced},
		{nil, &two, true, HolderReplaced},
		{&one, nil, false, HolderNotPaired},
		{nil, nil, false, HolderNotPaired},
	} {
		if got := holderHealthOf(tc.holder, tc.current, tc.connected); got != tc.want {
			t.Errorf("holder %v current %v connected %t: %s, want %s", tc.holder, tc.current, tc.connected, got, tc.want)
		}
	}
}

func TestWaitingReason_AReplacedRunnerShowsRunnerReplacedUntilItsHealthLapses(t *testing.T) {
	f := newClaimFixture(t)
	queued, _ := f.runningRound(t, "Replaced")
	f.token = f.repair(t)
	f.assertWaitingReason(t, queued.Id, WaitingRunnerReplaced)
	f.lapse()
	f.assertWaitingReason(t, queued.Id, WaitingRunnerDisconnected)
	f.heartbeat(t, f.token, http.StatusOK)
	f.assertWaitingReason(t, queued.Id, WaitingRunnerReplaced)
}

// Every way a runner can be lost: none ends the Round, frees the slot or unlocks the Ticket.
func TestStrandedRound_NothingEndsOrUnlocksItWithoutAnAttestation(t *testing.T) {
	// Each returns whether its runner keeps heartbeating.
	cases := map[string]func(t *testing.T, f *claimFixture, claim RunnerClaim) bool{
		"dead": func(t *testing.T, f *claimFixture, claim RunnerClaim) bool {
			f.clock.Set(f.clock.Now().Add(24 * time.Hour))
			return false
		},
		"restarted": func(t *testing.T, f *claimFixture, claim RunnerClaim) bool {
			f.clock.Set(f.clock.Now().Add(time.Hour))
			f.register(t, f.token, http.StatusOK)
			if got := f.mustReconcile(t, reconcileBody(t)).Round; got == nil || got.Disposition != ReconcileHold {
				t.Fatalf("restarted Reconcile = %+v, want hold", got)
			}
			return true
		},
		"replaced": func(t *testing.T, f *claimFixture, claim RunnerClaim) bool {
			f.token = f.repair(t)
			f.mustReconcile(t, reconcileBody(t))
			return true
		},
		"credential revoked": func(t *testing.T, f *claimFixture, claim RunnerClaim) bool {
			f.expect(t, runnerCall{method: http.MethodDelete, path: "/api/runner-credential", cookie: f.cookie}, http.StatusNoContent)
			f.token = ""
			return false
		},
		"stale epoch reported": func(t *testing.T, f *claimFixture, claim RunnerClaim) bool {
			assertErrorCode(t, f.reportEvent(t, claim.RoundId, blockedEndings[1].event(t, "late", claim.ClaimEpoch+1, interruptedEvidence)), staleClaimEpochCode)
			f.clock.Set(f.clock.Now().Add(time.Hour))
			return false
		},
	}
	for name, lose := range cases {
		t.Run(name, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.runningRound(t, "Stranded "+name)
			other := f.queue(t, "Next in line")
			alive := lose(t, f, claim)
			for _, after := range []time.Duration{0, time.Minute, 7 * 24 * time.Hour} {
				f.clock.Set(f.clock.Now().Add(after))
				if alive {
					f.heartbeat(t, f.token, http.StatusOK)
				}
				if f.token != "" {
					assertNoWork(t, f.claim(t))
				}
				ticket := f.ticket(t, queued.Id)
				if ticket.OpenRound == nil || ticket.OpenRound.Id != claim.RoundId || ticket.Status != InProgress || len(ticket.AllowedActions.StatusChanges) != 0 {
					t.Fatalf("after %s: Ticket = %s %+v allowed=%+v, want In Progress, locked, the Round open", after, ticket.Status, ticket.OpenRound, ticket.AllowedActions.StatusChanges)
				}
				assertErrorCode(t, f.statusChange(t, queued.Id, Blocked), roundOpenCode)
				assertErrorCode(t, f.archive(t, queued.Id), roundOpenCode)
				if got := f.ticket(t, other.Id); got.OpenRound != nil {
					t.Fatalf("after %s: the next Ticket got a Round", after)
				}
			}
			if rows := roundRows(t, f.pool); len(rows) != 1 || rows[0].state != string(RoundRunning) {
				t.Fatalf("rounds = %+v, want the one running Round", rows)
			}
			if a := f.ticket(t, queued.Id).AllowedActions.AttestCessation; !a.Available {
				t.Fatalf("attestCessation = %+v, want available", a)
			}
		})
	}
}

func TestClaim_ResponsesAreJSONObjectsWithTheContractFields(t *testing.T) {
	f := newClaimFixture(t)
	f.queue(t, "shape")
	rec := f.do(t, claimCallWithKey(f.token, "shape"))
	var created map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	replayed := f.do(t, claimCallWithKey(f.token, "shape"))
	var again map[string]any
	if err := json.Unmarshal(replayed.Body.Bytes(), &again); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(created, again) || replayed.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("replay = %v (%s), want %v as JSON", again, replayed.Header().Get("Content-Type"), created)
	}
}
