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

const (
	eventReference  = "controlled:0b5f3c6e-5d1b-4d7a-9a50-1f2d4c0d9a11"
	eventOccurredAt = "2026-01-02T03:04:05.123456Z"
)

func startedEvent(key string, epoch int, occurredAt, reference string) string {
	return fmt.Sprintf(`{"type":"execution_started","idempotencyKey":%q,"claimEpoch":%d,"occurredAt":%q,"data":{"engineReference":%q}}`,
		key, epoch, occurredAt, reference)
}

func (f *claimFixture) reportEvent(t *testing.T, roundID, body string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/rounds/" + roundID + "/events", body: body, token: f.token})
}

func (f *claimFixture) claimTicket(t *testing.T, title string) (Ticket, RunnerClaim) {
	t.Helper()
	queued := f.queue(t, title)
	return queued, f.mustClaim(t)
}

func (f *claimFixture) startRound(t *testing.T, claim RunnerClaim, key string) *httptest.ResponseRecorder {
	t.Helper()
	rec := f.reportEvent(t, claim.RoundId, startedEvent(key, claim.ClaimEpoch, eventOccurredAt, eventReference))
	if rec.Code != http.StatusCreated {
		t.Fatalf("start Round %s: status=%d body=%s", claim.RoundId, rec.Code, rec.Body.String())
	}
	return rec
}

func databaseSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var out strings.Builder
	for _, table := range []string{"tickets", "rounds", "round_events", "round_engine_references", "round_activity", "usage_observations", "round_deliverables", "round_commands", "runners", "badges"} {
		var rows string
		if err := pool.QueryRow(context.Background(), `SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.id), '[]')::text FROM `+table+` x`).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&out, "%s=%s\n", table, rows)
	}
	var links string
	if err := pool.QueryRow(context.Background(), `SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.ticket_id, x.badge_id), '[]')::text FROM ticket_badges x`).Scan(&links); err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(&out, "ticket_badges=%s\n", links)
	return out.String()
}

func assertSnapshotUnchanged(t *testing.T, pool *pgxpool.Pool, before, what string) {
	t.Helper()
	if after := databaseSnapshot(t, pool); after != before {
		t.Fatalf("%s changed state:\nbefore:\n%s\nafter:\n%s", what, before, after)
	}
}

func assertErrorBody(t *testing.T, rec *httptest.ResponseRecorder, status int, code, message string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status=%d, want %d; body=%s", rec.Code, status, rec.Body.String())
	}
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if want := newErrorBody(code, message); body != want {
		t.Fatalf("error body = %+v, want %+v", body, want)
	}
}

func assertInvalidRequest(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec, "invalid_request")
}

func assertRoundNotFound(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	assertErrorBody(t, rec, http.StatusNotFound, "not_found", roundNotFoundMessage)
}

func wantResultBody(roundID string, startedAt time.Time) string {
	return fmt.Sprintf(`{"roundId":%q,"startedAt":%q,"state":"running","type":"execution_started"}`, roundID, startedAt.UTC().Format(time.RFC3339Nano))
}

