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

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

const (
	deliveredBody       = "# Result\n\nThe cause is a stale cache.\n\n- Reproduced it\n- Wrote it up\n"
	deliveredSummary    = "Explained the stale cache and how to clear it."
	deliveredAssessment = "A written cause: met. The cause is named and shown."
)

func deliverableData(body, summary, assessment string) map[string]any {
	return map[string]any{"bodyMarkdown": body, "summary": summary, "criteriaAssessment": assessment}
}

func standardDeliverable() map[string]any {
	return deliverableData(deliveredBody, deliveredSummary, deliveredAssessment)
}

func deliveredEvent(t *testing.T, key string, epoch int, data map[string]any) string {
	t.Helper()
	return jsonText(t, map[string]any{"type": "delivered", "idempotencyKey": key, "claimEpoch": epoch, "occurredAt": eventOccurredAt, "data": data})
}

func standardDeliveredEvent(t *testing.T, claim RunnerClaim) string {
	t.Helper()
	return deliveredEvent(t, claim.RoundId+":9", claim.ClaimEpoch, standardDeliverable())
}

func (f *claimFixture) deliver(t *testing.T, claim RunnerClaim) *httptest.ResponseRecorder {
	t.Helper()
	return f.mustReport(t, claim.RoundId, standardDeliveredEvent(t, claim))
}

func wantDeliveredResult(roundID string, startedAt, endedAt time.Time) string {
	return fmt.Sprintf(`{"endedAt":%q,"roundId":%q,"startedAt":%q,"state":"delivered","type":"delivered"}`,
		endedAt.UTC().Format(time.RFC3339Nano), roundID, startedAt.UTC().Format(time.RFC3339Nano))
}

type deliverableRow struct {
	roundID, body, summary, assessment string
}

func deliverableRows(t *testing.T, f *claimFixture) []deliverableRow {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT r.public_id::text, d.body_markdown, d.summary, d.criteria_assessment
		FROM round_deliverables d JOIN rounds r ON r.id = d.round_id ORDER BY d.id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []deliverableRow
	for rows.Next() {
		var row deliverableRow
		if err := rows.Scan(&row.roundID, &row.body, &row.summary, &row.assessment); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	return out
}

func decodeTicketBody(t *testing.T, rec *httptest.ResponseRecorder) Ticket {
	t.Helper()
	var ticket Ticket
	if err := json.Unmarshal(rec.Body.Bytes(), &ticket); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return ticket
}

func roundStateAndEnd(t *testing.T, f *claimFixture, roundID string) (string, *time.Time) {
	t.Helper()
	var state string
	var endedAt *time.Time
	if err := f.pool.QueryRow(context.Background(), `SELECT state, ended_at FROM rounds WHERE public_id = $1::uuid`, roundID).Scan(&state, &endedAt); err != nil {
		t.Fatal(err)
	}
	return state, endedAt
}

func TestDelivered_MovesTheTicketToInReviewAndRetainsTheDeliverable(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Deliver me")
	before := readTicketRowFacts(t, f.pool, queued.Id)

	galleyNow := runnerEpoch.Add(42 * time.Second)
	f.clock.Set(galleyNow)
	rec := f.reportEvent(t, claim.RoundId, deliveredEvent(t, claim.RoundId+":9", 1, standardDeliverable()))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	if got, want := rec.Body.String(), wantDeliveredResult(claim.RoundId, runnerEpoch, galleyNow); got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}

	ticket := f.ticket(t, queued.Id)
	wantDelivery := &TicketDelivery{RoundId: claim.RoundId, Sequence: 1, Agent: claim.Agent, DeliveredAt: galleyNow}
	if ticket.Status != InReview || ticket.OpenRound != nil || ticket.RequestingAgentWork || !reflect.DeepEqual(ticket.Delivery, wantDelivery) {
		t.Fatalf("Ticket after delivery: status=%s openRound=%+v requestingAgentWork=%t delivery=%+v, want In Review, no open Round, %+v",
			ticket.Status, ticket.OpenRound, ticket.RequestingAgentWork, ticket.Delivery, wantDelivery)
	}
	after := readTicketRowFacts(t, f.pool, queued.Id)
	if after.status != string(InReview) || !after.updatedAt.After(before.updatedAt) || after.rank != before.rank || !reflect.DeepEqual(after.agentID, before.agentID) {
		t.Fatalf("Ticket row before %+v, after %+v: want In Review, a later updated_at, the same rank and Agent", before, after)
	}
	if state, endedAt := roundStateAndEnd(t, f, claim.RoundId); state != "delivered" || endedAt == nil || !endedAt.Equal(galleyNow) {
		t.Fatalf("Round = %s ended %v, want delivered at %v", state, endedAt, galleyNow)
	}
	if got, want := deliverableRows(t, f), []deliverableRow{{claim.RoundId, deliveredBody, deliveredSummary, deliveredAssessment}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("deliverables = %+v, want %+v", got, want)
	}
	var eventType, result string
	if err := f.pool.QueryRow(context.Background(), `SELECT type, result::text FROM round_events WHERE idempotency_key = $1`, claim.RoundId+":9").Scan(&eventType, &result); err != nil || eventType != "delivered" || !strings.Contains(result, `"state": "delivered"`) {
		t.Fatalf("stored event = %q %s (%v)", eventType, result, err)
	}

	round := f.roundOf(t, queued.Id)
	wantDeliverable := &RoundDeliverable{BodyMarkdown: deliveredBody, Summary: deliveredSummary, CriteriaAssessment: deliveredAssessment}
	if round.State != RoundDelivered || round.EndedAt == nil || !round.EndedAt.Equal(galleyNow) || !reflect.DeepEqual(round.Deliverable, wantDeliverable) {
		t.Fatalf("listed Round = %+v, want delivered at %v with %+v", round, galleyNow, wantDeliverable)
	}
}

func TestDelivered_EndedAtNeverPrecedesStartedAt(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Clock stepped back")
	f.clock.Set(runnerEpoch.Add(-time.Hour))
	rec := f.deliver(t, claim)
	if got, want := rec.Body.String(), wantDeliveredResult(claim.RoundId, runnerEpoch, runnerEpoch); got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
}

func TestDelivered_AFailureAtTheLastWriteRollsBackEveryChange(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Rollback")
	f.queue(t, "Waiting")
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `CREATE FUNCTION refuse_deliveries() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
		CREATE TRIGGER refuse_deliveries BEFORE INSERT ON round_events FOR EACH ROW WHEN (NEW.type = 'delivered') EXECUTE FUNCTION refuse_deliveries()`); err != nil {
		t.Fatal(err)
	}
	before := databaseSnapshot(t, f.pool)
	rec := f.reportEvent(t, claim.RoundId, deliveredEvent(t, "deliver", 1, standardDeliverable()))
	assertErrorBody(t, rec, http.StatusServiceUnavailable, "database_unavailable", roundEventFailedMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a delivery whose last write failed")
	if got := f.ticket(t, queued.Id); got.Status != InProgress || got.OpenRound == nil || got.OpenRound.State != OpenRoundRunning || got.Delivery != nil {
		t.Fatalf("Ticket = %s %+v %+v, want In Progress, running, no delivery", got.Status, got.OpenRound, got.Delivery)
	}
	assertNoWork(t, f.claim(t))
}

func TestDelivered_ABrokenTicketInvariantRecordsNothingAndAnswers500(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Broken invariant")
	var logs bytes.Buffer
	handler := NewHandlerWithClock(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), f.pool, testLogger(&logs), f.clock.Now)
	if _, err := f.pool.Exec(context.Background(), `UPDATE tickets SET status = 'Blocked' WHERE public_id = $1::uuid`, queued.Id); err != nil {
		t.Fatal(err)
	}
	before := databaseSnapshot(t, f.pool)

	req := httptest.NewRequest(http.MethodPost, "/api/runner/rounds/"+claim.RoundId+"/events", strings.NewReader(deliveredEvent(t, "deliver", 1, standardDeliverable())))
	req.Header.Set("Authorization", "Bearer "+f.token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assertErrorBody(t, rec, http.StatusInternalServerError, "internal_error", roundEventFailedMessage)
	assertSnapshotUnchanged(t, f.pool, before, "a delivery whose Ticket guard failed")
	if state, _ := roundStateAndEnd(t, f, claim.RoundId); state != "running" {
		t.Fatalf("Round state = %s, want running", state)
	}
	if out := logs.String(); !strings.Contains(out, claim.RoundId) || !strings.Contains(out, "ERROR") || !strings.Contains(out, "not In Progress") {
		t.Fatalf("the broken invariant was not logged with the Round id:\n%s", out)
	}
}

func TestDelivered_ReplayReturnsTheOriginalResultAndRetainsOneDeliverable(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Replay")
	next := f.queue(t, "Next")
	key := claim.RoundId + ":9"
	body := deliveredEvent(t, key, 1, standardDeliverable())
	first := f.mustReport(t, claim.RoundId, body)

	before := databaseSnapshot(t, f.pool)
	sameInstantOtherZone := jsonText(t, map[string]any{"type": "delivered", "idempotencyKey": key, "claimEpoch": 1, "occurredAt": "2026-01-02T11:04:05.123456+08:00", "data": standardDeliverable()})
	for _, replay := range []string{body, sameInstantOtherZone} {
		rec := f.reportEvent(t, claim.RoundId, replay)
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
			t.Fatalf("replay: status=%d body=%s, want 200 %s", rec.Code, rec.Body.String(), first.Body.String())
		}
	}
	assertSnapshotUnchanged(t, f.pool, before, "a replayed delivery")

	nextClaim := f.mustClaim(t)
	if nextClaim.Ticket.Id != next.Id {
		t.Fatalf("the freed slot went to %s, want %s", nextClaim.Ticket.Id, next.Id)
	}
	f.startRound(t, nextClaim, nextClaim.RoundId+":0")
	rec := f.reportEvent(t, claim.RoundId, body)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replay after the slot was reused: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rows := deliverableRows(t, f); len(rows) != 1 || rows[0].roundID != claim.RoundId {
		t.Fatalf("deliverables = %+v, want only the first Round's", rows)
	}

	reused := databaseSnapshot(t, f.pool)
	changed := deliveredEvent(t, key, 1, deliverableData("A different body", deliveredSummary, deliveredAssessment))
	assertErrorBody(t, f.reportEvent(t, claim.RoundId, changed), http.StatusConflict, idempotencyKeyConflictCode, idempotencyKeyConflictMessage)
	assertErrorBody(t, f.reportEvent(t, claim.RoundId, deliveredEvent(t, "another key", 1, standardDeliverable())), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
	assertSnapshotUnchanged(t, f.pool, reused, "a conflicting or late delivery")
	if got := f.ticket(t, queued.Id); got.Status != InReview {
		t.Fatalf("the delivered Ticket = %s, want In Review", got.Status)
	}
	if got := f.ticket(t, next.Id); got.Status != InProgress || got.OpenRound == nil || got.OpenRound.Id != nextClaim.RoundId {
		t.Fatalf("the next Ticket = %s %+v, want In Progress under its own Round", got.Status, got.OpenRound)
	}
}