func TestRoundEvent_ExecutionStartedStartsTheRoundAndMovesTheTicketToInProgress(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Start me")
	before := readTicketRowFacts(t, f.pool, queued.Id)

	galleyNow := runnerEpoch.Add(7 * time.Second)
	f.clock.Set(galleyNow)
	rec := f.reportEvent(t, claim.RoundId, startedEvent("round-1:0", claim.ClaimEpoch, eventOccurredAt, eventReference))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	if got, want := rec.Body.String(), wantResultBody(claim.RoundId, galleyNow); got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}

	ticket := f.ticket(t, queued.Id)
	wantRound := &TicketOpenRound{Id: claim.RoundId, Sequence: 1, State: OpenRoundRunning, Agent: claim.Agent, ClaimedAt: runnerEpoch, StartedAt: &galleyNow}
	if ticket.Status != InProgress || ticket.RequestingAgentWork || ticket.OpenRound == nil || ticket.OpenRound.State != wantRound.State ||
		ticket.OpenRound.StartedAt == nil || !ticket.OpenRound.StartedAt.Equal(galleyNow) || ticket.OpenRound.Id != wantRound.Id || ticket.OpenRound.Agent != wantRound.Agent {
		t.Fatalf("Ticket after the event: status=%s requestingAgentWork=%t openRound=%+v, want In Progress, false, %+v", ticket.Status, ticket.RequestingAgentWork, ticket.OpenRound, wantRound)
	}
	if len(ticket.AllowedActions.StatusChanges) != 0 || ticket.AllowedActions.Accept.Available || ticket.AllowedActions.Accept.Reason == nil || ticket.AllowedActions.Accept.Reason.Code != roundOpenCode {
		t.Fatalf("allowedActions of a running Ticket = %+v, want none and round_open", ticket.AllowedActions)
	}
	listed, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodGet, "/api/tickets", "", http.StatusOK)
	if got := decodeAs[TicketList](t, listed).Tickets[0]; got.Status != InProgress || got.OpenRound == nil || got.OpenRound.State != OpenRoundRunning {
		t.Fatalf("listed Ticket = %s %+v, want In Progress with a running Round", got.Status, got.OpenRound)
	}

	after := readTicketRowFacts(t, f.pool, queued.Id)
	if after.status != string(InProgress) || after.assigneeType != before.assigneeType || *after.agentID != *before.agentID || after.rank != before.rank || !after.updatedAt.After(before.updatedAt) {
		t.Fatalf("Ticket row = %+v, want In Progress, same Assignee and rank, updated_at after %v (was %+v)", after, before.updatedAt, before)
	}

	var state string
	var claimedAt, startedAt time.Time
	var endedAt *time.Time
	var epoch int
	if err := f.pool.QueryRow(context.Background(), `SELECT state, claimed_at, started_at, ended_at, claim_epoch FROM rounds WHERE public_id = $1::uuid`, claim.RoundId).
		Scan(&state, &claimedAt, &startedAt, &endedAt, &epoch); err != nil {
		t.Fatal(err)
	}
	if state != "running" || !claimedAt.Equal(runnerEpoch) || !startedAt.Equal(galleyNow) || endedAt != nil || epoch != 1 {
		t.Fatalf("Round row: state=%s claimed=%v started=%v ended=%v epoch=%d; want running, claimed %v, started by Galley's clock %v", state, claimedAt, startedAt, endedAt, epoch, runnerEpoch, galleyNow)
	}

	var references []struct {
		reference  string
		current    bool
		attachedAt time.Time
	}
	rows, err := f.pool.Query(context.Background(), `SELECT reference, is_current, attached_at FROM round_engine_references ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var r struct {
			reference  string
			current    bool
			attachedAt time.Time
		}
		if err := rows.Scan(&r.reference, &r.current, &r.attachedAt); err != nil {
			t.Fatal(err)
		}
		references = append(references, r)
	}
	rows.Close()
	if len(references) != 1 || references[0].reference != eventReference || !references[0].current || !references[0].attachedAt.Equal(galleyNow) || references[0].reference == claim.RoundId {
		t.Fatalf("engine references = %+v, want the one current %q attached at %v, separate from the Round id", references, eventReference, galleyNow)
	}

	var (
		key, eventType         string
		eventEpoch             int
		occurredAt, receivedAt time.Time
		payloadHash            []byte
		result                 string
		roundIDOfEvent         string
	)
	if err := f.pool.QueryRow(context.Background(), `SELECT e.idempotency_key, e.type, e.claim_epoch, e.occurred_at, e.received_at, e.payload_hash, e.result::text, r.public_id::text
		FROM round_events e JOIN rounds r ON r.id = e.round_id`).Scan(&key, &eventType, &eventEpoch, &occurredAt, &receivedAt, &payloadHash, &result, &roundIDOfEvent); err != nil {
		t.Fatal(err)
	}
	wantHash, err := roundEventPayloadHash(RoundEventExecutionStarted, 1, mustParseRFC3339(t, eventOccurredAt), []byte(`{"engineReference":`+fmt.Sprintf("%q", eventReference)+`}`))
	if err != nil {
		t.Fatal(err)
	}
	if key != "round-1:0" || eventType != "execution_started" || eventEpoch != 1 || !occurredAt.Equal(mustParseRFC3339(t, eventOccurredAt)) || !receivedAt.Equal(galleyNow) ||
		!bytes.Equal(payloadHash, wantHash) || roundIDOfEvent != claim.RoundId {
		t.Fatalf("round_events row: key=%q type=%q epoch=%d occurred=%v received=%v hash=%x round=%s", key, eventType, eventEpoch, occurredAt, receivedAt, payloadHash, roundIDOfEvent)
	}
	var stored, sent RoundEventResult
	if err := json.Unmarshal([]byte(result), &stored); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &sent); err != nil || !reflect.DeepEqual(stored, sent) {
		t.Fatalf("stored result %+v, sent %+v (%v)", stored, sent, err)
	}
	if n := tableRowCount(t, f.pool, "round_events"); n != 1 {
		t.Fatalf("round_events rows = %d, want 1", n)
	}
}

func TestRoundEvent_StartedAtNeverPrecedesClaimedAt(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.claimTicket(t, "Clock stepped back")
	f.clock.Set(runnerEpoch.Add(-time.Hour))
	rec := f.reportEvent(t, claim.RoundId, startedEvent("k", 1, eventOccurredAt, eventReference))
	if rec.Code != http.StatusCreated || rec.Body.String() != wantResultBody(claim.RoundId, runnerEpoch) {
		t.Fatalf("status=%d body=%s, want 201 with started at the claim time", rec.Code, rec.Body.String())
	}
}

func TestRoundEvent_TheRunnersOwnClockNeverTimesTheRound(t *testing.T) {
	for name, occurredAt := range map[string]string{
		"long before the claim": "1999-12-31T23:59:59Z",
		"long after the claim":  "2099-12-31T23:59:59Z",
	} {
		t.Run(name, func(t *testing.T) {
			f := newClaimFixture(t)
			_, claim := f.claimTicket(t, "Skewed runner")
			f.clock.Set(runnerEpoch.Add(time.Second))
			rec := f.reportEvent(t, claim.RoundId, startedEvent("k", 1, occurredAt, eventReference))
			if rec.Code != http.StatusCreated || rec.Body.String() != wantResultBody(claim.RoundId, runnerEpoch.Add(time.Second)) {
				t.Fatalf("status=%d body=%s, want 201 timed by Galley's clock", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestRoundEvent_ReplayReturnsTheOriginalResultAndChangesNothing(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Replay me")
	f.clock.Set(runnerEpoch.Add(3 * time.Second))
	body := startedEvent("round-1:0", 1, eventOccurredAt, eventReference)
	first := f.reportEvent(t, claim.RoundId, body)
	if first.Code != http.StatusCreated {
		t.Fatalf("first: status=%d body=%s", first.Code, first.Body.String())
	}
	afterFirst := databaseSnapshot(t, f.pool)

	f.clock.Set(runnerEpoch.Add(time.Hour))
	for name, replay := range map[string]string{
		"the same bytes":                    body,
		"the same instant in another zone":  startedEvent("round-1:0", 1, "2026-01-02T11:04:05.123456+08:00", eventReference),
		"the same object with other layout": "{\n \"data\" : {\"engineReference\" : \"" + eventReference + "\"},\n \"occurredAt\":\"" + eventOccurredAt + "\", \"claimEpoch\":1, \"idempotencyKey\":\"round-1:0\", \"type\":\"execution_started\" }",
	} {
		rec := f.reportEvent(t, claim.RoundId, replay)
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
			t.Fatalf("%s: status=%d body=%s, want 200 with the original body %s", name, rec.Code, rec.Body.String(), first.Body.String())
		}
		assertSnapshotUnchanged(t, f.pool, afterFirst, "a replay of "+name)
	}
	if n := tableRowCount(t, f.pool, "round_events"); n != 1 {
		t.Fatalf("round_events rows = %d, want 1", n)
	}
	if n := tableRowCount(t, f.pool, "round_engine_references"); n != 1 {
		t.Fatalf("engine references = %d, want 1", n)
	}
	if got := f.ticket(t, queued.Id); got.Status != InProgress || got.OpenRound == nil || got.OpenRound.State != OpenRoundRunning {
		t.Fatalf("Ticket after replays = %s %+v", got.Status, got.OpenRound)
	}

	f.deliverThroughAPI(t, claim.RoundId)
	afterEnd := databaseSnapshot(t, f.pool)
	rec := f.reportEvent(t, claim.RoundId, body)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replay after the Round ended: status=%d body=%s, want 200 with the original body", rec.Code, rec.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, afterEnd, "a replay after the Round ended")
}

func TestRoundEvent_ReplayIsAnsweredFromTheStoredResult(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.claimTicket(t, "Stored result")
	body := startedEvent("k", 1, eventOccurredAt, eventReference)
	f.startRound(t, claim, "k")
	if _, err := f.pool.Exec(context.Background(), `UPDATE round_events SET result = jsonb_set(result, '{startedAt}', '"2030-01-01T00:00:00Z"')`); err != nil {
		t.Fatal(err)
	}
	rec := f.reportEvent(t, claim.RoundId, body)
	if rec.Code != http.StatusOK || rec.Body.String() != wantResultBody(claim.RoundId, time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("replay: status=%d body=%s, want the stored result verbatim", rec.Code, rec.Body.String())
	}
}

func TestRoundEvent_SameKeyWithADifferentPayloadConflicts(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.claimTicket(t, "Conflict")
	f.startRound(t, claim, "k")
	before := databaseSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"a different engine reference": startedEvent("k", 1, eventOccurredAt, "controlled:other"),
		"a different claim epoch":      startedEvent("k", 2, eventOccurredAt, eventReference),
		"a different occurredAt":       startedEvent("k", 1, "2026-01-02T03:04:05.124Z", eventReference),
	} {
		rec := f.reportEvent(t, claim.RoundId, body)
		assertErrorBody(t, rec, http.StatusConflict, idempotencyKeyConflictCode, idempotencyKeyConflictMessage)
		assertSnapshotUnchanged(t, f.pool, before, name)
	}
}

func TestRoundEvent_AKeyBelongsToOneRound(t *testing.T) {
	f := newClaimFixture(t)
	_, first := f.claimTicket(t, "First")
	f.startRound(t, first, "shared-key")
	f.deliverThroughAPI(t, first.RoundId)
	_, second := f.claimTicket(t, "Second")
	rec := f.reportEvent(t, second.RoundId, startedEvent("shared-key", 1, eventOccurredAt, eventReference))
	if rec.Code != http.StatusCreated {
		t.Fatalf("the same key on another Round: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
}

func TestRoundEvent_StaleClaimEpochIsRejectedWithNoStateChange(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Superseded")
	if _, err := f.pool.Exec(context.Background(), `UPDATE rounds SET claim_epoch = 2 WHERE public_id = $1::uuid`, claim.RoundId); err != nil {
		t.Fatal(err)
	}
	before := databaseSnapshot(t, f.pool)
	for _, epoch := range []int{1, 3} {
		rec := f.reportEvent(t, claim.RoundId, startedEvent(fmt.Sprintf("k%d", epoch), epoch, eventOccurredAt, eventReference))
		assertErrorBody(t, rec, http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
		assertSnapshotUnchanged(t, f.pool, before, fmt.Sprintf("an event at epoch %d", epoch))
	}
	if n := tableRowCount(t, f.pool, "round_events"); n != 0 {
		t.Fatalf("round_events rows = %d, want none for a rejected event", n)
	}
	if got := f.ticket(t, queued.Id); got.Status != Ready || got.OpenRound == nil || got.OpenRound.State != OpenRoundClaimed {
		t.Fatalf("Ticket after stale events = %s %+v, want Ready and claimed", got.Status, got.OpenRound)
	}
	rec := f.reportEvent(t, claim.RoundId, startedEvent("k2", 2, eventOccurredAt, eventReference))
	if rec.Code != http.StatusCreated {
		t.Fatalf("the current epoch: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
}

func TestRoundEvent_UnknownForeignAndMalformedRoundsAreTheSameNotFound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Mine")

	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	_, theirClaim := foreign.claimTicket(t, "Theirs")

	before := databaseSnapshot(t, f.pool)
	body := startedEvent("k", 1, eventOccurredAt, eventReference)
	var bodies []string
	for _, roundID := range []string{
		uuid.NewString(),
		theirClaim.RoundId,
		strings.ToUpper(theirClaim.RoundId),
		"not-a-uuid",
		queued.Id,
		uuid.Nil.String(),
	} {
		rec := f.reportEvent(t, roundID, body)
		assertRoundNotFound(t, rec)
		bodies = append(bodies, rec.Body.String())
	}
	for _, b := range bodies[1:] {
		if b != bodies[0] {
			t.Fatalf("not-found bodies differ: %q vs %q", b, bodies[0])
		}
	}
	assertSnapshotUnchanged(t, f.pool, before, "an event for a Round that was never admitted")

	if rec := f.reportEvent(t, claim.RoundId, body); rec.Code != http.StatusCreated {
		t.Fatalf("own Round: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
	var theirs int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM rounds WHERE public_id = $1::uuid AND state = 'claimed'`, theirClaim.RoundId).Scan(&theirs); err != nil || theirs != 1 {
		t.Fatalf("the other Owner's Round changed: %d claimed rows (%v)", theirs, err)
	}
}