func TestDelivered_ConcurrentDeliveriesApplyExactlyOnce(t *testing.T) {
	const senders = 16
	t.Run("the same event", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.runningRound(t, "Same delivery")
		body := deliveredEvent(t, "deliver", 1, standardDeliverable())
		codes, bodies := sendConcurrently(senders, func(int) *httptest.ResponseRecorder { return f.reportEvent(t, claim.RoundId, body) })
		created := 0
		var original string
		for i, code := range codes {
			switch code {
			case http.StatusCreated:
				created++
				original = bodies[i]
			case http.StatusOK:
			default:
				t.Fatalf("sender %d: status=%d body=%s", i, code, bodies[i])
			}
		}
		for i, code := range codes {
			if code == http.StatusOK && bodies[i] != original {
				t.Fatalf("replay %s differs from %s", bodies[i], original)
			}
		}
		if created != 1 || len(deliverableRows(t, f)) != 1 {
			t.Fatalf("%d created and %d deliverables, want 1 and 1", created, len(deliverableRows(t, f)))
		}
	})
	t.Run("different keys", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.runningRound(t, "Different deliveries")
		codes, bodies := sendConcurrently(senders, func(i int) *httptest.ResponseRecorder {
			return f.reportEvent(t, claim.RoundId, deliveredEvent(t, fmt.Sprintf("deliver-%d", i), 1, deliverableData(fmt.Sprintf("Body %d", i), deliveredSummary, deliveredAssessment)))
		})
		created, notOpen := 0, 0
		for i, code := range codes {
			switch code {
			case http.StatusCreated:
				created++
			case http.StatusConflict:
				assertErrorBody(t, &httptest.ResponseRecorder{Code: code, Body: bytes.NewBufferString(bodies[i])}, http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
				notOpen++
			default:
				t.Fatalf("sender %d: status=%d body=%s", i, code, bodies[i])
			}
		}
		if created != 1 || notOpen != senders-1 || len(deliverableRows(t, f)) != 1 {
			t.Fatalf("%d created, %d not open, %d deliverables; want 1, %d, 1", created, notOpen, len(deliverableRows(t, f)), senders-1)
		}
	})
}

func TestDelivered_RejectionsChangeNothing(t *testing.T) {
	t.Run("a claimed Round", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.claimTicket(t, "Not started")
		before := databaseSnapshot(t, f.pool)
		body := deliveredEvent(t, "deliver", 1, standardDeliverable())
		assertErrorBody(t, f.reportEvent(t, claim.RoundId, body), http.StatusConflict, eventOutOfOrderCode, eventOutOfOrderMessage(RoundEventDelivered, RoundClaimed))
		assertSnapshotUnchanged(t, f.pool, before, "a delivery on a claimed Round")
		f.startRound(t, claim, "start")
		f.mustReport(t, claim.RoundId, body)
	})
	t.Run("a stale claim epoch", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.runningRound(t, "Stale")
		if _, err := f.pool.Exec(context.Background(), `UPDATE rounds SET claim_epoch = 2`); err != nil {
			t.Fatal(err)
		}
		before := databaseSnapshot(t, f.pool)
		for _, epoch := range []int{1, 3} {
			assertErrorBody(t, f.reportEvent(t, claim.RoundId, deliveredEvent(t, "deliver", epoch, standardDeliverable())), http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
		}
		assertSnapshotUnchanged(t, f.pool, before, "a delivery at a stale epoch")
		f.mustReport(t, claim.RoundId, deliveredEvent(t, "deliver", 2, standardDeliverable()))
	})
	t.Run("a delivered Round", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.runningRound(t, "Twice")
		f.deliver(t, claim)
		before := databaseSnapshot(t, f.pool)
		for _, body := range []string{
			deliveredEvent(t, "second delivery", 1, standardDeliverable()),
			progressEvent(t, "late note", 1, eventOccurredAt, "late"),
			usageEvent(t, observationA, 1, usageData(observationA)),
		} {
			assertErrorBody(t, f.reportEvent(t, claim.RoundId, body), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
		}
		assertSnapshotUnchanged(t, f.pool, before, "an event after delivery")
	})
	t.Run("unknown, foreign and malformed Rounds", func(t *testing.T) {
		f := newClaimFixture(t)
		queued, _ := f.runningRound(t, "Mine")
		foreignCookie, _ := secondOwnerSession(t, f.pool)
		foreign := &claimFixture{runnerFixture: f.runnerFixture}
		foreign.cookie = foreignCookie
		foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
		foreign.token = foreign.pair(t).Token
		foreign.register(t, foreign.token, http.StatusOK)
		_, theirs := foreign.runningRound(t, "Theirs")

		before := databaseSnapshot(t, f.pool)
		body := deliveredEvent(t, "deliver", 1, standardDeliverable())
		for _, roundID := range []string{uuid.NewString(), theirs.RoundId, strings.ToUpper(theirs.RoundId), "not-a-uuid", queued.Id, uuid.Nil.String()} {
			assertRoundNotFound(t, f.reportEvent(t, roundID, body))
		}
		assertSnapshotUnchanged(t, f.pool, before, "a delivery for a Round that is not the runner's")
	})
	t.Run("no runner credential", func(t *testing.T) {
		f := newClaimFixture(t)
		_, claim := f.runningRound(t, "Unauthenticated")
		path := "/api/runner/rounds/" + claim.RoundId + "/events"
		body := deliveredEvent(t, "deliver", 1, standardDeliverable())
		before := databaseSnapshot(t, f.pool)
		assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: path, body: body}))
		assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: path, body: body, cookie: f.cookie}))
		assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: path, body: body, cookie: f.cookie, token: f.token}))
		assertSnapshotUnchanged(t, f.pool, before, "an unauthenticated delivery")
		revoked := f.token
		f.token = f.pair(t).Token
		repaired := databaseSnapshot(t, f.pool)
		assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: path, body: body, token: revoked}))
		assertSnapshotUnchanged(t, f.pool, repaired, "a delivery with a revoked credential")
	})
}