func TestRoundEvent_EndedAndRunningRoundsRejectNewEventsWithNoStateChange(t *testing.T) {
	t.Run("ended", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Ended")
		f.startRound(t, claim, "k0")
		f.deliverThroughAPI(t, claim.RoundId)
		before := databaseSnapshot(t, f.pool)
		rec := f.reportEvent(t, claim.RoundId, startedEvent("k1", 1, eventOccurredAt, eventReference))
		assertErrorBody(t, rec, http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
		assertSnapshotUnchanged(t, f.pool, before, "an event for an ended Round")
	})
	t.Run("running", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Running")
		f.startRound(t, claim, "k0")
		before := databaseSnapshot(t, f.pool)
		rec := f.reportEvent(t, claim.RoundId, startedEvent("k1", 1, eventOccurredAt, "controlled:second"))
		assertErrorBody(t, rec, http.StatusConflict, eventOutOfOrderCode, eventOutOfOrderMessage(RoundEventExecutionStarted, RoundRunning))
		assertSnapshotUnchanged(t, f.pool, before, "a second execution_started")
		if n := tableRowCount(t, f.pool, "round_engine_references"); n != 1 {
			t.Fatalf("engine references = %d, want the first only", n)
		}
	})
}

func TestRoundEvent_DecisionLadderOrder(t *testing.T) {
	t.Run("the idempotency lookup precedes the epoch and open checks", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Ladder")
		first := f.startRound(t, claim, "k")
		if _, err := f.pool.Exec(context.Background(), `UPDATE rounds SET claim_epoch = 2`); err != nil {
			t.Fatal(err)
		}
		f.deliverThroughAPI(t, claim.RoundId)
		rec := f.reportEvent(t, claim.RoundId, startedEvent("k", 1, eventOccurredAt, eventReference))
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
			t.Fatalf("replay after the epoch moved and the Round ended: status=%d body=%s, want 200 original", rec.Code, rec.Body.String())
		}
		rec = f.reportEvent(t, claim.RoundId, startedEvent("k", 1, eventOccurredAt, "controlled:other"))
		assertErrorBody(t, rec, http.StatusConflict, idempotencyKeyConflictCode, idempotencyKeyConflictMessage)
	})
	t.Run("the epoch check precedes the open and ordering checks", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Ladder")
		f.startRound(t, claim, "k")
		assertErrorBody(t, f.reportEvent(t, claim.RoundId, startedEvent("new", 9, eventOccurredAt, eventReference)), http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
		f.deliverThroughAPI(t, claim.RoundId)
		assertErrorBody(t, f.reportEvent(t, claim.RoundId, startedEvent("new", 9, eventOccurredAt, eventReference)), http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
	})
	t.Run("a Round that is not open precedes the ordering check", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Ladder")
		f.deliverThroughAPI(t, claim.RoundId)
		assertErrorBody(t, f.reportEvent(t, claim.RoundId, startedEvent("new", 1, eventOccurredAt, eventReference)), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
	})
	t.Run("authentication precedes the Round lookup", func(t *testing.T) {
		f := newClaimFixture(t)
		rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/rounds/" + uuid.NewString() + "/events", body: startedEvent("k", 1, eventOccurredAt, eventReference)})
		assertUnauthenticated(t, rec)
	})
	t.Run("the identifier is checked before the body, and the body before the Round lookup", func(t *testing.T) {
		f := newClaimFixture(t)
		assertRoundNotFound(t, f.reportEvent(t, "not-a-uuid", `{`))
		assertInvalidRequest(t, f.reportEvent(t, uuid.NewString(), `{`))
	})
}