func TestDelivered_DataLimitsAtTheAPI(t *testing.T) {
	const mib = 1 << 20
	f := newClaimFixture(t)
	running := func(t *testing.T) RunnerClaim {
		t.Helper()
		_, claim := f.runningRound(t, t.Name())
		return claim
	}
	claim := running(t)
	accept := map[string]map[string]any{
		"a body of exactly 1 MiB":                       deliverableData(strings.Repeat("a", mib), deliveredSummary, deliveredAssessment),
		"a body of exactly 1 MiB in two-byte runes":     deliverableData(strings.Repeat("é", mib/2), deliveredSummary, deliveredAssessment),
		"2000 summary and 10000 assessment code points": deliverableData(deliveredBody, strings.Repeat("é", 2000), strings.Repeat("😀", 10000)),
		"tabs and line feeds":                           deliverableData("a\tb\n", "a\tb\n", "a\tb\n"),
	}
	reject := map[string]any{
		"a body of 1 MiB + 1":                   deliverableData(strings.Repeat("a", mib+1), deliveredSummary, deliveredAssessment),
		"a body of 1 MiB + 1 in two-byte runes": deliverableData(strings.Repeat("é", mib/2)+"a", deliveredSummary, deliveredAssessment),
		"an empty body":                         deliverableData("", deliveredSummary, deliveredAssessment),
		"a blank body":                          deliverableData(" \n\t ", deliveredSummary, deliveredAssessment),
		"a body with a carriage return":         deliverableData("a\r\nb", deliveredSummary, deliveredAssessment),
		"a body with a NUL":                     deliverableData("a\x00b", deliveredSummary, deliveredAssessment),
		"a 2001-code-point summary":             deliverableData(deliveredBody, strings.Repeat("é", 2001), deliveredAssessment),
		"an empty summary":                      deliverableData(deliveredBody, "", deliveredAssessment),
		"a blank summary":                       deliverableData(deliveredBody, " ", deliveredAssessment),
		"a summary with an escape":              deliverableData(deliveredBody, "a\x1bb", deliveredAssessment),
		"a 10001-code-point assessment":         deliverableData(deliveredBody, deliveredSummary, strings.Repeat("a", 10001)),
		"an empty assessment":                   deliverableData(deliveredBody, deliveredSummary, ""),
		"a blank assessment":                    deliverableData(deliveredBody, deliveredSummary, "\n\n"),
		"an assessment with DEL":                deliverableData(deliveredBody, deliveredSummary, "a\x7fb"),
		"no assessment":                         map[string]any{"bodyMarkdown": deliveredBody, "summary": deliveredSummary},
		"an extra key":                          map[string]any{"bodyMarkdown": deliveredBody, "summary": deliveredSummary, "criteriaAssessment": deliveredAssessment, "pr": "x"},
		"a key in another case":                 map[string]any{"BodyMarkdown": deliveredBody, "summary": deliveredSummary, "criteriaAssessment": deliveredAssessment},
		"a null body":                           map[string]any{"bodyMarkdown": nil, "summary": deliveredSummary, "criteriaAssessment": deliveredAssessment},
		"a numeric summary":                     map[string]any{"bodyMarkdown": deliveredBody, "summary": 7, "criteriaAssessment": deliveredAssessment},
		"an array":                              []any{deliveredBody},
		"another type's data":                   map[string]any{"note": "a note"},
	}
	before := databaseSnapshot(t, f.pool)
	for name, data := range reject {
		rec := f.reportEvent(t, claim.RoundId, jsonText(t, map[string]any{"type": "delivered", "idempotencyKey": "k", "claimEpoch": 1, "occurredAt": eventOccurredAt, "data": data}))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d body=%.300s, want 400", name, rec.Code, rec.Body.String())
		}
		assertErrorCode(t, rec, "invalid_request")
	}
	assertSnapshotUnchanged(t, f.pool, before, "rejected deliveries")

	for name, data := range accept {
		rec := f.reportEvent(t, claim.RoundId, deliveredEvent(t, "k", 1, data))
		if rec.Code != http.StatusCreated {
			t.Fatalf("%s: status=%d body=%s, want 201", name, rec.Code, rec.Body.String())
		}
		claim = running(t)
	}
	var largest int
	if err := f.pool.QueryRow(context.Background(), `SELECT max(octet_length(body_markdown)) FROM round_deliverables`).Scan(&largest); err != nil || largest != mib {
		t.Fatalf("largest stored body = %d bytes (%v), want %d", largest, err, mib)
	}
}

func TestRoundEvent_RequestBodyIsCappedAt8MiB(t *testing.T) {
	const mib = 1 << 20
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Escaped")

	var escaped strings.Builder
	for range mib {
		escaped.WriteString(`a`)
	}
	fullyEscaped := fmt.Sprintf(`{"type":"delivered","idempotencyKey":"escaped","claimEpoch":1,"occurredAt":%q,"data":{"bodyMarkdown":"%s","summary":%q,"criteriaAssessment":%q}}`,
		eventOccurredAt, escaped.String(), deliveredSummary, deliveredAssessment)
	if rec := f.reportEvent(t, claim.RoundId, fullyEscaped); rec.Code != http.StatusCreated {
		t.Fatalf("a maximal body with every byte escaped (%d bytes): status=%d body=%s, want 201", len(fullyEscaped), rec.Code, rec.Body.String())
	}
	if rows := deliverableRows(t, f); len(rows) != 1 || rows[0].body != strings.Repeat("a", mib) {
		t.Fatal("the escaped body was not stored as its decoded text")
	}

	_, claim = f.runningRound(t, "At the cap")
	padded := func(size int) string {
		event := deliveredEvent(t, "padded", 1, standardDeliverable())
		return event[:len(event)-1] + strings.Repeat(" ", size-len(event)) + "}"
	}
	before := databaseSnapshot(t, f.pool)
	rec := f.reportEvent(t, claim.RoundId, padded(roundEventBodyMaxBytes+1))
	assertErrorBody(t, rec, http.StatusRequestEntityTooLarge, requestTooLargeCode, roundEventBodyTooLargeMessage)
	assertSnapshotUnchanged(t, f.pool, before, "an oversized request")
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/rounds/" + claim.RoundId + "/events", body: padded(roundEventBodyMaxBytes + 1)}))
	if rec := f.reportEvent(t, claim.RoundId, padded(roundEventBodyMaxBytes)); rec.Code != http.StatusCreated {
		t.Fatalf("a body of exactly 8 MiB: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
}

func TestRoundDeliverables_TheDatabaseEnforcesItsInvariants(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Invariants")
	ownerID, roundID := roundRowIDs(t, f, claim.RoundId)
	insert := func(body, summary, assessment string) error {
		_, err := f.pool.Exec(context.Background(), `INSERT INTO round_deliverables (owner_id, round_id, body_markdown, summary, criteria_assessment) VALUES ($1, $2, $3, $4, $5)`,
			ownerID, roundID, body, summary, assessment)
		return err
	}
	for constraint, values := range map[string][3]string{
		"round_deliverables_body_markdown_size":            {strings.Repeat("é", 1<<19) + "a", "s", "c"},
		"round_deliverables_summary_length":                {"b", strings.Repeat("a", 2001), "c"},
		"round_deliverables_criteria_assessment_length":    {"b", "s", strings.Repeat("a", 10001)},
		"round_deliverables_body_markdown_not_blank":       {" \n", "s", "c"},
		"round_deliverables_summary_not_blank":             {"b", "\t", "c"},
		"round_deliverables_criteria_assessment_not_blank": {"b", "s", "\r\n"},
	} {
		assertViolates(t, insert(values[0], values[1], values[2]), constraint)
	}
	_, err := f.pool.Exec(context.Background(), `INSERT INTO round_deliverables (owner_id, round_id, body_markdown, summary, criteria_assessment) VALUES ($1, $2, 'b', 's', 'c')`, ownerID+1, roundID)
	assertViolates(t, err, "round_deliverables_round_fk")
	if err := insert(strings.Repeat("é", 1<<19), "s", "c"); err != nil {
		t.Fatalf("a 1 MiB body: %v", err)
	}
	assertViolates(t, insert("b", "s", "c"), "round_deliverables_round_unique")
	_, err = f.pool.Exec(context.Background(), `INSERT INTO round_events (owner_id, round_id, idempotency_key, type, claim_epoch, occurred_at, received_at, payload_hash, result)
		VALUES ($1, $2, 'k', 'failed', 1, now(), now(), decode(repeat('00', 32), 'hex'), '{}')`, ownerID, roundID)
	assertViolates(t, err, "round_events_type_m5")
}

func TestDelivered_AcceptFollowsTheRetainedCompletionCondition(t *testing.T) {
	type completion struct {
		template  TicketTemplate
		kind      AgentKind
		wantCode  string
		wantFinal TicketStatus
	}
	for _, tc := range []completion{
		{Basic, AgentKindResearch, "", Done},
		{Coding, AgentKindCoding, reviewedPrMergeNotImplementedCode, InReview},
	} {
		t.Run(string(tc.template), func(t *testing.T) {
			f := newClaimFixture(t)
			agent := createAgentForTest(t, f.handler, f.cookie, "Worker", tc.kind)
			body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets",
				fmt.Sprintf(`{"title":"Deliverable","template":%q,"goal":"g","successCriteria":"s","repository":"owner/repo"}`, tc.template), http.StatusCreated)
			id := decodeAs[Ticket](t, body).Id
			badgeRequest(t, f.handler, f.cookie, http.MethodPut, "/api/tickets/"+id+"/assignee", assignAgentBody(agent.Id), http.StatusOK)
			badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+id+"/status", `{"status":"Ready"}`, http.StatusOK)
			claim := f.mustClaim(t)
			f.startRound(t, claim, "start")
			f.deliver(t, claim)

			ticket := f.ticket(t, id)
			if ticket.Status != InReview || ticket.OpenRound != nil {
				t.Fatalf("Ticket = %s %+v, want In Review and unlocked", ticket.Status, ticket.OpenRound)
			}
			advertised := ticket.AllowedActions
			agentOwned := []TicketStatusChangeRejection{{Status: InProgress, Reason: ErrorDetail{Code: agentOwnedTransitionCode, Message: "Execution sets In Progress on an Agent-assigned Ticket"}}}
			if len(advertised.StatusChanges) != 0 || !reflect.DeepEqual(advertised.StatusChangeRejections, agentOwned) {
				t.Fatalf("advertised status changes = %v, rejections %+v; want none and %+v", advertised.StatusChanges, advertised.StatusChangeRejections, agentOwned)
			}
			for _, target := range allTicketStatuses {
				rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/status", body: fmt.Sprintf(`{"status":%q}`, target), cookie: f.cookie})
				wantCode := invalidTransitionCode
				if target == InProgress {
					wantCode = agentOwnedTransitionCode
				}
				if rec.Code != http.StatusBadRequest || decodeErrorBody(t, rec).Error.Code != wantCode {
					t.Fatalf("In Review -> %s: status=%d body=%s, want 400 %s", target, rec.Code, rec.Body.String(), wantCode)
				}
			}
			if got := readTicketRowFacts(t, f.pool, id); got.status != string(InReview) {
				t.Fatalf("Status after the refused moves = %s", got.status)
			}

			rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/accept", cookie: f.cookie})
			if tc.wantCode == "" {
				if !advertised.Accept.Available || advertised.Accept.Reason != nil || rec.Code != http.StatusOK || decodeTicketBody(t, rec).Status != Done {
					t.Fatalf("Accept advertised %+v, command %d %s; want available and Done", advertised.Accept, rec.Code, rec.Body.String())
				}
			} else {
				if advertised.Accept.Available || advertised.Accept.Reason == nil || advertised.Accept.Reason.Code != tc.wantCode ||
					rec.Code != http.StatusBadRequest || !reflect.DeepEqual(decodeErrorBody(t, rec).Error, *advertised.Accept.Reason) {
					t.Fatalf("Accept advertised %+v, command %d %s; want refused with %s by both", advertised.Accept, rec.Code, rec.Body.String(), tc.wantCode)
				}
			}
			if got := readTicketRowFacts(t, f.pool, id); got.status != string(tc.wantFinal) {
				t.Fatalf("final Status = %s, want %s", got.status, tc.wantFinal)
			}
		})
	}
}