func TestRoundEvent_RunnerAuthentication(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.claimTicket(t, "Auth")
	path := "/api/runner/rounds/" + claim.RoundId + "/events"
	body := startedEvent("k", 1, eventOccurredAt, eventReference)
	before := databaseSnapshot(t, f.pool)

	for name, call := range map[string]struct {
		authorization []string
		cookie        *http.Cookie
	}{
		"no header":                      {},
		"an unknown token":               {authorization: []string{"Bearer tir_" + strings.Repeat("Z", 43)}},
		"a malformed token":              {authorization: []string{"Bearer not-a-token"}},
		"a non-Bearer scheme":            {authorization: []string{"Basic " + f.token}},
		"a Bearer scheme with no token":  {authorization: []string{"Bearer"}},
		"two Authorization headers":      {authorization: []string{"Bearer " + f.token, "Bearer " + f.token}},
		"a session cookie":               {cookie: f.cookie},
		"a cookie beside a valid bearer": {authorization: []string{"Bearer " + f.token}, cookie: f.cookie},
	} {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		for _, value := range call.authorization {
			req.Header.Add("Authorization", value)
		}
		if call.cookie != nil {
			req.AddCookie(call.cookie)
		}
		rec := httptest.NewRecorder()
		f.handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status=%d body=%s, want 401", name, rec.Code, rec.Body.String())
		}
		assertUnauthenticated(t, rec)
	}
	assertSnapshotUnchanged(t, f.pool, before, "unauthenticated events")

	revoked := f.token
	f.token = f.pair(t).Token
	afterRepair := databaseSnapshot(t, f.pool)
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: path, body: body, token: revoked}))
	assertSnapshotUnchanged(t, f.pool, afterRepair, "an event with a revoked credential")
	if n := tableRowCount(t, f.pool, "round_events"); n != 0 {
		t.Fatalf("round_events rows = %d, want none from rejected credentials", n)
	}
}