func TestDelivered_ReleasesTheOpenRoundLock(t *testing.T) {
	type mutation struct {
		name     string
		call     func(f *lockedTicketFixture) runnerCall
		wantCode string
	}
	ticketPath := func(f *lockedTicketFixture, suffix string) string { return "/api/tickets/" + f.locked.Id + suffix }
	patch := func(field string) func(f *lockedTicketFixture) runnerCall {
		return func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPatch, path: ticketPath(f, ""), body: fmt.Sprintf(`{%q:"changed after delivery"}`, field)}
		}
	}
	for _, m := range []mutation{
		{name: "title", call: patch("title")},
		{name: "goal", call: patch("goal")},
		{name: "successCriteria", call: patch("successCriteria")},
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
		{name: "Accept", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPost, path: ticketPath(f, "/accept")}
		}},
		{name: "a move back to Ready", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPost, path: ticketPath(f, "/status"), body: `{"status":"Ready"}`}
		}, wantCode: invalidTransitionCode},
		{name: "archive", call: func(f *lockedTicketFixture) runnerCall {
			return runnerCall{method: http.MethodPost, path: ticketPath(f, "/archive")}
		}},
	} {
		t.Run(m.name, func(t *testing.T) {
			f := newLockedTicketFixture(t)
			call := m.call(f)
			assertRoundOpen(t, f.validateContract(t, call), f.claim.RoundId)
			f.startRound(t, f.claim, "start")
			assertRoundOpen(t, f.validateContract(t, call), f.claim.RoundId)
			f.deliver(t, f.claim)
			rec := f.validateContract(t, call)
			switch {
			case m.wantCode == "" && rec.Code != http.StatusOK:
				t.Fatalf("%s after delivery: status=%d body=%s, want 200", m.name, rec.Code, rec.Body.String())
			case m.wantCode != "":
				if rec.Code != http.StatusBadRequest || decodeErrorBody(t, rec).Error.Code != m.wantCode {
					t.Fatalf("%s after delivery: status=%d body=%s, want 400 %s", m.name, rec.Code, rec.Body.String(), m.wantCode)
				}
			}
		})
	}
}

func TestDelivered_FreesTheSlotAndTheNextClaimFollowsPriority(t *testing.T) {
	f := newClaimFixture(t)
	first := f.queue(t, "First")
	second := f.queue(t, "Second")
	third := f.queue(t, "Third")
	f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + third.Id + "/position", body: fmt.Sprintf(`{"before":%q}`, second.Id), cookie: f.cookie}, http.StatusOK)

	claim := f.mustClaim(t)
	if claim.Ticket.Id != first.Id {
		t.Fatalf("first claim took %s, want %s", claim.Ticket.Id, first.Id)
	}
	assertNoWork(t, f.claim(t))
	f.startRound(t, claim, "start")
	assertNoWork(t, f.claim(t))
	f.reportEvent(t, claim.RoundId, progressEvent(t, "note", 1, eventOccurredAt, "working"))
	assertNoWork(t, f.claim(t))
	f.deliver(t, claim)

	next := f.mustClaim(t)
	if next.Ticket.Id != third.Id || next.Sequence != 1 {
		t.Fatalf("the claim after delivery took %s (Round %d), want %s, which the Owner ranked above %s", next.Ticket.Id, next.Sequence, third.Id, second.Id)
	}
	assertNoWork(t, f.claim(t))
	if got := f.ticket(t, first.Id); got.Status != InReview || got.RequestingAgentWork {
		t.Fatalf("the delivered Ticket = %s, requesting work %t; want In Review and not requesting", got.Status, got.RequestingAgentWork)
	}
}

func TestDelivered_ADoneTicketMovedBackToReadyIsQueuedForANewRound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Again")
	f.clock.Set(runnerEpoch.Add(time.Minute))
	f.register(t, f.token, http.StatusOK)
	f.deliver(t, claim)
	f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/accept", cookie: f.cookie}, http.StatusOK)
	body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+queued.Id+"/status", `{"status":"Ready"}`, http.StatusOK)
	if ready := decodeAs[Ticket](t, body); !ready.RequestingAgentWork || ready.Delivery == nil || ready.Delivery.RoundId != claim.RoundId {
		t.Fatalf("Done -> Ready = %+v, want requesting Agent work with the first delivery still latest", ready)
	}

	second := f.mustClaim(t)
	if second.Ticket.Id != queued.Id || second.Sequence != 2 {
		t.Fatalf("second claim = %+v, want Round 2 of %s", second, queued.Id)
	}
	if got := f.ticket(t, queued.Id); got.Delivery != nil {
		t.Fatalf("delivery while Round 2 is claimed = %+v, want null", got.Delivery)
	}
	rounds := decodeRounds(t, f.listRounds(t, queued.Id))
	if len(rounds) != 2 || rounds[0].Id != second.RoundId || rounds[0].State != RoundClaimed || rounds[0].Deliverable != nil ||
		rounds[1].Id != claim.RoundId || rounds[1].State != RoundDelivered || rounds[1].Deliverable == nil || rounds[1].Deliverable.BodyMarkdown != deliveredBody {
		t.Fatalf("rounds = %+v, want Round 2 claimed without a deliverable, then Round 1 delivered with it", rounds)
	}

	f.clock.Set(runnerEpoch.Add(2 * time.Minute))
	f.register(t, f.token, http.StatusOK)
	f.startRound(t, second, "start-2")
	f.mustReport(t, second.RoundId, deliveredEvent(t, "deliver-2", second.ClaimEpoch, deliverableData("Second result", "Second summary", "Second assessment")))
	got := f.ticket(t, queued.Id)
	if got.Status != InReview || got.Delivery == nil || got.Delivery.RoundId != second.RoundId || got.Delivery.Sequence != 2 || !got.Delivery.DeliveredAt.Equal(runnerEpoch.Add(2*time.Minute)) {
		t.Fatalf("Ticket after Round 2 delivered = %s %+v", got.Status, got.Delivery)
	}
	rounds = decodeRounds(t, f.listRounds(t, queued.Id))
	if rounds[0].Deliverable == nil || rounds[0].Deliverable.BodyMarkdown != "Second result" || rounds[1].Deliverable.BodyMarkdown != deliveredBody {
		t.Fatalf("each Round must carry its own deliverable: %+v", rounds)
	}
}