func TestRoundEvent_IsAcceptedFromARunnerThatIsNotConnectedAndIsNotAHeartbeat(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.claimTicket(t, "Late event")
	seenBefore := f.health(t).LastSeenAt

	f.clock.Set(runnerEpoch.Add(2 * runnerHealthWindow))
	if got := f.health(t); got.State != RunnerDisconnected {
		t.Fatalf("health = %+v, want disconnected", got)
	}
	rec := f.reportEvent(t, claim.RoundId, startedEvent("k", 1, eventOccurredAt, eventReference))
	if rec.Code != http.StatusCreated {
		t.Fatalf("event from a disconnected runner: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
	got := f.health(t)
	if got.State != RunnerDisconnected || got.LastSeenAt == nil || seenBefore == nil || !got.LastSeenAt.Equal(*seenBefore) {
		t.Fatalf("health after the event = %+v, want still disconnected with last seen %v: an event is not a heartbeat", got, seenBefore)
	}
	rec = f.reportEvent(t, claim.RoundId, startedEvent("k", 1, eventOccurredAt, eventReference))
	if rec.Code != http.StatusOK {
		t.Fatalf("replay from a disconnected runner: status=%d, want 200", rec.Code)
	}
	if got := f.health(t); got.LastSeenAt == nil || !got.LastSeenAt.Equal(*seenBefore) {
		t.Fatalf("a replay moved last seen to %v", got.LastSeenAt)
	}
}

func TestRoundEvent_StrictDecodeRejectsMalformedRequestsWithNoStateChange(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.claimTicket(t, "Strict")
	before := databaseSnapshot(t, f.pool)

	valid := map[string]any{"type": "execution_started", "idempotencyKey": "k", "claimEpoch": 1, "occurredAt": eventOccurredAt, "data": map[string]any{"engineReference": eventReference}}
	with := func(key string, value any) string {
		m := map[string]any{}
		for k, v := range valid {
			m[k] = v
		}
		if value == nil {
			delete(m, key)
		} else {
			m[key] = value
		}
		out, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	raw := func(key, literal string) string {
		m := with(key, "placeholder")
		return strings.Replace(m, `"placeholder"`, literal, 1)
	}
	dataWith := func(engineReference any) string {
		return with("data", map[string]any{"engineReference": engineReference})
	}

	cases := map[string]string{
		"an empty body":                ``,
		"a JSON null":                  `null`,
		"an array":                     `[]`,
		"a truncated object":           `{"type":`,
		"two documents":                with("type", "execution_started") + ` {}`,
		"an unknown top-level field":   strings.TrimSuffix(with("type", "execution_started"), "}") + `,"extra":1}`,
		"an unknown data field":        with("data", map[string]any{"engineReference": eventReference, "extra": 1}),
		"data without engineReference": with("data", map[string]any{}),
		"data with another key only":   with("data", map[string]any{"session": "x"}),
		"data null":                    raw("data", "null"),
		"data an array":                raw("data", "[]"),
		"data a string":                raw("data", `"controlled:x"`),
		"data a number":                raw("data", "5"),
		"engineReference empty":        dataWith(""),
		"engineReference null":         raw("data", `{"engineReference":null}`),
		"engineReference a number":     dataWith(5),
		"engineReference too long":     dataWith(strings.Repeat("r", 201)),
		"engineReference control char": dataWith("controlled:\x07"),
		"engineReference newline":      dataWith("controlled:\nx"),
		"an unknown type":              with("type", "usage"),
		"delivered with started data":  with("type", "delivered"),
		"a wrongly cased type":         with("type", "EXECUTION_STARTED"),
		"an empty type":                with("type", ""),
		"a numeric type":               with("type", 5),
		"a missing type":               with("type", nil),
		"a missing idempotencyKey":     with("idempotencyKey", nil),
		"an empty idempotencyKey":      with("idempotencyKey", ""),
		"an idempotencyKey too long":   with("idempotencyKey", strings.Repeat("k", 201)),
		"an idempotencyKey with a tab": with("idempotencyKey", "a\tb"),
		"an idempotencyKey with a NUL": with("idempotencyKey", "a\x00b"),
		"an idempotencyKey with a DEL": with("idempotencyKey", "a\x7fb"),
		"an idempotencyKey a number":   with("idempotencyKey", 5),
		"a missing claimEpoch":         with("claimEpoch", nil),
		"claimEpoch zero":              with("claimEpoch", 0),
		"claimEpoch negative":          with("claimEpoch", -1),
		"claimEpoch fractional":        raw("claimEpoch", "1.5"),
		"claimEpoch exponent":          raw("claimEpoch", "1e0"),
		"claimEpoch a string":          with("claimEpoch", "1"),
		"claimEpoch a boolean":         with("claimEpoch", true),
		"claimEpoch beyond int32":      with("claimEpoch", 2147483648),
		"a missing occurredAt":         with("occurredAt", nil),
		"occurredAt empty":             with("occurredAt", ""),
		"occurredAt a word":            with("occurredAt", "yesterday"),
		"occurredAt a date":            with("occurredAt", "2026-10-01"),
		"occurredAt with a space":      with("occurredAt", "2026-10-01 12:00:00Z"),
		"occurredAt without a zone":    with("occurredAt", "2026-10-01T12:00:00"),
		"occurredAt a number":          with("occurredAt", 1759320000),
		"a missing data":               with("data", nil),
		"a null top-level value":       raw("claimEpoch", "null"),
	}
	for name, body := range cases {
		assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, body))
		assertSnapshotUnchanged(t, f.pool, before, name)
	}

	// The valid neighbours of the rejected forms are accepted, so the matrix tests the forms it names.
	rec := f.reportEvent(t, claim.RoundId, startedEvent(strings.Repeat("k", 200), 1, eventOccurredAt, strings.Repeat("r", 200)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("200-character key and reference: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
}

func TestRoundEvent_TheKeyIsStoredVerbatim(t *testing.T) {
	for _, key := range []string{" leading and trailing ", "é/ü:1 "} {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Verbatim")
		f.startRound(t, claim, key)
		var stored string
		if err := f.pool.QueryRow(context.Background(), `SELECT idempotency_key FROM round_events`).Scan(&stored); err != nil || stored != key {
			t.Fatalf("stored key %q (%v), want %q verbatim", stored, err, key)
		}
		rec := f.reportEvent(t, claim.RoundId, startedEvent(strings.TrimSpace(key), 1, eventOccurredAt, eventReference))
		assertErrorBody(t, rec, http.StatusConflict, eventOutOfOrderCode, eventOutOfOrderMessage(RoundEventExecutionStarted, RoundRunning))
	}
}

func TestRoundEvent_ConcurrentIdenticalEventsApplyExactlyOnce(t *testing.T) {
	const senders = 24
	for trial := range 3 {
		f := newClaimFixture(t)
		queued, claim := f.claimTicket(t, "Same event")
		body := startedEvent("round:0", 1, eventOccurredAt, eventReference)
		codes, bodies := sendConcurrently(senders, func(int) *httptest.ResponseRecorder { return f.reportEvent(t, claim.RoundId, body) })

		created, replayed := 0, 0
		var original string
		for i, code := range codes {
			switch code {
			case http.StatusCreated:
				created++
				original = bodies[i]
			case http.StatusOK:
				replayed++
			default:
				t.Fatalf("trial %d sender %d: status=%d body=%s", trial, i, code, bodies[i])
			}
		}
		if created != 1 || replayed != senders-1 {
			t.Fatalf("trial %d: %d created, %d replayed; want 1 and %d", trial, created, replayed, senders-1)
		}
		for i, code := range codes {
			if code == http.StatusOK && bodies[i] != original {
				t.Fatalf("trial %d: replay body %s differs from the original %s", trial, bodies[i], original)
			}
		}
		if events, references := tableRowCount(t, f.pool, "round_events"), tableRowCount(t, f.pool, "round_engine_references"); events != 1 || references != 1 {
			t.Fatalf("trial %d: %d events and %d references, want 1 and 1", trial, events, references)
		}
		if got := f.ticket(t, queued.Id); got.Status != InProgress || got.OpenRound == nil || got.OpenRound.State != OpenRoundRunning {
			t.Fatalf("trial %d: Ticket = %s %+v", trial, got.Status, got.OpenRound)
		}
	}
}

func TestRoundEvent_ConcurrentEventsWithDifferentKeysStartTheRoundOnce(t *testing.T) {
	const senders = 24
	for trial := range 3 {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Different keys")
		codes, bodies := sendConcurrently(senders, func(i int) *httptest.ResponseRecorder {
			return f.reportEvent(t, claim.RoundId, startedEvent(fmt.Sprintf("key-%d", i), 1, eventOccurredAt, fmt.Sprintf("controlled:%d", i)))
		})
		created, outOfOrder := 0, 0
		for i, code := range codes {
			switch code {
			case http.StatusCreated:
				created++
			case http.StatusConflict:
				assertErrorBody(t, &httptest.ResponseRecorder{Code: code, Body: bytes.NewBufferString(bodies[i])}, http.StatusConflict, eventOutOfOrderCode, eventOutOfOrderMessage(RoundEventExecutionStarted, RoundRunning))
				outOfOrder++
			default:
				t.Fatalf("trial %d sender %d: status=%d body=%s", trial, i, code, bodies[i])
			}
		}
		if created != 1 || outOfOrder != senders-1 {
			t.Fatalf("trial %d: %d created, %d out of order; want 1 and %d", trial, created, outOfOrder, senders-1)
		}
		var current int
		if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM round_engine_references WHERE is_current`).Scan(&current); err != nil || current != 1 {
			t.Fatalf("trial %d: %d current references (%v)", trial, current, err)
		}
		if events, references := tableRowCount(t, f.pool, "round_events"), tableRowCount(t, f.pool, "round_engine_references"); events != 1 || references != 1 {
			t.Fatalf("trial %d: %d events and %d references, want 1 and 1", trial, events, references)
		}
	}
}

func sendConcurrently(n int, send func(i int) *httptest.ResponseRecorder) ([]int, []string) {
	codes := make([]int, n)
	bodies := make([]string, n)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			rec := send(i)
			codes[i], bodies[i] = rec.Code, rec.Body.String()
		}()
	}
	close(start)
	wg.Wait()
	return codes, bodies
}

func TestRoundEvent_RacingTheOwnersCommandsNeitherDeadlocksNorLeavesInconsistentState(t *testing.T) {
	for trial := range 6 {
		f := newClaimFixture(t)
		queued, claim := f.claimTicket(t, "Racing")
		other := f.queue(t, "Other")
		third := f.queue(t, "Third")

		done := make(chan struct{})
		var startRec, archiveRec, reorderRec, claimRec, statusRec, editRec *httptest.ResponseRecorder
		go func() {
			defer close(done)
			start := make(chan struct{})
			var wg sync.WaitGroup
			run := func(target **httptest.ResponseRecorder, do func() *httptest.ResponseRecorder) {
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					*target = do()
				}()
			}
			run(&startRec, func() *httptest.ResponseRecorder {
				return f.reportEvent(t, claim.RoundId, startedEvent("k", 1, eventOccurredAt, eventReference))
			})
			run(&archiveRec, func() *httptest.ResponseRecorder { return f.archive(t, queued.Id) })
			run(&reorderRec, func() *httptest.ResponseRecorder {
				return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + third.Id + "/position", body: fmt.Sprintf(`{"before":%q}`, other.Id), cookie: f.cookie})
			})
			run(&claimRec, func() *httptest.ResponseRecorder { return f.claim(t) })
			run(&statusRec, func() *httptest.ResponseRecorder {
				return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/status", body: `{"status":"Backlog"}`, cookie: f.cookie})
			})
			run(&editRec, func() *httptest.ResponseRecorder {
				return f.do(t, runnerCall{method: http.MethodPatch, path: "/api/tickets/" + queued.Id, body: `{"title":"renamed"}`, cookie: f.cookie})
			})
			close(start)
			wg.Wait()
		}()
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			t.Fatalf("trial %d: the racing requests did not finish within 20 s (deadlock)", trial)
		}

		if startRec.Code != http.StatusCreated {
			t.Fatalf("trial %d: start: status=%d body=%s", trial, startRec.Code, startRec.Body.String())
		}
		for name, rec := range map[string]*httptest.ResponseRecorder{"archive": archiveRec, "status change": statusRec, "edit": editRec} {
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("trial %d: %s: status=%d body=%s, want 400 round_open", trial, name, rec.Code, rec.Body.String())
			}
			assertErrorCode(t, rec, roundOpenCode)
		}
		assertNoWork(t, claimRec)
		if reorderRec.Code != http.StatusOK && reorderRec.Code != http.StatusBadRequest {
			t.Fatalf("trial %d: reorder: status=%d body=%s", trial, reorderRec.Code, reorderRec.Body.String())
		}
		got := f.ticket(t, queued.Id)
		if got.Status != InProgress || got.ArchivedAt != nil || got.Title != "Racing" || got.OpenRound == nil || got.OpenRound.State != OpenRoundRunning || got.OpenRound.Id != claim.RoundId {
			t.Fatalf("trial %d: Ticket = %s %+v archived=%v title=%q", trial, got.Status, got.OpenRound, got.ArchivedAt, got.Title)
		}
		if events, references, rounds := tableRowCount(t, f.pool, "round_events"), tableRowCount(t, f.pool, "round_engine_references"), len(roundRows(t, f.pool)); events != 1 || references != 1 || rounds != 1 {
			t.Fatalf("trial %d: %d events, %d references, %d Rounds; want 1, 1, 1", trial, events, references, rounds)
		}
	}
}

func TestRoundEvent_OnlyAnExecutionStartedEventMovesAnAgentTicketToInProgress(t *testing.T) {
	f := newClaimFixture(t)
	first := f.queue(t, "First")
	second := f.queue(t, "Second")
	inProgress := `{"status":"InProgress"}`
	post := func(id string) *httptest.ResponseRecorder {
		return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/status", body: inProgress, cookie: f.cookie})
	}

	rec := post(second.Id)
	assertErrorCode(t, rec, agentOwnedTransitionCode)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("Ready -> In Progress with no Round: status=%d", rec.Code)
	}
	claim := f.mustClaim(t)
	before := databaseSnapshot(t, f.pool)
	rec = post(claim.Ticket.Id)
	assertErrorCode(t, rec, roundOpenCode)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("Ready -> In Progress with a claimed Round: status=%d", rec.Code)
	}
	assertSnapshotUnchanged(t, f.pool, before, "a direct move to In Progress")

	f.startRound(t, claim, "k")
	if got := f.ticket(t, claim.Ticket.Id); got.Status != InProgress {
		t.Fatalf("Ticket after the event = %s", got.Status)
	}
	if first.Id != claim.Ticket.Id {
		t.Fatalf("claimed %s, want %s", claim.Ticket.Id, first.Id)
	}
	for _, request := range []runnerCall{
		{method: http.MethodPost, path: "/api/runner/rounds/" + claim.RoundId + "/events", cookie: f.cookie, body: startedEvent("x", 1, eventOccurredAt, eventReference)},
		{method: http.MethodPost, path: "/api/tickets/" + second.Id + "/status", cookie: f.cookie, body: `{"status":"Backlog"}`},
		{method: http.MethodPost, path: "/api/tickets/" + second.Id + "/status", cookie: f.cookie, body: `{"status":"Ready"}`},
		{method: http.MethodPut, path: "/api/tickets/" + second.Id + "/assignee", cookie: f.cookie, body: `{"type":"owner"}`},
		{method: http.MethodPost, path: "/api/tickets/" + second.Id + "/status", cookie: f.cookie, body: inProgress},
	} {
		f.do(t, request)
	}
	if events, references := tableRowCount(t, f.pool, "round_events"), tableRowCount(t, f.pool, "round_engine_references"); events != 1 || references != 1 {
		t.Fatalf("Owner routes left %d events and %d references, want the one from the runner's event", events, references)
	}
}

func TestEngineReferences_AtMostOneIsCurrentAndThePriorIsRetained(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.claimTicket(t, "References")
	f.startRound(t, claim, "k")
	ctx := context.Background()

	_, err := f.pool.Exec(ctx, `INSERT INTO round_engine_references (owner_id, round_id, reference, is_current, attached_at)
		SELECT owner_id, id, 'controlled:second', true, now() FROM rounds`)
	if err == nil || !strings.Contains(err.Error(), "round_engine_references_one_current_per_round") {
		t.Fatalf("a second current reference: err = %v, want a round_engine_references_one_current_per_round violation", err)
	}

	var ownerID, roundRowID int64
	if err := f.pool.QueryRow(ctx, `SELECT owner_id, id FROM rounds`).Scan(&ownerID, &roundRowID); err != nil {
		t.Fatal(err)
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	attachedAt := runnerEpoch.Add(time.Minute)
	if err := attachEngineReference(ctx, tx, ownerID, roundRowID, "controlled:second", attachedAt); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	rows, err := f.pool.Query(ctx, `SELECT reference, is_current, attached_at FROM round_engine_references ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type reference struct {
		reference string
		current   bool
		at        time.Time
	}
	var got []reference
	for rows.Next() {
		var r reference
		if err := rows.Scan(&r.reference, &r.current, &r.at); err != nil {
			t.Fatal(err)
		}
		got = append(got, r)
	}
	if len(got) != 2 || got[0].reference != eventReference || got[0].current || got[1].reference != "controlled:second" || !got[1].current || !got[1].at.Equal(attachedAt) {
		t.Fatalf("references = %+v, want the first retained and not current, the second current", got)
	}
	if got[0].reference == claim.RoundId || got[1].reference == claim.RoundId {
		t.Fatal("an engine reference equals the Round id: identities must stay separate (ADR 0002)")
	}
}

func TestRoundEvent_AFailureAfterTheTicketGuardRollsEverythingBack(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Rollback")
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `CREATE FUNCTION refuse_round_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
		CREATE TRIGGER refuse_round_events BEFORE INSERT ON round_events FOR EACH ROW EXECUTE FUNCTION refuse_round_events()`); err != nil {
		t.Fatal(err)
	}
	before := databaseSnapshot(t, f.pool)
	rec := f.reportEvent(t, claim.RoundId, startedEvent("k", 1, eventOccurredAt, eventReference))
	assertErrorBody(t, rec, http.StatusServiceUnavailable, "database_unavailable", "failed to record the event")
	assertSnapshotUnchanged(t, f.pool, before, "an event whose last write failed")
	if got := f.ticket(t, queued.Id); got.Status != Ready || got.OpenRound == nil || got.OpenRound.State != OpenRoundClaimed {
		t.Fatalf("Ticket = %s %+v, want Ready and claimed", got.Status, got.OpenRound)
	}
}

func TestRoundEvent_ABrokenTicketInvariantRecordsNothingAndAnswers500(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Broken invariant")
	var logs bytes.Buffer
	handler := NewHandlerWithClock(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), f.pool, testLogger(&logs), f.clock.Now)
	if _, err := f.pool.Exec(context.Background(), `UPDATE tickets SET status = 'Backlog' WHERE public_id = $1::uuid`, queued.Id); err != nil {
		t.Fatal(err)
	}
	before := databaseSnapshot(t, f.pool)

	req := httptest.NewRequest(http.MethodPost, "/api/runner/rounds/"+claim.RoundId+"/events", strings.NewReader(startedEvent("k", 1, eventOccurredAt, eventReference)))
	req.Header.Set("Authorization", "Bearer "+f.token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assertErrorBody(t, rec, http.StatusInternalServerError, "internal_error", "failed to record the event")
	assertSnapshotUnchanged(t, f.pool, before, "an event whose Ticket guard failed")
	var state string
	if err := f.pool.QueryRow(context.Background(), `SELECT state FROM rounds WHERE public_id = $1::uuid`, claim.RoundId).Scan(&state); err != nil || state != "claimed" {
		t.Fatalf("Round state = %q (%v), want claimed", state, err)
	}
	if !strings.Contains(logs.String(), claim.RoundId) || !strings.Contains(logs.String(), "ERROR") {
		t.Fatalf("the broken invariant was not logged with the Round id:\n%s", logs.String())
	}
}

func TestDecideRoundEvent(t *testing.T) {
	open := func(state RoundState, epoch int) lockedRound {
		return lockedRound{state: string(state), epoch: epoch, open: true}
	}
	stopping := func(state RoundState, epoch int) lockedRound {
		return lockedRound{state: string(state), epoch: epoch, open: true, stopRequested: true}
	}
	for name, tc := range map[string]struct {
		round     lockedRound
		eventType RoundEventType
		epoch     int
		wantCode  string
	}{
		"a claimed Round at its epoch":        {open(RoundClaimed, 3), RoundEventExecutionStarted, 3, ""},
		"an older epoch":                      {open(RoundClaimed, 3), RoundEventExecutionStarted, 2, staleClaimEpochCode},
		"a newer epoch":                       {open(RoundClaimed, 3), RoundEventExecutionStarted, 4, staleClaimEpochCode},
		"a wrong epoch beats an ended Round":  {lockedRound{state: "delivered", epoch: 3}, RoundEventExecutionStarted, 2, staleClaimEpochCode},
		"a wrong epoch beats the wrong state": {open(RoundRunning, 3), RoundEventExecutionStarted, 2, staleClaimEpochCode},
		"an ended Round":                      {lockedRound{state: "delivered", epoch: 3}, RoundEventExecutionStarted, 3, roundNotOpenCode},
		"a running Round":                     {open(RoundRunning, 3), RoundEventExecutionStarted, 3, eventOutOfOrderCode},
		"progress on a running Round":         {open(RoundRunning, 3), RoundEventProgress, 3, ""},
		"usage on a running Round":            {open(RoundRunning, 3), RoundEventUsageObserved, 3, ""},
		"progress on a claimed Round":         {open(RoundClaimed, 3), RoundEventProgress, 3, eventOutOfOrderCode},
		"usage on a claimed Round":            {open(RoundClaimed, 3), RoundEventUsageObserved, 3, eventOutOfOrderCode},
		"progress on an ended Round":          {lockedRound{state: "delivered", epoch: 3}, RoundEventProgress, 3, roundNotOpenCode},
		"usage at a stale epoch":              {open(RoundRunning, 3), RoundEventUsageObserved, 2, staleClaimEpochCode},
		"waiting for input takes no progress": {open("waiting_for_input", 3), RoundEventProgress, 3, eventOutOfOrderCode},
		"delivery of a running Round":         {open(RoundRunning, 3), RoundEventDelivered, 3, ""},
		"delivery of a claimed Round":         {open(RoundClaimed, 3), RoundEventDelivered, 3, eventOutOfOrderCode},
		"delivery while waiting for input":    {open("waiting_for_input", 3), RoundEventDelivered, 3, eventOutOfOrderCode},
		"delivery at a stale epoch":           {open(RoundRunning, 3), RoundEventDelivered, 4, staleClaimEpochCode},
		"a second delivery":                   {lockedRound{state: "delivered", epoch: 3}, RoundEventDelivered, 3, roundNotOpenCode},
		"a stop confirmation, claimed":        {stopping(RoundClaimed, 3), RoundEventStopConfirmed, 3, ""},
		"a stop confirmation, running":        {stopping(RoundRunning, 3), RoundEventStopConfirmed, 3, ""},
		"a stop confirmation without a Stop":  {open(RoundRunning, 3), RoundEventStopConfirmed, 3, stopNotRequestedCode},
		"a stale epoch beats a missing Stop":  {open(RoundRunning, 3), RoundEventStopConfirmed, 2, staleClaimEpochCode},
		"an ended Round beats a missing Stop": {lockedRound{state: "delivered", epoch: 3}, RoundEventStopConfirmed, 3, roundNotOpenCode},
		"a stop confirmation, stopped":        {lockedRound{state: "stopped", epoch: 3, stopRequested: true}, RoundEventStopConfirmed, 3, roundNotOpenCode},
		"a stop confirmation, stale epoch":    {stopping(RoundRunning, 3), RoundEventStopConfirmed, 4, staleClaimEpochCode},
		"waiting for input takes no stop":     {stopping("waiting_for_input", 3), RoundEventStopConfirmed, 3, eventOutOfOrderCode},
		"progress on a stopped Round":         {lockedRound{state: "stopped", epoch: 3, stopRequested: true}, RoundEventProgress, 3, roundNotOpenCode},
		"failed, running":                     {open(RoundRunning, 3), RoundEventFailed, 3, ""},
		"interrupted, running":                {open(RoundRunning, 3), RoundEventInterrupted, 3, ""},
		"failed, running and Stopping":        {stopping(RoundRunning, 3), RoundEventFailed, 3, ""},
		"interrupted, running and Stopping":   {stopping(RoundRunning, 3), RoundEventInterrupted, 3, ""},
		"failed, claimed":                     {open(RoundClaimed, 3), RoundEventFailed, 3, eventOutOfOrderCode},
		"interrupted, claimed":                {open(RoundClaimed, 3), RoundEventInterrupted, 3, eventOutOfOrderCode},
		"failed while waiting for input":      {open("waiting_for_input", 3), RoundEventFailed, 3, eventOutOfOrderCode},
		"interrupted while waiting for input": {open("waiting_for_input", 3), RoundEventInterrupted, 3, eventOutOfOrderCode},
		"failed at a stale epoch":             {open(RoundRunning, 3), RoundEventFailed, 2, staleClaimEpochCode},
		"interrupted at a stale epoch":        {open(RoundRunning, 3), RoundEventInterrupted, 4, staleClaimEpochCode},
		"a stale epoch beats a claimed Round": {open(RoundClaimed, 3), RoundEventInterrupted, 2, staleClaimEpochCode},
		"failed after delivery":               {lockedRound{state: "delivered", epoch: 3}, RoundEventFailed, 3, roundNotOpenCode},
		"interrupted after a failure":         {lockedRound{state: "failed", epoch: 3}, RoundEventInterrupted, 3, roundNotOpenCode},
		"failed after an interruption":        {lockedRound{state: "interrupted", epoch: 3}, RoundEventFailed, 3, roundNotOpenCode},
		"progress on a failed Round":          {lockedRound{state: "failed", epoch: 3}, RoundEventProgress, 3, roundNotOpenCode},
		"stop confirmation, interrupted":      {lockedRound{state: "interrupted", epoch: 3, stopRequested: true}, RoundEventStopConfirmed, 3, roundNotOpenCode},
	} {
		t.Run(name, func(t *testing.T) {
			got := decideRoundEvent(tc.round, tc.eventType, tc.epoch)
			switch {
			case tc.wantCode == "" && got != nil:
				t.Fatalf("rejected with %+v", got)
			case tc.wantCode != "" && (got == nil || got.code != tc.wantCode || got.status != http.StatusConflict):
				t.Fatalf("decision = %+v, want a 409 %s", got, tc.wantCode)
			}
		})
	}
}

func TestRoundEvent_TakesTheOwnersPriorityLockThenTheTicketRowThenTheRoundRow(t *testing.T) {
	type step struct {
		name, holds, blockedOn string
		lockedAfterwards       string
	}
	type eventCase struct {
		name    string
		running bool
		stopped bool
		body    func(t *testing.T) string
	}
	for _, event := range []eventCase{
		{"execution_started", false, false, func(*testing.T) string { return startedEvent("k", 1, eventOccurredAt, eventReference) }},
		{"progress", true, false, func(t *testing.T) string { return progressEvent(t, "k", 1, eventOccurredAt, "locked") }},
		{"usage_observed", true, false, func(t *testing.T) string { return usageEvent(t, observationA, 1, usageData(observationA)) }},
		{"delivered", true, false, func(t *testing.T) string { return deliveredEvent(t, "k", 1, standardDeliverable()) }},
		{"stop_confirmed", true, true, func(t *testing.T) string { return stopConfirmedEvent(t, "k", 1, stopEvidence) }},
		{"failed", true, false, func(t *testing.T) string { return blockedEndings[0].event(t, "k", 1, failedExplanation) }},
		{"interrupted", true, false, func(t *testing.T) string { return blockedEndings[1].event(t, "k", 1, interruptedEvidence) }},
	} {
		for _, tc := range []step{
			{"the Owner's priority lock comes first", "priority", "pg_advisory_xact_lock", `SELECT 1 FROM tickets WHERE public_id = $1::uuid FOR UPDATE NOWAIT`},
			{"the Ticket row comes before the Round row", "ticket", "FOR UPDATE", `SELECT 1 FROM rounds r JOIN tickets t ON t.id = r.ticket_id WHERE t.public_id = $1::uuid FOR UPDATE OF r NOWAIT`},
		} {
			t.Run(event.name+": "+tc.name, func(t *testing.T) {
				f := newClaimFixture(t)
				queued, claim := f.claimTicket(t, "Lock order")
				if event.running {
					f.startRound(t, claim, "start")
				}
				if event.stopped {
					f.mustStop(t, queued.Id)
				}
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
				result := make(chan *httptest.ResponseRecorder, 1)
				body := event.body(t)
				go func() {
					result <- f.reportEvent(t, claim.RoundId, body)
				}()
				waitForLockWaiter(t, f.pool, tc.blockedOn)

				probe, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := probe.Exec(ctx, tc.lockedAfterwards, queued.Id); err != nil {
					t.Fatalf("the event, still waiting, already holds the lock that must come after: %v", err)
				}
				_ = probe.Rollback(ctx)

				if err := holder.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				if rec := <-result; rec.Code != http.StatusCreated {
					t.Fatalf("status=%d body=%s, want 201 once the lock is released", rec.Code, rec.Body.String())
				}
			})
		}
	}
}