func TestDelivered_RacingAnOwnerCommandIsSerialisedEitherWay(t *testing.T) {
	type order struct {
		name       string
		first      string
		wantAccept int
		wantStatus TicketStatus
	}
	for _, o := range []order{
		{"Accept first: refused because the Round is open", "accept", http.StatusBadRequest, InReview},
		{"delivery first: Accept completes the Ticket", "deliver", http.StatusOK, Done},
	} {
		t.Run(o.name, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.runningRound(t, "Race")
			ctx := context.Background()
			holder, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = holder.Rollback(ctx) }()
			if _, err := holder.Exec(ctx, `SELECT 1 FROM tickets WHERE public_id = $1::uuid FOR UPDATE`, queued.Id); err != nil {
				t.Fatal(err)
			}
			acceptDone := make(chan *httptest.ResponseRecorder, 1)
			deliverDone := make(chan *httptest.ResponseRecorder, 1)
			accept := func() {
				acceptDone <- f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/accept", cookie: f.cookie})
			}
			deliver := func() {
				deliverDone <- f.reportEvent(t, claim.RoundId, deliveredEvent(t, "deliver", 1, standardDeliverable()))
			}
			if o.first == "accept" {
				go accept()
				waitForLockWaiter(t, f.pool, "FOR UPDATE")
				go deliver()
			} else {
				go deliver()
				waitForLockWaiter(t, f.pool, "FOR UPDATE")
				go accept()
			}
			waitForLockWaiter(t, f.pool, "pg_advisory_xact_lock")
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			acceptRec, deliverRec := <-acceptDone, <-deliverDone
			if deliverRec.Code != http.StatusCreated {
				t.Fatalf("delivery: status=%d body=%s", deliverRec.Code, deliverRec.Body.String())
			}
			if acceptRec.Code != o.wantAccept {
				t.Fatalf("Accept: status=%d body=%s, want %d", acceptRec.Code, acceptRec.Body.String(), o.wantAccept)
			}
			if o.wantAccept == http.StatusBadRequest {
				assertRoundOpen(t, acceptRec, claim.RoundId)
			}
			if got := f.ticket(t, queued.Id); got.Status != o.wantStatus || got.OpenRound != nil || got.Delivery == nil {
				t.Fatalf("Ticket = %s %+v %+v, want %s, unlocked and delivered", got.Status, got.OpenRound, got.Delivery, o.wantStatus)
			}
		})
	}
}

func TestDelivered_RacingTheOwnersCommandsNeitherDeadlocksNorLeavesInconsistentState(t *testing.T) {
	for trial := range 6 {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, "Racing")
		other := f.queue(t, "Other")

		var deliverRec, acceptRec, editRec, claimRec, reorderRec *httptest.ResponseRecorder
		done := make(chan struct{})
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
			run(&deliverRec, func() *httptest.ResponseRecorder {
				return f.reportEvent(t, claim.RoundId, deliveredEvent(t, "deliver", 1, standardDeliverable()))
			})
			run(&acceptRec, func() *httptest.ResponseRecorder {
				return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/accept", cookie: f.cookie})
			})
			run(&editRec, func() *httptest.ResponseRecorder {
				return f.do(t, runnerCall{method: http.MethodPatch, path: "/api/tickets/" + queued.Id, body: `{"title":"renamed"}`, cookie: f.cookie})
			})
			run(&claimRec, func() *httptest.ResponseRecorder { return f.claim(t) })
			run(&reorderRec, func() *httptest.ResponseRecorder {
				return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + other.Id + "/position", body: fmt.Sprintf(`{"before":%q}`, queued.Id), cookie: f.cookie})
			})
			close(start)
			wg.Wait()
		}()
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			t.Fatalf("trial %d: the racing requests did not finish within 20 s (deadlock)", trial)
		}

		if deliverRec.Code != http.StatusCreated {
			t.Fatalf("trial %d: delivery: status=%d body=%s", trial, deliverRec.Code, deliverRec.Body.String())
		}
		for _, rec := range []*httptest.ResponseRecorder{acceptRec, editRec} {
			if rec.Code != http.StatusOK {
				assertRoundOpen(t, rec, claim.RoundId)
			}
		}
		if reorderRec.Code >= http.StatusInternalServerError {
			t.Fatalf("trial %d: reorder: status=%d body=%s", trial, reorderRec.Code, reorderRec.Body.String())
		}
		got := f.ticket(t, queued.Id)
		wantStatus, wantTitle := InReview, "Racing"
		if acceptRec.Code == http.StatusOK {
			wantStatus = Done
		}
		if editRec.Code == http.StatusOK {
			wantTitle = "renamed"
		}
		if got.Status != wantStatus || got.Title != wantTitle || got.OpenRound != nil || got.Delivery == nil || got.Delivery.RoundId != claim.RoundId {
			t.Fatalf("trial %d: Ticket = %s %q %+v %+v, want %s %q after Accept %d and edit %d", trial, got.Status, got.Title, got.OpenRound, got.Delivery, wantStatus, wantTitle, acceptRec.Code, editRec.Code)
		}
		switch claimRec.Code {
		case http.StatusCreated:
			if decodeClaim(t, claimRec).Ticket.Id != other.Id {
				t.Fatalf("trial %d: the racing claim took %s", trial, claimRec.Body.String())
			}
		case http.StatusNoContent:
			if next := f.mustClaim(t); next.Ticket.Id != other.Id {
				t.Fatalf("trial %d: the claim after the race took %s", trial, next.Ticket.Id)
			}
		default:
			t.Fatalf("trial %d: claim: status=%d body=%s", trial, claimRec.Code, claimRec.Body.String())
		}
		if rows := deliverableRows(t, f); len(rows) != 1 {
			t.Fatalf("trial %d: %d deliverables", trial, len(rows))
		}
	}
}
